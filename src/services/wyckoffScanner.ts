import axios from 'axios';
import mongoose, { Schema, Document, model } from 'mongoose';
import { sendSwingOpportunityToTelegram } from './swingTelegramBot';
import { generateChartPngBuffer, CandlePlotData } from './chartGenerator';
import { placeLimitBuyOrder, placeMarketSellOrder } from './binanceClient';

export interface CandleData {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const MAX_CONCURRENT_TRADES = 3;
const POSITION_SIZE_RATIO = 0.20; // 20% لكل صفقة تراكمية

// ==========================================
// 1. قاعدة البيانات (كولكشن مستقل: trades_wyckoff)
// ==========================================
export interface IWyckoffTrade extends Document {
  symbol: string;
  strategy: string;
  timeframe: string;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskPercent: number;
  allocatedCapital: number;
  quantity?: number;
  binanceOrderId?: string;
  status: 'ACTIVE' | 'WIN' | 'LOSS';
  entryTime: Date;
  exitTime?: Date;
  pnlDollars?: number;
  pnlPct?: number;
}

const WyckoffTradeSchema = new Schema<IWyckoffTrade>({
  symbol: { type: String, required: true, index: true },
  strategy: { type: String, default: 'WYCKOFF_SWING' },
  timeframe: { type: String, default: '4h' },
  entryPrice: { type: Number, required: true },
  stopLoss: { type: Number, required: true },
  tp1: { type: Number, required: true },
  tp2: { type: Number, required: true },
  tp3: { type: Number, required: true },
  riskPercent: { type: Number, required: true },
  allocatedCapital: { type: Number, required: true },
  quantity: { type: Number, default: 0 },
  binanceOrderId: { type: String },
  status: { type: String, enum: ['ACTIVE', 'WIN', 'LOSS'], default: 'ACTIVE', index: true },
  entryTime: { type: Date, default: Date.now },
  exitTime: { type: Date },
  pnlDollars: { type: Number, default: 0 },
  pnlPct: { type: Number, default: 0 },
}, { timestamps: true });

export const WyckoffTrade = mongoose.models.WyckoffTrade || 
  model<IWyckoffTrade>('WyckoffTrade', WyckoffTradeSchema, 'trades_wyckoff');

// ==========================================
// 2. إدارة المحفظة التراكمية (الأساس 500 دولار)
// ==========================================
async function getWyckoffAccountBalance(): Promise<number> {
  const initialEquity = 500.0;
  const closedTrades = await WyckoffTrade.find({ status: { $in: ['WIN', 'LOSS'] } });
  const totalRealizedPnl = closedTrades.reduce((sum, t) => sum + (t.pnlDollars || 0), 0);
  return Math.max(10, initialEquity + totalRealizedPnl);
}

// قائمة احتياطية في حال تعذر جلب السوق آلياً
const FALLBACK_PAIRS = [
  'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT', 'SUIUSDT',
  'DOGEUSDT', 'TONUSDT', 'APTUSDT', 'MATICUSDT', 'LTCUSDT', 'BCHUSDT', 'ICPUSDT', 'FETUSDT', 'RENDERUSDT', 'INJUSDT',
  'TAOUSDT', 'PEPEUSDT', 'SHIBUSDT', 'OPUSDT', 'ARBUSDT', 'ATOMUSDT', 'FILUSDT', 'FTMUSDT', 'WIFUSDT', 'KASUSDT',
  'STXUSDT', 'IMXUSDT', 'HBARUSDT', 'GRTUSDT', 'AAVEUSDT', 'MKRUSDT', 'SEIUSDT', 'FLOKIUSDT', 'BONKUSDT', 'RUNEUSDT'
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let cachedPairs: string[] = [];
let lastPairsFetchTime = 0;

const fetchAllSpotUsdtPairs = async (): Promise<string[]> => {
  const now = Date.now();
  if (cachedPairs.length > 0 && now - lastPairsFetchTime < 12 * 60 * 60 * 1000) {
    return cachedPairs;
  }

  try {
    const res = await axios.get('https://api.bybit.com/v5/market/instruments-info', {
      params: { category: 'spot' },
      timeout: 10000,
    });
    const list = res.data.result?.list || [];
    const activeUsdtPairs = list
      .filter((item: any) => item.quoteCoin === 'USDT' && item.status === 'Trading')
      .map((item: any) => item.symbol);

    if (activeUsdtPairs.length > 0) {
      cachedPairs = activeUsdtPairs;
      lastPairsFetchTime = now;
      console.log(`📡 [Wyckoff Scanner] تم تحديث أزواج Bybit Spot آلياً: ${cachedPairs.length} زوج نشط.`);
      return cachedPairs;
    }
  } catch {
    console.warn('⚠️ تعذر جلب قائمة الأزواج ديناميكياً، استخدام القائمة الاحتياطية.');
  }

  return cachedPairs.length > 0 ? cachedPairs : FALLBACK_PAIRS;
};

const alertedPairs = new Map<string, number>();

const fetchCandles = async (symbol: string, interval = '240', limit = 60): Promise<CandleData[]> => {
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/kline', {
      params: { category: 'spot', symbol, interval, limit },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });
    const list = res.data.result?.list;
    if (!list) return [];
    return list.map((c: any) => ({
      openTime: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    })).reverse();
  } catch {
    return [];
  }
};

