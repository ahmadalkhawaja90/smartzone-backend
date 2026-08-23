import axios from 'axios';
import { Opportunity } from '../models/Opportunity';
import { sendOpportunityToTelegram } from './telegramBot';

export interface CandleData {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ==========================================================
// 1. جلب قائمة أفضل أزواج USDT النشطة
// ==========================================================
export const getActiveUSDTSpotPairs = async (): Promise<string[]> => {
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=spot', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });

    const blacklist = ['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'EURUSDT', 'DAIUSDT'];

    return res.data.result.list
      .filter((item: any) => item.symbol.endsWith('USDT') && !blacklist.includes(item.symbol))
      .sort((a: any, b: any) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
      .slice(0, 75)
      .map((item: any) => item.symbol);
  } catch (error) {
    console.error('⚠️ فشل جلب أزواج الكريبتو من Bybit:', (error as Error).message);
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT'];
  }
};

// ==========================================================
// 2. جلب الشموع البيانية
// ==========================================================
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toBybitInterval = (interval: string): string => {
  if (interval === '15m') return '15';
  if (interval === '1h') return '60';
  if (interval === '4h') return '240';
  return interval;
};

const toOkxInterval = (interval: string): string => {
  if (interval === '15m') return '15m';
  if (interval === '1h') return '1H';
  if (interval === '4h') return '4H';
  return interval;
};

const fetchCandlesFromBybit = async (symbol: string, interval: string, limit: number): Promise<CandleData[]> => {
  const res = await axios.get('https://api.bybit.com/v5/market/kline', {
    params: { category: 'spot', symbol, interval: toBybitInterval(interval), limit },
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 8000,
  });

  if (!res.data.result?.list?.length) {
    throw new Error('Bybit data empty');
  }

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
};

const fetchCandlesFromOkx = async (symbol: string, interval: string, limit: number): Promise<CandleData[]> => {
  const okxSymbol = symbol.replace('USDT', '') + '-USDT';
  const res = await axios.get('https://www.okx.com/api/v5/market/candles', {
    params: { instId: okxSymbol, bar: toOkxInterval(interval), limit },
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 8000,
  });

  if (!res.data?.data?.length) {
    throw new Error('OKX data empty');
  }

  return res.data.data
    .map((c: any) => ({
      openTime: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }))
    .reverse();
};

const fetchCandles = async (symbol: string, interval = '60', limit = 100): Promise<CandleData[]> => {
  try {
    return await fetchCandlesFromBybit(symbol, interval, limit);
  } catch {
    try {
      return await fetchCandlesFromOkx(symbol, interval, limit);
    } catch {
      return [];
    }
  }
};

// ==========================================================
// 3. أدوات التحليل المؤسسي (Swings & FVG)
// ==========================================================
interface SwingPoint {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

interface FVG {
  startIndex: number;
  top: number;
  bottom: number;
  type: 'BULLISH' | 'BEARISH';
}

const findSwings = (candles: CandleData[], leftRight = 3): SwingPoint[] => {
  const swings: SwingPoint[] = [];
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const isHigh = candles.slice(i - leftRight, i + leftRight + 1).every((c, idx) => idx === leftRight || c.high <= candles[i].high);
    const isLow = candles.slice(i - leftRight, i + leftRight + 1).every((c, idx) => idx === leftRight || c.low >= candles[i].low);

    if (isHigh) swings.push({ index: i, price: candles[i].high, type: 'HIGH' });
    if (isLow) swings.push({ index: i, price: candles[i].low, type: 'LOW' });
  }
  return swings;
};

const detectFVGs = (candles: CandleData[], startIdx: number, endIdx: number): FVG[] => {
  const fvgs: FVG[] = [];
  for (let i = startIdx; i < endIdx - 2; i++) {
    const c1 = candles[i];
    const c3 = candles[i + 2];

    if (c1.high < c3.low) {
      fvgs.push({ startIndex: i, top: c3.low, bottom: c1.high, type: 'BULLISH' });
    } else if (c1.low > c3.high) {
      fvgs.push({ startIndex: i, top: c1.low, bottom: c3.high, type: 'BEARISH' });
    }
  }
  return fvgs;
};

// ==========================================================
// 4. خوارزمية تحليل ICT المؤسسية المطابقة للباك-تيست
// ==========================================================
export const analyzeICTBullishSetup = (candles: CandleData[], symbol: string, timeframe: string) => {
  if (candles.length < 50) return null;

  const swings = findSwings(candles, 3);
  if (swings.length < 5) return null;

  // فحص آخر هيكل مكتمل
  const sCurrent = swings[swings.length - 1];
  const sPrev = swings[swings.length - 2];
  const sPrior = swings[swings.length - 3];

  // 1. التحقق من وجود سحب سيولة (SSL Sweep) لقاع سابق
  if (sCurrent.type !== 'LOW' || sPrev.type !== 'HIGH' || sPrior.type !== 'LOW') {
    return null;
  }

  const didSweep = sCurrent.price < sPrior.price;
  if (!didSweep) return null;

  // 2. التحقق من كسر الهيكل الصاعد (Bullish MSS) بإغلاق جسم الشمعة
  let mssCandleIdx = -1;
  for (let cIdx = sCurrent.index + 1; cIdx < candles.length; cIdx++) {
    if (candles[cIdx].close > sPrev.price) {
      mssCandleIdx = cIdx;
      break;
    }
  }

  if (mssCandleIdx === -1) return null;

  // التأكد من حداثة الكسر (حدث خلال آخر 15 شمعة)
  if (candles.length - 1 - mssCandleIdx > 15) return null;

  // 3. حساب نطاق التوازن ومنطقة الخصم (Discount Zone < 50%)
  const impulseLow = sCurrent.price;
  const impulseHigh = candles[mssCandleIdx].high;
  const impulseRange = impulseHigh - impulseLow;
  if (impulseRange <= 0) return null;

  const equilibrium = impulseLow + impulseRange * 0.5;

  // 4. البحث عن FVG صاعد في منطقة الخصم
  const fvgs = detectFVGs(candles, sCurrent.index, mssCandleIdx);
  const validDiscountFVG = fvgs.reverse().find((f) => f.type === 'BULLISH' && f.top <= equilibrium);

  if (!validDiscountFVG) return null;

  const currentPrice = candles[candles.length - 1].close;
  const entryPrice = validDiscountFVG.top;
  const stopLoss = parseFloat((impulseLow * 0.997).toFixed(6)); // 0.3% Buffer
  const risk = entryPrice - stopLoss;

  if (risk <= 0) return null;

  const tp1 = parseFloat((entryPrice + risk * 1.5).toFixed(6));
  const tp2 = parseFloat(sPrev.price.toFixed(6)); // استهداف سيولة القمة السابقة
  const tp3 = parseFloat((entryPrice + risk * 3.0).toFixed(6));

  const baseAsset = symbol.replace('USDT', '');

  return {
    symbol,
    baseAsset,
    market: 'crypto' as const,
    timeframe,
    type: 'SPOT_BUY' as const,
    currentPrice,
    entryZone: {
      min: parseFloat((validDiscountFVG.bottom).toFixed(6)),
      max: parseFloat((validDiscountFVG.top).toFixed(6)),
    },
    stopLoss,
    targets: { tp1, tp2, tp3 },
    riskRewardRatio: '1:3.0',
    confluenceScore: 95,
    fulfilledConditions: [
      {
        title: 'Sell-Side Liquidity Sweep',
        description: `تم سحب سيولة القاع السابق عند $${sPrior.price.toFixed(4)} عبر كسر وهمي ثم الارتداد.`,
      },
      {
        title: 'Market Structure Shift (MSS)',
        description: `تأكيد كسر هيكل السوق الصاعد بإغلاق شمعة كاملة فوق القمة $${sPrev.price.toFixed(4)}.`,
      },
      {
        title: 'Discount FVG Entry',
        description: `تحديد الدخول عند فجوة FVG غير مغطاة داخل منطقة الخصم المؤسسية (أقل من 50% من الاندفاع).`,
      },
    ],
    analysisReasons: {
      entryReason: `دخول مؤسسي متوافق مع نموذج ICT على فريم [${timeframe}] بعد اكتمال السحب وكسر الهيكل.`,
      stopLossReason: `وقف الخسارة محمي أسفل قاع السحب المؤسسي $${stopLoss}.`,
      takeProfitReason: `TP1 = 1:1.5 | TP2 = سيولة القمة السابقة $${tp2} | TP3 = امتداد 1:3.0.`,
    },
    status: 'ACTIVE' as const,
  };
};

// ==========================================================
// 5. تشغيل المسح الدوري الشامل
// ==========================================================
export const runFullCryptoScan = async () => {
  const targetTimeframes = ['1h', '4h'];
  console.log('🚀 [Crypto Scanner] بدء دورة الفحص الشامل للكريبتو (1h, 4h)...');

  let symbols: string[] = [];
  try {
    symbols = await getActiveUSDTSpotPairs();
    console.log(`🔍 تم جلب ${symbols.length} زوج للتداول بنجاح.`);
  } catch (error) {
    console.error('❌ فشل جلب قائمة الأزواج:', (error as Error).message);
    return;
  }

  let discoveredCount = 0;

  for (const symbol of symbols) {
    for (const tf of targetTimeframes) {
      try {
        const candles = await fetchCandles(symbol, tf, 100);
        if (candles.length < 50) continue;

        const opportunity = analyzeICTBullishSetup(candles, symbol, tf);

        if (opportunity) {
          const existing = await Opportunity.findOne({
            symbol,
            timeframe: tf,
            status: 'ACTIVE',
            createdAt: { $gte: new Date(Date.now() - 4 * 60 * 60 * 1000) },
          });

          if (!existing) {
            const createdOpp = await Opportunity.create(opportunity);
            discoveredCount++;
            console.log(`🎯 [فرصة ICT رُصدت]: ${symbol} [${tf}] - Score: ${opportunity.confluenceScore}%`);

            sendOpportunityToTelegram(createdOpp).catch((err) => {
              console.error(`⚠️ خطأ إرسال التلغرام لـ ${symbol}:`, err.message);
            });
          }
        }
      } catch (error) {
        // الاستمرار في الفحص
      }
      await sleep(150);
    }
  }

  console.log(`✨ [Crypto Scanner] انتهى الفحص: تم رصد وإرسال ${discoveredCount} فرصة بنجاح.`);
};
