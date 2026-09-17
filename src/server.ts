import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/db';
import { initOpportunityScheduler } from './services/scheduler';
import { initTelegramBot } from './services/telegramBot';

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

// بدء التشغيل وربط الخدمات
const startServer = async () => {
  try {
    // 1. الاتصال بقاعدة البيانات
    await connectDB();

    // 2. تفعيل بوت التلجرام للاستماع للأوامر (/balance)
    initTelegramBot();

    // 3. تشغيل السيرفر
    app.listen(PORT, () => {
      console.log(`📡 Server is running on port: ${PORT}`);

      // 4. تشغيل جدول الفحص الآلي (Crypto & Harmonics)
      initOpportunityScheduler();
    });
  } catch (error) {
    console.error('❌ فشل بدء تشغيل السيرفر:', error);
    process.exit(1);
  }
};

startServer();
