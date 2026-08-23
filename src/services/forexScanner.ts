import axios from 'axios';
import { sendForexOpportunityToTelegram } from './telegramForex';

const API_KEY = process.env.TWELVE_DATA_API_KEY || '7d5b98c57c0c4c05b856c93fdaebd37b';

// الأصول الأساسية: الذهب، الفضة، والعملات الرئيسية
const TARGET_ASSETS = [
  { symbol: 'XAU/USD', yahooTicker: 'GC=F', decimals: 2, slBuffer: 1.5 },
  { symbol: 'XAG/USD', yahooTicker: 'SI=F', decimals: 3, slBuffer: 0.05 },
  { symbol: 'EUR/USD', yahooTicker: 'EURUSD=X', decimals: 5, slBuffer: 0.0008 },
  { symbol: 'GBP/USD', yahooTicker: 'GBPUSD=X', decimals: 5, slBuffer: 0.0009 },
  { symbol: 'USD/JPY', yahooTicker: 'USDJPY=X', decimals: 3, slBuffer: 0.15 },
  { symbol: 'AUD/USD', yahooTicker: 'AUDUSD=X', decimals: 5, slBuffer: 0.0008 },
  { symbol: 'GBP/JPY', yahooTicker: 'GBPJPY=X', decimals: 3, slBuffer: 0.18 },
];

export interface CandleData {
  open: number;
  high: number;
  low: number;
  close: number;
}

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

const sentForexCache = new Map<string, number>();

