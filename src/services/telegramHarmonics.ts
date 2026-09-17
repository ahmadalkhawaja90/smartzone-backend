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
  tp2?: number;
  tp3?: number;
  riskPct: number;
  score: number;
  allocatedCapital: number;
  fvgTop?: number;
  fvgBottom?: number;
}

export interface StrategyStats {
  stopLossCount: number;
  tp1Count: number;
  tp1ThenBECount: number;
  tp3Count: number;
  totalClosed: number;
  winRatePct: number;
}

export interface TradeOutcomeAlert {
  symbol: string;
  outcome: 'STOP_LOSS' | 'TP1' | 'TP1_THEN_BE' | 'TP3' | 'WIN' | 'LOSS';
  entryPrice: number;
  exitPrice: number;
  pnlDollars: number;
  pnlPct: number;
  allocatedCapital: number;
  currentBalance: number;
  stats?: StrategyStats;
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
🏁 *الهدف الأول (Target 1):* \`${signal.tp1}\` 🎯 (R:R = 1:${rr})
${signal.tp2 ? `🔹 *الهدف الثاني (Target 2):* \`${signal.tp2}\` 🚀\n` : ''}${signal.tp3 ? `👑 *الهدف الثالث (Target 3):* \`${signal.tp3}\` 💎\n` : ''}═════════════════════════
💼 *إدارة رأس المال التراكمي:*
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

// 2. إرسال إشعار إغلاق الصفقة متبوعاً بلوحة الإحصائيات التراكمية
export const sendTradeOutcomeToTelegram = async (data: TradeOutcomeAlert): Promise<boolean> => {
  if (!bot || !CHANNEL_ID) return false;

  let header = '';
  switch (data.outcome) {
    case 'STOP_LOSS':
    case 'LOSS':
      header = '🔴 *تم ضرب وقف الخسارة (STOP LOSS)* 🛑';
      break;
    case 'TP1':
      header = '🎯 *تم تحقيق الهدف الأول (TP1 HIT)* 🚀';
      break;
    case 'TP1_THEN_BE':
      header = '⚖️ *خروج على الدخول بعد الهدف الأول (TP1 ➔ BREAK-EVEN)* 🛡️';
      break;
    case 'TP3':
      header = '👑 *تم تحقيق الهدف الثالث بالكامل (TP3 HIT - FULL TARGET)* 💎';
      break;
    default:
      header = '🟢 *تم إغلاق الصفقة بنجاح* 🎯';
  }

  const pnlSign = data.pnlDollars >= 0 ? '+' : '';

  let message = `
${header}
═════════════════════════
💎 *الزوج:* \`${data.symbol}\`
⏱️ *الفريم:* \`4H\`
🎯 *سعر الدخول:* \`${data.entryPrice}\`
🏁 *سعر الخروج:* \`${data.exitPrice}\`
═════════════════════════
💰 *الربح / الخسارة المحققة:* \`${pnlSign}$${data.pnlDollars.toFixed(2)}\` (\`${pnlSign}${data.pnlPct.toFixed(2)}%\`)
💼 *حجم المركز:* \`$${data.allocatedCapital.toFixed(2)}\`
💵 *رصيد المحفظة التراكمي الآن:* \`$${data.currentBalance.toFixed(2)}\`
`;

  if (data.stats) {
    message += `═════════════════════════
📊 *إحصائيات استراتيجية ICT 4H التراكمية:*
🛑 *ضرب ستوب لوس:* \`${data.stats.stopLossCount}\`
🎯 *هدف أول:* \`${data.stats.tp1Count}\`
⚖️ *هدف أول ➔ بريك إيفن:* \`${data.stats.tp1ThenBECount}\`
👑 *هدف ثالث بالكامل:* \`${data.stats.tp3Count}\`
📈 *معدل الفوز العام:* \`${data.stats.winRatePct.toFixed(1)}%\` (إجمالي الصفقات: ${data.stats.totalClosed})
`;
  }

  try {
    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
    return true;
  } catch (err: any) {
    console.error('❌ خطأ إرسال نتيجة وإحصائيات الصفقة:', err.message);
    return false;
  }
};
