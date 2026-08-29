import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/db';
import { initTelegramBot } from './services/telegramBot';
import { initOpportunityScheduler } from './services/scheduler';
import { initTradeTracker } from './services/tradeTracker';
import { sendOpportunityToTelegram } from './services/telegramHighVolBot'; // استيراد دالة إرسال التليجرام

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

// مسار اختباري لإرسال صفقة وهمية فوراً لقناة التليجرام
app.get('/test-opportunity', async (req: Request, res: Response) => {
  try {
    const mockOpportunity = {
      symbol: 'TESTUSDT',
      market: 'crypto',
      timeframe: '1h',
      type: 'SPOT_BUY',
      currentPrice: 150.25,
      entryZone: { min: 148.0, max: 150.0 },
      stopLoss: 142.0,
      targets: { tp1: 158.0, tp2: 165.0, tp3: 175.0 },
      riskRewardRatio: '1:3.0',
      confluenceScore: 99,
      fulfilledConditions: [
        { title: 'Liquidity Sweep', description: 'اختبار سحب السيولة الوهمي' },
        { title: 'Test MSS', description: 'اختبار كسر الهيكل التجريبي' }
      ],
      analysisReasons: {
        entryReason: 'هذه صفقة اختبارية للتأكد من ربط القناة بنجاح.',
        stopLossReason: 'وقف خسارة تجريبي.',
        takeProfitReason: 'الأهداف التجريبية.'
      },
      status: 'ACTIVE'
    };

    // إرسال الصفقة التجريبية (بدون شارت أو مع شارت فارغ)
    await sendOpportunityToTelegram(mockOpportunity as any);

    res.status(200).json({ success: true, message: '✅ تم إرسال صفقة الاختبار إلى التليجرام بنجاح!' });
  } catch (error: any) {
    console.error('❌ خطأ في إرسال صفقة الاختبار:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// بدء التشغيل
const startServer = async () => {
  try {
    // 1. الاتصال بقاعدة البيانات أولاً
    await connectDB();

    // 2. تشغيل السيرفر
    app.listen(PORT, () => {
      console.log(`📡 Server is running on port: ${PORT}`);

      // 3. تشغيل البوت والماسح الذكي ومتتبع الصفقات في الخلفية
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
