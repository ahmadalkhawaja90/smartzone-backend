import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { WyckoffTrade } from './wyckoffScanner';

dotenv.config();

const token = process.env.TELEGRAM_SWING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const swingChannelId = process.env.TELEGRAM_SWING_CHANNEL_ID;

const bot = token ? new TelegramBot(token, { polling: false }) : null;

// دالة لجلب إحصائيات Wyckoff التراكمية مباشرة من MongoDB
async function getWyckoffStats() {
  try {
    const closed = await WyckoffTrade.find({ status: { $in: ['WIN', 'LOSS'] } });
    const stopLossCount = closed.filter(t => t.status === 'LOSS').length;
    const tp1Count = closed.filter(t => t.status === 'WIN' && (t.pnlPct || 0) <= 5.0).length;
    const tp1ThenBECount = closed.filter(t => t.status === 'WIN' && (t.pnlPct || 0) === 0).length;
    const tp3Count = closed.filter(t => t.status === 'WIN' && (t.pnlPct || 0) >= 12.0).length;
    const totalClosed = closed.length;
    const winRatePct = totalClosed > 0 ? ((totalClosed - stopLossCount) / totalClosed) * 100 : 0;

    return { stopLossCount, tp1Count, tp1ThenBECount, tp3Count, totalClosed, winRatePct };
  } catch {
    return { stopLossCount: 0, tp1Count: 0, tp1ThenBECount: 0, tp3Count: 0, totalClosed: 0, winRatePct: 0 };
  }
}

// 1. إرسال فرصة وايكوف جديدة للقناة
export const sendSwingOpportunityToTelegram = async (opp: any, chartBuffer?: Buffer) => {
  if (!bot || !swingChannelId) {
    console.warn('⚠️ [Swing Bot] بيانات التلغرام للقناة الخاصة غير مكتملة في .env');
    return;
  }

  const entryMin = opp.entryMin || (opp.entryPrice * 0.999).toFixed(opp.decimals || 4);
  const entryMax = opp.entryMax || (opp.entryPrice * 1.001).toFixed(opp.decimals || 4);
  const tp3Value = opp.tp3 || (opp.entryPrice + (opp.tp2 - opp.entryPrice) * 1.5).toFixed(opp.decimals || 4);

  const stats = await getWyckoffStats();

  const caption = 
`💎 *إشارة سوينغ مؤسسية — Wyckoff 4H* 💎
═════════════════════════
🪙 *العملة:* #${opp.symbol.toUpperCase()}
⏱️ *الفريم:* \`4H (Swing Execution)\`
🚦 *نوع الصفقة:* 🟢 \`SPOT BUY\`
═════════════════════════
💵 *Entry (منطقة الدخول):* \`${entryMin} - ${entryMax}\`
🛑 *SL (وقف الخسارة):* \`${opp.stopLoss}\` (\`-${opp.riskPercent}%\`) ❌

🎯 *الأهداف الاستثمارية:*
🔹 *TP1:* \`${opp.tp1}\` 🎯
🔹 *TP2:* \`${opp.tp2}\` 🚀
🔹 *TP3:* \`${tp3Value}\` 👑
═════════════════════════
💼 *إدارة رأس المال التراكمي (20%):*
✨ *تأمين ونقل الستوب للدخول فور ملامسة الهدف الأول.*

📊 *إحصائيات استراتيجية Wyckoff التراكمية:*
🛑 *ستوب لوس:* \`${stats.stopLossCount}\` | 🎯 *هدف أول:* \`${stats.tp1Count}\`
⚖️ *هدف أول ➔ بريك إيفن:* \`${stats.tp1ThenBECount}\` | 👑 *هدف ثالث:* \`${stats.tp3Count}\`
📈 *معدل الفوز الإجمالي:* \`${stats.winRatePct.toFixed(1)}%\` (المغلقة: ${stats.totalClosed})`;

  try {
    if (chartBuffer && chartBuffer.length > 0) {
      await bot.sendPhoto(swingChannelId, chartBuffer, {
        caption,
        parse_mode: 'Markdown',
      });
    } else {
      await bot.sendMessage(swingChannelId, caption, {
        parse_mode: 'Markdown',
      });
    }
    console.log(`✅ [Swing Telegram] تم إرسال صفقة ${opp.symbol} بنجاح.`);
  } catch (error: any) {
    console.error(`❌ [Swing Telegram Error] فشل الإرسال لـ ${opp.symbol}:`, error.message);
  }
};

// 2. إشعار الوصول للأهداف
export const sendTargetHitUpdate = async (symbol: string, targetNum: number, price: number) => {
  if (!bot || !swingChannelId) return;

  const stats = await getWyckoffStats();

  const msg = 
`🎯 *تم تحقيق الهدف [TP${targetNum}] بنجاح!* 🚀
═════════════════════════
🪙 *العملة:* #${symbol.toUpperCase()}
💵 *السعر المحقق:* \`${price}\`
🛡️ *الإجراء:* ${targetNum === 1 ? 'تم حجز الأرباح وتأمين الدخول.' : 'مستمرون نحو باقي الأهداف.'}
═════════════════════════
📊 *إحصائيات Wyckoff المباشرة:*
🛑 *ستوب لوس:* \`${stats.stopLossCount}\` | 🎯 *هدف أول:* \`${stats.tp1Count}\`
⚖️ *هدف أول ➔ بريك إيفن:* \`${stats.tp1ThenBECount}\` | 👑 *هدف ثالث:* \`${stats.tp3Count}\`
📈 *نسبة النجاح:* \`${stats.winRatePct.toFixed(1)}%\``;

  try {
    await bot.sendMessage(swingChannelId, msg, { parse_mode: 'Markdown' });
  } catch (err: any) {
    console.error('❌ خطأ إرسال إشعار الهدف:', err.message);
  }
};

// 3. إشعار ضرب الستوب
export const sendStopLossUpdate = async (symbol: string, price: number) => {
  if (!bot || !swingChannelId) return;

  const stats = await getWyckoffStats();

  const msg = 
`🛑 *تنبيه: ضرب وقف الخسارة (Stop Loss)* ❌
═════════════════════════
🪙 *العملة:* #${symbol.toUpperCase()}
💵 *سعر الخروج:* \`${price}\`
═════════════════════════
📊 *إحصائيات Wyckoff المباشرة:*
🛑 *ستوب لوس:* \`${stats.stopLossCount}\` | 🎯 *هدف أول:* \`${stats.tp1Count}\`
⚖️ *هدف أول ➔ بريك إيفن:* \`${stats.tp1ThenBECount}\` | 👑 *هدف ثالث:* \`${stats.tp3Count}\`
📈 *نسبة النجاح:* \`${stats.winRatePct.toFixed(1)}%\``;

  try {
    await bot.sendMessage(swingChannelId, msg, { parse_mode: 'Markdown' });
  } catch (err: any) {
    console.error('❌ خطأ إرسال إشعار الستوب:', err.message);
  }
};
