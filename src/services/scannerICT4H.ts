import axios from 'axios';
import mongoose, { Schema, Document, model } from 'mongoose';
import { sendICT4HSignalToTelegram, sendTradeOutcomeToTelegram } from './telegramHarmonics';
import { generateChartPngBuffer, CandlePlotData } from './chartGenerator';

const BINANCE_BASE_URL = process.env.BINANCE_TESTNET_URL || 'https://api.binance.com';
const TIMEFRAME = '4h';
const MAX_CONCURRENT_TRADES = 3;
const POSITION_SIZE_RATIO = 0.30;
const MAX_SL_PCT = 3.8;

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
  score: number;
  allocatedCapital: number;
  status: 'ACTIVE' | 'WIN' | 'LOSS';
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
  score: { type: Number, required: true },
  allocatedCapital: { type: Number, required: true },
  status: { type: String, enum: ['ACTIVE', 'WIN', 'LOSS'], default: 'ACTIVE', index: true },
  entryTime: { type: Date, default: Date.now },
  exitTime: { type: Date },
  pnlDollars: { type: Number, default: 0 },
  pnlPct: { type: Number, default: 0 },
}, { timestamps: true });

export const TradeICT4H = mongoose.models.TradeICT4H || model<ITradeICT4H>('TradeICT4H', TradeICT4HSchema, 'trades_ict_4h');

// ==========================================
// 2. تحليل ICT 4H الفني
// ==========================================
interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function getBinanceKlines(symbol: string, interval = TIMEFRAME, limit = 120): Promise<Candle[]> {
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

function findSwings(candles: Candle[], leftRight = 2) {
  const swings: { index: number; price: number; type: 'HIGH' | 'LOW' }[] = [];
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const isHigh = candles.slice(i - leftRight, i + leftRight + 1).every((c, idx) => idx === leftRight || c.high <= candles[i].high);
    const isLow = candles.slice(i - leftRight, i + leftRight + 1).every((c, idx) => idx === leftRight || c.low >= candles[i].low);
    if (isHigh) swings.push({ index: i, price: candles[i].high, type: 'HIGH' });
    if (isLow) swings.push({ index: i, price: candles[i].low, type: 'LOW' });
  }
  return swings;
}

function detectFVGs(candles: Candle[], startIdx: number, endIdx: number) {
  const fvgs: { startIndex: number; top: number; bottom: number }[] = [];
  for (let i = startIdx; i < endIdx - 2; i++) {
    const c1 = candles[i];
    const c3 = candles[i + 2];
    if (c1 && c3 && c1.high < c3.low) {
      fvgs.push({ startIndex: i, top: c3.low, bottom: c1.high });
    }
  }
  return fvgs;
}

function analyzeICTSetup(candles: Candle[]) {
  if (candles.length < 40) return null;
  const swings = findSwings(candles, 2);
  if (swings.length < 4) return null;

  const currentPrice = candles[candles.length - 1].close;
  const recentSwings = swings.slice(-15);

  for (let i = recentSwings.length - 1; i >= 1; i--) {
    const sweepNode = recentSwings[i];
    if (sweepNode.type === 'LOW') {
      let prevLow: { index: number; price: number } | null = null;
      let mssHigh: { index: number; price: number } | null = null;

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

        for (let c = sweepNode.index + 1; c < candles.length; c++) {
          if (candles[c].high > highestAfterMSS) highestAfterMSS = candles[c].high;
          if (mssIdx === -1 && candles[c].close > mssHigh.price) {
            mssIdx = c;
          }
        }

        if (mssIdx !== -1) {
          const impulseLow = sweepNode.price;
          const equilibrium = impulseLow + (highestAfterMSS - impulseLow) * 0.5;

          const fvgs = detectFVGs(candles, sweepNode.index, mssIdx);
          const validFVG = fvgs.reverse().find(f => f.top <= equilibrium);

          if (validFVG) {
            if (currentPrice <= equilibrium && currentPrice >= validFVG.bottom * 0.995) {
              const entryPrice = validFVG.top;
              const stopLoss = parseFloat((impulseLow * 0.997).toFixed(6));
              const risk = entryPrice - stopLoss;
              const riskPct = parseFloat(((risk / entryPrice) * 100).toFixed(2));

              if (risk > 0 && riskPct <= MAX_SL_PCT) {
                const tp1 = parseFloat(Math.max(mssHigh.price, entryPrice + risk * 1.0).toFixed(6));
                const rr = (tp1 - entryPrice) / risk;
                const discountDepth = ((equilibrium - entryPrice) / equilibrium) * 100;

                let score = 50;
                score += Math.min(rr * 10, 30);
                score += Math.min(discountDepth * 5, 20);
                if (riskPct <= 2.5) score += 10;

                return {
                  entryPrice,
                  stopLoss,
                  tp1,
                  riskPct,
                  score: parseFloat(score.toFixed(2)),
                  fvgTop: validFVG.top,
                  fvgBottom: validFVG.bottom
                };
              }
            }
          }
        }
      }
    }
  }
  return null;
}

// ==========================================
// 3. المحفظة والمراقبة وإرسال الإشعارات
// ==========================================
async function getAccountBalance(): Promise<number> {
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
        await trade.save();
        const newBalance = await getAccountBalance();

        // إرسال تقرير الخروج إلى تيليجرام
        await sendTradeOutcomeToTelegram({
          symbol: trade.symbol,
          outcome,
          entryPrice: trade.entryPrice,
          exitPrice,
          pnlDollars: trade.pnlDollars || 0,
          pnlPct: trade.pnlPct || 0,
          allocatedCapital: trade.allocatedCapital,
          currentBalance: newBalance,
        });
      }
    } catch {}
    await sleep(150);
  }
}

// ==========================================
// 4. الدالة الرئيسية لدورة الفحص
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

    const candles = await getBinanceKlines(symbol, TIMEFRAME, 60);
    if (candles.length < 40) continue;

    const setup = analyzeICTSetup(candles);
    if (setup) {
      candidates.push({ symbol, candles, ...setup });
    }
    await sleep(40);
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    const selectedTrades = candidates.slice(0, availableSlots);
    const totalEquity = await getAccountBalance();
    const tradeAllocation = totalEquity * POSITION_SIZE_RATIO;

    for (const trade of selectedTrades) {
      await TradeICT4H.create({
        symbol: trade.symbol,
        entryPrice: trade.entryPrice,
        stopLoss: trade.stopLoss,
        tp1: trade.tp1,
        riskPct: trade.riskPct,
        score: trade.score,
        allocatedCapital: parseFloat(tradeAllocation.toFixed(2)),
        status: 'ACTIVE',
        entryTime: new Date(),
      });

      // توليد صورة الشارت إن أمكن
      let chartBuffer: Buffer | undefined = undefined;
      try {
        chartBuffer = generateChartPngBuffer(trade.candles as unknown as CandlePlotData[], {
          symbol: trade.symbol,
          timeframe: '4h',
          entry: trade.entryPrice,
          stopLoss: trade.stopLoss,
          tp1: trade.tp1,
          fvgTop: trade.fvgTop,
          fvgBottom: trade.fvgBottom,
        });
      } catch {}

      // إرسال الإشعار للقناة المحددة
      await sendICT4HSignalToTelegram(
        {
          symbol: trade.symbol,
          entryPrice: trade.entryPrice,
          stopLoss: trade.stopLoss,
          tp1: trade.tp1,
          riskPct: trade.riskPct,
          score: trade.score,
          allocatedCapital: tradeAllocation,
        },
        chartBuffer
      );
    }
  }
}
