import cron from 'node-cron';
import { runFullCryptoScan } from './cryptoScanner';
import { runForexScan } from './forexScanner';
import { scanAllHarmonics } from './harmonicsScanner';
import { sendHarmonicSignalToTelegram } from './telegramHarmonics';

export const initOpportunityScheduler = () => {
  console.log('⏰ تم تفعيل جدولة الماسحات الذكية...');

  // تشغيل فوري أولي وإرسال رسالة اختبار لقناة الهارمونيك
  setTimeout(async () => {
    console.log('🧪 جاري إرسال صفقة تجريبية لقناة الهارمونيك للتأكد من الربط...');
    await sendHarmonicSignalToTelegram({
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
    });

    await runFullCryptoScan();
    await runForexScan();
    await scanAllHarmonics();
  }, 5000);

  // مسح الكريبتو ICT (كل 10 دقائق)
  cron.schedule('*/10 * * * *', async () => {
    await runFullCryptoScan();
  });

  // مسح الفوركس والمعادن ICT (كل 5 دقائق)
  cron.schedule('*/5 * * * *', async () => {
    await runForexScan();
  });

  // مسح الهارمونيك الموحد VIP (كل 10 دقائق)
  cron.schedule('*/10 * * * *', async () => {
    await scanAllHarmonics();
  });
};
