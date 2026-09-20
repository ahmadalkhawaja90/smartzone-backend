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

      // أ) إلغاء الأمر إذا تجاوز السعر TP1 دون تفعيل الشراء أو مر أكثر من 24 ساعة
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

      // ب) فحص حالة التنفيذ عبر باينانس أو وصول السعر لمنطقة الدخول
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

// 2. مراقبة وإدارة الصفقات النشطة وجني الأرباح
const trackActiveTrades = async () => {
  const activeOpps = await Opportunity.find({ 
    status: { $in: ['ACTIVE', 'BREAK_EVEN', 'TP2_SECURED'] } 
  });

  for (const opp of activeOpps) {
    try {
      const currentPrice = await getLatestPrice(opp.symbol);
      if (!currentPrice) continue;

      const entryPrice = opp.entryZone.max;
      const allocatedCapital = 150; // تم التعديل إلى 150 دولار (30% من المحفظة)
      const totalQty = allocatedCapital / entryPrice;

      // ==========================================
      // المرحلة الأولى: الصفقة نشطة بالكامل
      // ==========================================
      if (opp.status === 'ACTIVE') {
        // ضرب وقف الخسارة الأولي
        if (currentPrice <= opp.stopLoss) {
          await placeMarketSellOrder(opp.symbol, totalQty);
          const lossPct = parseFloat((((opp.stopLoss - entryPrice) / entryPrice) * 100).toFixed(2));
          const lossAmountUsd = parseFloat((allocatedCapital * (lossPct / 100)).toFixed(2));

          opp.status = 'HIT_SL';
          opp.profitPercentage = lossPct;
          opp.closedAt = new Date();
          await opp.save();
          console.log(`🛑 [Stop Loss Hit] ضرب وقف الخسارة لـ ${opp.symbol} (${lossPct}% | ${lossAmountUsd}$)`);
          await sendTradeUpdateToTelegram('SL', opp, lossPct, lossAmountUsd);
          continue;
        }

        // تحقيق TP1: بيع 50% وتأمين الباقي على الدخول (Break-Even)
        if (currentPrice >= opp.targets.tp1) {
          const sellQty = totalQty * 0.50;
          await placeMarketSellOrder(opp.symbol, sellQty);

          const tp1ProfitPct = parseFloat((((opp.targets.tp1 - entryPrice) / entryPrice) * 100).toFixed(2));
          // الربح المحقق بالدولار لنصف الكمية المباعة
          const tp1RealizedUsd = parseFloat(((allocatedCapital * 0.5) * (tp1ProfitPct / 100)).toFixed(2));

          opp.status = 'BREAK_EVEN';
          opp.currentStopLoss = entryPrice;
          opp.profitPercentage = tp1ProfitPct; 
          await opp.save();
          console.log(`🎯 [TP1 Hit & 50% Sold] تم بيع 50% وتأمين الدخول لـ ${opp.symbol} (+${tp1ProfitPct}% | +${tp1RealizedUsd}$)`);
          await sendTradeUpdateToTelegram('TP1', opp, tp1ProfitPct, tp1RealizedUsd);
          continue;
        }
      }

      // ==========================================
      // المرحلة الثانية: مؤمنة على الدخول بعد ضرب TP1
      // ==========================================
      if (opp.status === 'BREAK_EVEN') {
        // ارتداد السعر لضرب الدخول: بيع الـ 50% المتبقية دون خسارة
        if (currentPrice <= entryPrice) {
          const remainingQty = totalQty * 0.50;
          await placeMarketSellOrder(opp.symbol, remainingQty);

          // إجمالي ربح الصفقة الكاملة هو نصف ربح TP1 (لأن النصف الآخر خرج عند 0%)
          const netTradePct = parseFloat(((opp.profitPercentage || 0) * 0.5).toFixed(2));
          const totalRealizedUsd = parseFloat((allocatedCapital * (netTradePct / 100)).toFixed(2));

          opp.status = 'CLOSED_BE';
          opp.profitPercentage = netTradePct;
          opp.closedAt = new Date();
          await opp.save();
          console.log(`🛡️ [Closed at BE] خروج المتبقي على الدخول لـ ${opp.symbol} (صافي الربح: +${netTradePct}% | +${totalRealizedUsd}$)`);
          await sendTradeUpdateToTelegram('BE', opp, netTradePct, totalRealizedUsd);
          continue;
        }

        // تحقيق الهدف الثاني TP2: نقل الوقف المتبقي إلى مستوى TP1
        if (currentPrice >= opp.targets.tp2) {
          opp.status = 'TP2_SECURED';
          opp.currentStopLoss = opp.targets.tp1;
          await opp.save();
          console.log(`🔥 [TP2 Hit & Trailing Moved] تم رفع الوقف إلى TP1 لـ ${opp.symbol}`);
          await sendTradeUpdateToTelegram('TP2', opp);
          continue;
        }
      }

      // ==========================================
      // المرحلة الثالثة: تأمين ربح TP1 للنصف المتبقي
      // ==========================================
      if (opp.status === 'TP2_SECURED') {
        // ارتداد السعر وضرب وقف TP1 المحجوز
        if (currentPrice <= opp.targets.tp1) {
          const remainingQty = totalQty * 0.50;
          await placeMarketSellOrder(opp.symbol, remainingQty);

          const securedProfitPct = parseFloat((((opp.targets.tp1 - entryPrice) / entryPrice) * 100).toFixed(2));
          const totalRealizedUsd = parseFloat((allocatedCapital * (securedProfitPct / 100)).toFixed(2));

          opp.status = 'CLOSED_TRAILING_TP1';
          opp.profitPercentage = securedProfitPct;
          opp.closedAt = new Date();
          await opp.save();
          console.log(`🔒 [Trailing SL Hit at TP1] إغلاق المتبقي على ربح TP1 لـ ${opp.symbol} (+${securedProfitPct}% | +${totalRealizedUsd}$)`);
          await sendTradeUpdateToTelegram('TRAILING_TP1', opp, securedProfitPct, totalRealizedUsd);
          continue;
        }

        // تحقيق الهدف الأقصى TP3: بيع كامل النصف الأخير
        if (currentPrice >= opp.targets.tp3) {
          const remainingQty = totalQty * 0.50;
          await placeMarketSellOrder(opp.symbol, remainingQty);

          const tp3ProfitPct = parseFloat((((opp.targets.tp3 - entryPrice) / entryPrice) * 100).toFixed(2));
          // احتساب متوسط العائد للنصفين: نصف عند TP1 ونصف عند TP3
          const overallPct = parseFloat((((opp.profitPercentage || 0) * 0.5) + (tp3ProfitPct * 0.5)).toFixed(2));
          const totalRealizedUsd = parseFloat((allocatedCapital * (overallPct / 100)).toFixed(2));

          opp.status = 'HIT_TP3';
          opp.profitPercentage = overallPct;
          opp.closedAt = new Date();
          await opp.save();
          console.log(`👑 [TP3 Hit] إغلاق كامل الصفقة بنجاح لـ ${opp.symbol} (+${overallPct}% | +${totalRealizedUsd}$)`);
          await sendTradeUpdateToTelegram('TP3', opp, overallPct, totalRealizedUsd);
        }
      }
    } catch (error: any) {
      console.error(`⚠️ خطأ تتبع الصفقة النشطة لـ ${opp.symbol}:`, error.message);
    }
  }
};

export const runLiveTrackerCycle = async () => {
  await trackPendingOrders();
  await trackActiveTrades();
};
