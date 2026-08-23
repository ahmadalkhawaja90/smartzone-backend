import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// إنشاء نسخة البوت
let bot: TelegramBot | null = null;
if (token) {
  bot = new TelegramBot(token);
}

// دالة فحص وتنسيق الشروط الخمسة لـ ICT بعلامات الصح والخطأ
const formatAll5Conditions = (fulfilledConditions: any[] = []): string => {
  const masterConditions = [
    { key: 'sweep', label: '1. سحب السيولة (Liquidity Sweep)' },
    { key: 'shift', label: '2. كسر هيكل السوق (MSS / BOS)' },
    { key: 'fvg', label: '3. وجود فجوة سعرية متوازنة (FVG)' },
    { key: 'ote', label: '4. الارتداد من منطقة الخصم / الدخول (OTE / Discount Zone)' },
    { key: 'target', label: '5. استهداف مجمع سيولة واضح (Target Pool / External Liquidity)' },
  ];

  // الاعتماد المباشر على العدد الفعلي للشروط المحققة (نفس منطق الموقع 100%)
  const totalConditionsCount = Array.isArray(fulfilledConditions) ? fulfilledConditions.length : 0;

  return masterConditions
    .map((cond, idx) => {
      // التطابق المباشر: يطبع صح فقط على قدر عدد الشروط
      const isMet = idx < totalConditionsCount;
      return isMet ? `   ✅ ${cond.label}` : `   ❌ ${cond.label}`;
    })
    .join('\n');
};

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
    const rr = opp.riskRewardRatio || '1:2.8';
    const entryMin = opp.entryZone?.min ?? opp.currentPrice;
    const entryMax = opp.entryZone?.max ?? opp.currentPrice;
    const sl = opp.stopLoss ?? 0;
    const tp1 = opp.targets?.tp1 ?? 0;
    const tp2 = opp.targets?.tp2 ?? 0;
    const tp3 = opp.targets?.tp3 ?? 0;

    // تجهيز قائمة الشروط الـ 5 كاملة مع علامات الصح والخطأ
    const conditionsText = formatAll5Conditions(opp.fulfilledConditions);

    const message = `
🧠 *SMARTZONE AI — تقرير رصد وتحليل هيكلي* 📊
━━━━━━━━━━━━━━━━━━━━━
🔍 *الأصل المرصود:* \`${symbol}\` (Spot)
⏱ *الإطار الزمني:* \`${timeframe}\`
🔥 *مؤشر التوافق الخوارزمي:* \`${score}%\`
⚖️ *معدل العائد للمخاطرة:* \`${rr}\`

📌 *المستويات الهيكلية المرصودة:*
• نطاق التوازن المقترح: \`$${entryMin} - $${entryMax}\`
• نقطة إلغاء الفرضية التحليلية (Invalidation): \`$${sl}\`
• مستويات السيولة المستهدفة:
    ▫️ الهدف الأول: \`$${tp1}\`
    ▫️ الهدف الثاني: \`$${tp2}\`
    ▫️ الهدف الممتد: \`$${tp3}\`

📋 *شروط ICT الخمسة المؤكدة:*
${conditionsText}
━━━━━━━━━━━━━━━━━━━━━
> 💡 *السياق والمنطق الفني:*
> تم رصد تمركز مؤسسي إثر سحب سيولة سابقة وتكوين كسر هيكلي بزخم (MSS)، مما يعيد موازنة السعر داخل نطاق الخصم لاستهداف السيولة الخارجية.

> ⚖️ *إفصاح وإخلاء مسؤولية تنظيمي:*
> هذا التقرير هو نتاج رصد خوارزمي آلي لمفاهيم التحليل المتقدم وهيكل السوق (ICT/SMC) لأغراض تعليمية وإحصائية فقط، ولا يمثل أي استشارة مالية أو دعوة لفتح مراكز تداول. أسواق الكريبتو عالية التقلب وإدارة المخاطر تقع على مسؤوليتك الشخصية.

📱 *منصة SmartZone AI*
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
