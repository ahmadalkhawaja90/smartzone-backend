import axios from 'axios';
import { Opportunity } from '../models/Opportunity';
import { sendOpportunityToTelegram } from './telegramBot';
import { generateChartPngBuffer, CandlePlotData } from './chartGenerator';
import { placeLimitBuyOrder } from './binanceClient';

export interface CandleData {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ==========================================================
// 1. جلب قائمة أفضل 60 زوج USDT نشط
// ==========================================================
const CORE_TOP_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT',
  'SUIUSDT', 'DOGEUSDT', 'TONUSDT', 'APTUSDT', 'MATICUSDT',
  'LTCUSDT', 'BCHUSDT', 'ICPUSDT', 'FETUSDT', 'RENDERUSDT',
  'INJUSDT', 'TAOUSDT', 'RNDRUSDT', 'PEPEUSDT', 'SHIBUSDT',
  'OPUSDT', 'ARBUSDT', 'ATOMUSDT', 'FILUSDT', 'FTMUSDT',
  'WIFUSDT', 'KASUSDT', 'STXUSDT', 'IMXUSDT', 'HBARUSDT',
  'GRTUSDT', 'AAVEUSDT', 'MKRUSDT', 'SEIUSDT', 'FLOKIUSDT',
  'BONKUSDT', 'RUNEUSDT', 'BEAMUSDT', 'JUPUSDT', 'STRKUSDT',
  'PENDLEUSDT', 'TIAUSDT', 'ENSUSDT', 'GALAUSDT', 'CRVUSDT'
];

