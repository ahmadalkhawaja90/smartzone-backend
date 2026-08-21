import cron from 'node-cron';
import { runFullCryptoScan } from './cryptoScanner';
import { runForexScan } from './forexScanner';

export const initOpportunityScheduler = () => {
  console.log('⏰ تم تهيئة مجدول الفرص الآلي (ICT Crypto & Forex Scanners)...');

  // 1. تشغيل فحص فوري عند إقلاع السيرفر لكلا النظامين
  runFullCryptoScan();
  runForexScan();

  // 2. تشغيل فحص الفوركس والمعادن كل 5 دقائق
  cron.schedule('*/5 * * * *', async () => {
    console.log('🌍 فحص دوري لأسواق الفوركس والذهب (ICT & Silver Bullet)...');
    await runForexScan();
  });

  // 3. تشغيل فحص العملات الرقمية كل 10 دقائق
  cron.schedule('*/10 * * * *', async () => {
    console.log('🔄 فحص دوري لسوق العملات الرقمية (Crypto ICT Scanner)...');
    await runFullCryptoScan();
  });
};