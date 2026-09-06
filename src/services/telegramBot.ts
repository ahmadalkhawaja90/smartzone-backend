import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

let bot: TelegramBot | null = null;
if (token) {
  bot = new TelegramBot(token);
}

// عداد مباشر وبسيط بدون تعقيدات
let winCount = 0;
let lossCount = 0;

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

// 1. رسالة التوصية بالشكل المطلوب بالضبط
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
`💎 *فرصة محتملة جديدة* 💎

🪙 *العملة:* #${symbol}
💵 *Entry:* \`${entry}\`
🛑 *SL:* \`${sl}\` ❌
🎯 *TP1:* \`${tp1}\`
🚀 *TP2:* \`${tp2}\`
👑 *TP3:* \`${tp3}\`

🛡️ *تأمين 50% من الأرباح عند الهدف الأول ورفع الستوب لنقطة الدخول.*`;

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

// 2. تحديثات الأهداف والستوب مع عداد الصفقات الرابحة والخاسرة فقط
export const sendTradeUpdateToTelegram = async (
  event: 'FILLED' | 'TP1' | 'TP2' | 'TP3' | 'SL' | 'BE' | 'TRAILING_TP1',
  opp: any,
  _tradeProfitPct?: number
) => {
  if (!bot || !CHANNEL_ID) return;

  try {
    const symbol = (opp.symbol || '').toUpperCase();

    // يتم احتساب الصفقة رابحة لمرة واحدة فقط عند حسم TP1
    if (event === 'TP1') winCount++;
    if (event === 'SL') lossCount++;

    let updateText = '';
    if (event === 'FILLED') updateText = `⚡ *تم تفعيل أمر الدخول لعملة* #${symbol}`;
    if (event === 'TP1') updateText = `🎯 *تم تحقيق الهدف الأول (TP1) لعملة* #${symbol} ➔ تأمين الدخول`;
    if (event === 'TP2') updateText = `🚀 *تم تحقيق الهدف الثاني (TP2) لعملة* #${symbol}`;
    if (event === 'TP3') updateText = `👑 *تم تحقيق الهدف النهائي (TP3) لعملة* #${symbol}`;
    if (event === 'SL') updateText = `🛑 *ضرب وقف الخسارة (SL) لعملة* #${symbol}`;
    if (event === 'BE') updateText = `🛡️ *إغلاق على نقطة الدخول لعملة* #${symbol}`;
    if (event === 'TRAILING_TP1') updateText = `🔒 *إغلاق بربح محجوز لعملة* #${symbol}`;

    const message = 
`${updateText}

📊 *سجل الأداء:*
✅ *الصفقات الرابحة:* \`${winCount}\`
❌ *الصفقات الخاسرة:* \`${lossCount}\``;

    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
  } catch (error: any) {
    console.error(`Error trade update:`, error.message);
  }
};

export const initTelegramBot = () => {
  if (!token) return;
  console.log('🤖 بوت التلغرام جاهز للعمل...');
};
