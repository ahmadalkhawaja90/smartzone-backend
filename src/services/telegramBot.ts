import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// إنشاء نسخة البوت
let bot: TelegramBot | null = null;
if (token) {
  bot = new TelegramBot(token);
}

// 1. توليد رابط دعوة لمرة واحدة للمشتركين
export const generateOneTimeInviteLink = async (): Promise<string | null> => {
  if (!bot || !CHANNEL_ID) {
    console.error('⚠️ مفقود TELEGRAM_BOT_TOKEN أو TELEGRAM_CHANNEL_ID في .env');
    return null;
  }

  try {
    const invite = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 3600, // صالح لمدة ساعة
    });

    return invite.invite_link;
  } catch (error) {
    console.error('خطأ في توليد رابط القناة:', error);
    return null;
  }
};

// 2. إرسال تقرير الرصد الهيكلي مع الشارت فورياً إلى قناة التلغرام (فلتر 60% فما فوق)
export const sendOpportunityToTelegram = async (opp: any, chartBuffer?: Buffer): Promise<boolean> => {
  if (!bot || !CHANNEL_ID) {
    console.error('⚠️ مفقود TELEGRAM_BOT_TOKEN أو TELEGRAM_CHANNEL_ID في .env');
    return false;
  }

  // 🎯 الفلتر المعتمد: قبول الصفقات ذات نسبة التوافق 60% فما فوق (الفئة الأعلى نجاحاً)
  const score = opp.confluenceScore || 0;
  
  if (score < 60) {
    console.log(`⏳ تم حجب التقرير ${opp.symbol || 'ASSET'} عن التلجرام (السكور ${score}%). المطلوب 60% فما فوق.`);
    return false;
  }

  try {
    const symbol = opp.symbol || 'ASSET';
    const timeframe = opp.timeframe || '1h';
    const entryMin = opp.entryZone?.min ?? opp.currentPrice;
    const entryMax = opp.entryZone?.max ?? opp.currentPrice;
    const sl = opp.stopLoss ?? 0;
    const tp1 = opp.targets?.tp1 ?? 0;
    const tp2 = opp.targets?.tp2 ?? 0;
    const tp3 = opp.targets?.tp3 ?? 0;

    const message = `
🏛️ *SMARTZONE AI* ⚡
═════════════════════════
💎 *الأصل:* \`${symbol}\` (Spot)
⏱️ *الفريم:* \`${timeframe}\`
🚦 *نوع الصفقة:* 🟢 *شراء صاعد (BUY)*
🏆 *قوة التوافق:* \`${score}%\` 🔥
═════════════════════════
🎯 *منطقة الدخول:* \`$${entryMin} - $${entryMax}\`
🛑 *وقف الخسارة:* \`$${sl}\` ❌

🏁 *المستويات المستهدفة:*
  🔹 *الهدف 1:* \`$${tp1}\` 🎯 _(1:1.5)_
  🔹 *الهدف 2:* \`$${tp2}\` 🚀 _(سيولة BSL)_
  ${tp3 ? `🔹 *الهدف 3:* \`$${tp3}\` 👑 _(امتداد 1:3.0)_` : ''}
═════════════════════════
💡 *القراءة الفنية:*
✨ تم كسر قاع سابق وسحب السيولة المؤسسية (*SSL Sweep*)، أعقبه اندفاع سعري كسر هيكل السوق (*MSS*). الدخول مرتكز على فجوة سعرية صاعدة (*FVG*) داخل منطقة الخصم (*Discount Zone*).
`;

    if (chartBuffer) {
      await bot.sendPhoto(CHANNEL_ID, chartBuffer, {
        caption: message,
        parse_mode: 'Markdown',
      });
    } else {
      await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
    }

    console.log(`✅ تم نشر التقرير الفني للزوج ${symbol} (بسكور ${score}%) على قناة التلغرام بنجاح.`);
    return true;
  } catch (error) {
    console.error('❌ خطأ في إرسال التقرير إلى التلغرام:', error);
    return false;
  }
};

// 3. تشغيل نظام الحماية
export const initTelegramBot = () => {
  if (!token) return;
  console.log('🤖 تم تشغيل نظام حماية وإشعارات القناة بنجاح...');
};
