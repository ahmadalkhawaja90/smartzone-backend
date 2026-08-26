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

// 2. إرسال تقرير الرصد الهيكلي مع الشارت فورياً إلى قناة التلغرام
export const sendOpportunityToTelegram = async (opp: any, chartBuffer?: Buffer): Promise<boolean> => {
  if (!bot || !CHANNEL_ID) {
    console.error('⚠️ مفقود TELEGRAM_BOT_TOKEN أو TELEGRAM_CHANNEL_ID في .env');
    return false;
  }

  // 🎯 الفلتر المعتمد: قبول الصفقات ذات نسبة التوافق 60% فما فوق
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
    
    const rawTp1 = opp.targets?.tp1 ?? opp.tp1 ?? 0;
    const rawTp2 = opp.targets?.tp2 ?? opp.tp2 ?? 0;
    const rawTp3 = opp.targets?.tp3 ?? opp.tp3 ?? 0;
    
    // تمييز نوع الصفقة وصياغة قصة الشارت الديناميكية
    const isSell = opp.type === 'SELL' || opp.type === 'SHORT';
    const typeBadge = isSell ? '🔴 بيع هابط (SELL / SHORT)' : '🟢 شراء صاعد (BUY / LONG)';

    // 🛠️ ترتيب الأهداف بذكاء حسب نوع الصفقة (شراء تصاعدي / بيع تنازلي)
    let targetsArr = [rawTp1, rawTp2, rawTp3].filter((t) => t > 0);
    if (targetsArr.length > 0) {
      targetsArr.sort((a, b) => (isSell ? b - a : a - b));
    }
    const tp1 = targetsArr[0] || rawTp1;
    const tp2 = targetsArr[1] || rawTp2;
    const tp3 = targetsArr[2] || rawTp3;
    
    const chartStory = isSell
      ? `1️⃣ *السحب (Sweep):* السعر صعد بقوة وسحب سيولة القمم السابقة.\n2️⃣ *الكسر (MSS):* هبط السعر بقوة وكسر هيكل السوق السابق.\n3️⃣ *الفجوة (FVG):* بسبب قوة الهبوط، ترك السعر وراءه فجوة سعرية (المستطيل الأزرق) لم يتم تداولها.\n4️⃣ *لحظة الدخول (الآن):* السعر صعد ليصحح، وبمجرد دخوله منطقة العلاوة (Premium) واقترابه من المستطيل الأزرق، أرسلنا لك الإشعار لتتمركز بأمان (OTE). 🎯`
      : `1️⃣ *السحب (Sweep):* السعر نزل بقوة وسحب سيولة القيعان السابقة.\n2️⃣ *الكسر (MSS):* انطلق السعر بقوة للأعلى وكسر هيكل السوق السابق.\n3️⃣ *الفجوة (FVG):* بسبب قوة الصعود، ترك السعر وراءه فجوة سعرية (المستطيل الأزرق) لم يتم تداولها.\n4️⃣ *لحظة الدخول (الآن):* السعر هبط ليصحح، وبمجرد دخوله منطقة الخصم (Discount) واقترابه من المستطيل الأزرق، أرسلنا لك الإشعار لتتمركز بأمان (OTE). 🚀`;

    const message = `
🏛️ *SMARTZONE AI* ⚡
═════════════════════════
💎 *الأصل:* \`${symbol}\` (Spot)
⏱️ *الفريم:* \`${timeframe}\`
🚦 *نوع التمركز:* ${typeBadge}
🏆 *قوة التوافق:* \`${score}%\` 🔥
═════════════════════════
🎯 *المنطقة الذهبية للدخول:* \`$${entryMin} - $${entryMax}\`
🛑 *وقف الخسارة المحكم:* \`$${sl}\` ❌

🏁 *المستويات المستهدفة:*
  🔹 *الهدف 1:* \`$${tp1}\` 🎯 _(1:1.5)_
  🔹 *الهدف 2:* \`$${tp2}\` 🚀 _(سيولة الهدف)_
  ${tp3 ? `🔹 *الهدف 3:* \`$${tp3}\` 👑 _(امتداد 1:3.0)_` : ''}
═════════════════════════
📖 *قصة الشارت (السياق المؤسسي):*
${chartStory}
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
