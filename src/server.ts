import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import https from 'https';

// تحميل متغيرات البيئة
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

// المسارات الأساسية
app.get('/', (req: Request, res: Response) => {
  res.send('🚀 SmartZone AI Backend is Running Successfully!');
});

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// مسار الاختبار المباشر
app.get('/test-opportunity', (req: Request, res: Response) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID;

  if (!token || !chatId) {
    return res.status(400).json({ success: false, error: 'Telegram credentials missing in environment variables' });
  }

  const messageText = `🧪 *رسالة اختبارية من SmartZone AI*\n\n` +
    `✅ تم التحقق من اتصال السيرفر بنجاح!\n` +
    `🔹 *العملة التجريبية:* #TESTUSDT\n` +
    `🔹 *نوع الصفقة:* SPOT BUY\n` +
    `🔹 *سعر الدخول:* $150.25\n` +
    `🔹 *الهدف الأول:* $158.00\n` +
    `🔹 *وقف الخسارة:* $142.00\n\n` +
    `⚡ البوت يعمل وجاهز لإرسال الفرص الحية.`;

  const postData = JSON.stringify({
    chat_id: chatId,
    text: messageText,
    parse_mode: 'Markdown'
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const telegramReq = https.request(options, (telegramRes) => {
    let responseData = '';
    telegramRes.on('data', (chunk) => { responseData += chunk; });
    telegramRes.on('end', () => {
      res.status(200).json({ success: true, message: '✅ تم إرسال الرسالة الاختبارية بنجاح!', data: JSON.parse(responseData || '{}') });
    });
  });

  telegramReq.on('error', (err) => {
    res.status(500).json({ success: false, error: err.message });
  });

  telegramReq.write(postData);
  telegramReq.end();
});

app.listen(PORT, () => {
  console.log(`📡 Server is running on port: ${PORT}`);
});
