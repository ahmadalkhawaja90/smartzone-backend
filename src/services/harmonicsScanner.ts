import axios from 'axios';
import { sendHarmonicSignalToTelegram, HarmonicSignal } from './telegramHarmonics';
import { generateChartPngBuffer, CandlePlotData } from './chartGenerator';

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

const CRYPTO_TARGETS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT'
];

const TRADITIONAL_TARGETS = [
  // المعادن
  { name: 'XAU/USD (Gold)', ticker: 'GC=F', decimals: 2, market: 'FOREX_METALS' as const },
  { name: 'XAG/USD (Silver)', ticker: 'SI=F', decimals: 3, market: 'FOREX_METALS' as const },
  // الفوركس
  { name: 'EUR/USD', ticker: 'EURUSD=X', decimals: 5, market: 'FOREX_METALS' as const },
  { name: 'GBP/USD', ticker: 'GBPUSD=X', decimals: 5, market: 'FOREX_METALS' as const },
  { name: 'USD/JPY', ticker: 'JPY=X', decimals: 3, market: 'FOREX_METALS' as const },
  // المؤشرات
  { name: 'US100 (Nasdaq)', ticker: '^IXIC', decimals: 2, market: 'INDICES' as const },
  { name: 'US30 (Dow)', ticker: '^DJI', decimals: 2, market: 'INDICES' as const },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sentHarmonicsCache = new Map<string, number>();

// ==========================================
// 1. دوال جلب الشموع (Crypto & Traditional)
// ==========================================
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

// ==========================================
// 2. كشف القمم والقيعان
// ==========================================
const findSwings = (candles: CandleData[], leftRight = 3): SwingPoint[] => {
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

// ==========================================
// 3. المحرك الاستباقي (Anticipatory Engine)
// ==========================================
const predictHarmonics = (
  candles: CandleData[],
  decimals: number
): Omit<HarmonicSignal, 'market' | 'symbol' | 'timeframe'> | null => {
  const swings = findSwings(candles, 3);
  if (swings.length < 4) return null;

  const [X, A, B, C] = swings.slice(-4);
  const currentPrice = candles[candles.length - 1].close;

  if (candles.length - 1 - C.index > 30) return null;

  // أ) توقع الشراء (Bullish Setup - Pending D)
  if (X.type === 'LOW' && A.type === 'HIGH' && B.type === 'LOW' && C.type === 'HIGH') {
    if (currentPrice > C.price) return null;

    const XA = A.price - X.price;
    const AB = A.price - B.price;
    const BC = C.price - B.price;

    const bRetracement = AB / XA;
    const cRetracement = BC / AB;

    if (cRetracement < 0.382 || cRetracement > 0.95) return null;

    let pattern = '';
    let dRatio = 0;
    let score = 90;

    if (Math.abs(bRetracement - 0.618) <= 0.08) { pattern = 'Bullish Gartley'; dRatio = 0.786; score = 98; }
    else if (bRetracement >= 0.35 && bRetracement <= 0.55) { pattern = 'Bullish Bat'; dRatio = 0.886; score = 96; }
    else if (Math.abs(bRetracement - 0.786) <= 0.08) { pattern = 'Bullish Butterfly'; dRatio = 1.272; score = 94; }
    else if (bRetracement >= 0.25 && bRetracement <= 0.65 && !pattern) { pattern = 'Bullish Crab'; dRatio = 1.618; score = 92; }

    if (!pattern) return null;

    const projectedD = A.price - (XA * dRatio);
    if (currentPrice < projectedD * 0.998) return null;

    let stopLoss = 0;
    if (dRatio < 1) {
      stopLoss = X.price - (XA * 0.1);
    } else {
      const extRatio = dRatio === 1.272 ? 1.414 : 2.0;
      stopLoss = A.price - (XA * extRatio);
    }

    const entryPrice = parseFloat(projectedD.toFixed(decimals));
    stopLoss = parseFloat(stopLoss.toFixed(decimals));
    
    const risk = entryPrice - stopLoss;
    if (risk <= 0) return null;

    const CD = C.price - entryPrice;
    const tp1 = parseFloat((entryPrice + CD * 0.382).toFixed(decimals));
    const tp2 = parseFloat((entryPrice + CD * 0.618).toFixed(decimals));
    const tp3 = parseFloat(C.price.toFixed(decimals));

    const rewardTP1 = tp1 - entryPrice;
    if (rewardTP1 / risk < 1.3) return null;

    return {
      pattern,
      type: 'BUY',
      entryPrice,
      stopLoss,
      tp1, tp2, tp3,
      bRetracement: parseFloat(bRetracement.toFixed(3)),
      dRetracement: dRatio,
      score,
    };
  }

  // ب) توقع البيع (Bearish Setup - Pending D)
  if (X.type === 'HIGH' && A.type === 'LOW' && B.type === 'HIGH' && C.type === 'LOW') {
    if (currentPrice < C.price) return null;

    const XA = X.price - A.price;
    const AB = B.price - A.price;
    const BC = B.price - C.price;

    const bRetracement = AB / XA;
    const cRetracement = BC / AB;

    if (cRetracement < 0.382 || cRetracement > 0.95) return null;

    let pattern = '';
    let dRatio = 0;
    let score = 90;

    if (Math.abs(bRetracement - 0.618) <= 0.08) { pattern = 'Bearish Gartley'; dRatio = 0.786; score = 98; }
    else if (bRetracement >= 0.35 && bRetracement <= 0.55) { pattern = 'Bearish Bat'; dRatio = 0.886; score = 96; }
    else if (Math.abs(bRetracement - 0.786) <= 0.08) { pattern = 'Bearish Butterfly'; dRatio = 1.272; score = 94; }
    else if (bRetracement >= 0.25 && bRetracement <= 0.65 && !pattern) { pattern = 'Bearish Crab'; dRatio = 1.618; score = 92; }

    if (!pattern) return null;

    const projectedD = A.price + (XA * dRatio);
    if (currentPrice > projectedD * 1.002) return null;

    let stopLoss = 0;
    if (dRatio < 1) {
      stopLoss = X.price + (XA * 0.1);
    } else {
      const extRatio = dRatio === 1.272 ? 1.414 : 2.0;
      stopLoss = A.price + (XA * extRatio);
    }

    const entryPrice = parseFloat(projectedD.toFixed(decimals));
    stopLoss = parseFloat(stopLoss.toFixed(decimals));
    
    const risk = stopLoss - entryPrice;
    if (risk <= 0) return null;

    const CD = entryPrice - C.price;
    const tp1 = parseFloat((entryPrice - CD * 0.382).toFixed(decimals));
    const tp2 = parseFloat((entryPrice - CD * 0.618).toFixed(decimals));
    const tp3 = parseFloat(C.price.toFixed(decimals));

    const rewardTP1 = entryPrice - tp1;
    if (rewardTP1 / risk < 1.3) return null;

    return {
      pattern,
      type: 'SELL',
      entryPrice,
      stopLoss,
      tp1, tp2, tp3,
      bRetracement: parseFloat(bRetracement.toFixed(3)),
      dRetracement: dRatio,
      score,
    };
  }

  return null;
};

// ==========================================
// 4. محرك الفحص الشامل
// ==========================================
export const scanAllHarmonics = async () => {
  console.log('📐 [Harmonics Scanner] بدء فحص النماذج الاستباقية مع توليد الشارتات...');

  // الكريبتو
  for (const symbol of CRYPTO_TARGETS) {
    for (const tf of ['15m', '1h', '4h']) {
      const candles = await fetchCryptoCandles(symbol, tf);
      if (candles.length < 35) continue;

      const detected = predictHarmonics(candles, 4);
      if (detected) {
        const cacheKey = `${symbol}_${detected.pattern}_${tf}_${detected.type}`;
        const lastSent = sentHarmonicsCache.get(cacheKey) || 0;

        if (Date.now() - lastSent > 4 * 60 * 60 * 1000) {
          const chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], {
            symbol,
            timeframe: tf,
            entry: detected.entryPrice,
            stopLoss: detected.stopLoss,
            tp1: detected.tp1,
            tp2: detected.tp2,
            tp3: detected.tp3,
          });

          const sent = await sendHarmonicSignalToTelegram(
            {
              market: 'CRYPTO',
              symbol,
              timeframe: tf,
              ...detected,
            },
            chartBuffer
          );
          if (sent) sentHarmonicsCache.set(cacheKey, Date.now());
        }
      }
      await sleep(150);
    }
  }

  // الأسواق التقليدية (فوركس ومؤشرات ومعادن)
  for (const asset of TRADITIONAL_TARGETS) {
    for (const tf of ['15m', '1h', '4h']) {
      const candles = await fetchYahooCandles(asset.ticker, tf, asset.decimals);
      if (candles.length < 35) continue;

      const detected = predictHarmonics(candles, asset.decimals);
      if (detected) {
        const cacheKey = `${asset.name}_${detected.pattern}_${tf}_${detected.type}`;
        const lastSent = sentHarmonicsCache.get(cacheKey) || 0;

        if (Date.now() - lastSent > 4 * 60 * 60 * 1000) {
          const chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], {
            symbol: asset.name,
            timeframe: tf,
            entry: detected.entryPrice,
            stopLoss: detected.stopLoss,
            tp1: detected.tp1,
            tp2: detected.tp2,
            tp3: detected.tp3,
          });

          const sent = await sendHarmonicSignalToTelegram(
            {
              market: asset.market,
              symbol: asset.name,
              timeframe: tf,
              ...detected,
            },
            chartBuffer
          );
          if (sent) sentHarmonicsCache.set(cacheKey, Date.now());
        }
      }
      await sleep(150);
    }
  }

  console.log('📐 [Harmonics Scanner] اكتملت دورة فحص الهارمونيك بنجاح.');
};
