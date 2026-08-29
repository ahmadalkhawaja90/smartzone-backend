import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
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

// مسار اختباري يرسل رسالة فورية ومباشرة عبر Telegram API
app.get('/test-opportunity', async (req: Request, res: Response) => {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHANNEL_ID;

    if (!token || !chatId) {
      return res.status(400).json({ success: false, error: 'Telegram credentials missing in .env' });
    }

    const testMessage = `🧪 *رسالة اختبارية من SmartZone AI*\n\n` +
      `✅ تم التحقق من اتصال السيرفر بنجاح!\n` +
      `🔹 *العملة التجريبية:* #TESTUSDT\n` +
      `🔹 *نوع الصفقة:* SPOT BUY\n` +
      `🔹 *سعر الدخول:* $150.25\n` +
      `🔹 *الهدف الأول:* $158.00\n` +
      `🔹 *وقف الخسارة:* $142.00\n\n` +
      `⚡ البوت يعمل وجاهز لإرسال الفرص الحية.`;

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text: testMessage,
      parse_mode: 'Markdown'
    });

    res.status(200).json({ success: true, message: '✅ تم إرسال الرسالة الاختبارية إلى القناة بنجاح!' });
  } catch (error: any) {
    console.error('❌ خطأ في إرسال الاختبار:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// بدء التشغيل
const startServer = async () => {
  try {
    await connectDB();

    app.listen(PORT, () => {
      console.log(`📡 Server is running on port: ${PORT}`);
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
