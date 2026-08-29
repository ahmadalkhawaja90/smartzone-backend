import axios from 'axios';
import { Opportunity } from '../models/Opportunity';
import { sendOpportunityToTelegram } from './TelegramHighVolbot';
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
// 1. قائمة العملات عالية التقلب والسيولة (Mid & Low Caps / Memecoins)
// ==========================================================
const HIGH_VOL_PAIRS = [
  'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', 'FLOKIUSDT', 'BOMEUSDT', 'MEWUSDT', 'POPCATUSDT',
  'INJUSDT', 'FETUSDT', 'RNDRUSDT', 'RENDERUSDT', 'TAOUSDT', 'ARKMUSDT', 'WLDUSDT',
  'SUIUSDT', 'SEIUSDT', 'APTUSDT', 'TIAUSDT', 'ORDIUSDT', '1000SATSUSDT', 'KASUSDT',
  'TRBUSDT', 'UMAUSDT', 'GASUSDT', 'CYBERUSDT', 'YGGUSDT', 'GALAUSDT', 'CFXUSDT',
  'STXUSDT', 'IMXUSDT', 'PENDLEUSDT', 'JUPUSDT', 'STRKUSDT', 'PYTHUSDT', 'ENAUSDT',
  'ONDOUSDT', 'ZETAUSDT', 'ALTUSDT', 'MANTAUSDT', 'DYMUSDT', 'OMNIUSDT', 'REZUSDT',
  'BBUSDT', 'NOTUSDT', 'TONUSDT', 'PEOPLEUSDT', 'ENSUSDT', 'MEMEUSDT', 'WUSDT', 'BLURUSDT'
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
      .slice(0, 80)
      .map((item: any) => item.symbol);

    return Array.from(new Set([...HIGH_VOL_PAIRS, ...dynamicTop])).slice(0, 60);
  } catch (error) {
    return HIGH_VOL_PAIRS.slice(0, 60);
  }
};

// ==========================================================
// 2. دالة حساب نسبة التقلب المئوية (ATRP Filter)
// ==========================================================
export const calculateATRP = (candles: CandleData[], period = 14): number => {
  if (candles.length < period + 1) return 0;

  let totalTrueRangePercent = 0;
  const targetCandles = candles.slice(-period);

  for (let i = 1; i < targetCandles.length; i++) {
    const current = targetCandles[i];
    const prev = targetCandles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close)
    );

    const trPercent = (tr / current.close) * 100;
    totalTrueRangePercent += trPercent;
  }

  return parseFloat((totalTrueRangePercent / (period - 1)).toFixed(2));
};

// ==========================================================
// 3. جلب الشموع البيانية
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
// 4. أدوات التحليل المؤسسي
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
  type: 'BULLISH' | 'BEARISH';
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
    } else if (c1.low > c3.high) {
      fvgs.push({ startIndex: i, top: c1.low, bottom: c3.high, type: 'BEARISH' });
    }
  }
  return fvgs;
};

