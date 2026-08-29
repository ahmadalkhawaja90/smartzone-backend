import axios from 'axios';
import { sendForexOpportunityToTelegram } from './telegramForex';
import { generateChartPngBuffer, CandlePlotData } from './chartGenerator';

const API_KEY = process.env.TWELVE_DATA_API_KEY || '7d5b98c57c0c4c05b856c93fdaebd37b';
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'da7bdi9r01qqqkkitr70da7bdi9r01qqqkkitr7g';

// العملات المحددة حصراً
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
// 1. جلب الشموع البيانية (Twelve Data أساسي، Finnhub بديل)
// ==========================================================
const fetchFromTwelveData = async (
  asset: typeof TARGET_ASSETS[0],
  interval: '15m' | '1h',
  outputsize: number
): Promise<CandleData[]> => {
  const intervalParam = interval === '15m' ? '15min' : '1h';

  const res = await axios.get('https://api.twelvedata.com/time_series', {
    params: { symbol: asset.symbol, interval: intervalParam, outputsize, apikey: API_KEY },
    timeout: 5000,
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
    timeout: 5000,
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
    // الانتقال للمزود البديل
  }

  try {
    return await fetchFromFinnhub(asset, interval, outputsize);
  } catch {
    return [];
  }
};

// ==========================================================
// 2. كشف السوينغات والفجوات المؤسسية
// ==========================================================
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
// 3. المحلل المؤسسي الصارم (ICT Setup)
// ==========================================================
export const analyzeForexICTSetup = (candles: CandleData[], asset: typeof TARGET_ASSETS[0], timeframe: '15m' | '1h') => {
  if (!candles || candles.length < 50) return null;

  const swings = findSwings(candles, 2);
  if (swings.length < 5) return null;

  const currentPrice = candles[candles.length - 1].close;
  const recentSwings = swings.slice(-15);

  for (let i = recentSwings.length - 1; i >= 2; i--) {
    const sweepNode = recentSwings[i];

    // ==========================================
    // أ) نموذج الشراء الصاعد (Bullish Setup)
    // ==========================================
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
        let mssCandleIdx = -1;
        let highestAfterMSS = sweepNode.price;

        for (let cIdx = sweepNode.index + 1; cIdx < candles.length - 1; cIdx++) {
          if (candles[cIdx].high > highestAfterMSS) highestAfterMSS = candles[cIdx].high;
          if (mssCandleIdx === -1 && candles[cIdx].close > mssHigh.price) {
            mssCandleIdx = cIdx;
          }
        }

        // تحقق من حدوث الكسر في آخر 24 شمعة
        if (mssCandleIdx !== -1 && (candles.length - 1 - mssCandleIdx <= 24)) {
          const impulseLow = sweepNode.price;
          const impulseHigh = highestAfterMSS;
          const impulseRange = impulseHigh - impulseLow;
          if (impulseRange <= 0) continue;

          const equilibrium = impulseLow + impulseRange * 0.5;

          const fvgs = detectFVGs(candles, sweepNode.index, mssCandleIdx);
          const validFVG = fvgs.reverse().find((f) => {
            if (f.type !== 'BULLISH' || f.top > equilibrium) return false;
            let closed = false;
            for (let m = f.startIndex + 2; m < candles.length - 1; m++) {
              if (candles[m].low < f.bottom) closed = true;
            }
            return !closed;
          });

          if (validFVG) {
            // دخول مباشر عندما يكون السعر في منطقة الخصم وقريباً من الـ FVG
            if (currentPrice <= equilibrium && currentPrice >= validFVG.bottom * 0.998) {
              const entryPrice = parseFloat(validFVG.top.toFixed(asset.decimals));
              const stopLoss = parseFloat((impulseLow - asset.slBuffer).toFixed(asset.decimals));
              const risk = entryPrice - stopLoss;

              if (risk > 0) {
                const rawTp1 = parseFloat((entryPrice + risk * 1.5).toFixed(asset.decimals));
                const rawTp2 = parseFloat(mssHigh.price.toFixed(asset.decimals));
                const rawTp3 = parseFloat((entryPrice + risk * 3.0).toFixed(asset.decimals));

                const sortedTargets = [rawTp1, rawTp2, rawTp3].sort((a, b) => a - b);

                return {
                  opportunity: {
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
                    targets: { tp1: sortedTargets[0], tp2: sortedTargets[1], tp3: sortedTargets[2] },
                    riskRewardRatio: '1:3.0',
                    confluenceScore: 95,
                    fulfilledConditions: [
                      { title: 'Sell-Side Liquidity Sweep', description: `سحب سيولة القاع ${prevLow.price}` },
                      { title: 'True MSS Close', description: `كسر هيكل حقيقي فوق ${mssHigh.price}` },
                      { title: 'Discount FVG', description: `ارتداد من فجوة سعرية غير مستهلكة` },
                    ],
                    analysisReasons: {
                      entryReason: `شراء من منطقة خصم مثالية مع FVG.`,
                      stopLossReason: `وقف خسارة أسفل قاع السحب مع هامش أمان: ${stopLoss}`,
                      takeProfitReason: `TP1: ${sortedTargets[0]} | TP2: ${sortedTargets[1]}`
                    },
                  },
                  chartOptions: {
                    symbol: asset.symbol,
                    timeframe,
                    entry: entryPrice,
                    stopLoss,
                    tp1: sortedTargets[0],
                    tp2: sortedTargets[1],
                    tp3: sortedTargets[2],
                    fvgTop: validFVG.top,
                    fvgBottom: validFVG.bottom,
                  },
                };
              }
            }
          }
        }
      }
    }

    // ==========================================
    // ب) نموذج البيع الهابط (Bearish Setup)
    // ==========================================
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
        let mssCandleIdx = -1;
        let lowestAfterMSS = sweepNode.price;

        for (let cIdx = sweepNode.index + 1; cIdx < candles.length - 1; cIdx++) {
          if (candles[cIdx].low < lowestAfterMSS) lowestAfterMSS = candles[cIdx].low;
          if (mssCandleIdx === -1 && candles[cIdx].close < mssLow.price) {
            mssCandleIdx = cIdx;
          }
        }

        if (mssCandleIdx !== -1 && (candles.length - 1 - mssCandleIdx <= 24)) {
          const impulseHigh = sweepNode.price;
          const impulseLow = lowestAfterMSS;
          const impulseRange = impulseHigh - impulseLow;
          if (impulseRange <= 0) continue;

          const equilibrium = impulseLow + impulseRange * 0.5;

          const fvgs = detectFVGs(candles, sweepNode.index, mssCandleIdx);
          const validFVG = fvgs.reverse().find((f) => {
            if (f.type !== 'BEARISH' || f.bottom < equilibrium) return false;
            let closed = false;
            for (let m = f.startIndex + 2; m < candles.length - 1; m++) {
              if (candles[m].high > f.top) closed = true;
            }
            return !closed;
          });

          if (validFVG) {
            if (currentPrice >= equilibrium && currentPrice <= validFVG.top * 1.002) {
              const entryPrice = parseFloat(validFVG.bottom.toFixed(asset.decimals));
              const stopLoss = parseFloat((impulseHigh + asset.slBuffer).toFixed(asset.decimals));
              const risk = stopLoss - entryPrice;

              if (risk > 0) {
                const rawTp1 = parseFloat((entryPrice - risk * 1.5).toFixed(asset.decimals));
                const rawTp2 = parseFloat(mssLow.price.toFixed(asset.decimals));
                const rawTp3 = parseFloat((entryPrice - risk * 3.0).toFixed(asset.decimals));

                const sortedTargets = [rawTp1, rawTp2, rawTp3].sort((a, b) => b - a);

                return {
                  opportunity: {
                    symbol: asset.symbol,
                    type: 'SELL',
                    strategy: 'ICT Institutional Setup 🏛️',
                    timeframe,
                    currentPrice: parseFloat(currentPrice.toFixed(asset.decimals)),
                    entryZone: {
                      min: parseFloat(validFVG.bottom.toFixed(asset.decimals)),
                      max: parseFloat(validFVG.top.toFixed(asset.decimals)),
                    },
                    stopLoss,
                    targets: { tp1: sortedTargets[0], tp2: sortedTargets[1], tp3: sortedTargets[2] },
                    riskRewardRatio: '1:3.0',
                    confluenceScore: 95,
                    fulfilledConditions: [
                      { title: 'Buy-Side Liquidity Sweep', description: `سحب سيولة القمة ${prevHigh.price}` },
                      { title: 'True MSS Close', description: `كسر هيكل حقيقي أسفل ${mssLow.price}` },
                      { title: 'Premium FVG', description: `ارتداد من فجوة سعرية بيعية غير مستهلكة` },
                    ],
                    analysisReasons: {
                      entryReason: `بيع من منطقة غلاء مع FVG هابطة.`,
                      stopLossReason: `وقف خسارة أعلى قمة السحب مع هامش أمان: ${stopLoss}`,
                      takeProfitReason: `TP1: ${sortedTargets[0]} | TP2: ${sortedTargets[1]}`
                    },
                  },
                  chartOptions: {
                    symbol: asset.symbol,
                    timeframe,
                    entry: entryPrice,
                    stopLoss,
                    tp1: sortedTargets[0],
                    tp2: sortedTargets[1],
                    tp3: sortedTargets[2],
                    fvgTop: validFVG.top,
                    fvgBottom: validFVG.bottom,
                  },
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

// ==========================================================
// 4. تنفيذ الفحص والإرسال المباشر للقناة
// ==========================================================
export const runForexScan = async () => {
  console.log(`🌍 [Forex Scanner] بدء فحص العملات الرئيسية الـ 5 (15m, 1h)...`);

  const tasks: Array<{ asset: typeof TARGET_ASSETS[0]; tf: '15m' | '1h' }> = [];
  for (const asset of TARGET_ASSETS) {
    for (const tf of ['1h', '15m'] as const) {
      tasks.push({ asset, tf });
    }
  }

  let discoveredCount = 0;

  for (const { asset, tf } of tasks) {
    try {
      const candles = await fetchForexCandles(asset, tf, 100);
      if (candles.length < 50) continue;

      const result = analyzeForexICTSetup(candles, asset, tf);
      if (!result) continue;

      // كاش لمنع تكرار نفس الصفقة خلال 3 ساعات
      const cacheKey = `${asset.symbol}_${tf}_${result.opportunity.type}_${Math.floor(Date.now() / (3 * 60 * 60 * 1000))}`;
      if (sentForexCache.has(cacheKey)) continue;

      sentForexCache.set(cacheKey, Date.now());
      discoveredCount++;

      console.log(`🎯 [فرصة فوركس مؤكدة رُصدت]: ${asset.symbol} [${tf}] - ${result.opportunity.type}`);

      const chartBuffer = generateChartPngBuffer(candles as unknown as CandlePlotData[], result.chartOptions);

      await sendForexOpportunityToTelegram(result.opportunity, chartBuffer);
    } catch (err: any) {
      console.error(`⚠️ خطأ في معالجة الزوج ${asset.symbol} [${tf}]:`, err.message);
    }
  }

  console.log(`✨ [Forex Scanner] اكتمل فحص الفوركس: رُصدت وأُرسلت ${discoveredCount} فرصة.`);
};
