import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_HARMONICS_CHANNEL_ID;

let bot: TelegramBot | null = null;
if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN);
}

export interface ICT4HSignal {
  symbol: string;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  riskPct: number;
  score: number;
  allocatedCapital: number;
  fvgTop?: number;
  fvgBottom?: number;
}

export interface TradeOutcomeAlert {
  symbol: string;
  outcome: 'WIN' | 'LOSS';
  entryPrice: number;
  exitPrice: number;
  pnlDollars: number;
  pnlPct: number;
  allocatedCapital: number;
  currentBalance: number;
}

// 1. إرسال إشعار فتح صفقة جديدة
export const sendICT4HSignalToTelegram = async (
  signal: ICT4HSignal,
  chartBuffer?: Buffer
): Promise<boolean> => {
  if (!bot || !CHANNEL_ID) {
    console.warn('⚠️ إعدادات التليجرام غير مكتملة في .env');
    return false;
  }

  const rr = ((signal.tp1 - signal.entryPrice) / (signal.entryPrice - signal.stopLoss)).toFixed(2);

  const message = `
⚡ *SMARTZONE AI — صفقة ICT جديدة (4H)* 🎯
═════════════════════════
💎 *الزوج:* \`${signal.symbol}\`
⏱️ *الفريم الزمني:* \`4H (Swing Execution)\`
🚦 *نوع الأمر:* 🟢 *شراء مباشر / معلق (BUY)*
🏆 *سكور الجودة (Score):* \`${signal.score}/100\` 🔥
═════════════════════════
🎯 *سعر الدخول (FVG Entry):* \`${signal.entryPrice}\`
🛑 *وقف الخسارة (Sweep Low):* \`${signal.stopLoss}\` (\`-${signal.riskPct}%\`) ❌
🏁 *الهدف الأول (Target 1):* \`${signal.tp1}\` 🎯
📊 *نسبة العائد إلى المخاطرة (R:R):* \`1:${rr}\`
═════════════════════════
💼 *إدارة رأس المال والمحفظة:*
💵 *الحصة المخصصة (30%):* \`$${signal.allocatedCapital.toFixed(2)}\`
🛡️ *أقصى مخاطرة مسموحة:* \`$${((signal.allocatedCapital * signal.riskPct) / 100).toFixed(2)}\`
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
    console.log(`✅ [Telegram ICT 4H Sent]: ${signal.symbol}`);
    return true;
  } catch (error: any) {
    console.error('❌ خطأ إرسال إشعار التليجرام:', error.message);
    return false;
  }
};

// 2. إرسال إشعار إغلاق صفقة (ربح أو وقف خسارة)
export const sendTradeOutcomeToTelegram = async (data: TradeOutcomeAlert): Promise<boolean> => {
  if (!bot || !CHANNEL_ID) return false;

  const isWin = data.outcome === 'WIN';
  const header = isWin ? '🟢 *تم تحقيق الهدف بنجاح (TP1 HIT)* 🚀' : '🔴 *تم ضرب وقف الخسارة (STOP LOSS)* 🛑';
  const pnlSign = isWin ? '+' : '';

  const message = `
${header}
═════════════════════════
💎 *الزوج:* \`${data.symbol}\`
⏱️ *الفريم:* \`4H\`
🎯 *سعر الدخول:* \`${data.entryPrice}\`
🏁 *سعر الخروج:* \`${data.exitPrice}\`
═════════════════════════
💰 *الربح / الخسارة المحققة:* \`${pnlSign}$${data.pnlDollars.toFixed(2)}\` (\`${pnlSign}${data.pnlPct.toFixed(2)}%\`)
💼 *حجم المركز:* \`$${data.allocatedCapital.toFixed(2)}\`
💵 *رصيد المحفظة الحالي:* \`$${data.currentBalance.toFixed(2)}\`
`;

  try {
    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
    return true;
  } catch (err: any) {
    console.error('❌ خطأ إرسال نتيجة الصفقة:', err.message);
    return false;
  }
};
