import axios from 'axios';
import { sendHarmonicSignalToTelegram, HarmonicSignal } from './telegramHarmonics';

interface CandleData {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SwingPoint {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

const CRYPTO_TARGETS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT'];

const TRADITIONAL_TARGETS = [
  { name: 'XAU/USD (Gold)', ticker: 'GC=F', decimals: 2, market: 'FOREX_METALS' as const },
  { name: 'XAG/USD (Silver)', ticker: 'SI=F', decimals: 3, market: 'FOREX_METALS' as const },
  { name: 'US100 (Nasdaq)', ticker: '^IXIC', decimals: 2, market: 'INDICES' as const },
  { name: 'US500 (S&P 500)', ticker: '^GSPC', decimals: 2, market: 'INDICES' as const },
  { name: 'US30 (Dow Jones)', ticker: '^DJI', decimals: 2, market: 'INDICES' as const },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sentHarmonicsCache = new Map<string, number>();

// 1. جلب شموع الكريبتو من Bybit
const fetchCryptoCandles = async (symbol: string, interval: string): Promise<CandleData[]> => {
  const bybitInterval = interval === '15m' ? '15' : interval === '1h' ? '60' : '240';
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/kline', {
      params: { category: 'spot', symbol, interval: bybitInterval, limit: 120 },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });
    if (!res.data?.result?.list?.length) return [];
    return res.data.result.list
      .map((c: any) => ({
        openTime: parseInt(c[0]),
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }))
      .reverse();
  } catch {
    return [];
  }
};

