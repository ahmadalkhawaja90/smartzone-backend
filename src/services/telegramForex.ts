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

  try {
    const symbol = opp.symbol;
    const timeframe = opp.timeframe;
    const type = opp.type === 'BUY' ? '🟢 تمركز شرائي صاعد (Bullish)' : '🔴 تمركز بيعي هابط (Bearish)';
    const strategy = opp.strategy;
    const session = opp.session;
    const entry = opp.entryPrice;
    const sl = opp.stopLoss;
    const tp1 = opp.tp1;
    const tp2 = opp.tp2;
    const score = opp.score || 90;
    const conditions = opp.conditions ? opp.conditions.map((c: string) => `  ✅ ${c}`).join('\n') : '';

    const message = `
🏛️ *SMARTZONE FOREX & METALS — تقرير هيكلي* 📊
━━━━━━━━━━━━━━━━━━━━━
📊 *الأصل المرصود:* \`${symbol}\`
🎯 *النموذج المؤسسي:* \`${strategy}\`
🧭 *الاتجاه الفني:* ${type}
⏱ *الإطار الزمني:* \`${timeframe}\`
🕒 *التوقيت / الجلسة:* \`${session}\`
🔥 *التوافق الخوارزمي:* \`${score}%\`

📌 *المستويات السعرية المرصودة:*
• منطقة الارتكاز والتوازن: \`${entry}\`
• نقطة إلغاء الفرضية التحليلية (Invalidation): \`${sl}\`
• مستويات تدفق السيولة:
   ▫️ المستوى الأول: \`${tp1}\`
   ▫️ المستوى الثاني: \`${tp2}\`

📋 *المحددات الفنية المؤكدة:*
${conditions}
━━━━━━━━━━━━━━━━━━━━━
> 💡 *السياق والمنطق الفني (${strategy}):*
> تم رصد تداخل سيولة بنكية مع تفريغ عقود سابقة وتشكيل فجوة قيمة عادلة (FVG) مدعومة بكسر هيكلي لحظي (MSS) داخل نطاق الجلسة.

> ⚖️ *إفصاح وإخلاء مسؤولية تنظيمي:*
> البيانات مولدة آلياً لمتابعة حركة السيولة المؤسسية لأغراض تعليمية وإحصائية بحتة، ولا تعتبر توصية مباشرة. الالتزام بإدارة رأس المال (0.5% - 1%) وتأمين المراكز يقع على مسؤوليتك الشخصية.

📱 *منصة SmartZone AI*
`;

    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
    console.log(`✅ تم نشر التقرير الهيكلي ${strategy} للزوج [${symbol} - ${timeframe}] بنجاح.`);
    return true;
  } catch (error) {
    console.error('❌ خطأ في إرسال تقرير الفوركس:', error);
    return false;
  }
};