import axios from 'axios';
import { CryptoTrade1H, ICryptoTrade1H } from './cryptoScanner';
import { checkOrderStatus, placeMarketSellOrder, cancelBinanceOrder } from './binanceClient';
import { sendTradeUpdateToTelegram } from './telegramBot';

// جلب السعر اللحظي للعملة من باينانس
const getLatestPrice = async (symbol: string): Promise<number | null> => {
  try {
    const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, {
      timeout: 5000,
    });
    return parseFloat(res.data.price);
  } catch {
    return null;
  }
};

// 1. مراقبة وإدارة الأوامر المعلقة في trades_ict_1h
const trackPendingOrders = async () => {
  const pendingTrades = await CryptoTrade1H.find({ status: 'PENDING_ENTRY' });

  for (const trade of pendingTrades) {
    try {
      const currentPrice = await getLatestPrice(trade.symbol);
      if (!currentPrice) continue;

      // أ) التحقق من إلغاء الصفقة إذا وصل السعر لـ TP1 قبل التفعيل أو مر أكثر من 24 ساعة
      const hoursSinceCreation = (Date.now() - new Date(trade.createdAt).getTime()) / (1000 * 60 * 60);
      if (currentPrice >= trade.targets.tp1 || hoursSinceCreation >= 24) {
        if (trade.orderId) {
          await cancelBinanceOrder(trade.symbol, trade.orderId);
        }
        trade.status = 'CANCELLED';
        await trade.save();
        console.log(`⏱️ [ICT 1H Expired] تم إلغاء الأمر المعلق لـ ${trade.symbol}`);
        continue;
      }

      // ب) فحص تفعيل الصفقة عبر باينانس Testnet أو وصول السعر لمنطقة الدخول
      let isFilled = false;
      if (trade.orderId) {
        const orderInfo = await checkOrderStatus(trade.symbol, trade.orderId);
        if (orderInfo && orderInfo.status === 'FILLED') {
          isFilled = true;
          if (orderInfo.executedQty > 0) {
            trade.quantity = orderInfo.executedQty;
          }
        }
      } else if (currentPrice <= trade.entryZone.max) {
        isFilled = true;
      }

      if (isFilled) {
        trade.status = 'ACTIVE';
        await trade.save();
        console.log(`🚀 [ICT 1H Filled] تم تفعيل الشراء لـ ${trade.symbol}`);
        await sendTradeUpdateToTelegram('FILLED', trade as any);
      }
    } catch (error: any) {
      console.error(`⚠️ خطأ تتبع الأمر المعلق لـ ${trade.symbol}:`, error.message);
    }
  }
};

