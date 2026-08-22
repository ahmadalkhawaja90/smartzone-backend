import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.FOREX_TELEGRAM_CHANNEL_ID || process.env.TELEGRAM_CHANNEL_ID;

let bot: TelegramBot | null = null;
if (token) {
  bot = new TelegramBot(token);
}

export const sendForexOpportunityToTelegram = async (opp: any): Promise<boolean> => {
  if (!bot || !CHANNEL_ID) {
    console.error('⚠️ مفقود TELEGRAM_BOT_TOKEN أو FOREX_TELEGRAM_CHANNEL_ID في .env');
    return false;
  }

  // فلتر السكور الذهبي للفوركس (60% فما فوق)
  const score = opp.confluenceScore || opp.score || 0;
  if (score < 60) {
    return false;
  }

  try {
    const symbol = opp.symbol || 'ASSET';
    const timeframe = opp.timeframe || '15m';
    const type = opp.type === 'BUY' ? '🟢 تمركز شرائي صاعد (Bullish)' : '🔴 تمركز بيعي هابط (Bearish)';
    const strategy = opp.strategy || 'ICT Institutional Setup 🏛️';
    const rr = opp.riskRewardRatio || '1:2.5';
    
    const entryMin = opp.entryZone?.min ?? opp.entryPrice ?? opp.currentPrice;
    const entryMax = opp.entryZone?.max ?? opp.entryPrice ?? opp.currentPrice;
    const sl = opp.stopLoss ?? 0;
    
    const tp1 = opp.targets?.tp1 ?? opp.tp1 ?? 0;
    const tp2 = opp.targets?.tp2 ?? opp.tp2 ?? 0;
    const tp3 = opp.targets?.tp3 ?? opp.tp3 ?? 0;

    // استخراج الشروط المؤكدة
    let conditionsText = '';
    if (Array.isArray(opp.fulfilledConditions)) {
      conditionsText = opp.fulfilledConditions.map((c: any) => `  ✅ ${c.title || c}`).join('\n');
    } else if (Array.isArray(opp.conditions)) {
      conditionsText = opp.conditions.map((c: string) => `  ✅ ${c}`).join('\n');
    }

    const message = `
🏛️ *SMARTZONE FOREX & METALS — تقرير هيكلي* 📊
━━━━━━━━━━━━━━━━━━━━━
📊 *الأصل المرصود:* \`${symbol}\`
🎯 *النموذج المؤسسي:* \`${strategy}\`
🧭 *الاتجاه الفني:* ${type}
⏱ *الإطار الزمني:* \`${timeframe}\`
🔥 *التوافق الخوارزمي:* \`${score}%\`
⚖️ *معدل العائد للمخاطرة:* \`${rr}\`

📌 *المستويات السعرية المرصودة:*
• نطاق التمركز والدخول: \`$${entryMin} - $${entryMax}\`
• نقطة إلغاء الفرضية التحليلية (Invalidation): \`$${sl}\`
• مستويات تدفق السيولة المستهدفة:
   ▫️ الهدف الأول: \`$${tp1}\`
   ▫️ الهدف الثاني: \`$${tp2}\`
   ${tp3 ? `▫️ الهدف الممتد: \`$${tp3}\`` : ''}

📋 *المحددات الفنية المؤكدة:*
${conditionsText || '  ✅ تأكيد سحب السيولة وكسر الهيكل في منطقة الخصم'}
━━━━━━━━━━━━━━━━━━━━━
> 💡 *السياق والمنطق الفني:*
> تم رصد تداخل سيولة بنكية إثر سحب سيولة قاع سابق وتشكيل كسر هيكلي مع فجوة سعرية (FVG) داخل نطاق الخصم لاستهداف السيولة الخارجية.

> ⚖️ *إفصاح وإخلاء مسؤولية تنظيمي:*
> البيانات مولدة آلياً لمتابعة حركة السيولة المؤسسية (ICT/SMC) لأغراض تعليمية وإحصائية بحتة، ولا تعتبر توصية مباشرة. إدارة المخاطر تقع على مسؤوليتك الشخصية.

📱 *منصة SmartZone AI*
`;

    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
    console.log(`✅ تم نشر التقرير الفني للزوج [${symbol} - ${timeframe}] بسكور ${score}% بنجاح.`);
    return true;
  } catch (error) {
    console.error('❌ خطأ في إرسال تقرير الفوركس:', error);
    return false;
  }
};

// تشغيل نظام البوت بدون إرسال أي رسائل تيست
export const initForexTelegramBot = () => {
  if (!token) return;
  console.log('🤖 تم تشغيل نظام إشعارات الفوركس والذهب بنجاح...');
};
