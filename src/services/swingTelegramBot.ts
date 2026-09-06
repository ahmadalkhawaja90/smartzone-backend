import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();

const token = process.env.TELEGRAM_SWING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const swingChannelId = process.env.TELEGRAM_SWING_CHANNEL_ID;

const bot = token ? new TelegramBot(token, { polling: false }) : null;

// عداد إحصائي مباشر للصفقات المكتملة
let totalWins = 0;
let totalLosses = 0;

export const setSwingStats = (wins: number, losses: number) => {
  totalWins = wins;
  totalLosses = losses;
};

export const sendSwingOpportunityToTelegram = async (opp: any, chartBuffer?: Buffer) => {
  if (!bot || !swingChannelId) {
    console.warn('⚠️ [Swing Bot] بيانات التلغرام للقناة الخاصة غير مكتملة في .env');
    return;
  }

  // حساب منطقة الدخول (نطاق تجميعي مرن 0.2%)
  const entryMin = opp.entryMin || (opp.entryPrice * 0.999).toFixed(opp.decimals || 4);
  const entryMax = opp.entryMax || (opp.entryPrice * 1.001).toFixed(opp.decimals || 4);

  // احتساب TP3 ممتد في حال عدم تمريره
  const tp3Value = opp.tp3 || (opp.entryPrice + (opp.tp2 - opp.entryPrice) * 1.5).toFixed(opp.decimals || 4);

  const caption = 
`💎 *إشارة سوينغ مؤسسية — Wyckoff & ICT* 💎
═════════════════════════
🪙 *العملة:* #${opp.symbol.toUpperCase()}
⏱️ *الفريم:* \`4H (Swing)\`
🚦 *نوع الصفقة:* 🟢 \`SPOT BUY\`
═════════════════════════
💵 *Entry (منطقة الدخول):* \`${entryMin} - ${entryMax}\`
🛑 *SL (وقف الخسارة):* \`${opp.stopLoss}\` ❌

🎯 *الأهداف الاستثمارية:*
🔹 *TP1:* \`${opp.tp1}\` 🎯
🔹 *TP2:* \`${opp.tp2}\` 🚀
🔹 *TP3:* \`${tp3Value}\` 👑
═════════════════════════
🛡️ *إدارة الصفقة:*
✨ *تأمين 50% من الأرباح عند ملامسة الهدف الأول (TP1) ونقل الستوب فوراً لسعر الدخول.*

📊 *سجل الأداء المباشر:*
✅ *رابحة:* \`${totalWins}\` | ❌ *خاسرة:* \`${totalLosses}\``;

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
    console.log(`✅ [Swing Telegram] تم إرسال صفقة ${opp.symbol} بالتنسيق الجديد بنجاح.`);
  } catch (error: any) {
    console.error(`❌ [Swing Telegram Error] فشل الإرسال لـ ${opp.symbol}:`, error.message);
  }
};

// دالة إشعار الوصول للأهداف
export const sendTargetHitUpdate = async (symbol: string, targetNum: number, price: number) => {
  if (!bot || !swingChannelId) return;

  if (targetNum === 1) totalWins += 1;

  const msg = 
`🎯 *تم تحقيق الهدف [TP${targetNum}] بنجاح!* 🚀
═════════════════════════
🪙 *العملة:* #${symbol.toUpperCase()}
💵 *السعر المحقق:* \`${price}\`
🛡️ *الإجراء:* ${targetNum === 1 ? 'تم حجز 50% من الأرباح ورفع الستوب لسعر الدخول.' : 'مستمرون نحو باقي الأهداف.'}
═════════════════════════
📊 *سجل الأداء العام:*
✅ *الصفقات الرابحة:* \`${totalWins}\` | ❌ *الصفقات الخاسرة:* \`${totalLosses}\``;

  try {
    await bot.sendMessage(swingChannelId, msg, { parse_mode: 'Markdown' });
  } catch (err: any) {
    console.error('❌ خطأ إرسال إشعار الهدف:', err.message);
  }
};

// دالة إشعار ضرب الستوب
export const sendStopLossUpdate = async (symbol: string, price: number) => {
  if (!bot || !swingChannelId) return;

  totalLosses += 1;

  const msg = 
`🛑 *تنبيه: ضرب وقف الخسارة (Stop Loss)* ❌
═════════════════════════
🪙 *العملة:* #${symbol.toUpperCase()}
💵 *سعر الخروج:* \`${price}\`
💡 *إدارة المخاطر جزء أساسي من استمرارية النجاح.*
═════════════════════════
📊 *سجل الأداء العام:*
✅ *الصفقات الرابحة:* \`${totalWins}\` | ❌ *الصفقات الخاسرة:* \`${totalLosses}\``;

  try {
    await bot.sendMessage(swingChannelId, msg, { parse_mode: 'Markdown' });
  } catch (err: any) {
    console.error('❌ خطأ إرسال إشعار الستوب:', err.message);
  }
};
