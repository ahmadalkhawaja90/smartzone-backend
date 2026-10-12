import axios from 'axios';
import { Opportunity } from '../models/Opportunity';
import { sendOpportunityToTelegram } from './telegramBot';
import { generateChartPngBuffer, CandlePlotData } from './chartGenerator';
import { placeLimitBuyOrder } from './binanceClient';

export interface CandleData {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ==========================================================
// 1. القائمة السوداء + قائمة أفضل 50 زوج USDT نشط
// ==========================================================
// 🛑 العملات المستبعدة رسميًا بسبب ضعف الأداء الفني وارتفاع الوقفات
const BLACKLIST_PAIRS = [
  'TIAUSDT', 'ATOMUSDT', 'FLOKIUSDT', 'AAVEUSDT', 'ICPUSDT', 
  'INJUSDT', 'BCHUSDT', 'LTCUSDT', 'XRPUSDT', 'OPUSDT', 
  'IMXUSDT', 'DYDXUSDT', 'CRVUSDT', 'ADAUSDT'
];

const CORE_TOP_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT',
  'SUIUSDT', 'DOGEUSDT', 'TONUSDT', 'APTUSDT', 'MATICUSDT',
  'LTCUSDT', 'BCHUSDT', 'ICPUSDT', 'FETUSDT', 'RENDERUSDT',
  'INJUSDT', 'TAOUSDT', 'PEPEUSDT', 'SHIBUSDT', 'OPUSDT',
  'ARBUSDT', 'ATOMUSDT', 'FILUSDT', 'WIFUSDT', 'KASUSDT',
  'STXUSDT', 'IMXUSDT', 'HBARUSDT', 'GRTUSDT', 'AAVEUSDT',
  'MKRUSDT', 'SEIUSDT', 'FLOKIUSDT', 'BONKUSDT', 'RUNEUSDT',
  'JUPUSDT', 'STRKUSDT', 'PENDLEUSDT', 'TIAUSDT', 'ENSUSDT',
  'GALAUSDT', 'CRVUSDT', 'DYDXUSDT', 'ORDIUSDT', 'ETHFIUSDT'
];