interface FVG {
  top: number;
  bottom: number;
}

const detectWyckoffSetup = (candles: CandleData[], symbol: string) => {
  if (candles.length < 50) return null;

  const i = candles.length - 1;
  const rangeSlice = candles.slice(i - 30, i - 5);
  const rangeSupport = Math.min(...rangeSlice.map(c => c.low));
  const rangeResistance = Math.max(...rangeSlice.map(c => c.high));
  const rangeSpread = (rangeResistance - rangeSupport) / rangeSupport;

  if (rangeSpread > 0.22 || rangeSpread < 0.035) return null;

  let springCandle = null;
  for (let s = i - 8; s <= i - 2; s++) {
    if (candles[s].low < rangeSupport && candles[s].close > rangeSupport * 0.980) {
      springCandle = candles[s];
      break;
    }
  }
  if (!springCandle) return null;

  let sosIdx = -1;
  for (let j = i - 5; j <= i; j++) {
    const c = candles[j];
    const body = c.close - c.open;
    const totalHeight = c.high - c.low;
    if (c.close > rangeResistance * 0.995 && totalHeight > 0 && (body / totalHeight) >= 0.40) {
      sosIdx = j;
      break;
    }
  }
  if (sosIdx === -1) return null;

  let foundFVG: FVG | null = null;
  for (let k = i - 6; k < sosIdx; k++) {
    if (candles[k].high < candles[k + 2].low) {
      foundFVG = {
        bottom: candles[k].high,
        top: candles[k + 2].low,
      };
    }
  }
  if (!foundFVG) return null;

  const entryPrice = parseFloat(((foundFVG.top + foundFVG.bottom) / 2).toFixed(6));
  const currentClose = candles[i].close;

  if (currentClose >= foundFVG.bottom * 0.995 && currentClose <= foundFVG.top * 1.03) {
    const stopLoss = parseFloat((springCandle.low * 0.992).toFixed(6));
    const risk = entryPrice - stopLoss;
    const riskPercent = parseFloat(((risk / entryPrice) * 100).toFixed(2));

    if (risk <= 0 || riskPercent > 5.5) return null;

    const tp1 = parseFloat((entryPrice * 1.040).toFixed(6));
    const tp2 = parseFloat((entryPrice * 1.085).toFixed(6));
    const tp3 = parseFloat((entryPrice * 1.150).toFixed(6));

    return {
      symbol,
      entryPrice,
      stopLoss,
      tp1,
      tp2,
      tp3,
      riskPercent,
      fvgTop: foundFVG.top,
      fvgBottom: foundFVG.bottom
    };
  }

  return null;
};

