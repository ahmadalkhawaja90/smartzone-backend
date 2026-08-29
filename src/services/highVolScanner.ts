import axios from 'axios';
import { Opportunity } from '../models/Opportunity';
import { sendOpportunityToTelegram } from './telegramHighVolbot';
import { generateChartPngBuffer, CandlePlotData } from './chartGenerator';

export interface CandleData {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ==========================================================
// 1. القائمة الشاملة للعملات عالية التقلب والزخم (53 زوج)
// ==========================================================
export const HIGH_VOLATILITY_PAIRS = [
  // Memes & High Beta
  'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', 'FLOKIUSDT', 'BOMEUSDT', 'MEWUSDT', 'POPCATUSDT', 'MEMEUSDT', 'PEOPLEUSDT', 'DOGEUSDT', 'SHIBUSDT',
  // AI & Data & DePIN
  'TAOUSDT', 'FETUSDT', 'RENDERUSDT', 'ARKMUSDT', 'WLDUSDT', 'NEARUSDT',
  // Fast L1 / L2 & Ecosystems
  'SOLUSDT', 'SUIUSDT', 'SEIUSDT', 'APTUSDT', 'TIAUSDT', 'STXUSDT', 'STRKUSDT', 'MANTAUSDT', 'DYMUSDT', 'ALTUSDT', 'ZETAUSDT', 'TONUSDT', 'KASUSDT', 'CFXUSDT', 'AVAXUSDT', 'FTMUSDT',
  // DeFi & RWA & Infrastructure
  'PENDLEUSDT', 'JUPUSDT', 'ONDOUSDT', 'ENAUSDT', 'PYTHUSDT', 'ENSUSDT', 'INJUSDT', 'UMAUSDT', 'TRBUSDT', 'CYBERUSDT', 'GASUSDT', 'WUSDT', 'BLURUSDT', 'REZUSDT', 'BBUSDT', 'NOTUSDT', 'OMNIUSDT',
  // Gaming & NFT
  'BEAMUSDT', 'GALAUSDT', 'YGGUSDT', 'IMXUSDT', 'ORDIUSDT', '1000SATSUSDT'
];

// ==========================================================
// 2. جلب الشموع البيانية (Bybit مع نظام Fallback لـ OKX)
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

const detectBullishFVGs = (candles: CandleData[], startIdx: number, endIdx: number): FVG[] => {
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
// 4. خوارزمية تحليل ICT للشراء الصاعد فقط (Bullish ICT)
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

    // صفقات الشراء الصاعدة فقط
    if (sweepNode.type === 'LOW') {
      let prevLow = null;
      let mssHigh = null;

      // 1. إيجاد القاع المسحوب والقمة بينهما
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

        // 2. التحقق من كسر الهيكل (MSS)
        for (let c = sweepNode.index + 1; c < candles.length - 1; c++) {
          if (candles[c].high > highestAfterMSS) highestAfterMSS = candles[c].high;
          if (mssIdx === -1 && candles[c].close > mssHigh.price) {
            mssIdx = c;
          }
        }

        // 3. التحقق من التوقيت والـ FVG
        if (mssIdx !== -1 && (candles.length - mssIdx <= 30)) {
          const impulseLow = sweepNode.price;
          const equilibrium = impulseLow + (highestAfterMSS - impulseLow) * 0.5;

          const fvgs = detectBullishFVGs(candles, sweepNode.index, mssIdx);
          const validFVG = fvgs.reverse().find(f => {
            if (f.top > equilibrium) return false;
            
            let closed = false;
            for(let m = f.startIndex + 2; m < candles.length - 1; m++) {
              if (candles[m].low < f.bottom) closed = true;
            }
            return !closed;
          });

          if (validFVG) {
            // 4. فلتر منع التأخير
            if (currentPrice > validFVG.top * 1.006) {
              continue;
            }

            // التأكد أن السعر عاد لمنطقة الخصم
            if (currentPrice <= equilibrium && currentPrice > validFVG.bottom * 0.998) {
              const entryPrice = validFVG.top;
              const stopLoss = parseFloat((impulseLow * 0.997).toFixed(6));
              const risk = entryPrice - stopLoss;
              
              if (risk > 0) {
                const rawTp1 = parseFloat((entryPrice + risk * 1.5).toFixed(6));
                const rawTp2 = parseFloat(mssHigh.price.toFixed(6));
                const rawTp3 = parseFloat((entryPrice + risk * 3.0).toFixed(6));

                const sortedTargets = [rawTp1, rawTp2, rawTp3].sort((a, b) => a - b);
                const tp1 = sortedTargets[0];
                const tp2 = sortedTargets[1];
                const tp3 = sortedTargets[2];

                return {
                  opportunity: {
                    symbol,
                    baseAsset,
                    market: 'crypto' as const,
                    timeframe,
                    type: 'SPOT_BUY' as const,
                    currentPrice,
                    entryZone: { min: parseFloat(validFVG.bottom.toFixed(6)), max: parseFloat(validFVG.top.toFixed(6)) },
                    stopLoss,
                    targets: { tp1, tp2, tp3 },
                    riskRewardRatio: '1:3.0',
                    confluenceScore: 98,
                    fulfilledConditions: [
                      { title: 'Liquidity Sweep', description: `سحب سيولة القاع $${prevLow.price}` },
                      { title: 'True MSS', description: `كسر حقيقي للهيكل فوق $${mssHigh.price}` },
                      { title: 'Fresh Discount FVG', description: `عودة السعر لاختبار فجوة غير مستهلكة` },
                    ],
                    analysisReasons: {
                      entryReason: `شراء من FVG مثالية داخل منطقة الخصم.`,
                      stopLossReason: `وقف أسفل قاع السحب $${stopLoss}.`,
                      takeProfitReason: `TP1: $${tp1} | TP2: $${tp2}`
                    },
                    status: 'ACTIVE' as const,
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
// 5. تشغيل المسح المخصص للعملات عالية التقلب
// ==========================================
export const runHighVolCryptoScan = async () => {
  const targetTimeframes = ['1h', '4h'];
  console.log(`🚀 [High-Vol Crypto Scanner] بدء فحص العملات عالية التقلب (${HIGH_VOLATILITY_PAIRS.length} زوج)...`);

  let discoveredCount = 0;

  for (const symbol of HIGH_VOLATILITY_PAIRS) {
    for (const tf of targetTimeframes) {
      try {
        const candles = await fetchCandles(symbol, tf, 100);
        if (candles.length < 40) continue;

        const result = analyzeICTSetup(candles, symbol, tf);

        if (result) {
          const existing = await Opportunity.findOne({
            symbol,
            timeframe: tf,
            status: 'ACTIVE',
            createdAt: { $gte: new Date(Date.now() - 4 * 60 * 60 * 1000) },
          });

          if (!existing) {
            const createdOpp = await Opportunity.create(result.opportunity);
            discoveredCount++;
            console.log(`🎯 [فرصة شراء عالية التقلب]: ${symbol} [${tf}]`);

            const chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], result.chartOptions);

            sendOpportunityToTelegram(createdOpp, chartBuffer).catch((err: any) => {
              console.error(`⚠️ خطأ إرسال التلغرام لـ ${symbol}:`, err?.message || err);
            });
          }
        }
      } catch (error) {
        // متابعة الفحص للعملات التالية
      }
      await sleep(150);
    }
  }

  console.log(`✨ [High-Vol Scanner] اكتمل الفحص: رُصدت ${discoveredCount} فرصة شراء جديدة.`);
};
