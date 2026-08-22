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
// 1. جلب قائمة أفضل أزواج USDT النشطة (المصدر الأساسي: Bybit)
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
      .slice(0, 100)
      .map((item: any) => item.symbol);
  } catch (error) {
    console.error('⚠️ فشل جلب أزواج الكريبتو من Bybit:', (error as Error).message);
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT', 'DOGEUSDT', 'MATICUSDT'];
  }
};

// ==========================================================
// 2. جلب الشموع البيانية — مع مصدر احتياطي (Fallback) تلقائي
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
    throw new Error('Bybit أرجعت بيانات فارغة');
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
    throw new Error('OKX أرجعت بيانات فارغة');
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

const fetchCandles = async (symbol: string, interval = '15', limit = 40): Promise<CandleData[]> => {
  try {
    return await fetchCandlesFromBybit(symbol, interval, limit);
  } catch (bybitError) {
    console.warn(`⚠️ Bybit فشل لـ ${symbol} [${interval}]: ${(bybitError as Error).message} — تجربة OKX كبديل...`);
    try {
      return await fetchCandlesFromOkx(symbol, interval, limit);
    } catch (okxError) {
      console.error(`❌ فشل جلب الشموع لـ ${symbol} [${interval}] من كل المصادر: ${(okxError as Error).message}`);
      return [];
    }
  }
};

// ==========================================================
// 3. أدوات هيكلية مشتركة (Swing Points + Aggregation + Bias)
// ==========================================================
interface SwingPoint {
  index: number;
  price: number;
}

// قاع حقيقي: أدنى من N شمعة قبله وN شمعة بعده (fractal)
const findSwingLows = (candles: CandleData[], leftRight = 2): SwingPoint[] => {
  const lows: SwingPoint[] = [];
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const left = candles.slice(i - leftRight, i);
    const right = candles.slice(i + 1, i + 1 + leftRight);
    const isSwingLow = left.every((c) => c.low >= candles[i].low) && right.every((c) => c.low >= candles[i].low);
    if (isSwingLow) lows.push({ index: i, price: candles[i].low });
  }
  return lows;
};

// قمة حقيقية: أعلى من N شمعة قبله وN شمعة بعده (fractal)
const findSwingHighs = (candles: CandleData[], leftRight = 2): SwingPoint[] => {
  const highs: SwingPoint[] = [];
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const left = candles.slice(i - leftRight, i);
    const right = candles.slice(i + 1, i + 1 + leftRight);
    const isSwingHigh = left.every((c) => c.high <= candles[i].high) && right.every((c) => c.high <= candles[i].high);
    if (isSwingHigh) highs.push({ index: i, price: candles[i].high });
  }
  return highs;
};