// ==========================================
// 3. مراقبة وإغلاق صفقات Wyckoff والتنفيذ على باينانس
// ==========================================
async function monitorActiveWyckoffTrades() {
  const activeTrades = await WyckoffTrade.find({ status: 'ACTIVE' });
  if (activeTrades.length === 0) return;

  for (const trade of activeTrades) {
    try {
      const candles = await fetchCandles(trade.symbol, '1', 2);
      if (candles.length === 0) continue;
      const currentPrice = candles[candles.length - 1].close;

      let closed = false;

      if (currentPrice <= trade.stopLoss) {
        closed = true;
        trade.status = 'LOSS';
        trade.exitTime = new Date();
        trade.pnlPct = -trade.riskPercent;
        trade.pnlDollars = -trade.allocatedCapital * (trade.riskPercent / 100);
      } else if (currentPrice >= trade.tp1) {
        closed = true;
        trade.status = 'WIN';
        trade.exitTime = new Date();
        const gainPct = (trade.tp1 - trade.entryPrice) / trade.entryPrice;
        trade.pnlPct = parseFloat((gainPct * 100).toFixed(2));
        trade.pnlDollars = trade.allocatedCapital * gainPct;
      }

      if (closed) {
        // تنفيذ أمر بيع الإغلاق في باينانس Testnet
        if (trade.quantity && trade.quantity > 0) {
          await placeMarketSellOrder(trade.symbol, trade.quantity);
        }
        await trade.save();
      }
    } catch (err: any) {
      console.error(`⚠️ خطأ مراقبة صفقة Wyckoff لـ ${trade.symbol}:`, err.message);
    }
    await sleep(100);
  }
}

// ==========================================
// 4. الدالة الرئيسية للفحص والتنفيذ التراكمي
// ==========================================
export const runWyckoffScannerJob = async () => {
  console.log('💎 [Wyckoff Swing Scanner] بدء دورة الفحص للسوق كاملاً على 4H...');
  await monitorActiveWyckoffTrades();

  const activeCount = await WyckoffTrade.countDocuments({ status: 'ACTIVE' });
  if (activeCount >= MAX_CONCURRENT_TRADES) {
    console.log(`ℹ️ [Wyckoff Swing] الحد الأقصى للصفقات المتزامنة مستوفى (${activeCount}/${MAX_CONCURRENT_TRADES}).`);
    return;
  }

  const pairsToScan = await fetchAllSpotUsdtPairs();
  const now = Date.now();
  let foundSignalsCount = 0;

  for (const symbol of pairsToScan) {
    const isAlreadyOpen = await WyckoffTrade.exists({ symbol, status: 'ACTIVE' });
    if (isAlreadyOpen) continue;

    const lastAlert = alertedPairs.get(symbol) || 0;
    if (now - lastAlert < 72 * 60 * 60 * 1000) continue;

    try {
      const candles = await fetchCandles(symbol, '240', 60);
      if (candles.length < 50) continue;

      const setup = detectWyckoffSetup(candles, symbol);
      if (setup) {
        alertedPairs.set(symbol, now);
        foundSignalsCount++;

        // احتساب الرصيد التراكمي اللحظي وتخصيص 20%
        const currentEquity = await getWyckoffAccountBalance();
        const tradeAllocation = currentEquity * POSITION_SIZE_RATIO;

        // تنفيذ أمر شراء حقيقي في باينانس Testnet
        const buyRes = await placeLimitBuyOrder(setup.symbol, setup.entryPrice, tradeAllocation);

        // توثيق الصفقة في كولكشن trades_wyckoff
        await WyckoffTrade.create({
          symbol: setup.symbol,
          entryPrice: setup.entryPrice,
          stopLoss: setup.stopLoss,
          tp1: setup.tp1,
          tp2: setup.tp2,
          tp3: setup.tp3,
          riskPercent: setup.riskPercent,
          allocatedCapital: parseFloat(tradeAllocation.toFixed(2)),
          quantity: buyRes.quantity || 0,
          binanceOrderId: buyRes.orderId || undefined,
          status: 'ACTIVE',
          entryTime: new Date(),
        });

        let chartBuffer: Buffer | undefined = undefined;
        try {
          chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], {
            symbol,
            timeframe: '4h',
            entry: setup.entryPrice,
            stopLoss: setup.stopLoss,
            tp1: setup.tp1,
            tp2: setup.tp2,
            tp3: setup.tp3,
            fvgTop: setup.fvgTop,
            fvgBottom: setup.fvgBottom,
          });
        } catch {}

        await sendSwingOpportunityToTelegram(setup, chartBuffer);
        await sleep(1000);

        const currentActiveAfterOpen = await WyckoffTrade.countDocuments({ status: 'ACTIVE' });
        if (currentActiveAfterOpen >= MAX_CONCURRENT_TRADES) break;
      }
    } catch {}

    await sleep(60);
  }

  console.log(`🏁 [Wyckoff Swing Scanner] اكتمل فحص ${pairsToScan.length} زوج. إشارات جديدة: ${foundSignalsCount}`);
};
