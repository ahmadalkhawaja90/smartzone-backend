import axios from 'axios';
import { Opportunity } from '../models/Opportunity';
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

// 1. مراقبة وإدارة الأوامر المعلقة
const trackPendingOrders = async () => {
  const pendingOpps = await Opportunity.find({ status: 'PENDING_ENTRY' });

  for (const opp of pendingOpps) {
    try {
      const currentPrice = await getLatestPrice(opp.symbol);
      if (!currentPrice) continue;

      // أ) التحقق مما إذا كان السعر قد تجاوز TP1 دون تفعيل الشراء (Setup Invalidation)
      const hoursSinceCreation = (Date.now() - new Date(opp.createdAt).getTime()) / (1000 * 60 * 60);
      if (currentPrice >= opp.targets.tp1 || hoursSinceCreation >= 24) {
        if (opp.orderId) {
          await cancelBinanceOrder(opp.symbol, opp.orderId);
        }
        opp.status = 'EXPIRED';
        opp.closedAt = new Date();
        await opp.save();
        console.log(`⏱️ [Order Expired] تم إلغاء الأمر المعلق لـ ${opp.symbol}`);
        continue;
      }

      // ب) فحص حالة التنفيذ عبر الـ API
      let isFilled = false;
      if (opp.orderId) {
        const orderInfo = await checkOrderStatus(opp.symbol, opp.orderId);
        if (orderInfo && orderInfo.status === 'FILLED') {
          isFilled = true;
        }
      } else {
        if (currentPrice <= opp.entryZone.max) {
          isFilled = true;
        }
      }

      if (isFilled) {
        opp.status = 'ACTIVE';
        opp.currentStopLoss = opp.stopLoss;
        await opp.save();
        console.log(`🚀 [Order Filled] تم تفعيل صفقة الشراء لـ ${opp.symbol}`);
        await sendTradeUpdateToTelegram('FILLED', opp);
      }
    } catch (error: any) {
      console.error(`⚠️ خطأ تتبع الأمر المعلق لـ ${opp.symbol}:`, error.message);
    }
  }
};

