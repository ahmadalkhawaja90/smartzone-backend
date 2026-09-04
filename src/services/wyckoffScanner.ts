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

const EXPANDED_PAIRS = [
  'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT', 'SUIUSDT',
  'DOGEUSDT', 'TONUSDT', 'APTUSDT', 'MATICUSDT', 'LTCUSDT', 'BCHUSDT', 'ICPUSDT', 'FETUSDT', 'RENDERUSDT', 'INJUSDT',
  'TAOUSDT', 'PEPEUSDT', 'SHIBUSDT', 'OPUSDT', 'ARBUSDT', 'ATOMUSDT', 'FILUSDT', 'FTMUSDT', 'WIFUSDT', 'KASUSDT',
  'STXUSDT', 'IMXUSDT', 'HBARUSDT', 'GRTUSDT', 'AAVEUSDT', 'MKRUSDT', 'SEIUSDT', 'FLOKIUSDT', 'BONKUSDT', 'RUNEUSDT',
  'BEAMUSDT', 'JUPUSDT', 'STRKUSDT', 'PENDLEUSDT', 'TIAUSDT', 'ENSUSDT', 'GALAUSDT', 'CRVUSDT', 'LDOUSDT', 'QNTUSDT',
  'ALGOUSDT', 'DYDXUSDT', 'SANDUSDT', 'MANAUSDT', 'AXSUSDT', 'FLOWUSDT', 'CHZUSDT', 'EGLDUSDT', 'CFXUSDT', 'MINAUSDT',
  'ZILUSDT', 'KAVAUSDT', 'SNXUSDT', 'COMPUSDT', 'BLURUSDT', '1INCHUSDT', 'WOOUSDT', 'ROSEUSDT', 'GMXUSDT', 'RNDRUSDT',
  'AGIXUSDT', 'ORDIUSDT', 'SATSUSDT', 'ILVUSDT', 'SUPERUSDT', 'PYTHUSDT', 'ZROUSDT', 'IOUSDT', 'NOTUSDT', 'BBUSDT',
  'WUSDT', 'ZKUSDT', 'LISTAUSDT', 'TNSRUSDT', 'OMNIUSDT', 'REZUSDT', 'SAGAUSDT', 'ENAUSDT', 'ETHFIUSDT', 'AEVOUSDT',
  'METISUSDT', 'PORTALUSDT', 'DYMUSDT', 'ALTUSDT', 'MANTAUSDT', 'XAIUSDT', 'AIUSDT', 'NFPUSDT', 'ACEUSDT', 'JTOUSDT',
  'MEMEUSDT', 'TUSDT', 'ORBSUSDT', 'ARKMUSDT', 'WLDUSDT', 'CYBERUSDT', 'MAVUSDT', 'XVGUSDT'
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// منع تكرار إرسال نفس العملة خلال 3 أيام (72 ساعة)
const alertedPairs = new Map<string, number>();

const fetchCandles = async (symbol: string, interval = '240', limit = 120): Promise<CandleData[]> => {
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

  if (rangeSpread > 0.22 || rangeSpread < 0.035) return null;

  let springCandle = null;
  for (let s = i - 8; s <= i - 2; s++) {
    if (candles[s].low < rangeSupport && candles[s].close > rangeSupport * 0.980) {
      springCandle = candles[s];
      break;
    }
  }
  if (!springCandle) return null;

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

  if (currentClose >= foundFVG.bottom * 0.995 && currentClose <= foundFVG.top * 1.03) {
    const stopLoss = parseFloat((springCandle.low * 0.992).toFixed(6));
    const risk = entryPrice - stopLoss;
    const riskPercent = parseFloat(((risk / entryPrice) * 100).toFixed(2));

    if (risk <= 0 || riskPercent > 5.5) return null;

    const tp1 = parseFloat((entryPrice * 1.040).toFixed(6));
    const tp2 = parseFloat((entryPrice * 1.085).toFixed(6));

    return {
      symbol,
      entryPrice,
      stopLoss,
      tp1,
      tp2,
      riskPercent,
      fvgTop: foundFVG.top,
      fvgBottom: foundFVG.bottom
    };
  }

  return null;
};

export const runWyckoffScannerJob = async () => {
  console.log('💎 [Wyckoff Swing Scanner] بدء دورة الفحص للسوينغ المؤسسي على 4H...');
  const now = Date.now();

  for (const symbol of EXPANDED_PAIRS) {
    const lastAlert = alertedPairs.get(symbol) || 0;
    // إذا تم تنبيه هذه العملة خلال الـ 72 ساعة الماضية، تجاوز
    if (now - lastAlert < 72 * 60 * 60 * 1000) continue;

    try {
      const candles = await fetchCandles(symbol, '240', 60);
      if (candles.length < 50) continue;

      const setup = detectWyckoffSetup(candles, symbol);
      if (setup) {
        alertedPairs.set(symbol, now);

        let chartBuffer: Buffer | undefined = undefined;
        try {
          chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], {
            symbol,
            timeframe: '4h',
            entry: setup.entryPrice,
            stopLoss: setup.stopLoss,
            tp1: setup.tp1,
            tp2: setup.tp2,
            tp3: setup.tp2,
            fvgTop: setup.fvgTop,
            fvgBottom: setup.fvgBottom,
          });
        } catch {}

        await sendSwingOpportunityToTelegram(setup, chartBuffer);
        await sleep(1000);
      }
    } catch {}

    await sleep(200);
  }

  console.log('🏁 [Wyckoff Swing Scanner] اكتملت دورة فحص السوينغ بنجاح.');
};