// ==========================================================
// 5. خوارزمية تحليل ICT الذكية
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
            for(let m = f.startIndex + 2; m < candles.length - 1; m++) {
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
                const rawTp1 = parseFloat((entryPrice + risk * 1.5).toFixed(6));
                const rawTp2 = parseFloat(mssHigh.price.toFixed(6));
                const rawTp3 = parseFloat((entryPrice + risk * 3.0).toFixed(6));
                const sortedTargets = [rawTp1, rawTp2, rawTp3].sort((a, b) => a - b);
                
                return {
                  opportunity: {
                    symbol, baseAsset, market: 'crypto' as const, timeframe,
                    type: 'SPOT_BUY' as const, currentPrice,
                    entryZone: { min: parseFloat(validFVG.bottom.toFixed(6)), max: parseFloat(validFVG.top.toFixed(6)) },
                    stopLoss, targets: { tp1: sortedTargets[0], tp2: sortedTargets[1], tp3: sortedTargets[2] },
                    riskRewardRatio: '1:3.0', confluenceScore: 98,
                    fulfilledConditions: [
                      { title: 'Liquidity Sweep', description: `سحب سيولة القاع $${prevLow.price}` },
                      { title: 'True MSS', description: `كسر حقيقي للهيكل فوق $${mssHigh.price}` },
                      { title: 'Fresh Discount FVG', description: `عودة السعر لاختبار فجوة غير مستهلكة` },
                    ],
                    analysisReasons: { entryReason: `شراء من FVG مثالية.`, stopLossReason: `وقف أسفل قاع السحب $${stopLoss}.`, takeProfitReason: `TP1: $${sortedTargets[0]} | TP2: $${sortedTargets[1]}` },
                    status: 'ACTIVE' as const,
                  },
                  chartOptions: { symbol, timeframe, entry: entryPrice, stopLoss, tp1: sortedTargets[0], tp2: sortedTargets[1], tp3: sortedTargets[2], fvgTop: validFVG.top, fvgBottom: validFVG.bottom },
                };
              }
            }
          }
        }
      }
    }

    if (sweepNode.type === 'HIGH') {
      let prevHigh = null;
      let mssLow = null;

      for (let j = i - 1; j >= 0; j--) {
        if (recentSwings[j].type === 'HIGH' && sweepNode.price > recentSwings[j].price) {
          prevHigh = recentSwings[j];
          let minPrice = Infinity;
          for (let k = j; k <= i; k++) {
            if (recentSwings[k].type === 'LOW' && recentSwings[k].price < minPrice) {
              minPrice = recentSwings[k].price;
              mssLow = recentSwings[k];
            }
          }
          break; 
        }
      }

      if (prevHigh && mssLow) {
        let mssIdx = -1;
        let lowestAfterMSS = sweepNode.price;

        for (let c = sweepNode.index + 1; c < candles.length - 1; c++) {
          if (candles[c].low < lowestAfterMSS) lowestAfterMSS = candles[c].low;
          if (mssIdx === -1 && candles[c].close < mssLow.price) {
            mssIdx = c;
          }
        }

        if (mssIdx !== -1 && (candles.length - mssIdx <= 30)) {
          const impulseHigh = sweepNode.price;
          const equilibrium = impulseHigh - (impulseHigh - lowestAfterMSS) * 0.5;

          const fvgs = detectFVGs(candles, sweepNode.index, mssIdx);
          const validFVG = fvgs.reverse().find(f => {
            if (f.type !== 'BEARISH' || f.bottom < equilibrium) return false;
            let closed = false;
            for(let m = f.startIndex + 2; m < candles.length - 1; m++) {
              if (candles[m].high > f.top) closed = true;
            }
            return !closed;
          });

          if (validFVG) {
            if (currentPrice >= equilibrium && currentPrice < validFVG.top * 1.002) {
              const entryPrice = validFVG.bottom;
              const stopLoss = parseFloat((impulseHigh * 1.003).toFixed(6));
              const risk = stopLoss - entryPrice;
              
              if (risk > 0) {
                const rawTp1 = parseFloat((entryPrice - risk * 1.5).toFixed(6));
                const rawTp2 = parseFloat(mssLow.price.toFixed(6));
                const rawTp3 = parseFloat((entryPrice - risk * 3.0).toFixed(6));
                const sortedTargets = [rawTp1, rawTp2, rawTp3].sort((a, b) => b - a);

                return {
                  opportunity: {
                    symbol, baseAsset, market: 'crypto' as const, timeframe,
                    type: 'SELL' as const, currentPrice,
                    entryZone: { min: parseFloat(validFVG.bottom.toFixed(6)), max: parseFloat(validFVG.top.toFixed(6)) },
                    stopLoss, targets: { tp1: sortedTargets[0], tp2: sortedTargets[1], tp3: sortedTargets[2] },
                    riskRewardRatio: '1:3.0', confluenceScore: 98,
                    fulfilledConditions: [
                      { title: 'Liquidity Sweep', description: `سحب سيولة القمة $${prevHigh.price}` },
                      { title: 'True MSS', description: `كسر حقيقي للهيكل أسفل $${mssLow.price}` },
                      { title: 'Fresh Premium FVG', description: `عودة السعر لاختبار فجوة بيعية` },
                    ],
                    analysisReasons: { entryReason: `بيع من FVG مثالية.`, stopLossReason: `وقف أعلى قمة السحب $${stopLoss}.`, takeProfitReason: `TP1: $${sortedTargets[0]} | TP2: $${sortedTargets[1]}` },
                    status: 'ACTIVE' as const,
                  },
                  chartOptions: { symbol, timeframe, entry: entryPrice, stopLoss, tp1: sortedTargets[0], tp2: sortedTargets[1], tp3: sortedTargets[2], fvgTop: validFVG.top, fvgBottom: validFVG.bottom },
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
// 6. تشغيل المسح الدوري الشامل مع فلتر ATRP
// ==========================================
export const runHighVolCryptoScan = async () => {
  const targetTimeframes = ['1h', '4h'];
  console.log('🚀 [High Vol Scanner] بدء دورة الفحص لعملات التقلب العالي...');

  let symbols: string[] = [];
  try {
    symbols = await getActiveUSDTSpotPairs();
    console.log(`🔍 تم تثبيت ${symbols.length} زوج من عملات الحركة السريعة.`);
  } catch (error) {
    return;
  }

  let discoveredCount = 0;
  const MIN_VOLATILITY_PERCENT = 4.0; // تجاهل العملات الأقل من 4% حركة

  for (const symbol of symbols) {
    for (const tf of targetTimeframes) {
      try {
        const candles = await fetchCandles(symbol, tf, 100);
        if (candles.length < 40) continue;

        const atrp = calculateATRP(candles, 14);
        if (atrp < MIN_VOLATILITY_PERCENT) {
          continue; 
        }

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
            console.log(`🎯 [فرصة ICT سريعة رُصدت]: ${symbol} [${tf}] - ATRP: ${atrp}%`);

            const chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], result.chartOptions);

            sendOpportunityToTelegram(createdOpp, chartBuffer).catch((err) => {
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

  console.log(`✨ [High Vol Scanner] اكتمل الفحص: رُصدت ${discoveredCount} فرصة سريعة.`);
};