export const getActiveUSDTSpotPairs = async (): Promise<string[]> => {
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=spot', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });

    const stableBlacklist = ['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'EURUSDT', 'DAIUSDT', 'USDEUSDT'];

    const dynamicTop = res.data.result.list
      .filter((item: any) => item.symbol.endsWith('USDT') && !stableBlacklist.includes(item.symbol))
      .sort((a: any, b: any) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
      .slice(0, 50)
      .map((item: any) => item.symbol);

    const merged = Array.from(new Set([...CORE_TOP_PAIRS, ...dynamicTop])).slice(0, 50);
    // تصفية أزواج القائمة السوداء
    return merged.filter((sym) => !BLACKLIST_PAIRS.includes(sym));
  } catch (error) {
    return CORE_TOP_PAIRS.filter((sym) => !BLACKLIST_PAIRS.includes(sym));
  }
};

// ==========================================================
// 2. جلب الشموع البيانية (Bybit مع OKX كخيار احتياطي)
// ==========================================================
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchCandlesFromBybit = async (symbol: string, interval = '240', limit = 250): Promise<CandleData[]> => {
  const res = await axios.get('https://api.bybit.com/v5/market/kline', {
    params: { category: 'spot', symbol, interval, limit },
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

const fetchCandlesFromOkx = async (symbol: string, interval = '4H', limit = 250): Promise<CandleData[]> => {
  const okxSymbol = symbol.replace('USDT', '') + '-USDT';
  const res = await axios.get('https://www.okx.com/api/v5/market/candles', {
    params: { instId: okxSymbol, bar: interval, limit },
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

const fetchCandles = async (symbol: string, interval = '240', limit = 250): Promise<CandleData[]> => {
  try {
    return await fetchCandlesFromBybit(symbol, interval, limit);
  } catch {
    try {
      return await fetchCandlesFromOkx(symbol, '4H', limit);
    } catch {
      return [];
    }
  }
};

// ==========================================
// 3. الدوال الرياضية للمؤشرات الفنية (EMA & RSI)
// ==========================================
const calculateEMA = (candles: CandleData[], period: number): (number | null)[] => {
  const k = 2 / (period + 1);
  const ema: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period) return ema;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].close;
  ema[period - 1] = sum / period;

  for (let i = period; i < candles.length; i++) {
    const prevEma = ema[i - 1];
    if (prevEma !== null) {
      ema[i] = candles[i].close * k + prevEma * (1 - k);
    }
  }
  return ema;
};

const calculateRSI = (candles: CandleData[], period = 14): (number | null)[] => {
  const rsi: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return rsi;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      rsi[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsi[i] = 100 - (100 / (1 + rs));
    }
  }
  return rsi;
};

// ==========================================
// 4. خوارزمية فحص الارتداد (EMA 50 Pullback + RSI)
// ==========================================
export const analyzeEMAPullbackSetup = (candles: CandleData[], symbol: string, timeframe = '4h') => {
  if (candles.length < 210) return null;

  const idx = candles.length - 1;
  const c = candles[idx];
  const prevC = candles[idx - 1];

  const ema50Arr = calculateEMA(candles, 50);
  const ema200Arr = calculateEMA(candles, 200);
  const rsiArr = calculateRSI(candles, 14);

  const ema50 = ema50Arr[idx];
  const ema200 = ema200Arr[idx];
  const rsi = rsiArr[idx];
  const prevEma50 = ema50Arr[idx - 1];

  if (!ema50 || !ema200 || !rsi || !prevEma50) return null;

  // 1. شرط الاتجاه العام الصاعد: السعر و EMA 50 فوق EMA 200
  const isUptrend = c.close > ema200 && ema50 > ema200;
  if (!isUptrend) return null;

  // 2. ملامسة خط EMA 50
  const touchedEMA50 = (prevC.low <= prevEma50 * 1.01) || (c.low <= ema50 * 1.01);
  if (!touchedEMA50) return null;

  // 3. وصول RSI إلى تشبع بيعي مؤقت تحت 45 خلال آخر 3 شموع
  const rsiDip = rsiArr.slice(idx - 2, idx + 1).some((r) => r !== null && r <= 45);
  if (!rsiDip) return null;

  // 4. شمعة ارتدادية خضراء صريحة
  const isBullishReversal = c.close > c.open && c.close > prevC.close;
  if (!isBullishReversal) return null;

  const entryPrice = parseFloat(c.close.toFixed(6));
  const lowestLow = Math.min(c.low, prevC.low);
  const stopLoss = parseFloat((lowestLow * 0.995).toFixed(6));
  const risk = entryPrice - stopLoss;

  if (risk <= 0) return null;

  // فلترة مسافة الوقف المئوية (بين 1.5% و 6.5%)
  const riskPct = (risk / entryPrice) * 100;
  if (riskPct < 1.5 || riskPct > 6.5) return null;

  // توزيع الأهداف الثلاثة بشكل تصاعدي
  const tp1 = parseFloat((entryPrice + risk * 1.2).toFixed(6));
  const tp2 = parseFloat((entryPrice + risk * 2.0).toFixed(6));
  const tp3 = parseFloat((entryPrice + risk * 3.0).toFixed(6));
  const baseAsset = symbol.replace('USDT', '');

  return {
    opportunity: {
      symbol,
      baseAsset,
      market: 'crypto' as const,
      timeframe,
      type: 'SPOT_BUY' as const,
      currentPrice: entryPrice,
      entryZone: { min: parseFloat((entryPrice * 0.998).toFixed(6)), max: entryPrice },
      stopLoss,
      targets: { tp1, tp2, tp3 },
      riskRewardRatio: '1:2.0',
      confluenceScore: 95,
      fulfilledConditions: [
        { title: 'Macro Uptrend', description: `السعر أعلى من متوسط EMA 200` },
        { title: 'EMA 50 Pullback', description: `إعادة اختبار لدعم متوسط EMA 50` },
        { title: 'RSI Oversold Dip', description: `مؤشر القوة النسبية ارتد من تحت مستوى 45` },
        { title: 'Bullish Confirmation', description: `إغلاق شمعة ارتداد خضراء صريحة` },
      ],
      analysisReasons: {
        entryReason: `شراء عند ارتداد EMA 50 وتأكيد صاعد بسعر $${entryPrice}.`,
        stopLossReason: `وقف أسفل قاع الارتداد بنسبة ${riskPct.toFixed(2)}%: $${stopLoss}.`,
        takeProfitReason: `أهداف تصاعدية: TP1 (1.2R): $${tp1} | TP2 (2.0R): $${tp2} | TP3 (3.0R): $${tp3}.`
      },
      status: 'PENDING_ENTRY' as const,
    },
    chartOptions: {
      symbol,
      timeframe,
      entry: entryPrice,
      stopLoss,
      tp1,
      tp2,
      tp3,
    },
  };
};

// ==========================================
// 5. تشغيل المسح الدوري الشامل (فريم 4H)
// ==========================================
export const runFullCryptoScan = async () => {
  const targetTimeframes = ['4h'];
  console.log('🚀 [Crypto Scanner] بدء فحص استراتيجية الارتداد (EMA 50 Pullback + RSI 4H)...');

  // 🛡️ فحص اتجاه قائد السوق (BTC Trend Filter) أولاً قبل فحص أي عملة
  try {
    const btcCandles = await fetchCandles('BTCUSDT', '240', 250);
    if (btcCandles.length >= 50) {
      const btcEMA50Arr = calculateEMA(btcCandles, 50);
      const latestBtcPrice = btcCandles[btcCandles.length - 1].close;
      const latestBtcEma50 = btcEMA50Arr[btcEMA50Arr.length - 1];

      if (latestBtcEma50 && latestBtcPrice < latestBtcEma50) {
        console.warn(`🛑 [BTC Filter]: سعر البيتكوين ($${latestBtcPrice}) أسفل EMA 50 ($${latestBtcEma50.toFixed(2)}). تم تجميد فتح صفقات جديدة لحماية المحفظة.`);
        return;
      }
    }
  } catch (error) {
    console.error('⚠️ [BTC Filter] تعذر جلب شموع البيتكوين، سيتم الاستمرار بحذر.');
  }

  let symbols: string[] = [];
  try {
    symbols = await getActiveUSDTSpotPairs();
    console.log(`🔍 تم تثبيت ${symbols.length} زوج مؤهل للفحص (مستبعد منها القائمة السوداء).`);
  } catch (error) {
    return;
  }

  let discoveredCount = 0;

  for (const symbol of symbols) {
    for (const tf of targetTimeframes) {
      try {
        const candles = await fetchCandles(symbol, '240', 250);
        if (candles.length < 210) continue;

        const result = analyzeEMAPullbackSetup(candles, symbol, tf);

        if (result) {
          // 1. التحقق من عدم تكرار نفس العملة خلال 24 ساعة
          const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const existing = await Opportunity.findOne({
            symbol,
            $or: [
              { status: { $in: ['PENDING_ENTRY', 'ACTIVE', 'BREAK_EVEN', 'TP1_SECURED'] } },
              { createdAt: { $gte: twentyFourHoursAgo } }
            ]
          });

          if (existing) {
            continue;
          }

          // 🛑 2. فحص سقف الصفقات المتزامنة في المحفظة (الحد الأقصى 10 صفقات)
          const activeTradesCount = await Opportunity.countDocuments({
            status: { $in: ['PENDING_ENTRY', 'ACTIVE', 'BREAK_EVEN', 'TP1_SECURED'] }
          });

          if (activeTradesCount >= 10) {
            console.log(`⏸️ [سقف الصفقات]: تم رصد فرصة لـ ${symbol} ولكن تم تجاوزها لأن المحفظة ممتلئة بالكامل (${activeTradesCount}/10).`);
            continue; // لن يتم الشراء ولن يُرسل شيء للتلغرام
          }

          // ⚡ 3. تنفيذ الشراء الفعلي على منصة Binance أولاً
          const entryPrice = result.opportunity.entryZone.max;
          const orderResult = await placeLimitBuyOrder(symbol, entryPrice);

          // 🛑 4. التحقق الصارم من قبول الأمر على المنصة قبل المتابعة
          if (!orderResult.success || !orderResult.orderId) {
            console.warn(`⚠️ [فشل التنفيذ] لم يتم إرسال تنبيه ${symbol} للتلغرام لعدم نجاح أمر المنصة: ${orderResult.error}`);
            continue; // منع الحفظ ومنع التلغرام إذا لم يُنفذ في بينانس
          }

          const orderId = orderResult.orderId;
          console.log(`⚡ [Binance] تم تأكيد أمر الشراء لـ ${symbol} بسعر $${entryPrice} (Order ID: ${orderId})`);

          // 💾 5. الحفظ في قاعدة البيانات بالمعرف المؤكد
          const createdOpp = await Opportunity.create({
            ...result.opportunity,
            orderId,
          });

          discoveredCount++;
          console.log(`🎯 [صفقة مؤكدة ومفتوحة]: ${symbol} (${activeTradesCount + 1}/10)`);

          // 📲 6. توليد الشارت وإرسال الإشعار للتلغرام (للصفقة المنفذة فعلياً فقط)
          const chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], result.chartOptions);
          await sendOpportunityToTelegram(createdOpp, chartBuffer);
        }
      } catch (error) {
        // الاستمرار في الفحص في حال وجود أخطاء في زوج معين
      }
      await sleep(150);
    }
  }

  console.log(`✨ [Crypto Scanner] اكتمل فحص 4H: نُفذت وأُرسلت ${discoveredCount} صفقة حقيقية.`);
};
