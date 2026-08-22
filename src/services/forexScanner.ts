import axios from 'axios';
import { sendForexOpportunityToTelegram } from './telegramForex';

const API_KEY = process.env.TWELVE_DATA_API_KEY || '7d5b98c57c0c4c05b856c93fdaebd37b';

// الأصول الأساسية: الذهب وأزواج الفوركس عالية السيولة
const TARGET_ASSETS = ['XAU/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUDUSD', 'GBP/JPY'];

const sentForexCache = new Map<string, number>();

// ==========================================================
// 1. فحص جلسات السيولة لـ ICT (EST / UTC-4)
// ==========================================================
const getSilverBulletSession = (): string | null => {
  const now = new Date();
  const nyTimeStr = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
  const [hours, minutes] = nyTimeStr.split(':').map(Number);
  const totalMinutes = hours * 60 + minutes;

  if (totalMinutes >= 180 && totalMinutes < 240) return 'London Open Killzone (3 AM - 4 AM NY)';
  if (totalMinutes >= 600 && totalMinutes < 660) return 'NY AM Silver Bullet (10 AM - 11 AM NY)';
  if (totalMinutes >= 840 && totalMinutes < 900) return 'NY PM Silver Bullet (2 PM - 3 PM NY)';

  return null;
};

// ==========================================================
// 2. جلب الشموع البيانية
// ==========================================================
const fetchForexCandles = async (symbol: string, interval = '1h', outputsize = 70) => {
  try {
    const res = await axios.get('https://api.twelvedata.com/time_series', {
      params: { symbol, interval, outputsize, apikey: API_KEY },
      timeout: 10000,
    });

    if (!res.data || !res.data.values) return [];

    return res.data.values
      .map((c: any) => ({
        time: c.datetime,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
      }))
      .reverse();
  } catch (error: any) {
    return [];
  }
};

// ==========================================================
// 3. أدوات تحديد القمم والقيعان والاتجاه العام
// ==========================================================
const findSwingLows = (candles: any[], leftRight = 2) => {
  const lows: any[] = [];
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const left = candles.slice(i - leftRight, i);
    const right = candles.slice(i + 1, i + 1 + leftRight);
    if (left.every((c) => c.low >= candles[i].low) && right.every((c) => c.low >= candles[i].low)) {
      lows.push({ index: i, price: candles[i].low });
    }
  }
  return lows;
};

const findSwingHighs = (candles: any[], leftRight = 2) => {
  const highs: any[] = [];
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const left = candles.slice(i - leftRight, i);
    const right = candles.slice(i + 1, i + 1 + leftRight);
    if (left.every((c) => c.high <= candles[i].high) && right.every((c) => c.high <= candles[i].high)) {
      highs.push({ index: i, price: candles[i].high });
    }
  }
  return highs;
};

// ==========================================================
// 4. خوارزمية التحليل الهيكلي المحسنة للفوركس (15m + 1h)
// ==========================================================
const analyzeForexICTSetup = (candles: any[], symbol: string, timeframe: '15m' | '1h') => {
  if (!candles || candles.length < 35) return null;

  const currentCandle = candles[candles.length - 1];
  const currentPrice = currentCandle.close;

  const swingLows = findSwingLows(candles, 2);
  const swingHighs = findSwingHighs(candles, 2);

  if (swingLows.length < 2 || swingHighs.length < 1) return null;

  const priorSwingLow = swingLows[swingLows.length - 2].price;
  const latestSwingLow = swingLows[swingLows.length - 1];
  const latestSwingHigh = swingHighs[swingHighs.length - 1];

  // فلتر منطقة الخصم (Discount Zone)
  const rangeLow = Math.min(latestSwingLow.price, latestSwingHigh.price);
  const rangeHigh = Math.max(latestSwingLow.price, latestSwingHigh.price);
  if (currentPrice > (rangeLow + rangeHigh) / 2) return null;

  let score = 35; // نقاط الخصم والاتجاه الأساسي
  const conditions: string[] = ['التمركز داخل منطقة الخصم (Discount Zone)'];

  // سحب السيولة
  const sweepCandle = candles.slice(-6, -1).find((c) => c.low < priorSwingLow && c.close > priorSwingLow);
  if (sweepCandle) {
    score += 20;
    conditions.push('سحب سيولة القاع (SSL Sweep)');
  }

  // كسر الهيكل
  const prevSwingHigh = swingHighs[swingHighs.length - 1].price;
  const hasMSS = currentPrice > prevSwingHigh || candles[candles.length - 2].close > prevSwingHigh;
  if (hasMSS) {
    score += 20;
    conditions.push('كسر وتغيير هيكل السوق (Bullish MSS)');
  }

  // فجوة السعر FVG
  const c1 = candles[candles.length - 3];
  const c3 = candles[candles.length - 1];
  if (c3.low > c1.high) {
    score += 15;
    conditions.push('فجوة قيمة عادلة شرائية (Bullish FVG)');
  }

  if (score < 60) return null;

  const isJpy = symbol.includes('JPY');
  const isGold = symbol.includes('XAU') || symbol.includes('GOLD');
  const slBuffer = isGold ? 1.5 : (isJpy ? 0.15 : 0.0008);
  const decimals = isGold ? 2 : (isJpy ? 3 : 5);

  const stopLoss = parseFloat((priorSwingLow - slBuffer).toFixed(decimals));
  const risk = currentPrice - stopLoss;

  if (risk <= 0) return null;

  const tp1 = parseFloat((currentPrice + risk * 1.5).toFixed(decimals));
  const tp2 = parseFloat((currentPrice + risk * 2.5).toFixed(decimals));
  const tp3 = parseFloat((currentPrice + risk * 4.0).toFixed(decimals));

  return {
    symbol,
    type: 'BUY',
    strategy: `ICT Institutional Setup 🏛️`,
    timeframe,
    currentPrice,
    entryZone: {
      min: parseFloat((currentPrice * 0.999).toFixed(decimals)),
      max: parseFloat((currentPrice * 1.001).toFixed(decimals)),
    },
    stopLoss,
    targets: { tp1, tp2, tp3 },
    riskRewardRatio: '1:2.5',
    confluenceScore: Math.min(score, 95),
    fulfilledConditions: conditions.map((c) => ({ title: c })),
  };
};

// ==========================================================
// 5. تشغيل الفحص الدوري
// ==========================================================
export const runForexScan = async () => {
  try {
    const targetTimeframes: Array<'15m' | '1h'> = ['15m', '1h'];
    console.log(`🌍 بدء مسح الفوركس والمعادن (15m, 1h)...`);

    for (const symbol of TARGET_ASSETS) {
      for (const tf of targetTimeframes) {
        const intervalParam = tf === '15m' ? '15min' : '1h';
        const candles = await fetchForexCandles(symbol, intervalParam, 50);

        const setup = analyzeForexICTSetup(candles, symbol, tf);

        if (setup && setup.confluenceScore >= 60) {
          const cacheKey = `${symbol}_${tf}_${setup.type}_${new Date().getHours()}`;
          if (!sentForexCache.has(cacheKey)) {
            const sent = await sendForexOpportunityToTelegram(setup);
            if (sent) sentForexCache.set(cacheKey, Date.now());
          }
        }
        await new Promise((r) => setTimeout(r, 6000)); // احترام معدل طلبات Twelve Data
      }
    }
  } catch (error: any) {
    console.error('❌ خطأ في مسح الفوركس:', error.message);
  }
};
