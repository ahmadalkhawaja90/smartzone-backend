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

  const orderType = signal.type === 'BUY' ? '🟢 أمر شراء معلق (BUY LIMIT)' : '🔴 أمر بيع معلق (SELL LIMIT)';
  const marketBadge =
    signal.market === 'CRYPTO'
      ? '🪙 العملات الرقمية (Crypto)'
      : signal.market === 'FOREX_METALS'
      ? '🥇 الفوركس والمعادن (Forex & Metals)'
      : '🏛️ المؤشرات العالمية (Global Indices)';

  const message = `
📐 <b>SMARTZONE HARMONIC AI — تنبيه استباقي</b> ⚡
═════════════════════════
🌐 <b>السوق:</b> ${marketBadge}
💎 <b>الأصل / الزوج:</b> <code>${signal.symbol}</code>
📐 <b>النموذج المتوقع:</b> <b>${signal.pattern}</b>
⏱️ <b>الإطار الزمني:</b> <code>${signal.timeframe}</code>
🚦 <b>نوع التمركز:</b> ${orderType}
🏆 <b>نسبة التوافق الهندسي:</b> <code>${signal.score}%</code> 🔥
═════════════════════════
🎯 <b>منطقة الانعكاس المتوقعة (Point D):</b> <code>${signal.entryPrice}</code>
🛑 <b>وقف الخسارة المحكم (Invalidation):</b> <code>${signal.stopLoss}</code> ❌

🏁 <b>المستويات المستهدفة (Fibonacci Targets):</b>
  🔹 <b>الهدف الأول (TP1 - 0.382):</b> <code>${signal.tp1}</code> 🎯
  🔹 <b>الهدف الثاني (TP2 - 0.618):</b> <code>${signal.tp2}</code> 🚀
  🔹 <b>الهدف الممتد (TP3 - 1.000):</b> <code>${signal.tp3}</code> 👑
═════════════════════════
💡 <b>القراءة الهندسية:</b>
✨ اكتمل تشكل الأضلاع (XA, AB, BC) بنسب فيبوناتشي دقيقة. السعر يتجه حالياً نحو منطقة الانعكاس المحتملة (PRZ - النقطة D) لارتداد متوقع.
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
