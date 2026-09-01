import TelegramBot from 'node-telegram-bot-api';
import { Opportunity } from '../models/Opportunity';

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

// دالة مساعدة لحساب الرصيد التراكمي وإحصائيات المحفظة من قاعدة البيانات
export const calculatePortfolioMetrics = async () => {
  const initialCapital = 100;
  const riskPerTrade = 10; // 10$ لكل صفقة

  const closedTrades = await Opportunity.find({
    status: { $in: ['HIT_TP1', 'HIT_TP2', 'HIT_TP3', 'HIT_SL', 'CLOSED_BE'] },
  });

  let totalNetProfitUsdt = 0;
  let winCount = 0;
  let lossCount = 0;
  let beCount = 0;

  for (const trade of closedTrades) {
    const pct = trade.profitPercentage || 0;
    const profitUsdt = riskPerTrade * (pct / 100);
    totalNetProfitUsdt += profitUsdt;

    if (trade.status === 'HIT_SL') {
      lossCount++;
    } else if (trade.status === 'CLOSED_BE') {
      beCount++;
    } else {
      winCount++;
    }
  }

  const currentBalance = initialCapital + totalNetProfitUsdt;
  const totalTrades = winCount + lossCount + beCount;
  const winRate = totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(1) : '0.0';

  return {
    initialCapital,
    currentBalance: parseFloat(currentBalance.toFixed(2)),
    totalNetProfitUsdt: parseFloat(totalNetProfitUsdt.toFixed(2)),
    winRate: `${winRate}%`,
    winCount,
    lossCount,
    beCount,
  };
};

// 2. إرسال تقرير الرصد الهيكلي مع الشارت فورياً إلى قناة التلغرام
export const sendOpportunityToTelegram = async (opp: any, chartBuffer?: Buffer): Promise<boolean> => {
  if (!bot || !CHANNEL_ID) {
    console.error('⚠️ مفقود TELEGRAM_BOT_TOKEN أو TELEGRAM_CHANNEL_ID في .env');
    return false;
  }

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
    
    const isSell = opp.type === 'SELL' || opp.type === 'SHORT';
    const typeBadge = isSell ? '🔴 بيع هابط (SELL / SHORT)' : '🟢 شراء صاعد (BUY / LONG)';

    let targetsArr = [rawTp1, rawTp2, rawTp3].filter((t) => t > 0);
    if (targetsArr.length > 0) {
      targetsArr.sort((a, b) => (isSell ? b - a : a - b));
    }
    const tp1 = targetsArr[0] || rawTp1;
    const tp2 = targetsArr[1] || rawTp2;
    const tp3 = targetsArr[2] || rawTp3;
    
    const chartStory = isSell
      ? `1️⃣ *السحب (Sweep):* السعر صعد بقوة وسحب سيولة القمم السابقة.\n2️⃣ *الكسر (MSS):* هبط السعر بقوة وكسر هيكل السوق السابق.\n3️⃣ *الفجوة (FVG):* ترك السعر فجوة سعرية لم يتم تداولها.\n4️⃣ *لحظة الدخول:* تم وضع أمر بيع محدد بانتظار التفعيل.`
      : `1️⃣ *السحب (Sweep):* السعر نزل بقوة وسحب سيولة القيعان السابقة.\n2️⃣ *الكسر (MSS):* انطلق السعر بقوة للأعلى وكسر هيكل السوق السابق.\n3️⃣ *الفجوة (FVG):* ترك السعر وراءه فجوة سعرية في منطقة الخصم.\n4️⃣ *لحظة الدخول:* تم وضع أمر شراء معلق (Limit Order) عند $${entryMax}. 🚀`;

    const message = `
🏛️ *SMARTZONE AI - رصد فرصة جديدة* ⚡
═════════════════════════
💎 *الأصل:* \`${symbol}\` (Spot Testnet)
⏱️ *الفريم:* \`${timeframe}\`
🚦 *نوع التمركز:* ${typeBadge}
🏆 *قوة التوافق:* \`${score}%\` 🔥
═════════════════════════
🎯 *أمر الدخول المعلق:* \`$${entryMax}\`
🛑 *وقف الخسارة المحكم:* \`$${sl}\` ❌

🏁 *المستويات المستهدفة:*
  🔹 *الهدف 1:* \`$${tp1}\` 🎯 _(جني 25% + تأمين دخول)_
  🔹 *الهدف 2:* \`$${tp2}\` 🚀 _(امتداد 1.272)_
  ${tp3 ? `🔹 *الهدف 3:* \`$${tp3}\` 👑 _(امتداد 1.618)_` : ''}
