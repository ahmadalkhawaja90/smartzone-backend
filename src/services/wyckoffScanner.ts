import axios from 'axios';
import { sendSwingOpportunityToTelegram } from './swingTelegramBot';
import { generateChartPngBuffer, CandlePlotData } from './chartGenerator';

export interface CandleData {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// قائمة احتياطية في حال تعذر جلب السوق آلياً
const FALLBACK_PAIRS = [
  'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT', 'SUIUSDT',
  'DOGEUSDT', 'TONUSDT', 'APTUSDT', 'MATICUSDT', 'LTCUSDT', 'BCHUSDT', 'ICPUSDT', 'FETUSDT', 'RENDERUSDT', 'INJUSDT',
  'TAOUSDT', 'PEPEUSDT', 'SHIBUSDT', 'OPUSDT', 'ARBUSDT', 'ATOMUSDT', 'FILUSDT', 'FTMUSDT', 'WIFUSDT', 'KASUSDT',
  'STXUSDT', 'IMXUSDT', 'HBARUSDT', 'GRTUSDT', 'AAVEUSDT', 'MKRUSDT', 'SEIUSDT', 'FLOKIUSDT', 'BONKUSDT', 'RUNEUSDT'
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// كاش لتخزين أزواج المنصة وتحديثها كل 12 ساعة
let cachedPairs: string[] = [];
let lastPairsFetchTime = 0;

const fetchAllSpotUsdtPairs = async (): Promise<string[]> => {
  const now = Date.now();
  if (cachedPairs.length > 0 && now - lastPairsFetchTime < 12 * 60 * 60 * 1000) {
    return cachedPairs;
  }

  try {
    const res = await axios.get('https://api.bybit.com/v5/market/instruments-info', {
      params: { category: 'spot' },
      timeout: 10000,
    });
    const list = res.data.result?.list || [];
    const activeUsdtPairs = list
      .filter((item: any) => item.quoteCoin === 'USDT' && item.status === 'Trading')
      .map((item: any) => item.symbol);

    if (activeUsdtPairs.length > 0) {
      cachedPairs = activeUsdtPairs;
      lastPairsFetchTime = now;
      console.log(`📡 [Wyckoff Scanner] تم تحديث أزواج Bybit Spot آلياً: ${cachedPairs.length} زوج نشط.`);
      return cachedPairs;
    }
  } catch (error: any) {
    console.warn('⚠️ تعذر جلب قائمة الأزواج ديناميكياً، استخدام القائمة الاحتياطية.');
  }

  return cachedPairs.length > 0 ? cachedPairs : FALLBACK_PAIRS;
};

// منع تكرار إرسال نفس العملة خلال 3 أيام (72 ساعة)
const alertedPairs = new Map<string, number>();

const fetchCandles = async (symbol: string, interval = '240', limit = 60): Promise<CandleData[]> => {
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/kline', {
      params: { category: 'spot', symbol, interval, limit },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });
    const list = res.data.result?.list;
    if (!list) return [];
    return list.map((c: any) => ({
      openTime: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    })).reverse();
  } catch {
    return [];
  }
};

interface FVG {
  top: number;
  bottom: number;
}

const detectWyckoffSetup = (candles: CandleData[], symbol: string) => {
  if (candles.length < 50) return null;

  const i = candles.length - 1;
  const rangeSlice = candles.slice(i - 30, i - 5);
  const rangeSupport = Math.min(...rangeSlice.map(c => c.low));
  const rangeResistance = Math.max(...rangeSlice.map(c => c.high));
  const rangeSpread = (rangeResistance - rangeSupport) / rangeSupport;

  // نسبة النطاق العرضي للتجميع
  if (rangeSpread > 0.22 || rangeSpread < 0.035) return null;

  // رصد شمعة الـ Spring (كسر الدعم وإغلاق أعلاه)
  let springCandle = null;
  for (let s = i - 8; s <= i - 2; s++) {
    if (candles[s].low < rangeSupport && candles[s].close > rangeSupport * 0.980) {
      springCandle = candles[s];
      break;
    }
  }
  if (!springCandle) return null;

  // رصد شمعة SOS الصاعدة القوية
  let sosIdx = -1;
  for (let j = i - 5; j <= i; j++) {
    const c = candles[j];
    const body = c.close - c.open;
    const totalHeight = c.high - c.low;
    if (c.close > rangeResistance * 0.995 && totalHeight > 0 && (body / totalHeight) >= 0.40) {
      sosIdx = j;
      break;
    }
  }
  if (sosIdx === -1) return null;

  // رصد فجوة FVG
  let foundFVG: FVG | null = null;
  for (let k = i - 6; k < sosIdx; k++) {
    if (candles[k].high < candles[k + 2].low) {
      foundFVG = {
        bottom: candles[k].high,
        top: candles[k + 2].low,
      };
    }
  }
  if (!foundFVG) return null;

  const entryPrice = parseFloat(((foundFVG.top + foundFVG.bottom) / 2).toFixed(6));
  const currentClose = candles[i].close;

  // التأكد من ملامسة السعر للمنطقة
  if (currentClose >= foundFVG.bottom * 0.995 && currentClose <= foundFVG.top * 1.03) {
    const stopLoss = parseFloat((springCandle.low * 0.992).toFixed(6));
    const risk = entryPrice - stopLoss;
    const riskPercent = parseFloat(((risk / entryPrice) * 100).toFixed(2));

    // استبعاد الصفقات ذات الوقف الأكبر من 5.5%
    if (risk <= 0 || riskPercent > 5.5) return null;

    const tp1 = parseFloat((entryPrice * 1.040).toFixed(6));
    const tp2 = parseFloat((entryPrice * 1.085).toFixed(6));
    const tp3 = parseFloat((entryPrice * 1.150).toFixed(6));

    return {
      symbol,
      entryPrice,
      stopLoss,
      tp1,
      tp2,
      tp3,
      riskPercent,
      fvgTop: foundFVG.top,
      fvgBottom: foundFVG.bottom
    };
  }

  return null;
};

export const runWyckoffScannerJob = async () => {
  console.log('💎 [Wyckoff Swing Scanner] بدء دورة الفحص للسوق كاملاً على 4H...');
  const pairsToScan = await fetchAllSpotUsdtPairs();
  const now = Date.now();

  let foundSignalsCount = 0;

  for (const symbol of pairsToScan) {
    const lastAlert = alertedPairs.get(symbol) || 0;
    // منع التكرار لنفس الزوج خلال 72 ساعة
    if (now - lastAlert < 72 * 60 * 60 * 1000) continue;

    try {
      const candles = await fetchCandles(symbol, '240', 60);
      if (candles.length < 50) continue;

      const setup = detectWyckoffSetup(candles, symbol);
      if (setup) {
        alertedPairs.set(symbol, now);
        foundSignalsCount++;

        let chartBuffer: Buffer | undefined = undefined;
        try {
          chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], {
            symbol,
            timeframe: '4h',
            entry: setup.entryPrice,
            stopLoss: setup.stopLoss,
            tp1: setup.tp1,
            tp2: setup.tp2,
            tp3: setup.tp3,
            fvgTop: setup.fvgTop,
            fvgBottom: setup.fvgBottom,
          });
        } catch {}

        await sendSwingOpportunityToTelegram(setup, chartBuffer);
        await sleep(1000);
      }
    } catch {}

    await sleep(60);
  }

  console.log(`🏁 [Wyckoff Swing Scanner] اكتمل فحص ${pairsToScan.length} زوج. إشارات جديدة: ${foundSignalsCount}`);
};
