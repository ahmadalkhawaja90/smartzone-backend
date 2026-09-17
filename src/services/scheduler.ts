import cron from 'node-cron';
import { runFullCryptoScan } from './cryptoScanner';
import { runLiveTrackerCycle } from './liveTracker';
import { runWyckoffScannerJob } from './wyckoffScanner';
import { runICT4HScannerJob } from './scannerICT4H';

// أعلام لمنع تداخل عمليات الفحص والمراقبة (Concurrency Locks)
let isCryptoScanning = false;
let isTrackerRunning = false;
let isWyckoffScanning = false;
let isICT4HScanning = false;

// دالة تنفيذ فحص الكريبتو الأساسي (1H)
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

// دالة تنفيذ فحص السوينغ (وايكوف 4H)
const executeWyckoffScan = async () => {
  if (isWyckoffScanning) {
    console.warn('⚠️ فحص وايكوف السابق لا يزال قيد التنفيذ، تم تخطي هذه الدورة.');
    return;
  }
  isWyckoffScanning = true;
  try {
    console.log('💎 بدء فحص نماذج السوينغ المؤسسي (Wyckoff 4H)...');
    await runWyckoffScannerJob();
  } catch (error: any) {
    console.error('❌ خطأ أثناء تنفيذ فحص السوينغ المؤسسي:', error.message || error);
  } finally {
    isWyckoffScanning = false;
  }
};

// دالة تنفيذ محرك ICT 4H الجديد (فحص ومتابعة الصفقات وحساب التراكمي)
const executeICT4HScan = async () => {
  if (isICT4HScanning) {
    return;
  }
  isICT4HScanning = true;
  try {
    await runICT4HScannerJob();
  } catch (error: any) {
    console.error('❌ خطأ أثناء تنفيذ دورة ICT 4H:', error.message || error);
  } finally {
    isICT4HScanning = false;
  }
};

export const initOpportunityScheduler = () => {
  console.log('⏰ تم تهيئة مجدول الفرص والمراقبة الحية (ICT 1H, Wyckoff, Live Tracker & ICT 4H Engine)...');

  // 1. تشغيل أولي بتسلسل زمني مدروس لتجنب تجاوز حدود الـ API
  setTimeout(() => executeCryptoScan(), 2000);
  setTimeout(() => executeLiveTracker(), 5000);
  setTimeout(() => executeICT4HScan(), 10000);
  setTimeout(() => executeWyckoffScan(), 20000);

  // 2. المراقبة اللحظية للصفقات المفتوحة وتحديث أهداف/وقف ICT 4H (كل دقيقة)
  cron.schedule('* * * * *', async () => {
    await executeLiveTracker();
    await executeICT4HScan();
  });

  // 3. فحص العملات الرقمية للاستراتيجية الأساسية (ICT 1H) كل 10 دقائق
  cron.schedule('*/10 * * * *', async () => {
    await executeCryptoScan();
  });

  // 4. فحص نماذج وايكوف كل ساعة عند الدقيقة 5
  cron.schedule('5 * * * *', async () => {
    await executeWyckoffScan();
  });
};
