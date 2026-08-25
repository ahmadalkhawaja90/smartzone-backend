import axios from 'axios';
import cron from 'node-cron';
import { Opportunity } from '../models/Opportunity';
import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

const bot = token ? new TelegramBot(token) : null;

// ==========================================
// 1. جلب السعر الحالي للعملة
// ==========================================
const getCurrentPrice = async (symbol: string): Promise<number | null> => {
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/tickers', {
      params: { category: 'spot', symbol },
      timeout: 5000
    });
    if (res.data.result?.list?.length > 0) {
      return parseFloat(res.data.result.list[0].lastPrice);
    }
    return null;
  } catch (error) {
    return null;
  }
};

// ==========================================
// 2. تحديث حالة الصفقات النشطة
// ==========================================
export const trackActiveTrades = async () => {
  console.log('🔄 [Trade Tracker] فحص حالة الصفقات النشطة...');
  try {
    // جلب الصفقات النشطة فقط
    const activeTrades = await Opportunity.find({ status: 'ACTIVE' });
    
    if (activeTrades.length === 0) return;

    for (const trade of activeTrades) {
      const currentPrice = await getCurrentPrice(trade.symbol);
      if (!currentPrice) continue;

      let isClosed = false;
      let newStatus = 'ACTIVE';

      // فحص صفقات الشراء (SPOT_BUY)
      if (trade.type === 'SPOT_BUY') {
        if (currentPrice <= trade.stopLoss) {
          newStatus = 'LOST';
          isClosed = true;
        } else if (currentPrice >= trade.targets.tp1) {
          // يمكن هنا جعله يتتبع TP2 و TP3، للتبسيط سنعتبر وصوله لـ TP1 هو ربح
          newStatus = 'WON';
          isClosed = true;
        }
      } 
      // فحص صفقات البيع (SELL)
      else if (trade.type === 'SELL') {
        if (currentPrice >= trade.stopLoss) {
          newStatus = 'LOST';
          isClosed = true;
        } else if (currentPrice <= trade.targets.tp1) {
          newStatus = 'WON';
          isClosed = true;
        }
      }

      if (isClosed) {
        trade.status = newStatus as 'WON' | 'LOST' | 'ACTIVE';
        await trade.save();
        console.log(`✅ [Trade Tracker] تم إغلاق صفقة ${trade.symbol} بحالة: ${newStatus}`);
      }
    }
  } catch (error) {
    console.error('❌ خطأ في تتبع الصفقات:', error);
  }
};

// ==========================================
// 3. التقرير اليومي
// ==========================================
export const sendDailyReport = async () => {
  if (!bot || !CHANNEL_ID) return;

  console.log('📊 [Trade Tracker] إعداد التقرير اليومي...');
  
  try {
    // جلب صفقات آخر 24 ساعة
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const closedTrades = await Opportunity.find({
      status: { $in: ['WON', 'LOST'] },
      updatedAt: { $gte: yesterday }
    });

    if (closedTrades.length === 0) {
      console.log('⚠️ لا توجد صفقات مغلقة اليوم لإرسال تقرير.');
      return;
    }

    const won = closedTrades.filter(t => t.status === 'WON').length;
    const lost = closedTrades.filter(t => t.status === 'LOST').length;
    const total = won + lost;
    const winRate = ((won / total) * 100).toFixed(1);

    const message = `
📊 *تقرير التداول اليومي - SMARTZONE AI* ⚡
═════════════════════════
🗓️ *تاريخ التقرير:* \`${new Date().toLocaleDateString('en-GB')}\`

📈 *إجمالي الصفقات المغلقة:* \`${total}\` صفقة
✅ *الصفقات الرابحة:* \`${won}\`
❌ *الصفقات الخاسرة:* \`${lost}\`

🏆 *نسبة النجاح (Win Rate):* \`${winRate}%\`
═════════════════════════
_ملاحظة: الصفقات الرابحة هي التي حققت الهدف الأول (TP1) كحد أدنى._
`;

    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
    console.log('✅ تم إرسال التقرير اليومي إلى التلغرام.');

  } catch (error) {
    console.error('❌ خطأ في إرسال التقرير اليومي:', error);
  }
};

// ==========================================
// 4. تشغيل المجدول الزمني (Cron Jobs)
// ==========================================
export const initTradeTracker = () => {
  // تشغيل فحص الأسعار كل 15 دقيقة
  cron.schedule('*/15 * * * *', () => {
    trackActiveTrades();
  });

  // إرسال التقرير اليومي الساعة 11:30 مساءً (بتوقيت الخادم / الأردن UTC+3)
  cron.schedule('30 23 * * *', () => {
    sendDailyReport();
  }, {
    timezone: "Asia/Amman"
  });

  console.log('🕒 تم تفعيل نظام التتبع الآلي والتقارير اليومية...');
};