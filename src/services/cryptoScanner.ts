import axios from 'axios';
import mongoose, { Schema, Document, model } from 'mongoose';
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

const MAX_CONCURRENT_TRADES = 5;
const POSITION_SIZE_RATIO = 0.10; // 10% لكل صفقة تراكمية

// ==========================================
// 1. قاعدة البيانات (كولكشن مستقل: trades_ict_1h)
// ==========================================
export interface ICryptoTrade1H extends Document {
  symbol: string;
  baseAsset: string;
  strategy: string;
  timeframe: string;
  entryZone: { min: number; max: number };
  stopLoss: number;
  targets: { tp1: number; tp2: number; tp3: number };
  allocatedCapital: number;
  quantity?: number;
  orderId?: string;
  status: 'PENDING_ENTRY' | 'ACTIVE' | 'BREAK_EVEN' | 'TP2_SECURED' | 'CLOSED_WIN' | 'CLOSED_LOSS' | 'CANCELLED';
  pnlDollars?: number;
  pnlPct?: number;
  createdAt: Date;
  updatedAt: Date;
}

const CryptoTrade1HSchema = new Schema<ICryptoTrade1H>({
  symbol: { type: String, required: true, index: true },
  baseAsset: { type: String, required: true },
  strategy: { type: String, default: 'ICT_1H' },
  timeframe: { type: String, default: '1h' },
  entryZone: {
    min: { type: Number, required: true },
    max: { type: Number, required: true }
  },
  stopLoss: { type: Number, required: true },
  targets: {
    tp1: { type: Number, required: true },
    tp2: { type: Number, required: true },
    tp3: { type: Number, required: true }
  },
  allocatedCapital: { type: Number, required: true },
  quantity: { type: Number, default: 0 },
  orderId: { type: String },
  status: {
    type: String,
    enum: ['PENDING_ENTRY', 'ACTIVE', 'BREAK_EVEN', 'TP2_SECURED', 'CLOSED_WIN', 'CLOSED_LOSS', 'CANCELLED'],
    default: 'PENDING_ENTRY',
    index: true
  },
  pnlDollars: { type: Number, default: 0 },
  pnlPct: { type: Number, default: 0 },
}, { timestamps: true });

export const CryptoTrade1H = mongoose.models.CryptoTrade1H || 
  model<ICryptoTrade1H>('CryptoTrade1H', CryptoTrade1HSchema, 'trades_ict_1h');

// ==========================================
// 2. إدارة المحفظة التراكمية (الأساس 500 دولار)
// ==========================================
async function getICT1HAccountBalance(): Promise<number> {
  const initialEquity = 500.0;
  const closedTrades = await CryptoTrade1H.find({ status: { $in: ['CLOSED_WIN', 'CLOSED_LOSS'] } });
  const totalRealizedPnl = closedTrades.reduce((sum, t) => sum + (t.pnlDollars || 0), 0);
  return Math.max(10, initialEquity + totalRealizedPnl);
}

// ==========================================
// 3. جلب قائمة العملات والشموع
// ==========================================
const CORE_TOP_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT',
  'SUIUSDT', 'DOGEUSDT', 'TONUSDT', 'APTUSDT', 'MATICUSDT',
  'LTCUSDT', 'BCHUSDT', 'ICPUSDT', 'FETUSDT', 'RENDERUSDT',
  'INJUSDT', 'TAOUSDT', 'RNDRUSDT', 'PEPEUSDT', 'SHIBUSDT',
  'OPUSDT', 'ARBUSDT', 'ATOMUSDT', 'FILUSDT', 'FTMUSDT',
  'WIFUSDT', 'KASUSDT', 'STXUSDT', 'IMXUSDT', 'HBARUSDT',
  'GRTUSDT', 'AAVEUSDT', 'MKRUSDT', 'SEIUSDT', 'FLOKIUSDT',
  'BONKUSDT', 'RUNEUSDT', 'BEAMUSDT', 'JUPUSDT', 'STRKUSDT',
  'PENDLEUSDT', 'TIAUSDT', 'ENSUSDT', 'GALAUSDT', 'CRVUSDT'
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
      .slice(0, 60)
      .map((item: any) => item.symbol);

    return Array.from(new Set([...CORE_TOP_PAIRS, ...dynamicTop])).slice(0, 60);
  } catch {
    return CORE_TOP_PAIRS;
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchCandles = async (symbol: string, interval = '1h', limit = 100): Promise<CandleData[]> => {
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/kline', {
      params: { category: 'spot', symbol, interval: '60', limit },
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

// ==========================================
// 4. أدوات وخوارزمية تحليل ICT على فريم 1H
// ==========================================
interface SwingPoint {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

interface FVG {
  startIndex: number;
  top: number;
  bottom: number;
  type: 'BULLISH';
}

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
    }
  }
  return fvgs;
};

