import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_HARMONICS_CHANNEL_ID;

export interface HarmonicSignal {
  market: 'CRYPTO' | 'FOREX_METALS' | 'INDICES';
  symbol: string;
  pattern: string;
  type: 'BUY' | 'SELL';
  timeframe: string;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  bRetracement: number;
  dRetracement: number;
  score: number;
}

export const sendHarmonicSignalToTelegram = async (signal: HarmonicSignal): Promise<boolean> => {
  if (!BOT_TOKEN || !CHANNEL_ID) {
    console.warn('⚠️ إعدادات قناة الهارمونيك غير مكتملة في .env (TELEGRAM_HARMONICS_CHANNEL_ID مفقود)');
    return false;
  }

  const directionBadge = signal.type === 'BUY' ? '🟢 شراء صاعد (BUY / LONG)' : '🔴 بيع هابط (SELL / SHORT)';
  const marketBadge =
    signal.market === 'CRYPTO'
      ? '🪙 العملات الرقمية (Crypto)'
      : signal.market === 'FOREX_METALS'
      ? '🥇 المعادن والذهب (Metals & Gold)'
      : '🏛️ المؤشرات الأمريكية (US Indices)';

  const message = `
🎯 <b>تنبيه VIP: اكتمال نموذج هارمونيك هندسي</b>
═════════════════════════
🌐 <b>السوق:</b> ${marketBadge}
💎 <b>الأصل / الزوج:</b> <code>${signal.symbol}</code>
📐 <b>النموذج:</b> <b>${signal.pattern}</b>
⏱️ <b>الفريم الزمني:</b> ${signal.timeframe}
🚦 <b>الاتجاه المتوقع:</b> ${directionBadge}
🏆 <b>نسبة التوافق الرياضي:</b> <b>${signal.score}%</b>
═════════════════════════
🎯 <b>نقطة الدخول (نقطة الانعكاس D):</b> <code>${signal.entryPrice}</code>
🛑 <b>وقف الخسارة المحمي (نقطة X):</b> <code>${signal.stopLoss}</code>

🏁 <b>الأهداف النموذجية (Fibonacci Levels):</b>
  • <b>الهدف الأول (TP1 - 0.382):</b> <code>${signal.tp1}</code>
  • <b>الهدف الثاني (TP2 - 0.618):</b> <code>${signal.tp2}</code>
  • <b>الهدف الثالث (TP3 - 1.000):</b> <code>${signal.tp3}</code>
═════════════════════════
📐 <b>نسب فيبوناتشي المحققة:</b>
  • ارتداد النقطة B: <code>${(signal.bRetracement * 100).toFixed(1)}%</code>
  • منطقة الانعكاس D (PRZ): <code>${(signal.dRetracement * 100).toFixed(1)}%</code>
═════════════════════════
⚠️ <i>إدارة رأس المال: يُنصح بنقل وقف الخسارة لنقطة الدخول فور تحقيق الهدف الأول TP1.</i>
`;

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: CHANNEL_ID,
      text: message,
      parse_mode: 'HTML',
    });
    console.log(`✅ [Harmonic Sent]: ${signal.symbol} - ${signal.pattern} (${signal.type})`);
    return true;
  } catch (error: any) {
    console.error('❌ خطأ إرسال إشعار الهارمونيك:', error.message);
    return false;
  }
};