// 2. مراقبة وإدارة الصفقات النشطة (SL, TP1, Break-Even, Trailing SL, TP3)
const trackActiveTrades = async () => {
  const activeTrades = await CryptoTrade1H.find({ 
    status: { $in: ['ACTIVE', 'BREAK_EVEN', 'TP2_SECURED'] } 
  });

  for (const trade of activeTrades) {
    try {
      const currentPrice = await getLatestPrice(trade.symbol);
      if (!currentPrice) continue;

      const entryPrice = trade.entryZone.max;
      const totalQty = trade.quantity && trade.quantity > 0 
        ? trade.quantity 
        : trade.allocatedCapital / entryPrice;

      // ─── المرحلة الأولى: الصفقة نشطة في مسارها الطبيعي ───
      if (trade.status === 'ACTIVE') {
        if (currentPrice <= trade.stopLoss) {
          if (totalQty > 0) {
            await placeMarketSellOrder(trade.symbol, totalQty);
          }
          const lossPct = parseFloat((((trade.stopLoss - entryPrice) / entryPrice) * 100).toFixed(2));
          trade.status = 'CLOSED_LOSS';
          trade.pnlPct = lossPct;
          trade.pnlDollars = trade.allocatedCapital * (lossPct / 100);
          await trade.save();

          console.log(`🛑 [ICT 1H SL] ضرب وقف الخسارة لـ ${trade.symbol}`);
          await sendTradeUpdateToTelegram('SL', trade as any, lossPct);
          continue;
        }

        if (currentPrice >= trade.targets.tp1) {
          const sellQty = totalQty * 0.50;
          if (sellQty > 0) {
            await placeMarketSellOrder(trade.symbol, sellQty);
          }

          const tp1ProfitPct = parseFloat((((trade.targets.tp1 - entryPrice) / entryPrice) * 100).toFixed(2));
          trade.status = 'BREAK_EVEN';
          trade.pnlPct = tp1ProfitPct;
          await trade.save();

          console.log(`🎯 [ICT 1H TP1] جني ربح 50% وتأمين الدخول لـ ${trade.symbol}`);
          await sendTradeUpdateToTelegram('TP1', trade as any, tp1ProfitPct);
          continue;
        }
      }

      // ─── المرحلة الثانية: تأمين الدخول (Break-Even) ───
      if (trade.status === 'BREAK_EVEN') {
        if (currentPrice <= entryPrice) {
          const remainingQty = totalQty * 0.50;
          if (remainingQty > 0) {
            await placeMarketSellOrder(trade.symbol, remainingQty);
          }

          // الربح الإجمالي هو نصف الصفقة الأول عند TP1
          const halfProfitDollars = (trade.allocatedCapital * 0.50) * (((trade.targets.tp1 - entryPrice) / entryPrice));
          trade.status = 'CLOSED_WIN';
          trade.pnlDollars = halfProfitDollars;
          await trade.save();

          console.log(`🛡️ [ICT 1H Closed at BE] خروج المتبقي على الدخول لـ ${trade.symbol}`);
          await sendTradeUpdateToTelegram('BE', trade as any, 0);
          continue;
        }

        if (currentPrice >= trade.targets.tp2) {
          trade.status = 'TP2_SECURED';
          await trade.save();

          console.log(`🔥 [ICT 1H TP2] رفع الوقف إلى TP1 لـ ${trade.symbol}`);
          await sendTradeUpdateToTelegram('TP2', trade as any);
          continue;
        }
      }

      // ─── المرحلة الثالثة: تأمين الوقف عند TP1 والهدف الثالث ───
      if (trade.status === 'TP2_SECURED') {
        if (currentPrice <= trade.targets.tp1) {
          const remainingQty = totalQty * 0.50;
          if (remainingQty > 0) {
            await placeMarketSellOrder(trade.symbol, remainingQty);
          }

          const gainPct = ((trade.targets.tp1 - entryPrice) / entryPrice);
          trade.status = 'CLOSED_WIN';
          trade.pnlDollars = trade.allocatedCapital * gainPct;
          trade.pnlPct = parseFloat((gainPct * 100).toFixed(2));
          await trade.save();

          console.log(`🔒 [ICT 1H Trailing SL] إغلاق المتبقي على ربح TP1 لـ ${trade.symbol}`);
          await sendTradeUpdateToTelegram('TRAILING_TP1', trade as any, trade.pnlPct);
          continue;
        }

        if (currentPrice >= trade.targets.tp3) {
          const remainingQty = totalQty * 0.50;
          if (remainingQty > 0) {
            await placeMarketSellOrder(trade.symbol, remainingQty);
          }

          const tp1Gain = (trade.targets.tp1 - entryPrice) / entryPrice;
          const tp3Gain = (trade.targets.tp3 - entryPrice) / entryPrice;
          const totalProfitDollars = (trade.allocatedCapital * 0.5 * tp1Gain) + (trade.allocatedCapital * 0.5 * tp3Gain);
          const totalProfitPct = parseFloat(((totalProfitDollars / trade.allocatedCapital) * 100).toFixed(2));

          trade.status = 'CLOSED_WIN';
          trade.pnlDollars = totalProfitDollars;
          trade.pnlPct = totalProfitPct;
          await trade.save();

          console.log(`👑 [ICT 1H TP3 Full Hit] إغلاق كامل الصفقة بربح تام لـ ${trade.symbol}`);
          await sendTradeUpdateToTelegram('TP3', trade as any, totalProfitPct);
        }
      }
    } catch (error: any) {
      console.error(`⚠️ خطأ تتبع صفقة ICT 1H لـ ${trade.symbol}:`, error.message);
    }
  }
};

export const runLiveTrackerCycle = async () => {
  await trackPendingOrders();
  await trackActiveTrades();
};
