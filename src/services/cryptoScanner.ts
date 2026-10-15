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
// 4. خوارزمية فحص الارتداد المفلترة بدقة
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
  const prevRsi = rsiArr[idx - 1];
  const prevEma50 = ema50Arr[idx - 1];

  if (!ema50 || !ema200 || !rsi || !prevRsi || !prevEma50) return null;

  // 1. شرط الاتجاه العام الصاعد: السعر و EMA 50 كلاهما فوق EMA 200
  const isUptrend = c.close > ema200 && ema50 > ema200;
  if (!isUptrend) return null;

  // 2. ملامسة واختبار دعم EMA 50
  const touchedEMA50 = (prevC.low <= prevEma50 * 1.01) || (c.low <= ema50 * 1.01);
  if (!touchedEMA50) return null;

  // 3. فلترة RSI المحسنة: كان هناك تصحيح حديث لكن الـ RSI ينعطف صعوداً الآن
  const recentDip = rsiArr.slice(idx - 3, idx + 1).some((r) => r !== null && r <= 48);
  const rsiReversingUp = rsi > prevRsi && rsi >= 42;
  if (!recentDip || !rsiReversingUp) return null;

  // 4. شمعة تأكيد قوية (Bullish Engulfing / Strong Reversal) لمنع مصائد الثيران
  const isGreen = c.close > c.open;
  const higherClose = c.close > prevC.close;
  
  // ابتلاع ما لا يقل عن 60% من الشمعة الهابطة السابقة
  const prevCandleBody = Math.abs(prevC.close - prevC.open);
  const currentCandleBody = c.close - c.open;
  const hasStrongBody = currentCandleBody >= prevCandleBody * 0.6;

  // التأكد من عدم وجود ذيل علوي طويل (رفض بيعي)
  const candleRange = c.high - c.low;
  const upperWick = c.high - c.close;
  const noHeavyRejection = candleRange > 0 ? (upperWick / candleRange) <= 0.35 : true;

  if (!isGreen || !higherClose || !hasStrongBody || !noHeavyRejection) return null;

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
        { title: 'EMA 50 Support', description: `اختبار ارتدادي ناجح لمتوسط EMA 50` },
        { title: 'RSI Reversal Momentum', description: `انعطاف مؤشر القوة النسبية صعوداً مع تأكيد المشترين` },
        { title: 'Bullish Engulfing Confirmation', description: `إغلاق شمعة ارتداد قوية بدون ذيل رفض علوي` },
      ],
      analysisReasons: {
        entryReason: `شراء ارتداد قوي ومؤكد لـ EMA 50 بسعر $${entryPrice}.`,
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
// 5. تشغيل المسح الدوري الشامل
// ==========================================
export const runFullCryptoScan = async () => {
  const targetTimeframes = ['4h'];
  console.log('🚀 [Crypto Scanner] بدء فحص استراتيجية الارتداد المفلترة (4H)...');

  // 🛡️ فحص صارم لقائد السوق (BTC Trend & Momentum Filter)
  try {
    const btcCandles = await fetchCandles('BTCUSDT', '240', 250);
    if (btcCandles.length >= 50) {
      const btcEMA50Arr = calculateEMA(btcCandles, 50);
      const btcRsiArr = calculateRSI(btcCandles, 14);

      const btcIdx = btcCandles.length - 1;
      const btcPrice = btcCandles[btcIdx].close;
      const prevBtcPrice = btcCandles[btcIdx - 1].close;
      const btcEma50 = btcEMA50Arr[btcIdx];
      const prevBtcEma50 = btcEMA50Arr[btcIdx - 1];
      const btcRsi = btcRsiArr[btcIdx];

      // شرطان حاسمان للبيتكوين:
      // 1. ثبات السعر لآخر شمعتين فوق EMA 50 لمنع الاختراقات الكاذبة
      const btcAboveEma = btcEma50 && prevBtcEma50 && (btcPrice > btcEma50) && (prevBtcPrice > prevBtcEma50);
      
      // 2. زخم البيتكوين إيجابي (RSI >= 50)
      const btcHasMomentum = btcRsi !== null && btcRsi >= 50;

      if (!btcAboveEma || !btcHasMomentum) {
        console.warn(`🛑 [BTC Filter]: البيتكوين يفتقر للزخم الصاعد (السعر: $${btcPrice} | EMA50: $${btcEma50?.toFixed(2)} | RSI: ${btcRsi?.toFixed(1)}). تم تجميد صفقات العملات البديلة.`);
        return;
      }
    }
  } catch (error) {
    console.error('⚠️ [BTC Filter] تعذر جلب شموع البيتكوين، سيتم التخطي بحذر.');
  }

  let symbols: string[] = [];
  try {
    symbols = await getActiveUSDTSpotPairs();
    console.log(`🔍 تم تثبيت ${symbols.length} زوج مؤهل للفحص.`);
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

          // سقف الـ 10 صفقات
          const activeTradesCount = await Opportunity.countDocuments({
            status: { $in: ['PENDING_ENTRY', 'ACTIVE', 'BREAK_EVEN', 'TP1_SECURED'] }
          });

          if (activeTradesCount >= 10) {
            console.log(`⏸️ [سقف الصفقات]: المحفظة مكتملة (${activeTradesCount}/10).`);
            continue;
          }

          // تنفيذ أمر الشراء
          const entryPrice = result.opportunity.entryZone.max;
          const orderResult = await placeLimitBuyOrder(symbol, entryPrice);

          if (!orderResult.success || !orderResult.orderId) {
            console.warn(`⚠️ [فشل التنفيذ] تعذر وضع أمر ${symbol}: ${orderResult.error}`);
            continue;
          }

          const orderId = orderResult.orderId;
          console.log(`⚡ [Binance] تم تأكيد أمر الشراء لـ ${symbol} بسعر $${entryPrice} (Order ID: ${orderId})`);

          const createdOpp = await Opportunity.create({
            ...result.opportunity,
            orderId,
          });

          discoveredCount++;
          console.log(`🎯 [صفقة مؤكدة جديدة]: ${symbol} (${activeTradesCount + 1}/10)`);

          const chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], result.chartOptions);
          await sendOpportunityToTelegram(createdOpp, chartBuffer);
        }
      } catch (error) {
        // متابعة الفحص
      }
      await sleep(150);
    }
  }

  console.log(`✨ [Crypto Scanner] اكتمل الفحص: نُفذت وأُرسلت ${discoveredCount} صفقة.`);
};