═════════════════════════
📖 *السياق المؤسسي:*
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

    console.log(`✅ تم نشر التقرير الفني للزوج ${symbol} بنجاح.`);
    return true;
  } catch (error) {
    console.error('❌ خطأ في إرسال التقرير إلى التلغرام:', error);
    return false;
  }
};

// 3. إرسال إشعار لحظي عند تحديث حالة الصفقة والرصيد التراكمي
export const sendTradeUpdateToTelegram = async (
  event: 'FILLED' | 'TP1' | 'TP2' | 'TP3' | 'SL' | 'BE',
  opp: any,
  tradeProfitPct?: number
) => {
  if (!bot || !CHANNEL_ID) return;

  try {
    const symbol = opp.symbol;
    const entryPrice = opp.entryZone?.max || opp.currentPrice;
    const stats = await calculatePortfolioMetrics();

    let title = '';
    let details = '';
    const sign = (tradeProfitPct || 0) >= 0 ? '+' : '';

    switch (event) {
      case 'FILLED':
        title = `⚡ *تم تفعيل صفقة شراء جديدة*`;
        details = `📍 تم شراء \`${symbol}\` عند: \`$${entryPrice}\`\n💼 حجم الصفقة: \`$10.00 (10%)\``;
        break;
      case 'TP1':
        title = `🎯 *تم تحقيق الهدف الأول (TP1)*`;
        details = `💰 تم إغلاق \`25%\` من الصفقة بربح \`${sign}${tradeProfitPct}%\`\n🛡️ *تم نقل وقف الخسارة إلى نقطة الدخول ($${entryPrice}) - الصفقة في أمان تام.*`;
        break;
      case 'TP2':
        title = `🔥 *تم تحقيق الهدف الثاني (TP2)*`;
        details = `🚀 وصل السعر إلى الهدف الثاني \`$${opp.targets.tp2}\` لـ \`${symbol}\`.`;
        break;
      case 'TP3':
        title = `👑 *تم إغلاق كامل الصفقة على الهدف الذهبي (TP3)*`;
        details = `🎉 ربح الصفقة الإجمالي: \`${sign}${tradeProfitPct}%\`\n💵 تم الخروج بالكامل عند: \`$${opp.targets.tp3}\``;
        break;
      case 'SL':
        title = `🛑 *تم ضرب وقف الخسارة (Stop Loss)*`;
        details = `📉 خسارة الصفقة: \`${sign}${tradeProfitPct}%\`\n🛑 السعر: \`$${opp.stopLoss}\``;
        break;
      case 'BE':
        title = `🛡️ *إغلاق على نقطة الدخول (Break-Even)*`;
        details = `⚖️ ارتد السعر لنقطة الدخول \`$${entryPrice}\` لـ \`${symbol}\`، وتم الخروج بربح 25% المحجوز مسبقاً وبدون أي خسارة.`;
        break;
    }

    const message = `
${title}
═════════════════════════
💎 *الزوج:* \`${symbol}\`
${details}
═════════════════════════
📊 *حالة المحفظة التراكمية:*
💰 *الرصيد الكلي:* \`$${stats.currentBalance} USDT\`
📈 *صافي الأرباح:* \`$${stats.totalNetProfitUsdt >= 0 ? '+' : ''}${stats.totalNetProfitUsdt} USDT\`
🏆 *نسبة النجاح (Win Rate):* \`${stats.winRate}\` (✅ ${stats.winCount} | ❌ ${stats.lossCount} | 🛡️ ${stats.beCount})
`;

    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
  } catch (error: any) {
    console.error(`⚠️ خطأ إرسال تحديث الصفقة لـ ${opp.symbol}:`, error.message);
  }
};

// 4. تشغيل نظام البوت
export const initTelegramBot = () => {
  if (!token) return;
  console.log('🤖 تم تشغيل نظام حماية وإشعارات القناة بنجاح...');
};
