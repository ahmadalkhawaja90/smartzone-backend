import axios from 'axios';
import { Opportunity, IOpportunity } from '../models/Opportunity';
import { checkOrderStatus, placeMarketSellOrder, cancelBinanceOrder } from './binanceClient';

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
        console.log(`⏱️ [Order Expired] تم إلغاء الأمر المعلق لـ ${opp.symbol} لانتهاء الصلاحية أو تجاوز الهدف.`);
        continue;
      }

      // ب) فحص حالة التنفيذ عبر الـ API
      if (opp.orderId) {
        const orderInfo = await checkOrderStatus(opp.symbol, opp.orderId);
        if (orderInfo && orderInfo.status === 'FILLED') {
          opp.status = 'ACTIVE';
          opp.currentStopLoss = opp.stopLoss;
          await opp.save();
          console.log(`🚀 [Order Filled] تم تفعيل صفقة الشراء بنجاح لـ ${opp.symbol} وتحويلها إلى ACTIVE.`);
        }
      } else {
        // فحص بديل: إذا لم يتوفر orderId ولامس السعر الحد العلوي للفجوة
        if (currentPrice <= opp.entryZone.max) {
          opp.status = 'ACTIVE';
          opp.currentStopLoss = opp.stopLoss;
          await opp.save();
        }
      }
    } catch (error: any) {
      console.error(`⚠️ خطأ تتبع الأمر المعلق لـ ${opp.symbol}:`, error.message);
    }
  }
};

// 2. مراقبة وإدارة الصفقات النشطة (SL, TP1, Break-Even)
const trackActiveTrades = async () => {
  const activeOpps = await Opportunity.find({ status: { $in: ['ACTIVE', 'BREAK_EVEN'] } });

  for (const opp of activeOpps) {
    try {
      const currentPrice = await getLatestPrice(opp.symbol);
      if (!currentPrice) continue;

      const entryPrice = opp.entryZone.max;

      // ==========================================
      // أ) الصفقات بالحالة ACTIVE (قبل تأمين الدخول)
      // ==========================================
      if (opp.status === 'ACTIVE') {
        // ضرب وقف الخسارة الأساسي
        if (currentPrice <= opp.stopLoss) {
          opp.status = 'HIT_SL';
          opp.profitPercentage = parseFloat((((opp.stopLoss - entryPrice) / entryPrice) * 100).toFixed(2));
          opp.closedAt = new Date();
          await opp.save();
          console.log(`🛑 [Stop Loss Hit] ضرب وقف الخسارة لـ ${opp.symbol} عند $${opp.stopLoss}`);
          continue;
        }

        // ضرب الهدف الأول (TP1) -> بيع 25% + نقل الوقف لنقطة الدخول
        if (currentPrice >= opp.targets.tp1) {
          // حساب الكمية وإغلاق 25%
          const allocatedCapital = 10; // $10 لكل صفقة
          const totalQty = allocatedCapital / entryPrice;
          const sellQty = totalQty * 0.25;

          await placeMarketSellOrder(opp.symbol, sellQty);

          opp.status = 'BREAK_EVEN';
          opp.currentStopLoss = entryPrice; // رفع الوقف إلى سعر الدخول
          opp.profitPercentage = parseFloat((((opp.targets.tp1 - entryPrice) / entryPrice) * 100).toFixed(2));
          await opp.save();
          console.log(`🎯 [TP1 Hit & BE Secured] تم جني 25% من أرباح ${opp.symbol} وتأمين باقي الصفقة على الدخول $${entryPrice}`);
        }
      }

      // ==========================================
      // ب) الصفقات بالحالة BREAK_EVEN (مؤمنة على الدخول)
      // ==========================================
      if (opp.status === 'BREAK_EVEN') {
        // ارتداد السعر وضرب نقطة الدخول (خروج بدون خسارة)
        if (currentPrice <= entryPrice) {
          opp.status = 'CLOSED_BE';
          opp.closedAt = new Date();
          await opp.save();
          console.log(`🛡️ [Closed at BE] خرجت الصفقة على نقطة الدخول لـ ${opp.symbol} بدون أي خسارة.`);
          continue;
        }

        // ضرب الهدف الثاني TP2
        if (currentPrice >= opp.targets.tp2) {
          opp.status = 'HIT_TP2';
          await opp.save();
          console.log(`🔥 [TP2 Hit] وصل السعر للهدف الثاني لـ ${opp.symbol} عند $${opp.targets.tp2}`);
        }

        // ضرب الهدف الثالث TP3 (الإغلاق الكامل للأرباح)
        if (currentPrice >= opp.targets.tp3) {
          opp.status = 'HIT_TP3';
          opp.profitPercentage = parseFloat((((opp.targets.tp3 - entryPrice) / entryPrice) * 100).toFixed(2));
          opp.closedAt = new Date();
          await opp.save();
          console.log(`👑 [TP3 Hit - Full TP] تم إغلاق كامل الصفقة بربح قياسي لـ ${opp.symbol} عند $${opp.targets.tp3}`);
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
