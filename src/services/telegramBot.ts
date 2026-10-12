import TelegramBot from 'node-telegram-bot-api';
import { Opportunity } from '../models/Opportunity';
import { calculateDynamicEquity } from './binanceClient';

const token = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

let bot: TelegramBot | null = null;
if (token) {
  bot = new TelegramBot(token);
}

// ==========================================================
// محفظة التتبع المالي الافتراضية ($250)
// ==========================================================
export const INITIAL_CAPITAL = 250.0;

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

// 1. رسالة التوصية عند رصد الفرصة المنفذة فعلياً على المنصة
export const sendOpportunityToTelegram = async (opp: any, chartBuffer?: Buffer): Promise<boolean> => {
  if (!bot || !CHANNEL_ID) return false;

  const score = opp.confluenceScore || 0;
  if (score < 60) return false;

  try {
    const symbol = (opp.symbol || 'ASSET').toUpperCase();
    const entry = opp.entryZone?.max ?? opp.currentPrice;
    const sl = opp.stopLoss ?? 0;
    const tp1 = opp.targets?.tp1 ?? opp.tp1 ?? 0;
    const tp2 = opp.targets?.tp2 ?? opp.tp2 ?? 0;
    const tp3 = opp.targets?.tp3 ?? opp.tp3 ?? (entry + (tp2 - entry) * 1.5);

    const message = 
`🎯 *فرصة ارتداد مؤكدة (EMA 50 Pullback 4H)* 🎯

🪙 *العملة:* #${symbol}
💵 *سعر الدخول:* \`${entry}\`
🛑 *وقف الخسارة (SL):* \`${sl}\` ❌
🎯 *الهدف الأول (TP1):* \`${tp1}\`
🚀 *الهدف الثاني (TP2):* \`${tp2}\`
👑 *الهدف الثالث (TP3):* \`${tp3}\`

🛡️ *إدارة الصفقة: حجز أرباح عند TP1 ورفع الوقف لنقطة الدخول (Break-Even).*`;

    if (chartBuffer) {
      await bot.sendPhoto(CHANNEL_ID, chartBuffer, { caption: message, parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
    }
    return true;
  } catch (error) {
    return false;
  }
};

// 2. تحديثات الأهداف والستوب مع طباعة الرصيد التراكمي المحدث
export const sendTradeUpdateToTelegram = async (
  event: 'FILLED' | 'TP1' | 'TP2' | 'TP3' | 'SL' | 'BE' | 'TRAILING_TP1',
  opp: any,
  tradeProfitPct?: number,
  _realizedDollarGain?: number
) => {
  if (!bot || !CHANNEL_ID) return;

  try {
    const symbol = (opp.symbol || '').toUpperCase();
    const pctText = tradeProfitPct !== undefined ? ` (${tradeProfitPct > 0 ? '+' : ''}${tradeProfitPct}%)` : '';

    let updateText = '';
    if (event === 'FILLED') {
      updateText = `⚡ *تم تفعيل أمر الشراء لعملة* #${symbol}\n💵 *سعر التنفيذ:* \`${opp.entryZone?.max ?? opp.currentPrice}\``;
    }
    if (event === 'TP1') {
      updateText = `🎯 *تم تحقيق الهدف الأول (TP1) لعملة* #${symbol} *${pctText}*\n✅ *تم إغلاق 50% من العقد وتأمين الوقف على سعر الدخول (Break-Even).*`;
    }
    if (event === 'TP2') {
      updateText = `🚀 *تم تحقيق الهدف الثاني (TP2) لعملة* #${symbol}\n🔒 *تم رفع الوقف لحجز أرباح TP1.*`;
    }
    if (event === 'TP3') {
      updateText = `👑 *تم تحقيق الهدف الأقصى (TP3) لعملة* #${symbol} *${pctText}*\n💰 *إغلاق كامل الصفقة بنجاح بأقصى ربح.*`;
    }
    if (event === 'SL') {
      updateText = `🛑 *ضرب وقف الخسارة (SL) لعملة* #${symbol} *${pctText}*`;
    }
    if (event === 'BE') {
      updateText = `🛡️ *إغلاق المتبقي على سعر الدخول لعملة* #${symbol}\n✨ *الصفقة انتهت بصافي ربح مؤمّن من الهدف الأول.*`;
    }
    if (event === 'TRAILING_TP1') {
      updateText = `🔒 *إغلاق المتبقي على ربح محجوز (TP1) لعملة* #${symbol} *${pctText}*`;
    }

    // حساب الرصيد التراكمي الدقيق من قاعدة البيانات مباشرة
    const currentBalance = await calculateDynamicEquity();
    const netProfitDollars = currentBalance - INITIAL_CAPITAL;
    const netProfitPct = ((netProfitDollars / INITIAL_CAPITAL) * 100).toFixed(2);
    const sign = netProfitDollars >= 0 ? '+' : '';

    // إحصاء عدد الصفقات الحقيقي
    const winCount = await Opportunity.countDocuments({
      status: { $in: ['CLOSED_BE', 'CLOSED_TRAILING_TP1', 'HIT_TP3'] }
    });
    const lossCount = await Opportunity.countDocuments({
      status: 'HIT_SL'
    });

    const message = 
`${updateText}

💼 *المحفظة الافتراضية:*
💵 *رأس المال الابتدائي:* \`$${INITIAL_CAPITAL.toFixed(2)}\`
💰 *الرصيد الحالي:* \`$${currentBalance.toFixed(2)}\`
📈 *صافي النمو:* \`${sign}$${netProfitDollars.toFixed(2)} (${sign}${netProfitPct}%)\`

📊 *سجل العمليات:*
✅ *الصفقات الرابحة:* \`${winCount}\`
❌ *الصفقات الخاسرة:* \`${lossCount}\``;

    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
  } catch (error: any) {
    console.error(`Error trade update:`, error.message);
  }
};

export const initTelegramBot = () => {
  if (!token) return;
  console.log(`🤖 بوت التلغرام جاهز للعمل (المحفظة الافتراضية: $${INITIAL_CAPITAL})...`);
};
