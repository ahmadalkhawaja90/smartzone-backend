import TelegramBot from 'node-telegram-bot-api';
import { CryptoTrade1H } from './cryptoScanner';

const token = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

let bot: TelegramBot | null = null;
if (token) {
  bot = new TelegramBot(token);
}

// دالة لجلب إحصائيات ICT 1H التراكمية مباشرة من MongoDB
async function getICT1HStats() {
  try {
    const closed = await CryptoTrade1H.find({
      status: { $in: ['CLOSED_WIN', 'CLOSED_LOSS'] }
    });

    const stopLossCount = closed.filter(t => t.status === 'CLOSED_LOSS').length;
    const tp1Count = closed.filter(t => t.status === 'CLOSED_WIN' && (t.pnlPct || 0) <= 5.0 && (t.pnlDollars || 0) > 0).length;
    const tp1ThenBECount = closed.filter(t => t.status === 'CLOSED_WIN' && (t.pnlDollars || 0) > 0 && (t.pnlPct || 0) === 0).length;
    const tp3Count = closed.filter(t => t.status === 'CLOSED_WIN' && (t.pnlPct || 0) >= 10.0).length;

    const totalClosed = closed.length;
    const winRatePct = totalClosed > 0 ? ((totalClosed - stopLossCount) / totalClosed) * 100 : 0;

    return { stopLossCount, tp1Count, tp1ThenBECount, tp3Count, totalClosed, winRatePct };
  } catch {
    return { stopLossCount: 0, tp1Count: 0, tp1ThenBECount: 0, tp3Count: 0, totalClosed: 0, winRatePct: 0 };
  }
}

export const generateOneTimeInviteLink = async (): Promise<string | null> => {
  if (!bot || !CHANNEL_ID) return null;
  try {
    const invite = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 3600,
    });
    return invite.invite_link;
  } catch {
    return null;
  }
};

// 1. رسالة فرصة التداول (ICT 1H)
export const sendOpportunityToTelegram = async (opp: any, chartBuffer?: Buffer): Promise<boolean> => {
  if (!bot || !CHANNEL_ID) return false;

  try {
    const symbol = (opp.symbol || 'ASSET').toUpperCase();
    const entry = opp.entryZone?.max ?? opp.entryPrice ?? 0;
    const sl = opp.stopLoss ?? 0;
    const tp1 = opp.targets?.tp1 ?? opp.tp1 ?? 0;
    const tp2 = opp.targets?.tp2 ?? opp.tp2 ?? 0;
    const tp3 = opp.targets?.tp3 ?? opp.tp3 ?? (entry + (tp2 - entry) * 1.5);
    const allocated = opp.allocatedCapital ? `$${opp.allocatedCapital.toFixed(2)}` : '10%';

    const stats = await getICT1HStats();

    const message = 
`💎 *فرصة ICT مؤسسية جديدة (1H)* 💎
═════════════════════════
🪙 *العملة:* #${symbol}
⏱️ *الفريم:* \`1H\`
💵 *Entry (الدخول):* \`${entry}\`
🛑 *SL (الوقف):* \`${sl}\` ❌
🎯 *TP1:* \`${tp1}\`
🚀 *TP2:* \`${tp2}\`
👑 *TP3:* \`${tp3}\`
═════════════════════════
💼 *الحصة التراكمية (10%):* \`${allocated}\`
🛡️ *تأمين 50% من الأرباح عند TP1 ونقل الستوب لسعر الدخول.*

📊 *إحصائيات ICT 1H التراكمية:*
🛑 *ستوب لوس:* \`${stats.stopLossCount}\` | 🎯 *هدف أول:* \`${stats.tp1Count}\`
⚖️ *هدف أول ➔ بريك إيفن:* \`${stats.tp1ThenBECount}\` | 👑 *هدف ثالث:* \`${stats.tp3Count}\`
📈 *معدل الفوز:* \`${stats.winRatePct.toFixed(1)}%\` (المغلقة: ${stats.totalClosed})`;

    if (chartBuffer) {
      await bot.sendPhoto(CHANNEL_ID, chartBuffer, { caption: message, parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
    }
    return true;
  } catch {
    return false;
  }
};

// 2. تحديثات الأهداف والوقف والبريك إيفن
export const sendTradeUpdateToTelegram = async (
  event: 'FILLED' | 'TP1' | 'TP2' | 'TP3' | 'SL' | 'BE' | 'TRAILING_TP1',
  opp: any,
  _tradeProfitPct?: number
) => {
  if (!bot || !CHANNEL_ID) return;

  try {
    const symbol = (opp.symbol || '').toUpperCase();
    const stats = await getICT1HStats();

    let updateText = '';
    if (event === 'FILLED') updateText = `⚡ *تم تفعيل أمر الدخول لعملة* #${symbol}`;
    if (event === 'TP1') updateText = `🎯 *تم تحقيق الهدف الأول (TP1) لعملة* #${symbol} ➔ تأمين الدخول`;
    if (event === 'TP2') updateText = `🚀 *تم تحقيق الهدف الثاني (TP2) لعملة* #${symbol}`;
    if (event === 'TP3') updateText = `👑 *تم تحقيق الهدف النهائي (TP3) بالكامل لعملة* #${symbol}`;
    if (event === 'SL') updateText = `🛑 *ضرب وقف الخسارة (SL) لعملة* #${symbol}`;
    if (event === 'BE') updateText = `🛡️ *إغلاق المتبقي على نقطة الدخول (Break-Even) لعملة* #${symbol}`;
    if (event === 'TRAILING_TP1') updateText = `🔒 *إغلاق المتبقي بربح محجوز عند TP1 لعملة* #${symbol}`;

    const message = 
`${updateText}
═════════════════════════
📊 *إحصائيات ICT 1H المباشرة:*
🛑 *ضرب ستوب لوس:* \`${stats.stopLossCount}\`
🎯 *هدف أول فقط:* \`${stats.tp1Count}\`
⚖️ *هدف أول ➔ بريك إيفن:* \`${stats.tp1ThenBECount}\`
👑 *هدف ثالث بالكامل:* \`${stats.tp3Count}\`
📈 *نسبة النجاح الإجمالية:* \`${stats.winRatePct.toFixed(1)}%\``;

    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
  } catch (error: any) {
    console.error(`Error trade update:`, error.message);
  }
};

export const initTelegramBot = () => {
  if (!token) return;
  console.log('🤖 بوت التلغرام جاهز للعمل...');
};
