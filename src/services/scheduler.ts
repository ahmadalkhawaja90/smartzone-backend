import cron from 'node-cron';
import { runFullCryptoScan } from './cryptoScanner';
import { runLiveTrackerCycle } from './liveTracker';

// أعلام لمنع تداخل عمليات الفحص والمراقبة (Concurrency Locks)
let isCryptoScanning = false;
let isTrackerRunning = false;

// دالة تنفيذ فحص الكريبتو الأساسي (ICT 1H)
const executeCryptoScan = async () => {
  if (isCryptoScanning) {
    console.warn('⚠️ فحص الكريبتو السابق لا يزال قيد التنفيذ، تم تخطي هذه الدورة.');
    return;
  }
  isCryptoScanning = true;
  try {
    console.log('🔄 بدء فحص سوق العملات الرقمية (Crypto ICT 1H)...');
    await runFullCryptoScan();
  } catch (error: any) {
    console.error('❌ خطأ أثناء تنفيذ فحص العملات الرقمية:', error.message || error);
  } finally {
    isCryptoScanning = false;
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
  console.log('⏰ تم تهيئة مجدول الفرص والمراقبة الحية (ICT 1H & Live Tracker)...');

  // 1. تشغيل أولي بتسلسل زمني مدروس لتجنب تجاوز حدود الـ API
  setTimeout(() => executeCryptoScan(), 2000);
  setTimeout(() => executeLiveTracker(), 5000);

  // 2. المراقبة اللحظية للصفقات المفتوحة (كل دقيقة)
  cron.schedule('* * * * *', async () => {
    await executeLiveTracker();
  });

  // 3. فحص العملات الرقمية للاستراتيجية الأساسية (ICT 1H) كل 10 دقائق
  cron.schedule('*/10 * * * *', async () => {
    await executeCryptoScan();
  });
};
