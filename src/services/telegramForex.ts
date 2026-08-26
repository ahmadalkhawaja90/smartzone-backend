import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.FOREX_TELEGRAM_CHANNEL_ID || process.env.TELEGRAM_CHANNEL_ID;

let bot: TelegramBot | null = null;
if (token) {
  bot = new TelegramBot(token);
}

export const sendForexOpportunityToTelegram = async (opp: any, chartBuffer?: Buffer): Promise<boolean> => {
  if (!bot || !CHANNEL_ID) {
    console.error('⚠️ مفقود TELEGRAM_BOT_TOKEN أو FOREX_TELEGRAM_CHANNEL_ID في .env');
    return false;
  }

  try {
    const symbol = opp.symbol || 'ASSET';
    const timeframe = opp.timeframe || '15m';
    const typeLabel = opp.type === 'BUY' ? '🟢 شراء صاعد (BUY)' : '🔴 بيع هابط (SELL)';
    
    const entryMin = opp.entryZone?.min ?? opp.entryPrice ?? opp.currentPrice;
    const entryMax = opp.entryZone?.max ?? opp.entryPrice ?? opp.currentPrice;
    const sl = opp.stopLoss ?? 0;
    
    const tp1 = opp.targets?.tp1 ?? opp.tp1 ?? 0;
    const tp2 = opp.targets?.tp2 ?? opp.tp2 ?? 0;
    const tp3 = opp.targets?.tp3 ?? opp.tp3 ?? 0;

    const message = `
🏛️ *SMARTZONE AI* ⚡
═════════════════════════
💎 *الأصل:* \`${symbol}\`
⏱️ *الفريم:* \`${timeframe}\`
🚦 *نوع الصفقة:* *${typeLabel}*
═════════════════════════
🎯 *منطقة الدخول:* \`${entryMin} - ${entryMax}\`
🛑 *وقف الخسارة:* \`${sl}\` ❌

🏁 *المستويات المستهدفة:*
  🔹 *الهدف 1:* \`${tp1}\` 🎯 _(1:1.5)_
  🔹 *الهدف 2:* \`${tp2}\` 🚀 _(سيولة BSL)_
  ${tp3 ? `🔹 *الهدف 3:* \`${tp3}\` 👑 _(امتداد 1:3.0)_` : ''}
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

    console.log(`✅ تم نشر التقرير الفني للزوج [${symbol} - ${timeframe}] بنجاح.`);
    return true;
  } catch (error) {
    console.error('❌ خطأ في إرسال تقرير العملات:', error);
    return false;
  }
};

// تشغيل نظام البوت
export const initForexTelegramBot = () => {
  if (!token) return;
  console.log('🤖 تم تشغيل نظام إشعارات العملات الرئيسية بنجاح...');
};