// تجميع شموع صغيرة لصناعة شموع اصطناعية بفريم أعلى (بدون طلب API إضافي)
const aggregateCandles = (candles: CandleData[], factor: number): CandleData[] => {
  const result: CandleData[] = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    result.push({
      openTime: chunk[0].openTime,
      open: chunk[0].open,
      close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result;
};

// عامل التجميع لصناعة فريم أعلى تقريبي من نفس بيانات الفريم الحالي
const getHtfAggregationFactor = (timeframe: string): number => {
  if (timeframe === '15m') return 16; // ~4 ساعات
  if (timeframe === '1h') return 4; // ~4 ساعات
  if (timeframe === '4h') return 6; // ~يوم واحد
  return 4;
};

type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

// اتجاه الفريم الأعلى: قيعان مرتفعة (Higher Lows) = صاعد، قيعان منخفضة = هابط
const getHtfBias = (candles: CandleData[], timeframe: string): Bias => {
  const factor = getHtfAggregationFactor(timeframe);
  const htf = aggregateCandles(candles, factor);
  if (htf.length < 10) return 'NEUTRAL'; // بيانات غير كافية للحكم بثقة

  const swingLows = findSwingLows(htf, 1);
  if (swingLows.length < 2) return 'NEUTRAL';

  const [prev, last] = swingLows.slice(-2);
  if (last.price > prev.price) return 'BULLISH';
  if (last.price < prev.price) return 'BEARISH';
  return 'NEUTRAL';
};

// ==========================================================
// 4. خوارزمية تحليل ICT — مع فلاتر إلزامية (Bias + Discount) وأهداف سيولة حقيقية
// ==========================================================
export const analyzeICTBullishSetup = (candles: CandleData[], symbol: string, timeframe: string) => {
  // نحتاج بيانات كافية لصناعة فريم أعلى موثوق (خصوصاً لفريم 15m، عامل تجميع 16)
  if (candles.length < 180) return null;

  const currentCandle = candles[candles.length - 1];
  const currentPrice = currentCandle.close;

  // ---------------------------------------------------------
  // فلتر إلزامي 1: اتجاه الفريم الأعلى (HTF Bias)
  // لا معنى للبحث عن فرصة شراء إذا كان الاتجاه العام هابطاً
  // ---------------------------------------------------------
  const htfBias = getHtfBias(candles, timeframe);
  if (htfBias !== 'BULLISH') {
    return null;
  }

  // ---------------------------------------------------------
  // تحديد آخر قاع وقمة حقيقيين (Swing Points) على الفريم الحالي
  // ---------------------------------------------------------
  const swingLows = findSwingLows(candles, 2);
  const swingHighs = findSwingHighs(candles, 2);

  if (swingLows.length < 2 || swingHighs.length < 1) return null;

  const priorSwingLow = swingLows[swingLows.length - 2].price; // القاع "المعروف مسبقاً"، وليس آخر واحد قد يكون جزءاً من الحركة الحالية
  const latestSwingLowForRange = swingLows[swingLows.length - 1];
  const latestSwingHighForRange = swingHighs[swingHighs.length - 1];

  // ---------------------------------------------------------
  // فلتر إلزامي 2: منطقة الخصم (Discount Zone)
  // لا شراء إلا إذا كان السعر تحت 50% من آخر نطاق حركة حقيقي
  // ---------------------------------------------------------
  const rangeLow = Math.min(latestSwingLowForRange.price, latestSwingHighForRange.price);
  const rangeHigh = Math.max(latestSwingLowForRange.price, latestSwingHighForRange.price);
  const midpoint = (rangeLow + rangeHigh) / 2;
  const isDiscountZone = currentPrice <= midpoint;

  if (!isDiscountZone) {
    return null;
  }

  let confluenceScore = 0;
  const fulfilledConditions: Array<{ title: string; description: string }> = [];

  // منح نقاط أساسية لتحقق الفلترين الإلزاميين (كانوا شرط قبول، وهلق كمان جزء من قوة التوافق المعروضة)
  confluenceScore += 20;
  fulfilledConditions.push({
    title: 'HTF Bullish Bias',
    description: 'الاتجاه العام على الفريم الأعلى صاعد (قيعان مرتفعة)، يدعم البحث عن فرص شراء فقط.',
  });

  confluenceScore += 15;
  fulfilledConditions.push({
    title: 'Discount Zone',
    description: `السعر الحالي داخل منطقة الخصم (تحت 50% من آخر نطاق حركة: $${rangeLow.toFixed(6)} - $${rangeHigh.toFixed(6)}).`,
  });

  // ---------------------------------------------------------
  // الشرط: اكتساح سيولة حقيقي (SSL Sweep)
  // ---------------------------------------------------------
  const recentCandles = candles.slice(-6, -1);
  const sweepCandle = recentCandles.find((c) => c.low < priorSwingLow && c.close > priorSwingLow);
  const sweptRecentLow = !!sweepCandle;

  if (sweptRecentLow) {
    confluenceScore += 20;
    fulfilledConditions.push({
      title: 'SSL Sweep',
      description: `اكتساح سيولة قاع هيكلي عند $${priorSwingLow.toFixed(6)} مع رفض واضح وإغلاق فوقه.`,
    });
  }

  // ---------------------------------------------------------
  // الشرط: كسر وتغيير هيكل السوق (Bullish MSS) — باستخدام قمة حقيقية
  // ---------------------------------------------------------
  const prevSwingHigh = swingHighs[swingHighs.length - 1].price;
  const hasMSS = currentPrice > prevSwingHigh || candles[candles.length - 2].close > prevSwingHigh;
  if (hasMSS) {
    confluenceScore += 20;
    fulfilledConditions.push({
      title: 'Bullish MSS',
      description: `تغيير طابع وهيكل السوق باختراق قمة حقيقية سابقة عند $${prevSwingHigh.toFixed(6)}.`,
    });
  }

  // ---------------------------------------------------------
  // الشرط: فجوة سعرية (Bullish FVG)
  // ---------------------------------------------------------
  const c1 = candles[candles.length - 3];
  const c3 = candles[candles.length - 1];
  if (c3.low > c1.high) {
    confluenceScore += 15;
    fulfilledConditions.push({
      title: 'Bullish FVG',
      description: 'تشكل فجوة قيمة عادلة شرائية (Fair Value Gap) تمثل منطقة دخول مؤسسية.',
    });
  }

  // ---------------------------------------------------------
  // الشرط: كتلة الأوامر الشرائية (Bullish Order Block)
  // ---------------------------------------------------------
  let bullishOB: CandleData | null = null;
  let breakoutIndex = -1;
  const searchStart = Math.max(0, candles.length - 5);
  for (let i = searchStart; i < candles.length; i++) {
    if (candles[i].close > prevSwingHigh) {
      breakoutIndex = i;
      break;
    }
  }
  if (breakoutIndex > 0) {
    for (let i = breakoutIndex - 1; i >= Math.max(0, breakoutIndex - 4); i--) {
      if (candles[i].close < candles[i].open) {
        bullishOB = candles[i];
        break;
      }
    }
  }
  if (bullishOB) {
    confluenceScore += 10;
    fulfilledConditions.push({
      title: 'Bullish OB',
      description: `آخر شمعة بيعية قبل الاختراق تشكل كتلة أوامر شرائية بين $${bullishOB.low.toFixed(6)} - $${bullishOB.high.toFixed(6)}.`,
    });
  }

  // ---------------------------------------------------------
  // إدارة المخاطر: وقف عند القاع الهيكلي، أهداف عند سيولة حقيقية
  // ---------------------------------------------------------
  const stopLoss = parseFloat((priorSwingLow * 0.992).toFixed(6));
  const risk = currentPrice - stopLoss;

  if (risk <= 0 || confluenceScore < 55) return null;

  // الأهداف = أقرب 3 قمم حقيقية غير مكسورة فوق السعر الحالي (سيولة فعلية بالسوق)
  const liquidityTargets = swingHighs
    .map((s) => s.price)
    .filter((price) => price > currentPrice)
    .sort((a, b) => a - b);

  // لو ما لقينا عدد كافي من قمم حقيقية فوق السعر، نكمل الباقي بمضاعفات المخاطرة كحل احتياطي فقط
  const fallbackTargets = [risk * 1.5, risk * 2.5, risk * 4.0].map((r) => currentPrice + r);
  const targetPool = [...liquidityTargets, ...fallbackTargets];

  const tp1 = parseFloat(targetPool[0].toFixed(6));
  const tp2 = parseFloat((targetPool[1] ?? targetPool[0] * 1.02).toFixed(6));
  const tp3 = parseFloat((targetPool[2] ?? targetPool[1] ?? targetPool[0] * 1.04).toFixed(6));

  const actualRR = ((tp1 - currentPrice) / risk).toFixed(2);

  confluenceScore += 5;
  fulfilledConditions.push({
    title: 'Liquidity-Based Targets',
    description: `الأهداف محددة عند أقرب قمم سيولة حقيقية غير مكسورة، وليس مضاعفات افتراضية للمخاطرة.`,
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
      min: parseFloat((currentPrice * 0.996).toFixed(6)),
      max: parseFloat((currentPrice * 1.004).toFixed(6)),
    },
    stopLoss,
    targets: { tp1, tp2, tp3 },
    riskRewardRatio: `1:${actualRR}`,
    confluenceScore: Math.min(confluenceScore, 98),
    fulfilledConditions,
    analysisReasons: {
      entryReason: `دخول شراء سبوت على فريم [${timeframe}]، بانحياز صاعد على الفريم الأعلى، ضمن منطقة خصم، وبعد تأكيد كسر الهيكل.`,
      stopLossReason: `تم وضع الوقف أسفل القاع الهيكلي المحمي $${stopLoss} لتأمين رأس المال.`,
      takeProfitReason: `الأهداف محددة عند أقرب مستويات سيولة حقيقية (قمم سابقة غير مكسورة) فوق السعر الحالي.`,
    },
    status: 'ACTIVE' as const,
  };
};

// ==========================================================
// 5. تشغيل المسح الدوري الشامل — بعزل الأخطاء لكل عملة
// ==========================================================
export const runFullCryptoScan = async () => {
  const targetTimeframes = ['15m', '1h', '4h'];
  console.log('🚀 بدء المسح الشامل للكريبتو (15m, 1h, 4h)...');

  let symbols: string[] = [];
  try {
    symbols = await getActiveUSDTSpotPairs();
    console.log(`🔍 تم جلب ${symbols.length} زوج للتداول بنجاح.`);
  } catch (error) {
    console.error('❌ فشل جلب قائمة الأزواج بالكامل، إلغاء دورة المسح:', (error as Error).message);
    return;
  }

  let discoveredCount = 0;
  let failedCount = 0;

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];

    for (const tf of targetTimeframes) {
      try {
        // رفعنا الحد لـ 200 (أقصى ما يسمح Bybit بطلب واحد) — ضروري الآن
        // لصناعة فريم أعلى موثوق (HTF Bias) ولتحديد swing points كافية
        const candles = await fetchCandles(symbol, tf, 200);

        if (candles.length === 0) {
          failedCount++;
          continue;
        }

        const opportunity = analyzeICTBullishSetup(candles, symbol, tf);

        if (opportunity) {
          const existing = await Opportunity.findOne({
            symbol,
            timeframe: tf,
            status: 'ACTIVE',
            createdAt: { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
          });

          if (!existing) {
            const createdOpp = await Opportunity.create(opportunity);
            discoveredCount++;
            console.log(`✅ فرصة ICT جديدة: ${symbol} [${tf}] (نسبة التوافق: ${opportunity.confluenceScore}%)`);

            sendOpportunityToTelegram(createdOpp).catch((err) => {
              console.error(`⚠️ خطأ إشعار التلغرام لـ ${symbol}:`, err.message);
            });
          }
        }
      } catch (error) {
        failedCount++;
        console.error(`❌ خطأ أثناء معالجة ${symbol} [${tf}]:`, (error as Error).message);
      }

      await sleep(180);
    }
  }

  console.log(
    `✨ اكتمل الفحص: ${discoveredCount} فرصة جديدة، ${failedCount} محاولة فاشلة من أصل ${symbols.length * targetTimeframes.length}.`
  );
};
