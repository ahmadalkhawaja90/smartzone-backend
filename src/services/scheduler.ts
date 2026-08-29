import cron from 'node-cron';
import { runFullCryptoScan } from './cryptoScanner';
import { runHighVolCryptoScan } from './highVolScanner';
import { runForexScan } from './forexScanner';
import { scanAllHarmonics } from './harmonicsScanner';

// أعلام لمنع تداخل عمليات الفحص (Concurrency Locks)
let isForexScanning = false;
let isCryptoScanning = false;
let isHighVolScanning = false;
let isHarmonicScanning = false;

// دالة تنفيذ فحص الفوركس
const executeForexScan = async () => {
  if (isForexScanning) {
    console.warn('⚠️ فحص الفوركس السابق لا يزال قيد التنفيذ، تم تخطي هذه الدورة.');
    return;
  }
  isForexScanning = true;
  try {
    console.log('🌍 بدء فحص أسواق العملات الرئيسية لحظياً (ICT Engine)...');
    await runForexScan();
  } catch (error: any) {
    console.error('❌ خطأ أثناء تنفيذ فحص الفوركس:', error.message || error);
  } finally {
    isForexScanning = false;
  }
};

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

// دالة تنفيذ فحص العملات الرقمية عالية التقلب
const executeHighVolCryptoScan = async () => {
  if (isHighVolScanning) {
    console.warn('⚠️ فحص العملات السريعة السابق لا يزال قيد التنفيذ، تم تخطي هذه الدورة.');
    return;
  }
  isHighVolScanning = true;
  try {
    console.log('⚡ بدء فحص العملات عالية التقلب (High Volatility ICT)...');
    await runHighVolCryptoScan();
  } catch (error: any) {
    console.error('❌ خطأ أثناء تنفيذ فحص العملات السريعة:', error.message || error);
  } finally {
    isHighVolScanning = false;
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
  console.log('⏰ تم تهيئة مجدول الفرص الآلي (ICT Crypto, High-Vol Crypto, Forex & Harmonic Scanners)...');

  // 1. تشغيل فحص أولي بتسلسل زمني لتجنب الضغط على الـ API
  setTimeout(() => executeCryptoScan(), 2000);
  setTimeout(() => executeHighVolCryptoScan(), 10000);
  setTimeout(() => executeHarmonicScan(), 20000);
  setTimeout(() => executeForexScan(), 30000);

  // 2. فحص الفوركس في بداية كل ساعة
  cron.schedule('0 * * * *', async () => {
    await executeForexScan();
  });

  // 3. فحص العملات الرقمية الأساسية كل 10 دقائق
  cron.schedule('*/10 * * * *', async () => {
    await executeCryptoScan();
  });

  // 4. فحص العملات الرقمية عالية التقلب كل 10 دقائق (متباعدة بفارق 5 دقائق عن الكريبتو الأساسي)
  cron.schedule('5,15,25,35,45,55 * * * *', async () => {
    await executeHighVolCryptoScan();
  });

  // 5. فحص نماذج الهارمونيك كل 15 دقيقة
  cron.schedule('*/15 * * * *', async () => {
    await executeHarmonicScan();
  });
};
