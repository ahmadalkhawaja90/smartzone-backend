import axios from 'axios';
import { sendForexOpportunityToTelegram } from './telegramForex';
import { generateChartPngBuffer, CandlePlotData } from './chartGenerator';

const API_KEY = process.env.TWELVE_DATA_API_KEY || '7d5b98c57c0c4c05b856c93fdaebd37b';

// صجحنا القائمة: العملات الرئيسية فقط (بدون ذهب وبدون فضة)
const TARGET_ASSETS = [
  { symbol: 'EUR/USD', yahooTicker: 'EURUSD=X', decimals: 5, slBuffer: 0.0008, pipValuePerLot: 10 },
  { symbol: 'GBP/USD', yahooTicker: 'GBPUSD=X', decimals: 5, slBuffer: 0.0009, pipValuePerLot: 10 },
  { symbol: 'USD/JPY', yahooTicker: 'USDJPY=X', decimals: 3, slBuffer: 0.15, pipValuePerLot: 9.5 },
  { symbol: 'AUD/USD', yahooTicker: 'AUDUSD=X', decimals: 5, slBuffer: 0.0008, pipValuePerLot: 10 },
  { symbol: 'GBP/JPY', yahooTicker: 'GBPJPY=X', decimals: 3, slBuffer: 0.18, pipValuePerLot: 7.5 },
];

