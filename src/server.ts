import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/db';
import { initTelegramBot } from './services/telegramBot';
import { initOpportunityScheduler } from './services/scheduler';
import { initTradeTracker } from './services/tradeTracker';

// تحميل متغيرات البيئة
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

// إعدادات الـ Middleware
app.use(cors());
app.use(express.json());

// مسارات الفحص الأساسية
app.get('/', (req: Request, res: Response) => {
  res.send('🚀 SmartZone AI Backend is Running Successfully!');
});

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// بدء التشغيل وربط الخدمات الخلفية
const startServer = async () => {
  try {
    // 1. الاتصال بقاعدة البيانات أولاً
    await connectDB();

    // 2. تشغيل السيرفر
    app.listen(PORT, () => {
      console.log(`📡 Server is running on port: ${PORT}`);

      // 3. تشغيل البوت والماسحات التلقائية ومتتبع الصفقات
      initTelegramBot();
      initOpportunityScheduler();
      initTradeTracker();
    });
  } catch (error) {
    console.error('❌ فشل بدء تشغيل السيرفر:', error);
    process.exit(1);
  }
};

startServer();