// 2. جلب شموع المعادن والمؤشرات من Yahoo Finance
const fetchYahooCandles = async (ticker: string, interval: string, decimals: number): Promise<CandleData[]> => {
  const yInterval = interval === '15m' ? '15m' : interval === '1h' ? '60m' : '1d';
  const range = interval === '15m' ? '5d' : '30d';
  try {
    const res = await axios.get(`https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${yInterval}&range=${range}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 9000,
    });
    const result = res.data?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    if (!result?.timestamp || !quote?.close?.length) return [];

    const candles: CandleData[] = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      if (quote.open?.[i] && quote.high?.[i] && quote.low?.[i] && quote.close?.[i]) {
        candles.push({
          openTime: result.timestamp[i] * 1000,
          open: parseFloat(quote.open[i].toFixed(decimals)),
          high: parseFloat(quote.high[i].toFixed(decimals)),
          low: parseFloat(quote.low[i].toFixed(decimals)),
          close: parseFloat(quote.close[i].toFixed(decimals)),
          volume: quote.volume?.[i] || 1000,
        });
      }
    }
    return candles;
  } catch {
    return [];
  }
};

// 3. تحديد القمم والقيعان الهندسية
const findSwings = (candles: CandleData[], leftRight = 2): SwingPoint[] => {
  const swings: SwingPoint[] = [];
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const left = candles.slice(i - leftRight, i);
    const right = candles.slice(i + 1, i + 1 + leftRight);

    if (left.every((c) => c.high <= candles[i].high) && right.every((c) => c.high <= candles[i].high)) {
      swings.push({ index: i, price: candles[i].high, type: 'HIGH' });
    } else if (left.every((c) => c.low >= candles[i].low) && right.every((c) => c.low >= candles[i].low)) {
      swings.push({ index: i, price: candles[i].low, type: 'LOW' });
    }
  }
  return swings;
};

// 4. خوارزمية كشف النماذج (شراء وبيع Gartley & Bat)
const detectHarmonics = (
  candles: CandleData[],
  decimals: number
): Omit<HarmonicSignal, 'market' | 'symbol' | 'timeframe'> | null => {
  const swings = findSwings(candles, 2);
  if (swings.length < 5) return null;

  const [X, A, B, C, D] = swings.slice(-5);

  // التأكد من حداثة اكتمال النقطة D
  if (D.index < candles.length - 4) return null;

  // ==========================================
  // أ) النماذج الشرائية الصاعدة (Bullish Setups)
  // ==========================================
  if (X.type === 'LOW' && A.type === 'HIGH' && B.type === 'LOW' && C.type === 'HIGH' && D.type === 'LOW') {
    const XA = A.price - X.price;
    if (XA <= 0) return null;

    const bRetracement = (A.price - B.price) / XA;
    const dRetracement = (A.price - D.price) / XA;

    let pattern = '';
    let score = 95;

    // Gartley (B ~ 0.618, D ~ 0.786)
    if (Math.abs(bRetracement - 0.618) <= 0.08 && Math.abs(dRetracement - 0.786) <= 0.08) {
      pattern = 'Bullish Gartley';
      score = 98;
    }
    // Bat (B ~ 0.382-0.50, D ~ 0.886)
    else if (bRetracement >= 0.35 && bRetracement <= 0.55 && Math.abs(dRetracement - 0.886) <= 0.08) {
      pattern = 'Bullish Bat';
      score = 96;
    }

    if (pattern) {
      const entry = D.price;
      const stopLoss = parseFloat((X.price * 0.996).toFixed(decimals));
      if (stopLoss >= entry) return null;

      const CD = C.price - D.price;
      const tp1 = parseFloat((entry + CD * 0.382).toFixed(decimals));
      const tp2 = parseFloat((entry + CD * 0.618).toFixed(decimals));
      const tp3 = parseFloat((entry + CD * 1.0).toFixed(decimals));

      if (entry < tp1 && tp1 < tp2 && tp2 < tp3) {
        return {
          pattern,
          type: 'BUY',
          entryPrice: entry,
          stopLoss,
          tp1,
          tp2,
          tp3,
          bRetracement,
          dRetracement,
          score,
        };
      }
    }
  }

  // ==========================================
  // ب) النماذج البيعية الهابطة (Bearish Setups)
  // ==========================================
  if (X.type === 'HIGH' && A.type === 'LOW' && B.type === 'HIGH' && C.type === 'LOW' && D.type === 'HIGH') {
    const XA = X.price - A.price;
    if (XA <= 0) return null;

    const bRetracement = (B.price - A.price) / XA;
    const dRetracement = (D.price - A.price) / XA;

    let pattern = '';
    let score = 95;

    // Bearish Gartley
    if (Math.abs(bRetracement - 0.618) <= 0.08 && Math.abs(dRetracement - 0.786) <= 0.08) {
      pattern = 'Bearish Gartley';
      score = 98;
    }
    // Bearish Bat
    else if (bRetracement >= 0.35 && bRetracement <= 0.55 && Math.abs(dRetracement - 0.886) <= 0.08) {
      pattern = 'Bearish Bat';
      score = 96;
    }

    if (pattern) {
      const entry = D.price;
      const stopLoss = parseFloat((X.price * 1.004).toFixed(decimals));
      if (stopLoss <= entry) return null;

      const CD = D.price - C.price;
      const tp1 = parseFloat((entry - CD * 0.382).toFixed(decimals));
      const tp2 = parseFloat((entry - CD * 0.618).toFixed(decimals));
      const tp3 = parseFloat((entry - CD * 1.0).toFixed(decimals));

      if (entry > tp1 && tp1 > tp2 && tp2 > tp3) {
        return {
          pattern,
          type: 'SELL',
          entryPrice: entry,
          stopLoss,
          tp1,
          tp2,
          tp3,
          bRetracement,
          dRetracement,
          score,
        };
      }
    }
  }

  return null;
};

// 5. محرك الفحص الشامل
export const scanAllHarmonics = async () => {
  console.log('📐 [Harmonics Scanner] بدء فحص نماذج الهارمونيك (Crypto / Metals / Indices)...');

  // فحص الكريبتو
  for (const symbol of CRYPTO_TARGETS) {
    for (const tf of ['15m', '1h', '4h']) {
      const candles = await fetchCryptoCandles(symbol, tf);
      if (candles.length < 35) continue;

      const detected = detectHarmonics(candles, 4);
      if (detected) {
        const cacheKey = `${symbol}_${detected.pattern}_${tf}_${detected.type}`;
        const lastSent = sentHarmonicsCache.get(cacheKey) || 0;

        // منع تكرار نفس النموذج خلال 4 ساعات
        if (Date.now() - lastSent > 4 * 60 * 60 * 1000) {
          const sent = await sendHarmonicSignalToTelegram({
            market: 'CRYPTO',
            symbol,
            timeframe: tf,
            ...detected,
          });
          if (sent) sentHarmonicsCache.set(cacheKey, Date.now());
        }
      }
      await sleep(150);
    }
  }

  // فحص المعادن والمؤشرات
  for (const asset of TRADITIONAL_TARGETS) {
    for (const tf of ['15m', '1h', '4h']) {
      const candles = await fetchYahooCandles(asset.ticker, tf, asset.decimals);
      if (candles.length < 35) continue;

      const detected = detectHarmonics(candles, asset.decimals);
      if (detected) {
        const cacheKey = `${asset.name}_${detected.pattern}_${tf}_${detected.type}`;
        const lastSent = sentHarmonicsCache.get(cacheKey) || 0;

        if (Date.now() - lastSent > 4 * 60 * 60 * 1000) {
          const sent = await sendHarmonicSignalToTelegram({
            market: asset.market,
            symbol: asset.name,
            timeframe: tf,
            ...detected,
          });
          if (sent) sentHarmonicsCache.set(cacheKey, Date.now());
        }
      }
      await sleep(150);
    }
  }

  console.log('📐 [Harmonics Scanner] اكتملت دورة الفحص.');
};
