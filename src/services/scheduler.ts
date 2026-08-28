import cron from 'node-cron';
import { runFullCryptoScan } from './cryptoScanner';
import { runForexScan } from './forexScanner';
import { scanAllHarmonics } from './harmonicsScanner'; // الاسم المطابق للمصدر داخل ملفك

// أعلام لمنع تداخل عمليات الفحص (Concurrency Locks)
let isForexScanning = false;
let isCryptoScanning = false;
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

// دالة تنفيذ فحص الكريبتو (لم يتم تغييرها نهائياً)
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

// دالة تنفيذ فحص نماذج الهارمونيك (لم يتم تغييرها نهائياً)
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
  console.log('⏰ تم تهيئة مجدول الفرص الآلي (ICT Crypto, Forex & Harmonic Scanners)...');

  // 1. تشغيل فحص فوري عند إقلاع السيرفر
  executeForexScan();
  executeCryptoScan();
  executeHarmonicScan();

  // 2. فحص الفوركس يضبط تماماً في الدقيقة الأولى من كل ساعة (لصيد الفرصة فور إغلاق الشمعة تماماً)
  cron.schedule('0 * * * *', async () => {
    await executeForexScan();
  });

  // 3. فحص العملات الرقمية كل 10 دقائق (كما هي دون تغيير)
  cron.schedule('*/10 * * * *', async () => {
    await executeCryptoScan();
  });

  // 4. فحص نماذج الهارمونيك كل 15 دقيقة (كما هي دون تغيير)
  cron.schedule('*/15 * * * *', async () => {
    await executeHarmonicScan();
  });
};
