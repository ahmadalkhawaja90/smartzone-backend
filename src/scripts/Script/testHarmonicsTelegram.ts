import dotenv from 'dotenv';
import { sendHarmonicSignalToTelegram, HarmonicSignal } from '../services/telegramHarmonics';

dotenv.config();

const runHarmonicsTest = async () => {
  console.log('🧪 بدء اختبار إرسال صفقة تجريبية لقناة الهارمونيك...');

  // نموذج صفقة شراء هارمونيك تجريبية (Bullish Gartley على الذهب)
  const testSignal: HarmonicSignal = {
    market: 'FOREX_METALS',
    symbol: 'XAU/USD (Gold)',
    pattern: 'Bullish Gartley 📐',
    type: 'BUY',
    timeframe: '1h',
    entryPrice: 2635.50,
    stopLoss: 2618.00,
    tp1: 2648.20,
    tp2: 2656.80,
    tp3: 2670.00,
    bRetracement: 0.618,
    dRetracement: 0.786,
    score: 98,
  };

  const success = await sendHarmonicSignalToTelegram(testSignal);

  if (success) {
    console.log('✅ تم إرسال رسالة الاختبار بنجاح إلى قناة الهارمونيك!');
  } else {
    console.error('❌ فشل الإرسال. تحقق من TELEGRAM_HARMONICS_CHANNEL_ID ومن صلاحيات البوت كـ Admin.');
  }
};

runHarmonicsTest();