export const analyzeICTSetup = (candles: CandleData[], symbol: string, timeframe = '1h') => {
  if (candles.length < 50) return null;

  const swings = findSwings(candles, 2);
  if (swings.length < 5) return null;

  const currentPrice = candles[candles.length - 1].close;
  const baseAsset = symbol.replace('USDT', '');
  const recentSwings = swings.slice(-15);

  for (let i = recentSwings.length - 1; i >= 2; i--) {
    const sweepNode = recentSwings[i];

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
        let mssIdx = -1;
        let highestAfterMSS = sweepNode.price;

        for (let c = sweepNode.index + 1; c < candles.length - 1; c++) {
          if (candles[c].high > highestAfterMSS) highestAfterMSS = candles[c].high;
          if (mssIdx === -1 && candles[c].close > mssHigh.price) {
            mssIdx = c;
          }
        }

        if (mssIdx !== -1 && (candles.length - 1 - mssIdx <= 10)) {
          const impulseLow = sweepNode.price;
          const equilibrium = impulseLow + (highestAfterMSS - impulseLow) * 0.5;

          const fvgs = detectFVGs(candles, sweepNode.index, mssIdx);
          const validFVG = fvgs.reverse().find(f => {
            if (f.type !== 'BULLISH' || f.top > equilibrium) return false;
            
            let closed = false;
            for (let m = f.startIndex + 2; m < candles.length - 1; m++) {
              if (candles[m].low < f.bottom) closed = true;
            }
            return !closed;
          });

          if (validFVG) {
            if (currentPrice <= equilibrium && currentPrice > validFVG.bottom * 0.998) {
              const entryPrice = validFVG.top;
              const stopLoss = parseFloat((impulseLow * 0.997).toFixed(6));
              const risk = entryPrice - stopLoss;
              
              if (risk > 0) {
                const impulseRange = highestAfterMSS - impulseLow;

                const minTp1 = entryPrice + risk * 1.0;
                const tp1 = parseFloat(Math.max(mssHigh.price, minTp1).toFixed(6));

                const rawFibTp2 = impulseLow + impulseRange * 1.272;
                const minTp2 = tp1 + risk * 0.8;
                const tp2 = parseFloat(Math.max(rawFibTp2, minTp2).toFixed(6));

                const rawFibTp3 = impulseLow + impulseRange * 1.618;
                const minTp3 = tp2 + risk * 1.0;
                const tp3 = parseFloat(Math.max(rawFibTp3, minTp3).toFixed(6));

                return {
                  tradeData: {
                    symbol,
                    baseAsset,
                    timeframe,
                    entryZone: { min: parseFloat(validFVG.bottom.toFixed(6)), max: parseFloat(validFVG.top.toFixed(6)) },
                    stopLoss,
                    targets: { tp1, tp2, tp3 },
                  },
                  chartOptions: {
                    symbol,
                    timeframe,
                    entry: entryPrice,
                    stopLoss,
                    tp1,
                    tp2,
                    tp3,
                    fvgTop: validFVG.top,
                    fvgBottom: validFVG.bottom
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

// ==========================================
// 5. تشغيل المسح الدوري والتنفيذ التراكمي على فريم 1H
// ==========================================
export const runFullCryptoScan = async () => {
  console.log('🚀 [ICT 1H Scanner] بدء دورة الفحص لأفضل 60 عملة رقمية (1h)...');

  // فحص السقف الأقصى للصفقات المفتوحة
  const activeCount = await CryptoTrade1H.countDocuments({
    status: { $in: ['PENDING_ENTRY', 'ACTIVE', 'BREAK_EVEN', 'TP2_SECURED'] }
  });

  if (activeCount >= MAX_CONCURRENT_TRADES) {
    console.log(`ℹ️ [ICT 1H] الحد الأقصى للصفقات المتزامنة مستوفى (${activeCount}/${MAX_CONCURRENT_TRADES}).`);
    return;
  }

  let symbols: string[] = [];
  try {
    symbols = await getActiveUSDTSpotPairs();
    console.log(`🔍 تم تثبيت ${symbols.length} زوج من نخبة العملات للفحص.`);
  } catch {
    return;
  }

  let discoveredCount = 0;

  for (const symbol of symbols) {
    try {
      const currentActive = await CryptoTrade1H.countDocuments({
        status: { $in: ['PENDING_ENTRY', 'ACTIVE', 'BREAK_EVEN', 'TP2_SECURED'] }
      });
      if (currentActive >= MAX_CONCURRENT_TRADES) break;

      const candles = await fetchCandles(symbol, '1h', 100);
      if (candles.length < 40) continue;

      const result = analyzeICTSetup(candles, symbol, '1h');

      if (result) {
        // حماية من التكرار خلال 12 ساعة
        const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
        const existing = await CryptoTrade1H.findOne({
          symbol,
          $or: [
            { status: { $in: ['PENDING_ENTRY', 'ACTIVE', 'BREAK_EVEN', 'TP2_SECURED'] } },
            { createdAt: { $gte: twelveHoursAgo } }
          ]
        });

        if (existing) continue;

        // حساب الحصة التراكمية (10% من الرصيد الصافي)
        const currentEquity = await getICT1HAccountBalance();
        const tradeAllocation = currentEquity * POSITION_SIZE_RATIO;
        const entryPrice = result.tradeData.entryZone.max;

        // تنفيذ أمر شراء حقيقي في باينانس Testnet
        const orderResult = await placeLimitBuyOrder(symbol, entryPrice, tradeAllocation);

        let orderId: string | undefined = undefined;
        let quantity: number = 0;

        if (orderResult.success && orderResult.orderId) {
          orderId = orderResult.orderId;
          quantity = orderResult.quantity || 0;
          console.log(`⚡ [Binance Testnet] تم وضع أمر شراء لـ ${symbol} بحصة $${tradeAllocation.toFixed(2)} (Order ID: ${orderId})`);
        } else {
          console.warn(`⚠️ [Binance Testnet] تعذر تنفيذ الشراء لـ ${symbol}: ${orderResult.error}`);
        }

        const createdTrade = await CryptoTrade1H.create({
          ...result.tradeData,
          allocatedCapital: parseFloat(tradeAllocation.toFixed(2)),
          quantity,
          orderId,
          status: 'PENDING_ENTRY',
        });

        discoveredCount++;
        console.log(`🎯 [فرصة ICT 1H رُصدت]: ${symbol} - تم التوثيق في trades_ict_1h.`);

        let chartBuffer: Buffer | undefined = undefined;
        try {
          chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], result.chartOptions);
        } catch {}

        await sendOpportunityToTelegram(createdTrade as any, chartBuffer);
      }
    } catch (err: any) {
      console.error(`⚠️ خطأ فحص عملة ${symbol}:`, err.message);
    }
    await sleep(120);
  }

  console.log(`✨ [ICT 1H Scanner] اكتمل الفحص: رُصدت ${discoveredCount} فرصة.`);
};
