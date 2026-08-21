import axios from 'axios';
import { sendForexOpportunityToTelegram } from './telegramForex';

const API_KEY = process.env.TWELVE_DATA_API_KEY || '7d5b98c57c0c4c05b856c93fdaebd37b';

// الأصول الأساسية: الذهب والفضة والعملات الرئيسية
const TARGET_ASSETS = ['XAU/USD', 'XAG/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY'];

const sentForexCache = new Map<string, number>();

// فحص جلسات الرصاصة الفضية بتوقيت نيويورك (EST / UTC-4)
const getSilverBulletSession = (): string | null => {
  const now = new Date();
  const nyTimeStr = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
  const [hours, minutes] = nyTimeStr.split(':').map(Number);
  const totalMinutes = hours * 60 + minutes;

  if (totalMinutes >= 180 && totalMinutes < 240) return 'London Open Silver Bullet (3 AM - 4 AM NY)';
  if (totalMinutes >= 600 && totalMinutes < 660) return 'NY AM Silver Bullet (10 AM - 11 AM NY)';
  if (totalMinutes >= 840 && totalMinutes < 900) return 'NY PM Silver Bullet (2 PM - 3 PM NY)';

  return null;
};

const fetchForexCandles = async (symbol: string, interval = '1h', outputsize = 35) => {
  try {
    const res = await axios.get('https://api.twelvedata.com/time_series', {
      params: { symbol, interval, outputsize, apikey: API_KEY },
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

// 1. خوارزمية الرصاصة الفضية (Silver Bullet - 5m)
const analyzeSilverBullet = (candles: any[], symbol: string, session: string) => {
  if (!candles || candles.length < 15) return null;

  const c1 = candles[candles.length - 3];
  const c2 = candles[candles.length - 2];
  const c3 = candles[candles.length - 1];

  const recentLows = candles.slice(-12, -2).map((c) => c.low);
  const recentHighs = candles.slice(-12, -2).map((c) => c.high);
  const lowestLow = Math.min(...recentLows);
  const highestHigh = Math.max(...recentHighs);

  // Bullish Silver Bullet
  const isBullish = c3.low > c1.high && (c3.close > highestHigh || Math.min(c1.low, c2.low) <= lowestLow);
  if (isBullish) {
    const entryPrice = parseFloat(((c1.high + c3.low) / 2).toFixed(symbol.includes('JPY') ? 3 : (symbol.includes('XAU') ? 2 : 5)));
    const stopLoss = parseFloat((lowestLow * 0.999).toFixed(symbol.includes('JPY') ? 3 : (symbol.includes('XAU') ? 2 : 5)));
    const risk = Math.abs(entryPrice - stopLoss);
    return {
      symbol,
      type: 'BUY',
      strategy: 'ICT Silver Bullet 🏹',
      session,
      timeframe: '5m',
      entryPrice,
      stopLoss,
      tp1: parseFloat((entryPrice + risk * 1.5).toFixed(symbol.includes('JPY') ? 3 : (symbol.includes('XAU') ? 2 : 5))),
      tp2: parseFloat((entryPrice + risk * 2.5).toFixed(symbol.includes('JPY') ? 3 : (symbol.includes('XAU') ? 2 : 5))),
      score: 95,
      conditions: ['تداول داخل Killzone', 'سحب سيولة SSL', 'كسر هيكل MSS', 'فجوة FVG شرائية'],
    };
  }

  // Bearish Silver Bullet
  const isBearish = c3.high < c1.low && (c3.close < lowestLow || Math.max(c1.high, c2.high) >= highestHigh);
  if (isBearish) {
    const entryPrice = parseFloat(((c1.low + c3.high) / 2).toFixed(symbol.includes('JPY') ? 3 : (symbol.includes('XAU') ? 2 : 5)));
    const stopLoss = parseFloat((highestHigh * 1.001).toFixed(symbol.includes('JPY') ? 3 : (symbol.includes('XAU') ? 2 : 5)));
    const risk = Math.abs(stopLoss - entryPrice);
    return {
      symbol,
      type: 'SELL',
      strategy: 'ICT Silver Bullet 🏹',
      session,
      timeframe: '5m',
      entryPrice,
      stopLoss,
      tp1: parseFloat((entryPrice - risk * 1.5).toFixed(symbol.includes('JPY') ? 3 : (symbol.includes('XAU') ? 2 : 5))),
      tp2: parseFloat((entryPrice - risk * 2.5).toFixed(symbol.includes('JPY') ? 3 : (symbol.includes('XAU') ? 2 : 5))),
      score: 95,
      conditions: ['تداول داخل Killzone', 'سحب سيولة BSL', 'كسر هيكل MSS', 'فجوة FVG بيعية'],
    };
  }

  return null;
};

// 2. خوارزمية ICT الكلاسيكية (فريمات 1h و 4h فقط)
const analyzeClassicICT = (candles: any[], symbol: string, timeframe: '1h' | '4h') => {
  if (!candles || candles.length < 25) return null;

  const currentCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const c1 = candles[candles.length - 3];
  const c3 = candles[candles.length - 1];

  const recentCandles = candles.slice(-20, -1);
  const lowestLow = Math.min(...recentCandles.map((c) => c.low));
  const highestHigh = Math.max(...recentCandles.map((c) => c.high));

  let score = 0;
  const conditions: string[] = [];

  // نموذج شرائي كلاسيكي
  const hasMSSBuy = currentCandle.close > highestHigh || (prevCandle && prevCandle.close > highestHigh);
  const hasFVGBuy = c1 && c3 && c3.low > c1.high;
  const sweptLow = Math.min(...candles.slice(-5, -1).map((c) => c.low)) <= lowestLow;

  if (sweptLow) { score += 30; conditions.push('سحب سيولة القيعان (SSL Sweep)'); }
  if (hasMSSBuy) { score += 35; conditions.push('تغيير طابع السوق (Bullish MSS)'); }
  if (hasFVGBuy) { score += 30; conditions.push('فجوة قيمة عادلة (Bullish FVG)'); }

  if (score >= 90) {
    const entryPrice = currentCandle.close;
    const stopLoss = parseFloat((lowestLow * 0.998).toFixed(symbol.includes('JPY') ? 3 : (symbol.includes('XAU') ? 2 : 5)));
    const risk = entryPrice - stopLoss;
    if (risk > 0) {
      return {
        symbol,
        type: 'BUY',
        strategy: 'ICT Classic Swing / Intraday 🏛️',
        session: 'Higher Timeframe Analysis',
        timeframe,
        entryPrice,
        stopLoss,
        tp1: parseFloat((entryPrice + risk * 1.5).toFixed(symbol.includes('JPY') ? 3 : (symbol.includes('XAU') ? 2 : 5))),
        tp2: parseFloat((entryPrice + risk * 2.8).toFixed(symbol.includes('JPY') ? 3 : (symbol.includes('XAU') ? 2 : 5))),
        score,
        conditions,
      };
    }
  }

  return null;
};

export const runForexScan = async () => {
  try {
    const sbSession = getSilverBulletSession();
    console.log(`🌍 بدء مسح الفوركس والمعادن (ICT Classic 1h/4h + Silver Bullet)...`);

    for (const symbol of TARGET_ASSETS) {
      // 1. فحص الرصاصة الفضية (5m) أثناء جلسات الـ Killzones
      if (sbSession) {
        const sbCandles = await fetchForexCandles(symbol, '5min', 20);
        const sbSetup = analyzeSilverBullet(sbCandles, symbol, sbSession);
        if (sbSetup) {
          const cacheKey = `${symbol}_SB_${sbSetup.type}_${new Date().getHours()}`;
          if (!sentForexCache.has(cacheKey)) {
            const sent = await sendForexOpportunityToTelegram(sbSetup);
            if (sent) sentForexCache.set(cacheKey, Date.now());
          }
        }
        await new Promise((r) => setTimeout(r, 8000));
      }

      // 2. فحص ICT الكلاسيكي على فريمي 1h و 4h
      for (const tf of ['1h', '4h'] as const) {
        const tfCandles = await fetchForexCandles(symbol, tf === '1h' ? '1h' : '4h', 30);
        const classicSetup = analyzeClassicICT(tfCandles, symbol, tf);

        if (classicSetup) {
          const cacheKey = `${symbol}_CLASSIC_${tf}_${classicSetup.type}_${new Date().getHours()}`;
          if (!sentForexCache.has(cacheKey)) {
            const sent = await sendForexOpportunityToTelegram(classicSetup);
            if (sent) sentForexCache.set(cacheKey, Date.now());
          }
        }
        await new Promise((r) => setTimeout(r, 8000));
      }
    }
  } catch (error: any) {
    console.error('خطأ في مسح الفوركس:', error.message);
  }
};