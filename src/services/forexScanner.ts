import axios from 'axios';
import { Opportunity } from '../models/Opportunity';
import { sendForexOpportunityToTelegram } from './telegramForex';
import { generateChartPngBuffer } from './chartRenderer';

const TARGET_ASSETS = [
  { symbol: 'EUR/USD', yahooTicker: 'EURUSD=X', decimals: 5, slBuffer: 0.0008 },
  { symbol: 'GBP/USD', yahooTicker: 'GBPUSD=X', decimals: 5, slBuffer: 0.0009 },
  { symbol: 'USD/JPY', yahooTicker: 'USDJPY=X', decimals: 3, slBuffer: 0.15 },
  { symbol: 'AUD/USD', yahooTicker: 'AUDUSD=X', decimals: 5, slBuffer: 0.0008 },
  { symbol: 'GBP/JPY', yahooTicker: 'GBPJPY=X', decimals: 3, slBuffer: 0.18 },
];

interface CandleData {
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

// جلب بيانات فريم الساعة الحية من Yahoo Finance
const fetchHistoricalCandles = async (asset: typeof TARGET_ASSETS[0]): Promise<CandleData[]> => {
  try {
    const res = await axios.get(`https://query2.finance.yahoo.com/v8/finance/chart/${asset.yahooTicker}?interval=60m&range=5d`, {
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
      return candles;
    }
  } catch (err: any) {
    console.warn(`⚠️ تعذر جلب بيانات ${asset.symbol}:`, err.message);
  }
  return [];
};

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

const analyzeForexICTSetup = (candles: CandleData[], asset: typeof TARGET_ASSETS[0]) => {
  if (!candles || candles.length < 50) return null;

  const currentPrice = candles[candles.length - 1].close;
  const swings = findSwings(candles, 3);
  if (swings.length < 5) return null;

  const sCurrent = swings[swings.length - 1];
  const sPrev = swings[swings.length - 2];
  const sPrior = swings[swings.length - 3];

  // 1. فرصة شراء (BUY)
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

    const entryPrice = validFVG.top;
    
    // فلتر منع التأخير: التأكد أن السعر الحالي لم يبتعد كثيرًا عن منطقة الدخول
    if (currentPrice > entryPrice * 1.003) return null;

    const stopLoss = parseFloat((impulseLow - asset.slBuffer).toFixed(asset.decimals));
    const risk = entryPrice - stopLoss;
    if (risk <= 0) return null;

    const tp1 = parseFloat((entryPrice + risk * 1.5).toFixed(asset.decimals));
    const tp2 = parseFloat((entryPrice + risk * 3.0).toFixed(asset.decimals));

    return {
      type: 'BUY' as const,
      entryZone: { min: validFVG.bottom, max: validFVG.top },
      stopLoss,
      targets: { tp1, tp2, tp3: parseFloat((entryPrice + risk * 4.0).toFixed(asset.decimals)) },
      riskRewardRatio: '1:3.0',
      score: 95
    };
  }

  // 2. فرصة بيع (SELL)
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

    const entryPrice = validFVG.bottom;

    // فلتر منع التأخير
    if (currentPrice < entryPrice * 0.997) return null;

    const stopLoss = parseFloat((impulseHigh + asset.slBuffer).toFixed(asset.decimals));
    const risk = stopLoss - entryPrice;
    if (risk <= 0) return null;

    const tp1 = parseFloat((entryPrice - risk * 1.5).toFixed(asset.decimals));
    const tp2 = parseFloat((entryPrice - risk * 3.0).toFixed(asset.decimals));

    return {
      type: 'SELL' as const,
      entryZone: { min: validFVG.bottom, max: validFVG.top },
      stopLoss,
      targets: { tp1, tp2, tp3: parseFloat((entryPrice - risk * 4.0).toFixed(asset.decimals)) },
      riskRewardRatio: '1:3.0',
      score: 95
    };
  }

  return null;
};

// الدالة الرئيسية التي يتم جدولتها للعمل بشكل آلي
export const executeForexScan = async () => {
  console.log('🌍 [Forex Live Scanner] بدأ فحص أزواج العملات الحية...');
  let detectedCount = 0;

  for (const asset of TARGET_ASSETS) {
    try {
      const candles = await fetchHistoricalCandles(asset);
      if (candles.length < 50) continue;

      const setup = analyzeForexICTSetup(candles, asset);

      if (setup) {
        // منع تكرار نفس الصفقة خلال آخر 12 ساعة
        const existing = await Opportunity.findOne({
          symbol: asset.symbol,
          market: 'forex',
          status: 'active',
          createdAt: { $gte: new Date(Date.now() - 12 * 60 * 60 * 1000) }
        });

        if (existing) continue;

        const oppData = {
          symbol: asset.symbol,
          market: 'forex',
          timeframe: '1h',
          type: setup.type,
          entryZone: setup.entryZone,
          stopLoss: setup.stopLoss,
          targets: setup.targets,
          riskRewardRatio: setup.riskRewardRatio,
          score: setup.score,
          status: 'active',
          createdAt: new Date()
        };

        const savedOpp = await Opportunity.create(oppData);

        // توليد شارت الصفقة
        let chartBuffer: Buffer | undefined;
        try {
          chartBuffer = await generateChartPngBuffer({
            symbol: asset.symbol,
            timeframe: '1h',
            candles,
            entryZone: setup.entryZone,
            stopLoss: setup.stopLoss,
            targets: setup.targets,
            fvgZone: setup.entryZone,
            sweepPrice: setup.stopLoss
          });
        } catch (chartErr: any) {
          console.warn(`⚠️ تعذر توليد الشارت لـ ${asset.symbol}:`, chartErr.message);
        }

        // إرسال التنبيه الفوري لقناة الفوركس التابعة لك
        await sendForexOpportunityToTelegram(savedOpp, chartBuffer);
        detectedCount++;
      }

      await new Promise((r) => setTimeout(r, 300));
    } catch (err: any) {
      console.error(`❌ خطأ أثناء فحص ${asset.symbol}:`, err.message);
    }
  }

  console.log(`✨ [Forex Live Scanner] انتهت دورة الفحص. رُصدت ${detectedCount} فرصة جديدة.`);
};
