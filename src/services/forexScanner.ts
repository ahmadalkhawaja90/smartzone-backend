import axios from 'axios';
import { sendForexOpportunityToTelegram } from './telegramForex';
import { generateChartPngBuffer, CandlePlotData } from './chartGenerator';
import { watchEntryZone } from './finnhubPriceWatcher';

const API_KEY = process.env.TWELVE_DATA_API_KEY || '7d5b98c57c0c4c05b856c93fdaebd37b';
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'da7bdi9r01qqqkkitr70da7bdi9r01qqqkkitr7g';

// صجحنا القائمة: العملات الرئيسية فقط (بدون ذهب وبدون فضة)
// أضفنا finnhubSymbol كبديل جلب بيانات بدل ياهو
const TARGET_ASSETS = [
  { symbol: 'EUR/USD', finnhubSymbol: 'OANDA:EUR_USD', decimals: 5, slBuffer: 0.0008, pipValuePerLot: 10 },
  { symbol: 'GBP/USD', finnhubSymbol: 'OANDA:GBP_USD', decimals: 5, slBuffer: 0.0009, pipValuePerLot: 10 },
  { symbol: 'USD/JPY', finnhubSymbol: 'OANDA:USD_JPY', decimals: 3, slBuffer: 0.15, pipValuePerLot: 9.5 },
  { symbol: 'AUD/USD', finnhubSymbol: 'OANDA:AUD_USD', decimals: 5, slBuffer: 0.0008, pipValuePerLot: 10 },
  { symbol: 'GBP/JPY', finnhubSymbol: 'OANDA:GBP_JPY', decimals: 3, slBuffer: 0.18, pipValuePerLot: 7.5 },
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
// 1. جلب الشموع البيانية — Twelve Data أساسي، Finnhub بديل
// ==========================================================
const fetchFromTwelveData = async (
  asset: typeof TARGET_ASSETS[0],
  interval: '15m' | '1h',
  outputsize: number
): Promise<CandleData[]> => {
  const intervalParam = interval === '15m' ? '15min' : '1h';

  const res = await axios.get('https://api.twelvedata.com/time_series', {
    params: { symbol: asset.symbol, interval: intervalParam, outputsize, apikey: API_KEY },
    timeout: 4500,
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
  return [];
};

const fetchFromFinnhub = async (
  asset: typeof TARGET_ASSETS[0],
  interval: '15m' | '1h',
  outputsize: number
): Promise<CandleData[]> => {
  const resolution = interval === '15m' ? '15' : '60';
  const resolutionSeconds = interval === '15m' ? 15 * 60 : 60 * 60;
  const to = Math.floor(Date.now() / 1000);
  const from = to - resolutionSeconds * (outputsize + 5);

  const res = await axios.get('https://finnhub.io/api/v1/forex/candle', {
    params: {
      symbol: asset.finnhubSymbol,
      resolution,
      from,
      to,
      token: FINNHUB_API_KEY,
    },
    timeout: 4500,
  });

  const data = res.data;
  if (data?.s !== 'ok' || !data?.c?.length) return [];

  const candles: CandleData[] = [];
  for (let i = 0; i < data.c.length; i++) {
    candles.push({
      timestamp: data.t[i] * 1000,
      open: parseFloat(data.o[i].toFixed(asset.decimals)),
      high: parseFloat(data.h[i].toFixed(asset.decimals)),
      low: parseFloat(data.l[i].toFixed(asset.decimals)),
      close: parseFloat(data.c[i].toFixed(asset.decimals)),
    });
  }
  return candles.slice(-outputsize);
};

const fetchForexCandles = async (
  asset: typeof TARGET_ASSETS[0],
  interval: '15m' | '1h',
  outputsize = 100
): Promise<CandleData[]> => {
  try {
    const candles = await fetchFromTwelveData(asset, interval, outputsize);
    if (candles.length) return candles;
  } catch {
    // الانتقال للبديل فوراً
  }

  try {
    return await fetchFromFinnhub(asset, interval, outputsize);
  } catch {
    return [];
  }
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
// 4. تنفيذ الفحص — بالتوازي وبدون تأخير، مع مراقب السعر الحي
// ==========================================================
export const runForexScan = async () => {
  console.log(`🌍 [Forex Scanner] بدء فحص العملات الرئيسية (متوازي)...`);

  const tasks: Array<{ asset: typeof TARGET_ASSETS[0]; tf: '15m' | '1h' }> = [];
  for (const asset of TARGET_ASSETS) {
    for (const tf of ['1h', '15m'] as const) {
      tasks.push({ asset, tf });
    }
  }

  const results = await Promise.allSettled(
    tasks.map(async ({ asset, tf }) => {
      const candles = await fetchForexCandles(asset, tf, 100);
      if (candles.length < 50) return;

      const result = analyzeForexICTSetup(candles, asset, tf);
      if (!result || result.opportunity.confluenceScore < 85) return;

      const cacheKey = `${asset.symbol}_${tf}_${result.opportunity.type}_${Math.floor(Date.now() / (3 * 60 * 60 * 1000))}`;
      if (sentForexCache.has(cacheKey)) return;

      sentForexCache.set(cacheKey, Date.now()); // حجز الكاش لمنع التكرار
      watchEntryZone({
        finnhubSymbol: asset.finnhubSymbol,
        entryMin: result.opportunity.entryZone.min,
        entryMax: result.opportunity.entryZone.max,
        onEntryTriggered: async (triggerPrice: number) => {
          const chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], result.chartOptions);
          const sent = await sendForexOpportunityToTelegram(result.opportunity, chartBuffer);
          if (sent) {
            console.log(`🎯 [Signal Sent on Live Trigger]: ${asset.symbol} [${tf}] - ${result.opportunity.type} @ ${triggerPrice}`);
          }
        },
      });
    })
  );

  const failed = results.filter((r) => r.status === 'rejected').length;
  console.log(`✨ [Forex Scanner] اكتملت دورة الفحص. فشل: ${failed}/${tasks.length}`);
};