export const getActiveUSDTSpotPairs = async (): Promise<string[]> => {
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=spot', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });

    const blacklist = ['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'EURUSDT', 'DAIUSDT', 'USDEUSDT'];

    const dynamicTop = res.data.result.list
      .filter((item: any) => item.symbol.endsWith('USDT') && !blacklist.includes(item.symbol))
      .sort((a: any, b: any) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
      .slice(0, 60)
      .map((item: any) => item.symbol);

    return Array.from(new Set([...CORE_TOP_PAIRS, ...dynamicTop])).slice(0, 60);
  } catch (error) {
    return CORE_TOP_PAIRS;
  }
};

// ==========================================================
// 2. جلب الشموع البيانية
// ==========================================================
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toBybitInterval = (interval: string): string => {
  if (interval === '1h') return '60';
  if (interval === '4h') return '240';
  return interval;
};

const toOkxInterval = (interval: string): string => {
  if (interval === '1h') return '1H';
  if (interval === '4h') return '4H';
  return interval;
};

const fetchCandlesFromBybit = async (symbol: string, interval: string, limit: number): Promise<CandleData[]> => {
  const res = await axios.get('https://api.bybit.com/v5/market/kline', {
    params: { category: 'spot', symbol, interval: toBybitInterval(interval), limit },
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 8000,
  });

  if (!res.data.result?.list?.length) throw new Error('Bybit data empty');

  return res.data.result.list
    .map((c: any) => ({
      openTime: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }))
    .reverse();
};

const fetchCandlesFromOkx = async (symbol: string, interval: string, limit: number): Promise<CandleData[]> => {
  const okxSymbol = symbol.replace('USDT', '') + '-USDT';
  const res = await axios.get('https://www.okx.com/api/v5/market/candles', {
    params: { instId: okxSymbol, bar: toOkxInterval(interval), limit },
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 8000,
  });

  if (!res.data?.data?.length) throw new Error('OKX data empty');

  return res.data.data
    .map((c: any) => ({
      openTime: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }))
    .reverse();
};

const fetchCandles = async (symbol: string, interval = '1h', limit = 100): Promise<CandleData[]> => {
  try {
    return await fetchCandlesFromBybit(symbol, interval, limit);
  } catch {
    try {
      return await fetchCandlesFromOkx(symbol, interval, limit);
    } catch {
      return [];
    }
  }
};

// ==========================================================
// 3. أدوات التحليل المؤسسي
// ==========================================================
interface SwingPoint {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

interface FVG {
  startIndex: number;
  top: number;
  bottom: number;
  type: 'BULLISH';
}

const findSwings = (candles: CandleData[], leftRight = 2): SwingPoint[] => {
  const swings: SwingPoint[] = [];
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const isHigh = candles.slice(i - leftRight, i + leftRight + 1).every((c, idx) => idx === leftRight || c.high <= candles[i].high);
    const isLow = candles.slice(i - leftRight, i + leftRight + 1).every((c, idx) => idx === leftRight || c.low >= candles[i].low);

    if (isHigh) swings.push({ index: i, price: candles[i].high, type: 'HIGH' });
    if (isLow) swings.push({ index: i, price: candles[i].low, type: 'LOW' });
  }
  return swings;
};

const detectFVGs = (candles: CandleData[], startIdx: number, endIdx: number): FVG[] => {
  const fvgs: FVG[] = [];
  for (let i = startIdx; i < endIdx - 2; i++) {
    const c1 = candles[i];
    const c3 = candles[i + 2];

    if (c1.high < c3.low) {
      fvgs.push({ startIndex: i, top: c3.low, bottom: c1.high, type: 'BULLISH' });
    }
  }
  return fvgs;
};

// ==========================================================
// 4. خوارزمية تحليل ICT الذكية (بحث مرن للشراء فقط)
// ==========================================================
export const analyzeICTSetup = (candles: CandleData[], symbol: string, timeframe: string) => {
  if (candles.length < 50) return null;

  const swings = findSwings(candles, 2);
  if (swings.length < 5) return null;

  const currentPrice = candles[candles.length - 1].close;
  const baseAsset = symbol.replace('USDT', '');
  
  const recentSwings = swings.slice(-15);

  for (let i = recentSwings.length - 1; i >= 2; i--) {
    const sweepNode = recentSwings[i];

    if (sweepNode.type === 'LOW') {
      let prevLow = null;
      let mssHigh = null;

      for (let j = i - 1; j >= 0; j--) {
        if (recentSwings[j].type === 'LOW' && sweepNode.price < recentSwings[j].price) {
          prevLow = recentSwings[j];
          let maxPrice = -Infinity;
          for (let k = j; k <= i; k++) {
            if (recentSwings[k].type === 'HIGH' && recentSwings[k].price > maxPrice) {
              maxPrice = recentSwings[k].price;
              mssHigh = recentSwings[k];
            }
          }
          break; 
        }
      }

      if (prevLow && mssHigh) {
        let mssIdx = -1;
        let highestAfterMSS = sweepNode.price;

        for (let c = sweepNode.index + 1; c < candles.length - 1; c++) {
          if (candles[c].high > highestAfterMSS) highestAfterMSS = candles[c].high;
          if (mssIdx === -1 && candles[c].close > mssHigh.price) {
            mssIdx = c;
          }
        }

        if (mssIdx !== -1 && (candles.length - mssIdx <= 30)) {
          const impulseLow = sweepNode.price;
          const equilibrium = impulseLow + (highestAfterMSS - impulseLow) * 0.5;

          const fvgs = detectFVGs(candles, sweepNode.index, mssIdx);
          const validFVG = fvgs.reverse().find(f => {
            if (f.type !== 'BULLISH' || f.top > equilibrium) return false;
            
            let closed = false;
            for (let m = f.startIndex + 2; m < candles.length - 1; m++) {
              if (candles[m].low < f.bottom) closed = true;
            }
            return !closed;
          });

          if (validFVG) {
            if (currentPrice <= equilibrium && currentPrice > validFVG.bottom * 0.998) {
              const entryPrice = validFVG.top;
              const stopLoss = parseFloat((impulseLow * 0.997).toFixed(6));
              const risk = entryPrice - stopLoss;
              
              if (risk > 0) {
                const impulseRange = highestAfterMSS - impulseLow;

                const minTp1 = entryPrice + risk * 1.0;
                const tp1 = parseFloat(Math.max(mssHigh.price, minTp1).toFixed(6));

                const rawFibTp2 = impulseLow + impulseRange * 1.272;
                const minTp2 = tp1 + risk * 0.8;
                const tp2 = parseFloat(Math.max(rawFibTp2, minTp2).toFixed(6));

                const rawFibTp3 = impulseLow + impulseRange * 1.618;
                const minTp3 = tp2 + risk * 1.0;
                const tp3 = parseFloat(Math.max(rawFibTp3, minTp3).toFixed(6));

                return {
                  opportunity: {
                    symbol, baseAsset, market: 'crypto' as const, timeframe,
                    type: 'SPOT_BUY' as const, currentPrice,
                    entryZone: { min: parseFloat(validFVG.bottom.toFixed(6)), max: parseFloat(validFVG.top.toFixed(6)) },
                    stopLoss, targets: { tp1, tp2, tp3 },
                    riskRewardRatio: '1:3.0', confluenceScore: 98,
                    fulfilledConditions: [
                      { title: 'Liquidity Sweep', description: `سحب سيولة القاع $${prevLow.price}` },
                      { title: 'True MSS', description: `كسر حقيقي للهيكل فوق $${mssHigh.price}` },
                      { title: 'Fresh Discount FVG', description: `عودة السعر لاختبار فجوة غير مستهلكة` },
                    ],
                    analysisReasons: {
                      entryReason: `شراء من FVG مثالية في منطقة الخصم.`,
                      stopLossReason: `وقف أسفل قاع السحب $${stopLoss}.`,
                      takeProfitReason: `TP1 (سيولة BSL): $${tp1} | TP2 (فيبو 1.272): $${tp2} | TP3 (فيبو 1.618): $${tp3}`
                    },
                    status: 'PENDING_ENTRY' as const,
                  },
                  chartOptions: { symbol, timeframe, entry: entryPrice, stopLoss, tp1, tp2, tp3, fvgTop: validFVG.top, fvgBottom: validFVG.bottom },
                };
              }
            }
          }
        }
      }
    }
  }
  return null;
};

// ==========================================
// 5. تشغيل المسح الدوري الشامل مع إرسال الأوامر المعلقة
// ==========================================
export const runFullCryptoScan = async () => {
  const targetTimeframes = ['1h', '4h'];
  console.log('🚀 [Crypto Scanner] بدء دورة الفحص لأفضل 60 عملة رقمية (1h, 4h)...');

  let symbols: string[] = [];
  try {
    symbols = await getActiveUSDTSpotPairs();
    console.log(`🔍 تم تثبيت ${symbols.length} زوج من نخبة العملات للفحص.`);
  } catch (error) {
    return;
  }

  let discoveredCount = 0;

  for (const symbol of symbols) {
    for (const tf of targetTimeframes) {
      try {
        const candles = await fetchCandles(symbol, tf, 100);
        if (candles.length < 40) continue;

        const result = analyzeICTSetup(candles, symbol, tf);

        if (result) {
          // فحص منع التكرار: التأكد من عدم وجود صفقة نشطة أو معلقة لنفس العملة
          const existing = await Opportunity.findOne({
            symbol,
            status: { $in: ['PENDING_ENTRY', 'ACTIVE', 'BREAK_EVEN'] }
          });

          if (!existing) {
            // إرسال أمر الشراء المحدد (Limit Order) لمنصة باينانس
            const entryPrice = result.opportunity.entryZone.max;
            const orderResult = await placeLimitBuyOrder(symbol, entryPrice);

            let orderId: string | undefined = undefined;
            if (orderResult.success && orderResult.orderId) {
              orderId = orderResult.orderId;
              console.log(`⚡ [Binance Testnet] تم وضع أمر شراء معلق لـ ${symbol} بسعر $${entryPrice} (Order ID: ${orderId})`);
            } else {
              console.warn(`⚠️ [Binance Testnet] لم يتم إرسال الطلب لـ ${symbol}: ${orderResult.error}`);
            }

            const createdOpp = await Opportunity.create({
              ...result.opportunity,
              orderId,
            });

            discoveredCount++;
            console.log(`🎯 [فرصة ICT رُصدت]: ${symbol} [${tf}] - حالة الدخول: معلق`);

            const chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], result.chartOptions);

            sendOpportunityToTelegram(createdOpp, chartBuffer).catch((err: any) => {
              console.error(`⚠️ خطأ إرسال التلغرام لـ ${symbol}:`, err.message);
            });
          }
        }
      } catch (error) {
        // Continue loop
      }
      await sleep(150);
    }
  }

  console.log(`✨ [Crypto Scanner] اكتمل الفحص: إجمالي المحاولات ${symbols.length * 2} | رُصدت ${discoveredCount} فرصة.`);
};
