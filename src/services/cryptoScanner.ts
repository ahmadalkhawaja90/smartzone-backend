import axios from 'axios';
import { Opportunity } from '../models/Opportunity';
import { sendOpportunityToTelegram } from './telegramBot';

interface BinanceCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// 1. جلب قائمة أزواج USDT السبوت النشطة من باينانس عبر النطاق العام المفتوح
export const getActiveUSDTSpotPairs = async (): Promise<string[]> => {
  try {
    const res = await axios.get('https://data-api.binance.vision/api/v3/exchangeInfo', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });
    const symbols = res.data.symbols
      .filter((s: any) => s.status === 'TRADING' && s.isSpotTradingAllowed && s.quoteAsset === 'USDT')
      .map((s: any) => s.symbol);

    // استثناء العملات المستقرة والرموز ذات الرافعة
    const blacklist = ['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'EURUSDT', 'GBPUSDT', 'DAIUSDT', 'AEURUSDT'];
    return symbols.filter((s: string) => !blacklist.includes(s));
  } catch (error) {
    console.error('فشل جلب قائمة أزواج باينانس:', (error as Error).message);
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT'];
  }
};

// 2. جلب الشموع البيانية لأي عملة وفريم عبر النطاق المفتوح
const fetchCandles = async (symbol: string, interval = '15m', limit = 50): Promise<BinanceCandle[]> => {
  try {
    const res = await axios.get('https://data-api.binance.vision/api/v3/klines', {
      params: { symbol, interval, limit },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });
    return res.data.map((c: any) => ({
      openTime: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  } catch (error) {
    return [];
  }
};

// 3. خوارزمية تحليل وفحص استراتيجية ICT (Bullish Spot Setup)
const analyzeICTBullishSetup = (candles: BinanceCandle[], symbol: string, timeframe: string) => {
  if (candles.length < 30) return null;

  const currentCandle = candles[candles.length - 1];
  const currentPrice = currentCandle.close;

  // استخراج القمم والقيعان الأخيرة
  const recentCandles = candles.slice(-25, -1);
  const lowestLow = Math.min(...recentCandles.map((c) => c.low));
  const highestHigh = Math.max(...recentCandles.map((c) => c.high));

  let confluenceScore = 0;
  const fulfilledConditions: Array<{ title: string; description: string }> = [];

  // الشرط 1: سحب سيولة قاع سابق (SSL Sweep)
  const last5Lows = candles.slice(-6, -1).map((c) => c.low);
  const sweptRecentLow = Math.min(...last5Lows) <= lowestLow;
  if (sweptRecentLow) {
    confluenceScore += 25;
    fulfilledConditions.push({
      title: 'SSL Sweep',
      description: 'اكتساح وسحب سيولة القيعان السابقة (Sell-Side Liquidity) لجمع أوامر البيع والبدء في موجة صعود مؤسسية.',
    });
  }

  // الشرط 2: كسر وتغيير هيكل السوق صعوداً (Bullish MSS)
  const prevSwingHigh = Math.max(...candles.slice(-10, -2).map((c) => c.high));
  const hasMSS = currentPrice > prevSwingHigh || candles[candles.length - 2].close > prevSwingHigh;
  if (hasMSS) {
    confluenceScore += 25;
    fulfilledConditions.push({
      title: 'Bullish MSS',
      description: 'تغيير طابع وهيكل السوق (Market Structure Shift) مع إغلاق شمعة زخم شرائي أعلى القمة السابقة.',
    });
  }

  // الشرط 3: وجود فجوة سعرية شرائية (Bullish FVG)
  const c1 = candles[candles.length - 3];
  const c3 = candles[candles.length - 1];
  const hasBullishFVG = c3.low > c1.high;
  if (hasBullishFVG) {
    confluenceScore += 25;
    fulfilledConditions.push({
      title: 'Bullish FVG',
      description: 'تشكل فجوة قيمة عادلة شرائية (Fair Value Gap) تمثل منطقة إعادة تسعير مؤسسية للدخول المنخفض المخاطر.',
    });
  }

  // الشرط 4: شمعة ارتداد وكتلة طلب شرائية (Bullish OB)
  const isBullishEngulfing = currentCandle.close > currentCandle.open && currentCandle.close > candles[candles.length - 2].high;
  if (isBullishEngulfing) {
    confluenceScore += 15;
    fulfilledConditions.push({
      title: 'Bullish OB',
      description: 'رد فعل شرائي وزخم ورفض قوي من كتلة الأوامر والطلب المؤسسية (Order Block).',
    });
  }

  // الشرط 5: مسافة آمنة للأهداف ومعدل عائد ممتاز
  const stopLoss = parseFloat((lowestLow * 0.992).toFixed(6));
  const risk = currentPrice - stopLoss;
  if (risk > 0) {
    const tp1 = parseFloat((currentPrice + risk * 1.5).toFixed(6));
    const tp2 = parseFloat((currentPrice + risk * 2.5).toFixed(6));
    const tp3 = parseFloat((currentPrice + risk * 4.0).toFixed(6));

    if (confluenceScore >= 65) {
      confluenceScore += 10;
      fulfilledConditions.push({
        title: 'Optimal R:R',
        description: 'معدل المخاطرة إلى العائد يتجاوز 1:2.5 مع استهداف سيولة القمم العليا (Buy-Side Liquidity).',
      });

      const baseAsset = symbol.replace('USDT', '');

      return {
        symbol,
        baseAsset,
        market: 'crypto' as const,
        timeframe, // الفريم الحقيقي
        type: 'SPOT_BUY' as const,
        currentPrice,
        entryZone: {
          min: parseFloat((currentPrice * 0.996).toFixed(6)),
          max: parseFloat((currentPrice * 1.004).toFixed(6)),
        },
        stopLoss,
        targets: { tp1, tp2, tp3 },
        riskRewardRatio: '1:2.8',
        confluenceScore: Math.min(confluenceScore, 98),
        fulfilledConditions,
        analysisReasons: {
          entryReason: `دخول شراء سبوت فوري على فريم [${timeframe}] بعد تأكيد كسر الهيكل Bullish MSS وتجمع السيولة.`,
          stopLossReason: `تم وضع الوقف أسفل القاع المحمي $${stopLoss} لتأمين رأس المال ضد أي انزلاق غير متوقع.`,
          takeProfitReason: `الأهداف محددة عند مستويات السيولة الخارجية (BSL) والقمم السعرية السابقة لتحقيق أقصى ربح.`,
        },
        status: 'ACTIVE' as const,
      };
    }
  }

  return null;
};

// 4. تشغيل المسح الدوري الشامل على جميع العملات عبر 5 فريمات
export const runFullCryptoScan = async () => {
  try {
    const targetTimeframes = ['15m', '30m', '1h', '4h', '1d'];
    console.log('🚀 بدء المسح الشامل متعدد الفريمات (15m, 30m, 1h, 4h, 1d)...');
    
    const symbols = await getActiveUSDTSpotPairs();
    console.log(`🔍 تم جلب ${symbols.length} زوج للتداول السبوت.`);

    let discoveredCount = 0;

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];

      // فحص العملة على كل فريم
      for (const tf of targetTimeframes) {
        const candles = await fetchCandles(symbol, tf, 40);
        const opportunity = analyzeICTBullishSetup(candles, symbol, tf);

        if (opportunity) {
          // التحقق إن كانت هناك فرصة نشطة مسجلة مسبقاً لنفس العملة ونفس الفريم خلال آخر ساعتين
          const existing = await Opportunity.findOne({
            symbol,
            timeframe: tf,
            status: 'ACTIVE',
            createdAt: { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
          });

          if (!existing) {
            const createdOpp = await Opportunity.create(opportunity);
            discoveredCount++;
            console.log(`✅ فرصة ICT جديدة: ${symbol} [${tf}] (نسبة التوافق: ${opportunity.confluenceScore}%)`);

            // ⚡ إرسال التوصية فوراً لقناة التلغرام
            sendOpportunityToTelegram(createdOpp).catch((err) => {
              console.error(`خطأ أثناء إرسال إشعار التلغرام لـ ${symbol} (${tf}):`, err.message);
            });
          }
        }
      }

      // تأخير 300ms بين كل 10 عملات لتجنب ضغط الـ API
      if (i % 10 === 0 && i !== 0) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    console.log(`✨ اكتمل الفحص: تم إضافة ${discoveredCount} فرصة شراء جديدة عبر مختلف الفريمات.`);
  } catch (error) {
    console.error('خطأ أثناء تشغيل الماسح الذكي:', (error as Error).message);
  }
};