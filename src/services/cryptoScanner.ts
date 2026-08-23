import axios from 'axios';
import { Opportunity } from '../models/Opportunity';
import { sendOpportunityToTelegram } from './telegramBot';

export interface CandleData {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ==========================================================
// 1. جلب قائمة أفضل أزواج USDT النشطة
// ==========================================================
export const getActiveUSDTSpotPairs = async (): Promise<string[]> => {
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=spot', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });

    const blacklist = ['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'EURUSDT', 'DAIUSDT'];

    return res.data.result.list
      .filter((item: any) => item.symbol.endsWith('USDT') && !blacklist.includes(item.symbol))
      .sort((a: any, b: any) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
      .slice(0, 75)
      .map((item: any) => item.symbol);
  } catch (error) {
    console.error('⚠️ فشل جلب أزواج الكريبتو من Bybit:', (error as Error).message);
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT', 'DOGEUSDT'];
  }
};

// ==========================================================
// 2. جلب الشموع البيانية
// ==========================================================
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toBybitInterval = (interval: string): string => {
  if (interval === '15m') return '15';
  if (interval === '1h') return '60';
  if (interval === '4h') return '240';
  return interval;
};

const toOkxInterval = (interval: string): string => {
  if (interval === '15m') return '15m';
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

  if (!res.data.result?.list?.length) {
    throw new Error('Bybit data empty');
  }

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

  if (!res.data?.data?.length) {
    throw new Error('OKX data empty');
  }

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

const fetchCandles = async (symbol: string, interval = '60', limit = 100): Promise<CandleData[]> => {
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
// 3. أدوات تحديد القمم والقيعان (Swing Points)
// ==========================================================
interface SwingPoint {
  index: number;
  price: number;
}

const findSwingLows = (candles: CandleData[], leftRight = 2): SwingPoint[] => {
  const lows: SwingPoint[] = [];
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const left = candles.slice(i - leftRight, i);
    const right = candles.slice(i + 1, i + 1 + leftRight);
    if (left.every((c) => c.low >= candles[i].low) && right.every((c) => c.low >= candles[i].low)) {
      lows.push({ index: i, price: candles[i].low });
    }
  }
  return lows;
};

const findSwingHighs = (candles: CandleData[], leftRight = 2): SwingPoint[] => {
  const highs: SwingPoint[] = [];
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const left = candles.slice(i - leftRight, i);
    const right = candles.slice(i + 1, i + 1 + leftRight);
    if (left.every((c) => c.high <= candles[i].high) && right.every((c) => c.high <= candles[i].high)) {
      highs.push({ index: i, price: candles[i].high });
    }
  }
  return highs;
};

// ==========================================================
// 4. خوارزمية تحليل ICT المطورة والذكية
// ==========================================================
export const analyzeICTBullishSetup = (candles: CandleData[], symbol: string, timeframe: string) => {
  // تخفيف الشرط إلى 40 شمعة فقط لضمان فحص جميع الأزواج
  if (candles.length < 40) return null;

  const currentCandle = candles[candles.length - 1];
  const currentPrice = currentCandle.close;

  const swingLows = findSwingLows(candles, 2);
  const swingHighs = findSwingHighs(candles, 2);

  if (swingLows.length < 2 || swingHighs.length < 1) return null;

  const priorSwingLow = swingLows[swingLows.length - 2].price;
  const latestSwingLow = swingLows[swingLows.length - 1].price;
  const latestSwingHigh = swingHighs[swingHighs.length - 1].price;

  let confluenceScore = 0;
  const fulfilledConditions: Array<{ title: string; description: string }> = [];

  // 1. فحص منطقة الخصم (Discount Zone - 50% من النطاق الأخير)
  const rangeLow = Math.min(latestSwingLow, latestSwingHigh);
  const rangeHigh = Math.max(latestSwingLow, latestSwingHigh);
  const midpoint = (rangeLow + rangeHigh) / 2;
  const isDiscountZone = currentPrice <= midpoint * 1.01; // مع هامش مرونة 1%

  if (isDiscountZone) {
    confluenceScore += 25;
    fulfilledConditions.push({
      title: 'Discount Zone',
      description: `السعر داخل منطقة الخصم المؤسسية (تحت 50% من النطاق: $${rangeLow.toFixed(4)} - $${rangeHigh.toFixed(4)}).`,
    });
  }

  // 2. كشف سحب السيولة (SSL Sweep) خلال آخر 8 شموع
  const recentCandles = candles.slice(-8);
  const sweepCandle = recentCandles.find((c) => c.low < priorSwingLow && c.close > priorSwingLow * 0.998);
  if (sweepCandle) {
    confluenceScore += 25;
    fulfilledConditions.push({
      title: 'SSL Sweep',
      description: `تم سحب سيولة القاع الهيكلي $${priorSwingLow.toFixed(4)} مع رفض فوري وإغلاق أعلى منه.`,
    });
  }

  // 3. كشف كسر الهيكل الشرائي (Bullish MSS) خلال آخر 6 شموع
  const hasMSS = recentCandles.some((c) => c.close > latestSwingHigh);
  if (hasMSS || currentPrice > latestSwingHigh * 0.995) {
    confluenceScore += 25;
    fulfilledConditions.push({
      title: 'Bullish MSS',
      description: `تأكيد كسر هيكل السوق الصاعد واختراق القمة السابقة عند $${latestSwingHigh.toFixed(4)}.`,
    });
  }

  // 4. كشف الفجوة السعرية (Bullish FVG)
  for (let i = candles.length - 1; i >= candles.length - 5; i--) {
    if (i >= 2 && candles[i].low > candles[i - 2].high) {
      confluenceScore += 15;
      fulfilledConditions.push({
        title: 'Bullish FVG',
        description: `تشكل فجوة قيمة عادلة شرائية (Fair Value Gap) عند مستوى $${candles[i - 2].high.toFixed(4)}.`,
      });
      break;
    }
  }

  // قبول الصفقات التي تحقق سكور 65% فما فوق
  if (confluenceScore < 65) return null;

  const stopLoss = parseFloat((Math.min(priorSwingLow, latestSwingLow) * 0.992).toFixed(6));
  const risk = currentPrice - stopLoss;
  if (risk <= 0) return null;

  const tp1 = parseFloat((currentPrice + risk * 1.5).toFixed(6));
  const tp2 = parseFloat((currentPrice + risk * 2.5).toFixed(6));
  const tp3 = parseFloat((currentPrice + risk * 4.0).toFixed(6));

  confluenceScore += 10;
  fulfilledConditions.push({
    title: 'Risk-Reward Optimized',
    description: `عائد لمخاطرة مؤسسي يبدأ من 1:1.5 ويصل إلى 1:4.0.`,
  });

  const baseAsset = symbol.replace('USDT', '');

  return {
    symbol,
    baseAsset,
    market: 'crypto' as const,
    timeframe,
    type: 'SPOT_BUY' as const,
    currentPrice,
    entryZone: {
      min: parseFloat((currentPrice * 0.995).toFixed(6)),
      max: parseFloat((currentPrice * 1.005).toFixed(6)),
    },
    stopLoss,
    targets: { tp1, tp2, tp3 },
    riskRewardRatio: '1:2.5',
    confluenceScore: Math.min(confluenceScore, 98),
    fulfilledConditions,
    analysisReasons: {
      entryReason: `فرصة شراء ICT مكتملة الأركان على فريم [${timeframe}] داخل منطقة خصم بعد ارتداد هيكلي.`,
      stopLossReason: `تم تأمين الوقف أسفل القاع المحمي $${stopLoss}.`,
      takeProfitReason: `الأهداف موزعة هندسياً على امتدادات السيولة المتوقعة.`,
    },
    status: 'ACTIVE' as const,
  };
};

// ==========================================================
// 5. تشغيل المسح الدوري الشامل مع Logging تشخيصي
// ==========================================================
export const runFullCryptoScan = async () => {
  const targetTimeframes = ['1h', '4h'];
  console.log('🚀 [Crypto Scanner] بدء دورة الفحص الشامل للكريبتو (1h, 4h)...');

  let symbols: string[] = [];
  try {
    symbols = await getActiveUSDTSpotPairs();
    console.log(`🔍 تم جلب ${symbols.length} زوج للتداول بنجاح.`);
  } catch (error) {
    console.error('❌ فشل جلب قائمة الأزواج:', (error as Error).message);
    return;
  }

  let discoveredCount = 0;

  for (const symbol of symbols) {
    for (const tf of targetTimeframes) {
      try {
        const candles = await fetchCandles(symbol, tf, 100);
        if (candles.length < 40) continue;

        const opportunity = analyzeICTBullishSetup(candles, symbol, tf);

        if (opportunity) {
          const existing = await Opportunity.findOne({
            symbol,
            timeframe: tf,
            status: 'ACTIVE',
            createdAt: { $gte: new Date(Date.now() - 4 * 60 * 60 * 1000) },
          });

          if (!existing) {
            const createdOpp = await Opportunity.create(opportunity);
            discoveredCount++;
            console.log(`🎯 [فرصة رُصدت]: ${symbol} [${tf}] - Score: ${opportunity.confluenceScore}%`);

            sendOpportunityToTelegram(createdOpp).catch((err) => {
              console.error(`⚠️ خطأ إرسال التلغرام لـ ${symbol}:`, err.message);
            });
          }
        }
      } catch (error) {
        // تجاهل أخطاء الأزواج الفردية للاستمرار
      }
      await sleep(150);
    }
  }

  console.log(`✨ [Crypto Scanner] انتهى الفحص: تم رصد وإرسال ${discoveredCount} فرصة بنجاح.`);
};
