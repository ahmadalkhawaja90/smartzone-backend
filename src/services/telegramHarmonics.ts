import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_HARMONICS_CHANNEL_ID;

let bot: TelegramBot | null = null;
if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN);
}

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

export const sendHarmonicSignalToTelegram = async (
  signal: HarmonicSignal,
  chartBuffer?: Buffer
): Promise<boolean> => {
  if (!bot || !CHANNEL_ID) {
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
📐 *SMARTZONE HARMONIC AI — تنبيه استباقي* ⚡
═════════════════════════
🌐 *السوق:* ${marketBadge}
💎 *الأصل / الزوج:* \`${signal.symbol}\`
📐 *النموذج المتوقع:* *${signal.pattern}*
⏱️ *الإطار الزمني:* \`${signal.timeframe}\`
🚦 *نوع التمركز:* ${orderType}
🏆 *نسبة التوافق الهندسي:* \`${signal.score}%\` 🔥
═════════════════════════
🎯 *منطقة الانعكاس المتوقعة (Point D):* \`${signal.entryPrice}\`
🛑 *وقف الخسارة المحكم (Invalidation):* \`${signal.stopLoss}\` ❌

🏁 *المستويات المستهدفة (Fibonacci Targets):*
  🔹 *الهدف الأول (TP1 - 0.382):* \`${signal.tp1}\` 🎯
  🔹 *الهدف الثاني (TP2 - 0.618):* \`${signal.tp2}\` 🚀
  🔹 *الهدف الممتد (TP3 - 1.000):* \`${signal.tp3}\` 👑
═════════════════════════
💡 *القراءة الهندسية:*
✨ اكتمل تشكل الأضلاع (XA, AB, BC) بنسب فيبوناتشي دقيقة. السعر يتجه حالياً نحو منطقة الانعكاس المحتملة (PRZ - النقطة D) لارتداد متوقع.
`;

  try {
    if (chartBuffer) {
      await bot.sendPhoto(CHANNEL_ID, chartBuffer, {
        caption: message,
        parse_mode: 'Markdown',
      });
    } else {
      await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
    }

    console.log(`✅ [Harmonic + Chart Sent]: ${signal.symbol} - ${signal.pattern} (${signal.type})`);
    return true;
  } catch (error: any) {
    console.error('❌ خطأ إرسال إشعار الهارمونيك:', error.message);
    return false;
  }
};
