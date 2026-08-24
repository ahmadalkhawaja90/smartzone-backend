import axios from 'axios';
import { Opportunity } from '../models/Opportunity';
import { sendOpportunityToTelegram } from './telegramBot';
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
// 1. جلب قائمة أفضل 30 زوج USDT نشط
// ==========================================================
const CORE_TOP_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT',
  'SUIUSDT', 'DOGEUSDT', 'TONUSDT', 'APTUSDT', 'MATICUSDT',
  'LTCUSDT', 'BCHUSDT', 'ICPUSDT', 'FETUSDT', 'RENDERUSDT',
  'INJUSDT', 'TAOUSDT', 'RNDRUSDT', 'PEPEUSDT', 'SHIBUSDT',
  'OPUSDT', 'ARBUSDT', 'ATOMUSDT', 'FILUSDT', 'FTMUSDT'
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
      .slice(0, 30)
      .map((item: any) => item.symbol);

    return Array.from(new Set([...CORE_TOP_PAIRS.slice(0, 8), ...dynamicTop])).slice(0, 30);
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
// 3. أدوات التحليل المؤسسي (Swings & FVG)
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
// 4. خوارزمية تحليل ICT المؤسسية (شراء + بيع)
// ==========================================================
export const analyzeICTSetup = (candles: CandleData[], symbol: string, timeframe: string) => {
  if (candles.length < 40) return null;

  const swings = findSwings(candles, 2);
  if (swings.length < 4) return null;

  const sCurrent = swings[swings.length - 1];
  const sPrev = swings[swings.length - 2];
  const sPrior = swings[swings.length - 3];
  const currentPrice = candles[candles.length - 1].close;
  const baseAsset = symbol.replace('USDT', '');

  // ==========================================
  // أ) نموذج الشراء الصاعد (Bullish ICT Setup)
  // ==========================================
  if (sCurrent.type === 'LOW' && sPrev.type === 'HIGH' && sPrior.type === 'LOW') {
    if (sCurrent.price < sPrior.price) { // SSL Sweep
      let mssCandleIdx = -1;
      for (let cIdx = sCurrent.index + 1; cIdx < candles.length; cIdx++) {
        if (candles[cIdx].close > sPrev.price) {
          mssCandleIdx = cIdx;
          break;
        }
      }

      if (mssCandleIdx !== -1 && candles.length - 1 - mssCandleIdx <= 25) {
        const impulseLow = sCurrent.price;
        const impulseHigh = candles[mssCandleIdx].high;
        const equilibrium = impulseLow + (impulseHigh - impulseLow) * 0.5;

        const fvgs = detectFVGs(candles, sCurrent.index, mssCandleIdx);
        const validFVG = fvgs.reverse().find((f) => f.type === 'BULLISH' && f.top <= equilibrium);

        if (validFVG) {
          const entryPrice = validFVG.top;
          const stopLoss = parseFloat((impulseLow * 0.997).toFixed(6));
          const risk = entryPrice - stopLoss;

          if (risk > 0) {
            const tp1 = parseFloat((entryPrice + risk * 1.5).toFixed(6));
            const tp2 = parseFloat(sPrev.price.toFixed(6));
            const tp3 = parseFloat((entryPrice + risk * 3.0).toFixed(6));

            return {
              opportunity: {
                symbol,
                baseAsset,
                market: 'crypto' as const,
                timeframe,
                type: 'SPOT_BUY' as const,
                currentPrice,
                entryZone: {
                  min: parseFloat(validFVG.bottom.toFixed(6)),
                  max: parseFloat(validFVG.top.toFixed(6)),
                },
                stopLoss,
                targets: { tp1, tp2, tp3 },
                riskRewardRatio: '1:3.0',
                confluenceScore: 95,
                fulfilledConditions: [
                  { title: 'Sell-Side Liquidity Sweep', description: `تم سحب سيولة القاع السابق عند $${sPrior.price}.` },
                  { title: 'Bullish MSS', description: `كسر هيكل السوق الصاعد فوق القمة $${sPrev.price}.` },
                  { title: 'Discount FVG', description: `منطقة دخول داخل نطاق الخصم.` },
                ],
                analysisReasons: {
                  entryReason: `فرصة شراء ICT نموذجية على فريم [${timeframe}].`,
                  stopLossReason: `وقف الخسارة محمي أسفل قاع السحب $${stopLoss}.`,
                  takeProfitReason: `TP1: $${tp1} | TP2: $${tp2} | TP3: $${tp3}`,
                },
                status: 'ACTIVE' as const,
              },
              chartOptions: {
                symbol,
                timeframe,
                entry: entryPrice,
                stopLoss,
                tp1, tp2, tp3,
                fvgTop: validFVG.top,
                fvgBottom: validFVG.bottom,
              },
            };
          }
        }
      }
    }
  }

  // ==========================================
  // ب) نموذج البيع الهابط (Bearish ICT Setup)
  // ==========================================
  if (sCurrent.type === 'HIGH' && sPrev.type === 'LOW' && sPrior.type === 'HIGH') {
    if (sCurrent.price > sPrior.price) { // BSL Sweep
      let mssCandleIdx = -1;
      for (let cIdx = sCurrent.index + 1; cIdx < candles.length; cIdx++) {
        if (candles[cIdx].close < sPrev.price) {
          mssCandleIdx = cIdx;
          break;
        }
      }

      if (mssCandleIdx !== -1 && candles.length - 1 - mssCandleIdx <= 25) {
        const impulseHigh = sCurrent.price;
        const impulseLow = candles[mssCandleIdx].low;
        const equilibrium = impulseLow + (impulseHigh - impulseLow) * 0.5;

        const fvgs = detectFVGs(candles, sCurrent.index, mssCandleIdx);
        const validFVG = fvgs.reverse().find((f) => f.type === 'BEARISH' && f.bottom >= equilibrium);

        if (validFVG) {
          const entryPrice = validFVG.bottom;
          const stopLoss = parseFloat((impulseHigh * 1.003).toFixed(6));
          const risk = stopLoss - entryPrice;

          if (risk > 0) {
            const tp1 = parseFloat((entryPrice - risk * 1.5).toFixed(6));
            const tp2 = parseFloat(sPrev.price.toFixed(6));
            const tp3 = parseFloat((entryPrice - risk * 3.0).toFixed(6));

            return {
              opportunity: {
                symbol,
                baseAsset,
                market: 'crypto' as const,
                timeframe,
                type: 'SELL' as const,
                currentPrice,
                entryZone: {
                  min: parseFloat(validFVG.bottom.toFixed(6)),
                  max: parseFloat(validFVG.top.toFixed(6)),
                },
                stopLoss,
                targets: { tp1, tp2, tp3 },
                riskRewardRatio: '1:3.0',
                confluenceScore: 95,
                fulfilledConditions: [
                  { title: 'Buy-Side Liquidity Sweep', description: `تم سحب سيولة القمة السابقة عند $${sPrior.price}.` },
                  { title: 'Bearish MSS', description: `كسر هيكل السوق الهابط أسفل القاع $${sPrev.price}.` },
                  { title: 'Premium FVG', description: `منطقة دخول داخل نطاق العلاوة.` },
                ],
                analysisReasons: {
                  entryReason: `فرصة بيع ICT نموذجية على فريم [${timeframe}].`,
                  stopLossReason: `وقف الخسارة محمي أعلى قمة السحب $${stopLoss}.`,
                  takeProfitReason: `TP1: $${tp1} | TP2: $${tp2} | TP3: $${tp3}`,
                },
                status: 'ACTIVE' as const,
              },
              chartOptions: {
                symbol,
                timeframe,
                entry: entryPrice,
                stopLoss,
                tp1, tp2, tp3,
                fvgTop: validFVG.top,
                fvgBottom: validFVG.bottom,
              },
            };
          }
        }
      }
    }
  }

  return null;
};

// ==========================================
// 5. تشغيل المسح الدوري الشامل (1h, 4h)
// ==========================================
export const runFullCryptoScan = async () => {
  const targetTimeframes = ['1h', '4h'];
  console.log('🚀 [Crypto Scanner] بدء دورة الفحص لأفضل 30 عملة رقمية (1h, 4h)...');

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
          const existing = await Opportunity.findOne({
            symbol,
            timeframe: tf,
            status: 'ACTIVE',
            createdAt: { $gte: new Date(Date.now() - 4 * 60 * 60 * 1000) },
          });

          if (!existing) {
            const createdOpp = await Opportunity.create(result.opportunity);
            discoveredCount++;
            console.log(`🎯 [فرصة ICT رُصدت]: ${symbol} [${tf}] - ${result.opportunity.type} - Score: ${result.opportunity.confluenceScore}%`);

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

  console.log(`✨ [Crypto Scanner] اكتمل الفحص: إجمالي المحاولات 60 | رُصدت ${discoveredCount} فرصة.`);
};