// 2. مراقبة وإدارة الصفقات النشطة (SL, TP1, Break-Even, Trailing SL, TP3)
const trackActiveTrades = async () => {
  // جلب كافة الصفقات النشطة بمختلف مراحلها
  const activeOpps = await Opportunity.find({ 
    status: { $in: ['ACTIVE', 'BREAK_EVEN', 'TP2_SECURED'] } 
  });

  for (const opp of activeOpps) {
    try {
      const currentPrice = await getLatestPrice(opp.symbol);
      if (!currentPrice) continue;

      const entryPrice = opp.entryZone.max;
      const allocatedCapital = 50; // القيمة المخصصة لكل صفقة (50$)
      const totalQty = allocatedCapital / entryPrice;

      // ==========================================
      // أ) الصفقات بالحالة ACTIVE (قبل تأمين الدخول)
      // ==========================================
      if (opp.status === 'ACTIVE') {
        // ضرب وقف الخسارة الأساسي
        if (currentPrice <= opp.stopLoss) {
          const lossPct = parseFloat((((opp.stopLoss - entryPrice) / entryPrice) * 100).toFixed(2));
          opp.status = 'HIT_SL';
          opp.profitPercentage = lossPct;
          opp.closedAt = new Date();
          await opp.save();
          console.log(`🛑 [Stop Loss Hit] ضرب وقف الخسارة لـ ${opp.symbol}`);
          await sendTradeUpdateToTelegram('SL', opp, lossPct);
          continue;
        }

        // ضرب الهدف الأول (TP1) -> إغلاق 50% ونقل الوقف لنقطة الدخول
        if (currentPrice >= opp.targets.tp1) {
          const sellQty = totalQty * 0.50; // بيع نصف الكمية (50%)
          await placeMarketSellOrder(opp.symbol, sellQty);

          const tp1ProfitPct = parseFloat((((opp.targets.tp1 - entryPrice) / entryPrice) * 100).toFixed(2));
          opp.status = 'BREAK_EVEN';
          opp.currentStopLoss = entryPrice; // الوقف أصبح على الدخول
          opp.profitPercentage = tp1ProfitPct;
          await opp.save();
          console.log(`🎯 [TP1 Hit & 50% Sold] تم بيع 50% وتأمين الدخول لـ ${opp.symbol}`);
          await sendTradeUpdateToTelegram('TP1', opp, tp1ProfitPct);
          continue;
        }
      }

      // ==========================================
      // ب) الصفقات بالحالة BREAK_EVEN (مؤمنة بعد TP1)
      // ==========================================
      if (opp.status === 'BREAK_EVEN') {
        // ارتداد السعر وضرب نقطة الدخول (خروج الـ 50% المتبقية دون خسارة)
        if (currentPrice <= entryPrice) {
          opp.status = 'CLOSED_BE';
          opp.closedAt = new Date();
          await opp.save();
          console.log(`🛡️ [Closed at BE] خروج المتبقي على الدخول لـ ${opp.symbol}`);
          await sendTradeUpdateToTelegram('BE', opp, 0);
          continue;
        }

        // ضرب الهدف الثاني TP2 -> نقل الوقف إلى TP1 لحجز مزيد من الأرباح
        if (currentPrice >= opp.targets.tp2) {
          opp.status = 'TP2_SECURED';
          opp.currentStopLoss = opp.targets.tp1; // رفع الوقف ليصبح عند الهدف الأول
          await opp.save();
          console.log(`🔥 [TP2 Hit & Trailing Moved] تم رفع الوقف إلى TP1 لـ ${opp.symbol}`);
          await sendTradeUpdateToTelegram('TP2', opp);
          continue;
        }
      }

      // ==========================================
      // ج) الصفقات بالحالة TP2_SECURED (الوقف عند TP1)
      // ==========================================
      if (opp.status === 'TP2_SECURED') {
        // ارتداد السعر وضرب وقف TP1 المحجوز
        if (currentPrice <= opp.targets.tp1) {
          const remainingQty = totalQty * 0.50;
          await placeMarketSellOrder(opp.symbol, remainingQty);

          const securedProfitPct = parseFloat((((opp.targets.tp1 - entryPrice) / entryPrice) * 100).toFixed(2));
          opp.status = 'CLOSED_TRAILING_TP1';
          opp.profitPercentage = securedProfitPct;
          opp.closedAt = new Date();
          await opp.save();
          console.log(`🔒 [Trailing SL Hit at TP1] تم إغلاق المتبقي على ربح TP1 لـ ${opp.symbol}`);
          await sendTradeUpdateToTelegram('TRAILING_TP1', opp, securedProfitPct);
          continue;
        }

        // ضرب الهدف الثالث TP3 (الإغلاق التام للـ 50% المتبقية)
        if (currentPrice >= opp.targets.tp3) {
          const remainingQty = totalQty * 0.50;
          await placeMarketSellOrder(opp.symbol, remainingQty);

          const tp3ProfitPct = parseFloat((((opp.targets.tp3 - entryPrice) / entryPrice) * 100).toFixed(2));
          opp.status = 'HIT_TP3';
          opp.profitPercentage = tp3ProfitPct;
          opp.closedAt = new Date();
          await opp.save();
          console.log(`👑 [TP3 Hit] إغلاق كامل الصفقة بنجاح تام لـ ${opp.symbol}`);
          await sendTradeUpdateToTelegram('TP3', opp, tp3ProfitPct);
        }
      }
    } catch (error: any) {
      console.error(`⚠️ خطأ تتبع الصفقة النشطة لـ ${opp.symbol}:`, error.message);
    }
  }
};

// الدالة المجمعة التي يتم استدعاؤها دورياً
export const runLiveTrackerCycle = async () => {
  await trackPendingOrders();
  await trackActiveTrades();
};
