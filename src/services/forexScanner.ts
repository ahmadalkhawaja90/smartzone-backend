import axios from 'axios';
import { sendForexOpportunityToTelegram } from './telegramForex';

const API_KEY = process.env.TWELVE_DATA_API_KEY || '7d5b98c57c0c4c05b856c93fdaebd37b';

// الأصول الأساسية: الذهب وأزواج الفوركس عالية السيولة
const TARGET_ASSETS = [
  { symbol: 'XAU/USD', yahooTicker: 'GC=F', isGold: true },
  { symbol: 'EUR/USD', yahooTicker: 'EURUSD=X', isGold: false },
  { symbol: 'GBP/USD', yahooTicker: 'GBPUSD=X', isGold: false },
  { symbol: 'USD/JPY', yahooTicker: 'USDJPY=X', isGold: false },
  { symbol: 'AUD/USD', yahooTicker: 'AUDUSD=X', isGold: false },
  { symbol: 'GBP/JPY', yahooTicker: 'GBPJPY=X', isGold: false },
];

const sentForexCache = new Map<string, number>();

// ==========================================================
// 1. جلب الشموع البيانية (Twelve Data مع Fallback إلى Yahoo)
// ==========================================================
const fetchForexCandles = async (symbolObj: typeof TARGET_ASSETS[0], interval = '1h', outputsize = 70) => {
  const intervalParam = interval === '15m' ? '15min' : '1h';
  
  // 1. محاولة Twelve Data أولاً
  try {
    const res = await axios.get('https://api.twelvedata.com/time_series', {
      params: { symbol: symbolObj.symbol, interval: intervalParam, outputsize, apikey: API_KEY },
      timeout: 10000,
    });

    if (res.data?.values?.length) {
      return res.data.values
        .map((c: any) => ({
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }))
        .reverse();
    }
  } catch {
    // الانتقال للمصدر البديل عند الخطأ أو انتهاء الـ API Limit
  }

  // 2. مصدر احتياطي فوري (Yahoo Finance)
  try {
    const yInterval = interval === '15m' ? '15m' : '60m';
    const range = interval === '15m' ? '5d' : '30d';
    const res = await axios.get(`https://query2.finance.yahoo.com/v8/finance/chart/${symbolObj.yahooTicker}?interval=${yInterval}&range=${range}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });
    
    const result = res.data?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    if (quote?.close?.length) {
      const candles: any[] = [];
      for (let i = 0; i < quote.close.length; i++) {
        if (quote.open[i] && quote.high[i] && quote.low[i] && quote.close[i]) {
          candles.push({
            open: quote.open[i],
            high: quote.high[i],
            low: quote.low[i],
            close: quote.close[i],
          });
        }
      }
      return candles.slice(-outputsize);
    }
  } catch {
    return [];
  }

  return [];
};

// ==========================================================
// 2. أدوات تحديد القمم والقيعان (Swing Points)
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
// 3. خوارزمية التحليل الهيكلي المؤسسي ICT
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

  // فلتر منطقة الخصم (Discount Zone - تحت 50% من الحركة الأخيرة)
  const rangeLow = Math.min(latestSwingLow.price, latestSwingHigh.price);
  const rangeHigh = Math.max(latestSwingLow.price, latestSwingHigh.price);
  const midpoint = (rangeLow + rangeHigh) / 2;
  
  if (currentPrice > midpoint * 1.002) return null; // هامش مرونة بسيط

  let score = 35;
  const conditions: string[] = ['التمركز داخل منطقة الخصم (Discount Zone)'];

  // 1. سحب السيولة (SSL Sweep) خلال آخر 8 شموع
  const recentCandles = candles.slice(-8);
  const sweepCandle = recentCandles.find((c) => c.low < priorSwingLow && c.close > priorSwingLow * 0.999);
  if (sweepCandle) {
    score += 25;
    conditions.push('سحب سيولة القاع الهيكلي (SSL Sweep)');
  }

  // 2. كسر وتغيير هيكل السوق (Bullish MSS) خلال آخر 6 شموع
  const prevSwingHigh = latestSwingHigh.price;
  const hasMSS = recentCandles.some((c) => c.close > prevSwingHigh) || currentPrice > prevSwingHigh * 0.999;
  if (hasMSS) {
    score += 25;
    conditions.push('كسر وتغيير هيكل السوق الصاعد (Bullish MSS)');
  }

  // 3. فجوة القيمة العادلة (Bullish FVG)
  for (let i = candles.length - 1; i >= candles.length - 4; i--) {
    if (i >= 2 && candles[i].low > candles[i - 2].high) {
      score += 15;
      conditions.push('فجوة قيمة عادلة شرائية (Bullish FVG)');
      break;
    }
  }

  if (score < 60) return null;

  const isJpy = symbol.includes('JPY');
  const isGold = symbol.includes('XAU') || symbol.includes('GOLD');
  const slBuffer = isGold ? 1.5 : (isJpy ? 0.15 : 0.0008);
  const decimals = isGold ? 2 : (isJpy ? 3 : 5);

  const stopLoss = parseFloat((Math.min(priorSwingLow, latestSwingLow.price) - slBuffer).toFixed(decimals));
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
    currentPrice: parseFloat(currentPrice.toFixed(decimals)),
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
// 4. تشغيل الفحص الدوري للفوركس والمعادن
// ==========================================================
export const runForexScan = async () => {
  try {
    const targetTimeframes: Array<'15m' | '1h'> = ['15m', '1h'];
    console.log(`🌍 [Forex Scanner] بدء مسح الفوركس والمعادن (15m, 1h)...`);

    for (const asset of TARGET_ASSETS) {
      for (const tf of targetTimeframes) {
        const candles = await fetchForexCandles(asset, tf, 60);

        if (candles.length < 35) continue;

        const setup = analyzeForexICTSetup(candles, asset.symbol, tf);

        if (setup && setup.confluenceScore >= 60) {
          // منع تكرار نفس الصفقة لمدة ساعتين
          const cacheKey = `${asset.symbol}_${tf}_${setup.type}_${Math.floor(Date.now() / (2 * 60 * 60 * 1000))}`;
          if (!sentForexCache.has(cacheKey)) {
            const sent = await sendForexOpportunityToTelegram(setup);
            if (sent) {
              sentForexCache.set(cacheKey, Date.now());
              console.log(`🎯 [Forex Signal Sent]: ${asset.symbol} [${tf}] - Score: ${setup.confluenceScore}%`);
            }
          }
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  } catch (error: any) {
    console.error('❌ خطأ في مسح الفوركس:', error.message);
  }
};
