import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/db';
import { initTelegramBot, sendOpportunityToTelegram } from './services/telegramBot';
import { initOpportunityScheduler } from './services/scheduler';
import { sendForexOpportunityToTelegram } from './services/telegramForex';

// تحميل متغيرات البيئة
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

// إعدادات الـ Middleware
app.use(cors());
app.use(express.json());

// الاتصال بقاعدة البيانات
connectDB();

// مسارات الفحص الأساسية
app.get('/', (req: Request, res: Response) => {
  res.send('🚀 SmartZone AI Backend is Running Successfully!');
});

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// بدء تشغيل الخادم
app.listen(PORT, () => {
  console.log(`📡 Server is running on port: ${PORT}`);
});

// تشغيل البوت والماسح الذكي في الخلفية
initTelegramBot();
initOpportunityScheduler();

// اختبار إرسال إشعارات فورية للقناتين
setTimeout(async () => {
  try {
    console.log('🚀 جاري إرسال إشعارات الاختبار للقناتين...');

    // 1. اختبار قناة الفوركس والمعادن
    await sendForexOpportunityToTelegram({
      symbol: 'XAU/USD',
      strategy: 'ICT Silver Bullet (Test)',
      type: 'BUY',
      timeframe: '15m',
      session: 'New York Killzone',
      entryPrice: 2650.50,
      stopLoss: 2642.00,
      tp1: 2665.00,
      tp2: 2680.00,
      score: 96,
      conditions: [
        'اختبار اتصال ناجح مع السيرفر السحابي (Forex & Metals)',
        'تأكيد جاهزية إشعارات القناة وتنسيق التقارير'
      ]
    });

    // 2. اختبار قناة الكريبتو
    await sendOpportunityToTelegram({
      symbol: 'BTC/USDT',
      strategy: 'ICT Institutional Order Block (Test)',
      type: 'BUY',
      timeframe: '1h',
      entryPrice: 68500,
      stopLoss: 67200,
      tp1: 70500,
      tp2: 72000,
      score: 95,
      conditions: [
        'اختبار اتصال ناجح مع السيرفر السحابي (Crypto Channel)',
        'تأكيد جاهزية نظام الرصد الآلي'
      ]
    });
  } catch (error) {
    console.error('خطأ في إرسال رسائل الاختبار:', error);
  }
}, 3000);