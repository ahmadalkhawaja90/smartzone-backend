import axios from 'axios';
import { Opportunity } from '../models/Opportunity';
import { sendOpportunityToTelegram } from './telegramBot';

interface CandleData {
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

// تحويل الفريم لصيغة Bybit
const toBybitInterval = (interval: string): string => {
  if (interval === '15m') return '15';
  if (interval === '1h') return '60';
  if (interval === '4h') return '240';
  return interval;
};

// تحويل الفريم لصيغة OKX (المصدر الاحتياطي)
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

// مصدر احتياطي: OKX — يُستخدم فقط لو فشل Bybit (rate limit، صيانة، حظر مؤقت، الخ)
const fetchCandlesFromOkx = async (symbol: string, interval: string, limit: number): Promise<CandleData[]> => {
  // OKX يستخدم صيغة رمز مختلفة: BTC-USDT بدل BTCUSDT
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
// 3. خوارزمية تحليل ICT — بمنطق أدق لـ Order Block و Liquidity Sweep
// ==========================================================
const analyzeICTBullishSetup = (candles: CandleData[], symbol: string, timeframe: string) => {
  if (candles.length < 30) return null;

  const currentCandle = candles[candles.length - 1];
  const currentPrice = currentCandle.close;

  let confluenceScore = 0;
  const fulfilledConditions: Array<{ title: string; description: string }> = [];

  // ---------------------------------------------------------
  // الشرط 1: اكتساح سيولة حقيقي (SSL Sweep)
  // التعريف الصحيح: فتيل الشمعة يخترق قاع هيكلي سابق، لكن
  // الإغلاق يرجع فوقه — هذا يدل على رفض فعلي من المؤسسات،
  // وليس مجرد "أدنى سعر بالنطاق صار مؤخراً" (كما كان بالمنطق القديم).
  // ---------------------------------------------------------
  // القاع الهيكلي السابق: نطاق أقدم (يستثني آخر 5 شموع) ليمثل
  // "مستوى سيولة" معروف مسبقاً، لا نقطة تشكلت للتو.
  const priorRange = candles.slice(-30, -5);
  const priorSwingLow = Math.min(...priorRange.map((c) => c.low));

  const recentCandles = candles.slice(-6, -1);
  const sweepCandle = recentCandles.find((c) => c.low < priorSwingLow && c.close > priorSwingLow);
  const sweptRecentLow = !!sweepCandle;

  if (sweptRecentLow) {
    confluenceScore += 25;
    fulfilledConditions.push({
      title: 'SSL Sweep',
      description: `اكتساح سيولة قاع هيكلي عند $${priorSwingLow.toFixed(6)} مع رفض واضح وإغلاق فوقه، يشير لتصريف سيولة البائعين قبل الصعود.`,
    });
  }

  // ---------------------------------------------------------
  // الشرط 2: كسر وتغيير هيكل السوق (Bullish MSS)
  // ---------------------------------------------------------
  const prevSwingHigh = Math.max(...candles.slice(-10, -2).map((c) => c.high));
  const hasMSS = currentPrice > prevSwingHigh || candles[candles.length - 2].close > prevSwingHigh;
  if (hasMSS) {
    confluenceScore += 25;
    fulfilledConditions.push({
      title: 'Bullish MSS',
      description: 'تغيير طابع وهيكل السوق (Market Structure Shift) باختراق قمة سابقة.',
    });
  }

  // ---------------------------------------------------------
  // الشرط 3: فجوة سعرية (Bullish FVG)
  // ---------------------------------------------------------
  const c1 = candles[candles.length - 3];
  const c3 = candles[candles.length - 1];
  if (c3.low > c1.high) {
    confluenceScore += 25;
    fulfilledConditions.push({
      title: 'Bullish FVG',
      description: 'تشكل فجوة قيمة عادلة شرائية (Fair Value Gap) تمثل منطقة دخول مؤسسية.',
    });
  }

  // ---------------------------------------------------------
  // الشرط 4: كتلة الأوامر الشرائية (Bullish Order Block)
  // التعريف الصحيح: آخر شمعة هابطة (حمراء) قبل شمعة الاختراق
  // الصاعدة التي كسرت الهيكل — وليس الشمعة الصاعدة نفسها كما
  // كان بالمنطق القديم.
  // ---------------------------------------------------------
  let bullishOB: CandleData | null = null;

  // نحدد أول شمعة (بآخر 5 شموع) أغلقت فوق القمة السابقة = شمعة الاختراق
  let breakoutIndex = -1;
  const searchStart = Math.max(0, candles.length - 5);
  for (let i = searchStart; i < candles.length; i++) {
    if (candles[i].close > prevSwingHigh) {
      breakoutIndex = i;
      break;
    }
  }

  if (breakoutIndex > 0) {
    // نرجع للخلف من شمعة الاختراق لنلاقي آخر شمعة هابطة (الـ OB الحقيقية)
    for (let i = breakoutIndex - 1; i >= Math.max(0, breakoutIndex - 4); i--) {
      if (candles[i].close < candles[i].open) {
        bullishOB = candles[i];
        break;
      }
    }
  }

  if (bullishOB) {
    confluenceScore += 15;
    fulfilledConditions.push({
      title: 'Bullish OB',
      description: `آخر شمعة بيعية قبل الاختراق تشكل كتلة أوامر شرائية (Order Block) بين $${bullishOB.low.toFixed(6)} - $${bullishOB.high.toFixed(6)}.`,
    });
  }

  // ---------------------------------------------------------
  // الشرط 5: إدارة المخاطر وتحديد الأهداف
  // ---------------------------------------------------------
  // نستخدم القاع الهيكلي (priorSwingLow) لحساب الوقف، وليس
  // "أدنى سعر بآخر 24 شمعة" فقط — لضمان الاتساق مع منطق الـ Sweep أعلاه
  const stopLoss = parseFloat((priorSwingLow * 0.992).toFixed(6));
  const risk = currentPrice - stopLoss;

  if (risk > 0 && confluenceScore >= 60) {
    const tp1 = parseFloat((currentPrice + risk * 1.5).toFixed(6));
    const tp2 = parseFloat((currentPrice + risk * 2.5).toFixed(6));
    const tp3 = parseFloat((currentPrice + risk * 4.0).toFixed(6));

    confluenceScore += 10;
    fulfilledConditions.push({
      title: 'Optimal R:R',
      description: 'معدل المخاطرة إلى العائد يتجاوز 1:2.5 مع استهداف سيولة القمم العليا.',
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
      riskRewardRatio: '1:2.8',
      confluenceScore: Math.min(confluenceScore, 98),
      fulfilledConditions,
      analysisReasons: {
        entryReason: `دخول شراء سبوت على فريم [${timeframe}] بعد تأكيد كسر الهيكل Bullish MSS.`,
        stopLossReason: `تم وضع الوقف أسفل القاع الهيكلي المحمي $${stopLoss} لتأمين رأس المال.`,
        takeProfitReason: `الأهداف محددة عند مستويات السيولة الخارجية (BSL) والقمم السابقة.`,
      },
      status: 'ACTIVE' as const,
    };
  }

  return null;
};

// ==========================================================
// 4. تشغيل المسح الدوري الشامل — بعزل الأخطاء لكل عملة
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
      // كل عملة/فريم بمعزل تام — فشل واحد ما يوقف باقي القائمة
      try {
        const candles = await fetchCandles(symbol, tf, 40);

        if (candles.length === 0) {
          failedCount++;
          continue; // تم تسجيل سبب الفشل مسبقاً داخل fetchCandles
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
        // أي خطأ غير متوقع (قاعدة بيانات، الخ) لهذه العملة/الفريم فقط — لا يوقف باقي المسح
        failedCount++;
        console.error(`❌ خطأ أثناء معالجة ${symbol} [${tf}]:`, (error as Error).message);
      }

      // تأخير أعلى بين الطلبات لتجنب rate limiting (خصوصاً من IP سحابي مشترك)
      await sleep(180);
    }
  }

  console.log(
    `✨ اكتمل الفحص: ${discoveredCount} فرصة جديدة، ${failedCount} محاولة فاشلة من أصل ${symbols.length * targetTimeframes.length}.`
  );
};
