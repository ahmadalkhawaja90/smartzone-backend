import cron from 'node-cron';
import { runFullCryptoScan } from './cryptoScanner';
import { scanAllHarmonics } from './harmonicsScanner';

// أعلام لمنع تداخل عمليات الفحص (Concurrency Locks)
let isCryptoScanning = false;
let isHarmonicScanning = false;

// دالة تنفيذ فحص الكريبتو الأساسي
const executeCryptoScan = async () => {
  if (isCryptoScanning) {
    console.warn('⚠️ فحص الكريبتو السابق لا يزال قيد التنفيذ، تم تخطي هذه الدورة.');
    return;
  }
  isCryptoScanning = true;
  try {
    console.log('🔄 بدء فحص سوق العملات الرقمية (Crypto ICT Scanner)...');
    await runFullCryptoScan();
  } catch (error: any) {
    console.error('❌ خطأ أثناء تنفيذ فحص العملات الرقمية:', error.message || error);
  } finally {
    isCryptoScanning = false;
  }
};

// دالة تنفيذ فحص نماذج الهارمونيك
const executeHarmonicScan = async () => {
  if (isHarmonicScanning) {
    console.warn('⚠️ فحص الهارمونيك السابق لا يزال قيد التنفيذ، تم تخطي هذه الدورة.');
    return;
  }
  isHarmonicScanning = true;
  try {
    await scanAllHarmonics();
  } catch (error: any) {
    console.error('❌ خطأ أثناء تنفيذ فحص الهارمونيك:', error.message || error);
  } finally {
    isHarmonicScanning = false;
  }
};

export const initOpportunityScheduler = () => {
  console.log('⏰ تم تهيئة مجدول الفرص الآلي (ICT Crypto & Harmonic Scanners)...');

  // 1. تشغيل فحص أولي بتسلسل زمني لتجنب الضغط على الـ API
  setTimeout(() => executeCryptoScan(), 2000);
  setTimeout(() => executeHarmonicScan(), 10000);

  // 2. فحص العملات الرقمية الأساسية كل 10 دقائق
  cron.schedule('*/10 * * * *', async () => {
    await executeCryptoScan();
  });

  // 3. فحص نماذج الهارمونيك كل 15 دقيقة
  cron.schedule('*/15 * * * *', async () => {
    await executeHarmonicScan();
  });
};
