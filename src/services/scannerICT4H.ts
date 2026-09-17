import axios from 'axios';
import mongoose, { Schema, Document, model } from 'mongoose';
import { sendICT4HSignalToTelegram, sendTradeOutcomeToTelegram } from './telegramHarmonics';
import { generateChartPngBuffer, CandlePlotData } from './chartGenerator';
import { placeLimitBuyOrder, placeMarketSellOrder } from './binanceClient';

const BINANCE_BASE_URL = process.env.BINANCE_TESTNET_URL || 'https://api.binance.com';
const TIMEFRAME = '4h';
const MAX_CONCURRENT_TRADES = 3;
const POSITION_SIZE_RATIO = 0.30;
const MAX_SL_PCT = 4.5;
const MIN_SL_PCT = 0.8;

const WATCHLIST = [
  'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 
  'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT', 'SUIUSDT', 
  'DOGEUSDT', 'APTUSDT', 'LTCUSDT', 'BCHUSDT', 'ICPUSDT', 
  'FETUSDT', 'RENDERUSDT', 'INJUSDT', 'TAOUSDT', 'PEPEUSDT', 
  'SHIBUSDT', 'OPUSDT', 'ARBUSDT', 'ATOMUSDT', 'FILUSDT', 
  'FTMUSDT', 'WIFUSDT', 'KASUSDT', 'STXUSDT', 'IMXUSDT', 
  'HBARUSDT', 'GRTUSDT', 'AAVEUSDT', 'MKRUSDT', 'SEIUSDT', 
  'FLOKIUSDT', 'BONKUSDT', 'RUNEUSDT', 'BEAMUSDT', 'JUPUSDT', 
  'STRKUSDT', 'PENDLEUSDT', 'TIAUSDT', 'ENSUSDT', 'GALAUSDT', 
  'CRVUSDT', 'DYDXUSDT', 'SANDUSDT', 'MANAUSDT', 'AXSUSDT'
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ==========================================
// 1. قاعدة البيانات (كولكشن مستقل: trades_ict_4h)
// ==========================================
export interface ITradeICT4H extends Document {
  symbol: string;
  strategy: string;
  timeframe: string;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  riskPct: number;
  allocatedCapital: number;
  discountDepth: number;
  quantity?: number;
  binanceOrderId?: string;
  isTriggered: boolean;
  status: 'ACTIVE' | 'WIN' | 'LOSS' | 'CANCELLED';
  entryTime: Date;
  exitTime?: Date;
  pnlDollars?: number;
  pnlPct?: number;
}

const TradeICT4HSchema = new Schema<ITradeICT4H>({
  symbol: { type: String, required: true, index: true },
  strategy: { type: String, default: 'ICT_4H' },
  timeframe: { type: String, default: '4h' },
  entryPrice: { type: Number, required: true },
  stopLoss: { type: Number, required: true },
  tp1: { type: Number, required: true },
  riskPct: { type: Number, required: true },
  allocatedCapital: { type: Number, required: true },
  discountDepth: { type: Number, required: true },
  quantity: { type: Number, default: 0 },
  binanceOrderId: { type: String },
  isTriggered: { type: Boolean, default: false },
  status: { type: String, enum: ['ACTIVE', 'WIN', 'LOSS', 'CANCELLED'], default: 'ACTIVE', index: true },
  entryTime: { type: Date, default: Date.now },
  exitTime: { type: Date },
  pnlDollars: { type: Number, default: 0 },
  pnlPct: { type: Number, default: 0 },
}, { timestamps: true });

export const TradeICT4H = mongoose.models.TradeICT4H || model<ITradeICT4H>('TradeICT4H', TradeICT4HSchema, 'trades_ict_4h');

// ==========================================
// 2. دوال التحليل الفني والنموذج المؤسساتي
// ==========================================
interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function getBinanceKlines(symbol: string, interval = TIMEFRAME, limit = 100): Promise<Candle[]> {
  try {
    const res = await axios.get(`${BINANCE_BASE_URL}/api/v3/klines`, {
      params: { symbol, interval, limit },
      timeout: 8000,
    });
    return res.data.map((c: any) => ({
      time: Number(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5])
    }));
  } catch {
    return [];
  }
}

