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
// 1. جلب قائمة أفضل 50 زوج USDT نشط
// ==========================================================
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

    const blacklist = ['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'EURUSDT', 'DAIUSDT', 'USDEUSDT'];

    const dynamicTop = res.data.result.list
      .filter((item: any) => item.symbol.endsWith('USDT') && !blacklist.includes(item.symbol))
      .sort((a: any, b: any) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
      .slice(0, 50)
      .map((item: any) => item.symbol);

    return Array.from(new Set([...CORE_TOP_PAIRS, ...dynamicTop])).slice(0, 50);
  } catch (error) {
    return CORE_TOP_PAIRS;
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
// 4. خوارزمية فحص الارتداد الناجحة (EMA 50 Pullback + RSI)
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

  // 3. وصول RSI إلى تشبع بيعي تحت 45 خلال آخر 3 شموع
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

  // الهدف الكامل عند عائد 2.0R
  const tp = parseFloat((entryPrice + risk * 2.0).toFixed(6));
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
      targets: { tp1: tp, tp2: tp, tp3: tp },
      riskRewardRatio: '1:2.0',
      confluenceScore: 96,
      fulfilledConditions: [
        { title: 'Macro Uptrend', description: `السعر أعلى من متوسط EMA 200` },
        { title: 'EMA 50 Pullback', description: `إعادة اختبار ناجحة لدعم متوسط EMA 50` },
        { title: 'RSI Oversold Dip', description: `ارتداد بعد وصول مؤشر القوة النسبية تحت 45` },
        { title: 'Bullish Confirmation', description: `شمعة ارتدادية خضراء أغلقت أعلى من سابقتها` },
      ],
      analysisReasons: {
        entryReason: `شراء مباشر / Limit بسعر $${entryPrice} عند ارتداد EMA 50.`,
        stopLossReason: `وقف خسارة أسفل قاع الارتداد بنسبة ${riskPct.toFixed(2)}%: $${stopLoss}.`,
        takeProfitReason: `هدف نهائي كامل (2.0R): $${tp}.`
      },
      status: 'PENDING_ENTRY' as const,
    },
    chartOptions: {
      symbol,
      timeframe,
      entry: entryPrice,
      stopLoss,
      tp1: tp,
      tp2: tp,
      tp3: tp,
      fvgTop: entryPrice,
      fvgBottom: stopLoss,
    },
  };
};

// ==========================================
// 5. تشغيل المسح الدوري الشامل (فريم 4H)
// ==========================================
export const runFullCryptoScan = async () => {
  const targetTimeframes = ['4h'];
  console.log('🚀 [Crypto Scanner] بدء فحص استراتيجية الارتداد (EMA 50 Pullback + RSI 4H)...');

  let symbols: string[] = [];
  try {
    symbols = await getActiveUSDTSpotPairs();
    console.log(`🔍 تم تثبيت ${symbols.length} زوج للفحص المتقدم على فريم 4H.`);
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

          const entryPrice = result.opportunity.entryZone.max;
          const orderResult = await placeLimitBuyOrder(symbol, entryPrice);

          let orderId: string | undefined = undefined;
          if (orderResult.success && orderResult.orderId) {
            orderId = orderResult.orderId;
            console.log(`⚡ [Binance] تم وضع أمر شراء لـ ${symbol} بسعر $${entryPrice} (Order ID: ${orderId})`);
          } else {
            console.warn(`⚠️ [Binance] تنبيه التنفيذ لـ ${symbol}: ${orderResult.error}`);
          }

          const createdOpp = await Opportunity.create({
            ...result.opportunity,
            orderId,
          });

          discoveredCount++;
          console.log(`🎯 [فرصة ارتداد EMA 50]: ${symbol} - تم الحفظ والتجهيز للإرسال.`);

          const chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], result.chartOptions);
          await sendOpportunityToTelegram(createdOpp, chartBuffer);
        }
      } catch (error) {
        // الاستمرار في الفحص في حال وجود أخطاء في زوج معين
      }
      sleep(150);
    }
  }

  console.log(`✨ [Crypto Scanner] اكتمل فحص 4H: رُصدت ${discoveredCount} فرصة ارتداد ناجحة.`);
};