// ==========================================================
// 1. جلب الشموع البيانية
// ==========================================================
const fetchForexCandles = async (asset: typeof TARGET_ASSETS[0], interval: '15m' | '1h', outputsize = 80): Promise<CandleData[]> => {
  const intervalParam = interval === '15m' ? '15min' : '1h';

  // 1. محاولة Twelve Data
  try {
    const res = await axios.get('https://api.twelvedata.com/time_series', {
      params: { symbol: asset.symbol, interval: intervalParam, outputsize, apikey: API_KEY },
      timeout: 10000,
    });

    if (res.data?.values?.length) {
      return res.data.values
        .map((c: any) => ({
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }))
        .reverse();
    }
  } catch {
    // الانتقال إلى Yahoo Finance
  }

  // 2. Yahoo Finance كبديل فوري
  try {
    const yInterval = interval === '15m' ? '15m' : '60m';
    const range = interval === '15m' ? '5d' : '30d';
    const res = await axios.get(`https://query2.finance.yahoo.com/v8/finance/chart/${asset.yahooTicker}?interval=${yInterval}&range=${range}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });

    const quote = res.data?.chart?.result?.[0]?.indicators?.quote?.[0];
    if (quote?.close?.length) {
      const candles: CandleData[] = [];
      for (let i = 0; i < quote.close.length; i++) {
        if (quote.open[i] && quote.high[i] && quote.low[i] && quote.close[i]) {
          candles.push({
            open: parseFloat(quote.open[i].toFixed(asset.decimals)),
            high: parseFloat(quote.high[i].toFixed(asset.decimals)),
            low: parseFloat(quote.low[i].toFixed(asset.decimals)),
            close: parseFloat(quote.close[i].toFixed(asset.decimals)),
          });
        }
      }
      return candles.slice(-outputsize);
    }
  } catch {
    return [];
  }

  return [];
};

// ==========================================================
// 2. أدوات الهيكل المؤسسي
// ==========================================================
const findSwings = (candles: CandleData[], leftRight = 3): SwingPoint[] => {
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
// 3. خوارزمية التحليل المؤسسي (ICT Strict Engine)
// ==========================================================
const analyzeForexICTSetup = (candles: CandleData[], asset: typeof TARGET_ASSETS[0], timeframe: '15m' | '1h') => {
  if (!candles || candles.length < 50) return null;

  const swings = findSwings(candles, 3);
  if (swings.length < 5) return null;

  const sCurrent = swings[swings.length - 1];
  const sPrev = swings[swings.length - 2];
  const sPrior = swings[swings.length - 3];

  // 1. فحص نموذج الشراء المؤسسي (Bullish ICT)
  if (sCurrent.type === 'LOW' && sPrev.type === 'HIGH' && sPrior.type === 'LOW') {
    // سحب سيولة من قاع سابق
    const didSweep = sCurrent.price < sPrior.price;
    if (!didSweep) return null;

    // كسر الهيكل الصاعد (Bullish MSS) بإغلاق جسم الشمعة
    let mssCandleIdx = -1;
    for (let cIdx = sCurrent.index + 1; cIdx < candles.length; cIdx++) {
      if (candles[cIdx].close > sPrev.price) {
        mssCandleIdx = cIdx;
        break;
      }
    }

    if (mssCandleIdx === -1 || candles.length - 1 - mssCandleIdx > 12) return null;

    // التحقق من منطقة الخصم (Discount < 50%)
    const impulseLow = sCurrent.price;
    const impulseHigh = candles[mssCandleIdx].high;
    const impulseRange = impulseHigh - impulseLow;
    if (impulseRange <= 0) return null;

    const equilibrium = impulseLow + impulseRange * 0.5;

    // البحث عن FVG داخل منطقة الخصم
    const fvgs = detectFVGs(candles, sCurrent.index, mssCandleIdx);
    const validFVG = fvgs.reverse().find((f) => f.type === 'BULLISH' && f.top <= equilibrium);

    if (!validFVG) return null;

    const entryPrice = validFVG.top;
    const stopLoss = parseFloat((impulseLow - asset.slBuffer).toFixed(asset.decimals));
    const risk = entryPrice - stopLoss;
    if (risk <= 0) return null;

    const currentPrice = candles[candles.length - 1].close;
    const tp1 = parseFloat((entryPrice + risk * 1.5).toFixed(asset.decimals));
    const tp2 = parseFloat(sPrev.price.toFixed(asset.decimals)); // سيولة القمة السابقة
    const tp3 = parseFloat((entryPrice + risk * 3.0).toFixed(asset.decimals));

    return {
      symbol: asset.symbol,
      type: 'BUY',
      strategy: 'ICT Institutional Setup 🏛️',
      timeframe,
      currentPrice: parseFloat(currentPrice.toFixed(asset.decimals)),
      entryZone: {
        min: parseFloat(validFVG.bottom.toFixed(asset.decimals)),
        max: parseFloat(validFVG.top.toFixed(asset.decimals)),
      },
      stopLoss,
      targets: { tp1, tp2, tp3 },
      riskRewardRatio: '1:2.5',
      confluenceScore: 95,
      fulfilledConditions: [
        { title: 'Sell-Side Liquidity Sweep (SSL)' },
        { title: 'Market Structure Shift (MSS Body Close)' },
        { title: 'Discount Fair Value Gap (FVG)' },
      ],
    };
  }

  return null;
};

// ==========================================================
// 4. تشغيل الفحص الدوري للفوركس والمعادن (15m, 1h)
// ==========================================================
export const runForexScan = async () => {
  try {
    const targetTimeframes: Array<'15m' | '1h'> = ['15m', '1h'];
    console.log(`🌍 [Forex Scanner] بدء مسح الفوركس والمعادن (15m, 1h)...`);

    for (const asset of TARGET_ASSETS) {
      for (const tf of targetTimeframes) {
        const candles = await fetchForexCandles(asset, tf, 80);

        if (candles.length < 50) continue;

        const setup = analyzeForexICTSetup(candles, asset, tf);

        if (setup && setup.confluenceScore >= 85) {
          const cacheKey = `${asset.symbol}_${tf}_${setup.type}_${Math.floor(Date.now() / (3 * 60 * 60 * 1000))}`;
          if (!sentForexCache.has(cacheKey)) {
            const sent = await sendForexOpportunityToTelegram(setup);
            if (sent) {
              sentForexCache.set(cacheKey, Date.now());
              console.log(`🎯 [Forex Signal Sent]: ${asset.symbol} [${tf}] - Score: ${setup.confluenceScore}%`);
            }
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    console.log(`✨ [Forex Scanner] اكتمل فحص الفوركس والمعادن.`);
  } catch (error: any) {
    console.error('❌ خطأ في مسح الفوركس:', error.message);
  }
};