export interface CandleData {
  timestamp: number;
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
const fetchForexCandles = async (asset: typeof TARGET_ASSETS[0], interval: '15m' | '1h', outputsize = 100): Promise<CandleData[]> => {
  const intervalParam = interval === '15m' ? '15min' : '1h';

  try {
    const res = await axios.get('https://api.twelvedata.com/time_series', {
      params: { symbol: asset.symbol, interval: intervalParam, outputsize, apikey: API_KEY },
      timeout: 10000,
    });

    if (res.data?.values?.length) {
      return res.data.values
        .map((c: any) => ({
          timestamp: new Date(c.datetime).getTime(),
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }))
        .reverse();
    }
  } catch {
    // الانتقال للبديل الفوري
  }

  try {
    const yInterval = interval === '15m' ? '15m' : '60m';
    const range = interval === '15m' ? '5d' : '30d';
    const res = await axios.get(`https://query2.finance.yahoo.com/v8/finance/chart/${asset.yahooTicker}?interval=${yInterval}&range=${range}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });

    const result = res.data?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const quote = result?.indicators?.quote?.[0];

    if (quote?.close?.length) {
      const candles: CandleData[] = [];
      for (let i = 0; i < quote.close.length; i++) {
        if (quote.open[i] && quote.high[i] && quote.low[i] && quote.close[i]) {
          candles.push({
            timestamp: (timestamps[i] || Date.now() / 1000) * 1000,
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
// 2. كشف السوينغات والفجوات المؤسسية (ICT Logic)
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
// 3. المحلل الصارم (العملات الرئيسية فقط + السماح بصفقات الجمعة)
// ==========================================================
const analyzeForexICTSetup = (candles: CandleData[], asset: typeof TARGET_ASSETS[0], timeframe: '15m' | '1h') => {
  if (!candles || candles.length < 50) return null;

  const swings = findSwings(candles, 3);
  if (swings.length < 5) return null;

  const sCurrent = swings[swings.length - 1];
  const sPrev = swings[swings.length - 2];
  const sPrior = swings[swings.length - 3];

  // 1. فرصة شراء (Bullish ICT Setup)
  if (sCurrent.type === 'LOW' && sPrev.type === 'HIGH' && sPrior.type === 'LOW') {
    const didSweep = sCurrent.price < sPrior.price;
    if (!didSweep) return null;

    let mssCandleIdx = -1;
    for (let cIdx = sCurrent.index + 1; cIdx < candles.length; cIdx++) {
      if (candles[cIdx].close > sPrev.price) {
        mssCandleIdx = cIdx;
        break;
      }
    }

    if (mssCandleIdx === -1 || candles.length - 1 - mssCandleIdx > 12) return null;

    const impulseLow = sCurrent.price;
    const impulseHigh = candles[mssCandleIdx].high;
    const impulseRange = impulseHigh - impulseLow;
    if (impulseRange <= 0) return null;

    const equilibrium = impulseLow + impulseRange * 0.5;

    const fvgs = detectFVGs(candles, sCurrent.index, mssCandleIdx);
    const validFVG = fvgs.reverse().find((f) => f.type === 'BULLISH' && f.top <= equilibrium);

    if (!validFVG) return null;

    const currentPrice = candles[candles.length - 1].close;
    if (currentPrice > validFVG.top * 1.003 || currentPrice < validFVG.bottom * 0.997) return null;

    const entryPrice = validFVG.top;
    const stopLoss = parseFloat((impulseLow - asset.slBuffer).toFixed(asset.decimals));
    const risk = entryPrice - stopLoss;
    if (risk <= 0) return null;

    const tp1 = parseFloat((entryPrice + risk * 1.5).toFixed(asset.decimals));
    const tp2 = parseFloat((entryPrice + risk * 3.0).toFixed(asset.decimals));

    return {
      opportunity: {
        symbol: asset.symbol,
        type: 'BUY',
        strategy: 'ICT Institutional Setup 🏛️ (0.01 Lot + Breakeven)',
        timeframe,
        currentPrice: parseFloat(currentPrice.toFixed(asset.decimals)),
        entryZone: {
          min: parseFloat(validFVG.bottom.toFixed(asset.decimals)),
          max: parseFloat(validFVG.top.toFixed(asset.decimals)),
        },
        stopLoss,
        targets: { tp1, tp2, tp3: parseFloat(sPrev.price.toFixed(asset.decimals)) },
        riskRewardRatio: '1:3.0',
        confluenceScore: 95,
        fulfilledConditions: [
          { title: 'Sell-Side Liquidity Sweep (SSL)' },
          { title: 'Market Structure Shift (MSS Body Close)' },
          { title: 'Discount Fair Value Gap (FVG)' },
        ],
      },
      chartOptions: {
        symbol: asset.symbol,
        timeframe,
        entry: entryPrice,
        stopLoss,
        tp1,
        tp2,
        tp3: parseFloat(sPrev.price.toFixed(asset.decimals)),
        fvgTop: validFVG.top,
        fvgBottom: validFVG.bottom,
      },
    };
  }

  // 2. فرصة بيع (Bearish ICT Setup)
  if (sCurrent.type === 'HIGH' && sPrev.type === 'LOW' && sPrior.type === 'HIGH') {
    const didSweep = sCurrent.price > sPrior.price;
    if (!didSweep) return null;

    let mssCandleIdx = -1;
    for (let cIdx = sCurrent.index + 1; cIdx < candles.length; cIdx++) {
      if (candles[cIdx].close < sPrev.price) {
        mssCandleIdx = cIdx;
        break;
      }
    }

    if (mssCandleIdx === -1 || candles.length - 1 - mssCandleIdx > 12) return null;

    const impulseHigh = sCurrent.price;
    const impulseLow = candles[mssCandleIdx].low;
    const impulseRange = impulseHigh - impulseLow;
    if (impulseRange <= 0) return null;

    const equilibrium = impulseLow + impulseRange * 0.5;

    const fvgs = detectFVGs(candles, sCurrent.index, mssCandleIdx);
    const validFVG = fvgs.reverse().find((f) => f.type === 'BEARISH' && f.bottom >= equilibrium);

    if (!validFVG) return null;

    const currentPrice = candles[candles.length - 1].close;
    if (currentPrice < validFVG.bottom * 0.997 || currentPrice > validFVG.top * 1.003) return null;

    const entryPrice = validFVG.bottom;
    const stopLoss = parseFloat((impulseHigh + asset.slBuffer).toFixed(asset.decimals));
    const risk = stopLoss - entryPrice;
    if (risk <= 0) return null;

    const tp1 = parseFloat((entryPrice - risk * 1.5).toFixed(asset.decimals));
    const tp2 = parseFloat((entryPrice - risk * 3.0).toFixed(asset.decimals));

    return {
      opportunity: {
        symbol: asset.symbol,
        type: 'SELL',
        strategy: 'ICT Institutional Setup 🏛️ (0.01 Lot + Breakeven)',
        timeframe,
        currentPrice: parseFloat(currentPrice.toFixed(asset.decimals)),
        entryZone: {
          min: parseFloat(validFVG.bottom.toFixed(asset.decimals)),
          max: parseFloat(validFVG.top.toFixed(asset.decimals)),
        },
        stopLoss,
        targets: { tp1, tp2, tp3: parseFloat(sPrev.price.toFixed(asset.decimals)) },
        riskRewardRatio: '1:3.0',
        confluenceScore: 95,
        fulfilledConditions: [
          { title: 'Buy-Side Liquidity Sweep (BSL)' },
          { title: 'Market Structure Shift (MSS Body Close)' },
          { title: 'Premium Fair Value Gap (FVG)' },
        ],
      },
      chartOptions: {
        symbol: asset.symbol,
        timeframe,
        entry: entryPrice,
        stopLoss,
        tp1,
        tp2,
        tp3: parseFloat(sPrev.price.toFixed(asset.decimals)),
        fvgTop: validFVG.top,
        fvgBottom: validFVG.bottom,
      },
    };
  }

  return null;
};

// ==========================================================
// 4. تنفيذ الفحص الدوري للعملات الرئيسية فقط
// ==========================================================
export const runForexScan = async () => {
  try {
    const targetTimeframes: Array<'15m' | '1h'> = ['1h', '15m'];
    console.log(`🌍 [Forex Scanner] بدء فحص العملات الرئيسية...`);

    for (const asset of TARGET_ASSETS) {
      for (const tf of targetTimeframes) {
        const candles = await fetchForexCandles(asset, tf, 100);
        if (candles.length < 50) continue;

        const result = analyzeForexICTSetup(candles, asset, tf);

        if (result && result.opportunity.confluenceScore >= 85) {
          const cacheKey = `${asset.symbol}_${tf}_${result.opportunity.type}_${Math.floor(Date.now() / (3 * 60 * 60 * 1000))}`;
          if (!sentForexCache.has(cacheKey)) {
            const chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], result.chartOptions);
            const sent = await sendForexOpportunityToTelegram(result.opportunity, chartBuffer);
            if (sent) {
              sentForexCache.set(cacheKey, Date.now());
              console.log(`🎯 [Signal Sent Successfully]: ${asset.symbol} [${tf}] - ${result.opportunity.type}`);
            }
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    console.log(`✨ [Forex Scanner] اكتملت دورة الفحص بنجاح.`);
  } catch (error: any) {
    console.error('❌ خطأ في مسح الفوركس:', error.message);
  }
};