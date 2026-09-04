import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();

const token = process.env.TELEGRAM_SWING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const swingChannelId = process.env.TELEGRAM_SWING_CHANNEL_ID;

const bot = token ? new TelegramBot(token, { polling: false }) : null;

export const sendSwingOpportunityToTelegram = async (opp: any, chartBuffer?: Buffer) => {
  if (!bot || !swingChannelId) {
    console.warn('⚠️ [Swing Bot] بيانات التلغرام للقناة الخاصة غير مكتملة في .env');
    return;
  }

  const caption = 
`💎 *توصية سوينغ مؤسسية (Wyckoff + ICT)* 💎

🔹 *العملة:* #${opp.symbol}
📊 *الفريم:* 4H (سوينغ)
🎯 *نوع الصفقة:* SPOT BUY (شراء سبوت)

💵 *سعر الدخول:* \`$${opp.entryPrice}\`
🛑 *وقف الخسارة (SL):* \`$${opp.stopLoss}\` (${opp.riskPercent}%)
🎯 *الهدف الأول (TP1):* \`$${opp.tp1}\` (+4.0%) ➔ *تأمين الدخول*
🚀 *الهدف النهائي (TP2):* \`$${opp.tp2}\` (+8.5%)

📌 *أسباب الدخول المؤسسي:*
• اكتمال تجميع وايكوف (Phase C)
• كسر وهمي لقاع السيولة (Spring Shakeout)
• علامة قوة (SOS) واختبار فجوة FVG شرائية

⚠️ *إدارة الصفقة:* عند ملامسة TP1، يتم حجز 50% من الأرباح ورفع الستوب فوراً لسعر الدخول.`;

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
    console.log(`✅ [Swing Telegram] تم إرسال صفقة ${opp.symbol} بنجاح إلى القناة الخاصة.`);
  } catch (error: any) {
    console.error(`❌ [Swing Telegram Error] فشل الإرسال لـ ${opp.symbol}:`, error.message);
  }
};
