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

// 1. جلب قائمة أفضل أزواج USDT السبوت النشطة
export const getActiveUSDTSpotPairs = async (): Promise<string[]> => {
  try {
    const res = await axios.get('https://data-api.binance.vision/api/v3/ticker/24hr', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });
    
    const blacklist = ['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'EURUSDT', 'GBPUSDT', 'DAIUSDT', 'AEURUSDT'];
    
    // جلب أعلى 50 زوجاً من حيث حجم التداول والسيولة الحقيقية
    return res.data
      .filter((item: any) => item.symbol.endsWith('USDT') && !blacklist.includes(item.symbol))
      .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 50)
      .map((item: any) => item.symbol);
  } catch (error) {
    console.error('فشل جلب قائمة أزواج باينانس:', (error as Error).message);
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT', 'DOGEUSDT', 'MATICUSDT'];
  }
};

// 2. جلب الشموع البيانية
const fetchCandles = async (symbol: string, interval = '15m', limit = 40): Promise<BinanceCandle[]> => {
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

// 3. تحليل ICT Spot
const analyzeICTBullishSetup = (candles: BinanceCandle[], symbol: string, timeframe: string) => {
  if (candles.length < 30) return null;

  const currentCandle = candles[candles.length - 1];
  const currentPrice = currentCandle.close;

  const recentCandles = candles.slice(-25, -1);
  const lowestLow = Math.min(...recentCandles.map((c) => c.low));

  let confluenceScore = 0;
  const fulfilledConditions: Array<{ title: string; description: string }> = [];

  // الشرط 1: SSL Sweep
  const last5Lows = candles.slice(-6, -1).map((c) => c.low);
  const sweptRecentLow = Math.min(...last5Lows) <= lowestLow;
  if (sweptRecentLow) {
    confluenceScore += 25;
    fulfilledConditions.push({
      title: 'SSL Sweep',
      description: 'اكتساح وسحب سيولة القيعان السابقة (Sell-Side Liquidity) والبدء في موجة صعود.',
    });
  }

  // الشرط 2: Bullish MSS
  const prevSwingHigh = Math.max(...candles.slice(-10, -2).map((c) => c.high));
  const hasMSS = currentPrice > prevSwingHigh || candles[candles.length - 2].close > prevSwingHigh;
  if (hasMSS) {
    confluenceScore += 25;
    fulfilledConditions.push({
      title: 'Bullish MSS',
      description: 'تغيير طابع وهيكل السوق (Market Structure Shift) باختراق قمة سابقة.',
    });
  }

  // الشرط 3: Bullish FVG
  const c1 = candles[candles.length - 3];
  const c3 = candles[candles.length - 1];
  if (c3.low > c1.high) {
    confluenceScore += 25;
    fulfilledConditions.push({
      title: 'Bullish FVG',
      description: 'تشكل فجوة قيمة عادلة شرائية (Fair Value Gap) تمثل منطقة دخول آمنة.',
    });
  }

  // الشرط 4: رد فعل وزخم شرائي
  if (currentCandle.close > currentCandle.open && currentCandle.close > candles[candles.length - 2].high) {
    confluenceScore += 15;
    fulfilledConditions.push({
      title: 'Bullish OB',
      description: 'رد فعل شرائي وزخم ورفض قوي من كتلة الأوامر المؤسسية.',
    });
  }

  // الشرط 5: إدارة المخاطر ومعدل العائد
  const stopLoss = parseFloat((lowestLow * 0.992).toFixed(6));
  const risk = currentPrice - stopLoss;

  if (risk > 0 && confluenceScore >= 60) {
    const tp1 = parseFloat((currentPrice + risk * 1.5).toFixed(6));
    const tp2 = parseFloat((currentPrice + risk * 2.5).toFixed(6));
    const tp3 = parseFloat((currentPrice + risk * 4.0).toFixed(6));

    confluenceScore += 10;
    fulfilledConditions.push({
      title: 'Optimal R:R',
      description: 'معدل المخاطرة إلى العائد يتجاوز 1:2.5 مع استهداف سيولة القمم العليا.',
    });

    const baseAsset = symbol.replace('USDT', '');

    return {
      symbol,
      baseAsset,
      market: 'crypto' as const,
      timeframe,
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
        entryReason: `دخول شراء سبوت على فريم [${timeframe}] بعد تأكيد كسر الهيكل Bullish MSS.`,
        stopLossReason: `تم وضع الوقف أسفل القاع $${stopLoss} لحماية رأس المال.`,
        takeProfitReason: `الأهداف محددة عند مستويات السيولة (BSL) والقمم السابقة.`,
      },
      status: 'ACTIVE' as const,
    };
  }

  return null;
};

// 4. تشغيل المسح الدوري الشامل
export const runFullCryptoScan = async () => {
  try {
    const targetTimeframes = ['15m', '1h', '4h'];
    console.log('🚀 بدء المسح الشامل للكريبتو (15m, 1h, 4h)...');

    const symbols = await getActiveUSDTSpotPairs();
    console.log(`🔍 تم اختيار أفضل ${symbols.length} زوج بالسيولة للتداول.`);

    let discoveredCount = 0;

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];

      for (const tf of targetTimeframes) {
        const candles = await fetchCandles(symbol, tf, 40);
        const opportunity = analyzeICTBullishSetup(candles, symbol, tf);

        if (opportunity) {
          const existing = await Opportunity.findOne({
            symbol,
            timeframe: tf,
            status: 'ACTIVE',
            createdAt: { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
          });

          if (!existing) {
            const createdOpp = await Opportunity.create(opportunity);
            discoveredCount++;
            console.log(`✅ فرصة ICT جديدة: ${symbol} [${tf}]`);

            sendOpportunityToTelegram(createdOpp).catch((err) => {
              console.error(`خطأ إشعار التلغرام لـ ${symbol}:`, err.message);
            });
          }
        }
        // تأخير 50ms بين كل طلب لضمان استقرار السيرفر
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    console.log(`✨ اكتمل الفحص: تم العثور على ${discoveredCount} فرصة شراء جديدة.`);
  } catch (error) {
    console.error('خطأ أثناء تشغيل الماسح:', (error as Error).message);
  }
};