function calculateEMA(candles: Candle[], period = 50): number[] {
  const k = 2 / (period + 1);
  const ema = [candles[0].close];
  for (let i = 1; i < candles.length; i++) {
    ema.push(candles[i].close * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function getSwings(candles: Candle[], radius = 3) {
  const swings: { idx: number; price: number; type: 'HIGH' | 'LOW' }[] = [];
  for (let i = radius; i < candles.length - radius; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= radius; j++) {
      if (candles[i - j].high >= candles[i].high || candles[i + j].high >= candles[i].high) isHigh = false;
      if (candles[i - j].low <= candles[i].low || candles[i + j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) swings.push({ idx: i, price: candles[i].high, type: 'HIGH' });
    if (isLow) swings.push({ idx: i, price: candles[i].low, type: 'LOW' });
  }
  return swings;
}

function analyzeICTSetup(candles: Candle[]) {
  if (candles.length < 55) return null;

  const currentIdx = candles.length - 1;
  const currentCandle = candles[currentIdx];
  const ema50 = calculateEMA(candles, 50);

  // 1. الاتجاه العام: السعر أعلى متوسط 50 شمعة
  if (currentCandle.close < ema50[currentIdx]) return null;

  const swings = getSwings(candles, 3);
  const lastLows = swings.filter(s => s.type === 'LOW');
  const lastHighs = swings.filter(s => s.type === 'HIGH');

  if (lastLows.length < 2 || lastHighs.length < 1) return null;

  const prevMajorLow = lastLows[lastLows.length - 2];
  const sweepLow = lastLows[lastLows.length - 1];
  const recentHigh = lastHighs[lastHighs.length - 1];

  // 2. التحقق من سحب السيولة الرئيسي
  const swept = sweepLow.price < prevMajorLow.price && sweepLow.idx > prevMajorLow.idx;
  if (!swept) return null;

  // 3. تأكيد كسر الهيكل (MSS) بإغلاق جسم شمعة صاعدة
  if (recentHigh.idx <= sweepLow.idx) return null;
  const mssBreak = currentCandle.close > recentHigh.price;
  if (!mssBreak) return null;

  // 4. استخراج الفراغ السعري (Bullish FVG)
  let fvg: { top: number; bottom: number } | null = null;
  for (let k = sweepLow.idx; k < currentIdx - 1; k++) {
    if (candles[k] && candles[k + 2] && candles[k].high < candles[k + 2].low) {
      fvg = { top: candles[k + 2].low, bottom: candles[k].high };
    }
  }
  if (!fvg) return null;

  // حساب منطقة التوازن (Equilibrium 50%) وعمق الخصم
  const impulseHigh = currentCandle.high;
  const impulseLow = sweepLow.price;
  const equilibrium = impulseLow + (impulseHigh - impulseLow) * 0.5;

  // قبول الدخول إذا كان الـ FVG داخل منطقة الخصم
  if (fvg.top > equilibrium) return null;

  const entryPrice = fvg.top;
  const stopLoss = parseFloat((sweepLow.price * 0.993).toFixed(6));
  const risk = entryPrice - stopLoss;
  const riskPct = parseFloat(((risk / entryPrice) * 100).toFixed(2));

  if (risk <= 0 || riskPct > MAX_SL_PCT || riskPct < MIN_SL_PCT) return null;

  // حساب عمق الخصم للمفاضلة بين العملات
  const discountDepth = parseFloat((((equilibrium - entryPrice) / (equilibrium - impulseLow)) * 100).toFixed(2));
  const tp1 = parseFloat((entryPrice + risk * 2.0).toFixed(6));

  return {
    entryPrice,
    stopLoss,
    tp1,
    riskPct,
    discountDepth,
    fvgTop: fvg.top,
    fvgBottom: fvg.bottom
  };
}

// ==========================================
// 3. إدارة رأس المال والمتابعة اللحظية
// ==========================================
async function getTotalCumulativeEquity(): Promise<number> {
  const initialEquity = 500.0;
  const closedTrades = await TradeICT4H.find({ status: { $in: ['WIN', 'LOSS'] } });
  const totalRealizedPnl = closedTrades.reduce((sum, t) => sum + (t.pnlDollars || 0), 0);
  return Math.max(10, initialEquity + totalRealizedPnl);
}

async function monitorActiveTrades() {
  const activeTrades = await TradeICT4H.find({ status: 'ACTIVE' });
  if (activeTrades.length === 0) return;

  for (const trade of activeTrades) {
    try {
      const candles = await getBinanceKlines(trade.symbol, '1m', 2);
      if (candles.length === 0) continue;
      const currentPrice = candles[candles.length - 1].close;

      if (!trade.isTriggered) {
        if (currentPrice <= trade.entryPrice) {
          trade.isTriggered = true;
          await trade.save();
        } else if (currentPrice >= trade.tp1) {
          trade.status = 'CANCELLED';
          trade.exitTime = new Date();
          await trade.save();
          continue;
        } else {
          continue;
        }
      }

      let closed = false;
      let outcome: 'WIN' | 'LOSS' = 'WIN';
      let exitPrice = currentPrice;

      if (currentPrice <= trade.stopLoss) {
        closed = true;
        outcome = 'LOSS';
        trade.status = 'LOSS';
        trade.exitTime = new Date();
        trade.pnlPct = -trade.riskPct;
        trade.pnlDollars = -trade.allocatedCapital * (trade.riskPct / 100);
      } else if (currentPrice >= trade.tp1) {
        closed = true;
        outcome = 'WIN';
        trade.status = 'WIN';
        trade.exitTime = new Date();
        const gainPct = (trade.tp1 - trade.entryPrice) / trade.entryPrice;
        trade.pnlPct = parseFloat((gainPct * 100).toFixed(2));
        trade.pnlDollars = trade.allocatedCapital * gainPct;
      }

      if (closed) {
        if (trade.quantity && trade.quantity > 0) {
          await placeMarketSellOrder(trade.symbol, trade.quantity);
        }

        await trade.save();

        await sendTradeOutcomeToTelegram({
          symbol: trade.symbol,
          outcome,
          entryPrice: trade.entryPrice,
          exitPrice,
          pnlDollars: trade.pnlDollars || 0,
          pnlPct: trade.pnlPct || 0,
          allocatedCapital: trade.allocatedCapital,
        });
      }
    } catch (err: any) {
      console.error(`⚠️ خطأ مراقبة صفقة ${trade.symbol}:`, err.message);
    }
    await sleep(150);
  }
}

// ==========================================
// 4. دورة الفحص واختيار الصفقات
// ==========================================
export async function runICT4HScannerJob() {
  await monitorActiveTrades();

  const activeCount = await TradeICT4H.countDocuments({ status: 'ACTIVE' });
  const availableSlots = MAX_CONCURRENT_TRADES - activeCount;
  if (availableSlots <= 0) return;

  const candidates: any[] = [];

  for (const symbol of WATCHLIST) {
    const isAlreadyOpen = await TradeICT4H.exists({ symbol, status: 'ACTIVE' });
    if (isAlreadyOpen) continue;

    const candles = await getBinanceKlines(symbol, TIMEFRAME, 100);
    if (candles.length < 55) continue;

    const setup = analyzeICTSetup(candles);
    if (setup) {
      candidates.push({ symbol, candles, ...setup });
    }
    await sleep(40);
  }

  if (candidates.length > 0) {
    // المفاضلة وترتيب الصفقات تنازلياً حسب أعمق نسبة خصم (Discount Depth)
    candidates.sort((a, b) => b.discountDepth - a.discountDepth);

    const selectedTrades = candidates.slice(0, availableSlots);
    const totalEquity = await getTotalCumulativeEquity();
    // تخصيص 30% دائماً من إجمالي رأس المال التراكمي
    const tradeAllocation = parseFloat((totalEquity * POSITION_SIZE_RATIO).toFixed(2));

    for (const trade of selectedTrades) {
      const buyRes = await placeLimitBuyOrder(trade.symbol, trade.entryPrice, tradeAllocation);

      await TradeICT4H.create({
        symbol: trade.symbol,
        entryPrice: trade.entryPrice,
        stopLoss: trade.stopLoss,
        tp1: trade.tp1,
        riskPct: trade.riskPct,
        allocatedCapital: tradeAllocation,
        discountDepth: trade.discountDepth,
        quantity: buyRes.quantity || 0,
        binanceOrderId: buyRes.orderId || undefined,
        isTriggered: false,
        status: 'ACTIVE',
        entryTime: new Date(),
      });

      let chartBuffer: Buffer | undefined = undefined;
      try {
        const risk = trade.entryPrice - trade.stopLoss;
        chartBuffer = generateChartPngBuffer(trade.candles as unknown as CandlePlotData[], {
          symbol: trade.symbol,
          timeframe: '4h',
          entry: trade.entryPrice,
          stopLoss: trade.stopLoss,
          tp1: trade.tp1,
          tp2: parseFloat((trade.entryPrice + risk * 2.5).toFixed(6)),
          tp3: parseFloat((trade.entryPrice + risk * 3.5).toFixed(6)),
          fvgTop: trade.fvgTop,
          fvgBottom: trade.fvgBottom,
        });
      } catch {}

      await sendICT4HSignalToTelegram(
        {
          symbol: trade.symbol,
          entryPrice: trade.entryPrice,
          stopLoss: trade.stopLoss,
          tp1: trade.tp1,
          riskPct: trade.riskPct,
          allocatedCapital: tradeAllocation,
        },
        chartBuffer
      );
    }
  }
}
