import cron from 'node-cron';
import { runFullCryptoScan } from './cryptoScanner';
import { scanAllHarmonics } from './harmonicsScanner';
import { runLiveTrackerCycle } from './liveTracker';

// أعلام لمنع تداخل عمليات الفحص والمراقبة (Concurrency Locks)
let isCryptoScanning = false;
let isHarmonicScanning = false;
let isTrackerRunning = false;

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

// دالة تنفيذ المراقبة اللحظية والتنفيذ الآلي
const executeLiveTracker = async () => {
  if (isTrackerRunning) return;
  isTrackerRunning = true;
  try {
    await runLiveTrackerCycle();
  } catch (error: any) {
    console.error('❌ خطأ أثناء دورة التتبع اللحظي:', error.message || error);
  } finally {
    isTrackerRunning = false;
  }
};

export const initOpportunityScheduler = () => {
  console.log('⏰ تم تهيئة مجدول الفرص والمراقبة الحية (ICT Engine, Harmonics & Live Tracker)...');

  // 1. تشغيل أولي بتسلسل زمني لتجنب الضغط على الـ API
  setTimeout(() => executeCryptoScan(), 2000);
  setTimeout(() => executeHarmonicScan(), 10000);
  setTimeout(() => executeLiveTracker(), 5000);

  // 2. المراقبة اللحظية للصفقات والأوامر المعلقة (كل دقيقة)
  cron.schedule('* * * * *', async () => {
    await executeLiveTracker();
  });

  // 3. فحص العملات الرقمية الأساسية لاقتناص الفرص كل 10 دقائق
  cron.schedule('*/10 * * * *', async () => {
    await executeCryptoScan();
  });

  // 4. فحص نماذج الهارمونيك كل 15 دقيقة
  cron.schedule('*/15 * * * *', async () => {
    await executeHarmonicScan();
  });
};
