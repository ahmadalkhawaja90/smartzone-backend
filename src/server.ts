import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/db';
import { initTelegramBot } from './services/telegramBot';
import { initOpportunityScheduler } from './services/scheduler';

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

// تشغيل البوت والماسح الذكي في الخلفية للعمل الحقيقي المباشر
initTelegramBot();
initOpportunityScheduler();
