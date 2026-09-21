import axios from 'axios';
import { Opportunity } from '../models/Opportunity';
import { sendOpportunityToTelegram } from './telegramBot';
import { generateChartPngBuffer, CandlePlotData } from './chartGenerator';
import { placeLimitBuyOrder } from './binanceClient';

export interface CandleData {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ==========================================================
// 1. جلب قائمة أفضل 60 زوج USDT نشط
// ==========================================================
const CORE_TOP_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'DOTUSDT',
  'SUIUSDT', 'DOGEUSDT', 'TONUSDT', 'APTUSDT', 'MATICUSDT',
  'LTCUSDT', 'BCHUSDT', 'ICPUSDT', 'FETUSDT', 'RENDERUSDT',
  'INJUSDT', 'TAOUSDT', 'PEPEUSDT', 'SHIBUSDT', 'OPUSDT',
  'ARBUSDT', 'ATOMUSDT', 'FILUSDT', 'WIFUSDT', 'KASUSDT',
  'STXUSDT', 'IMXUSDT', 'HBARUSDT', 'GRTUSDT', 'AAVEUSDT',
  'MKRUSDT', 'SEIUSDT', 'FLOKIUSDT', 'BONKUSDT', 'RUNEUSDT',
  'JUPUSDT', 'STRKUSDT', 'PENDLEUSDT', 'TIAUSDT', 'ENSUSDT',
  'GALAUSDT', 'CRVUSDT', 'DYDXUSDT', 'ORDIUSDT', 'ETHFIUSDT'
];

export const getActiveUSDTSpotPairs = async (): Promise<string[]> => {
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=spot', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });

    const blacklist = ['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'EURUSDT', 'DAIUSDT', 'USDEUSDT'];

    const dynamicTop = res.data.result.list
      .filter((item: any) => item.symbol.endsWith('USDT') && !blacklist.includes(item.symbol))
      .sort((a: any, b: any) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
      .slice(0, 60)
      .map((item: any) => item.symbol);

    return Array.from(new Set([...CORE_TOP_PAIRS, ...dynamicTop])).slice(0, 60);
  } catch (error) {
    return CORE_TOP_PAIRS;
  }
};

// ==========================================================
// 2. جلب الشموع البيانية
// ==========================================================
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toBybitInterval = (interval: string): string => {
  if (interval === '1h') return '60';
  if (interval === '4h') return '240';
  return interval;
};

const toOkxInterval = (interval: string): string => {
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

  if (!res.data.result?.list?.length) throw new Error('Bybit data empty');

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

  if (!res.data?.data?.length) throw new Error('OKX data empty');

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

const fetchCandles = async (symbol: string, interval = '4h', limit = 100): Promise<CandleData[]> => {
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

// ==========================================
// 3. أدوات التحليل المؤسسي (ICT Elements)
// ==========================================
interface SwingPoint {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

interface FVG {
  startIndex: number;
  top: number;
  bottom: number;
  type: 'BULLISH';
}

interface OrderBlock {
  index: number;
  top: number;
  bottom: number;
}

const findSwings = (candles: CandleData[], leftRight = 2): SwingPoint[] => {
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
    }
  }
  return fvgs;
};

const findBullishOrderBlock = (candles: CandleData[], startIdx: number, endIdx: number): OrderBlock | null => {
  for (let i = endIdx - 1; i >= startIdx; i--) {
    const c = candles[i];
    if (c.close < c.open) {
      return { index: i, top: Math.max(c.open, c.close), bottom: c.low };
    }
  }
  return null;
};

const isOBUnmitigated = (candles: CandleData[], ob: OrderBlock, uptoIdx: number): boolean => {
  for (let i = ob.index + 1; i < uptoIdx; i++) {
    if (candles[i].low <= ob.bottom) return false;
  }
  return true;
};

// ==========================================
// 4. خوارزمية OB + FVG Confluence المعتمدة
// ==========================================
export const analyzeOBFVGSetup = (candles: CandleData[], symbol: string, timeframe: string) => {
  if (candles.length < 50) return null;

  const swings = findSwings(candles, 2);
  if (swings.length < 5) return null;

  const currentPrice = candles[candles.length - 1].close;
  const baseAsset = symbol.replace('USDT', '');
  const recentSwings = swings.slice(-15);

  for (let i = recentSwings.length - 1; i >= 2; i--) {
    const sweepNode = recentSwings[i];
    if (sweepNode.type !== 'LOW') continue;

    let prevLow: SwingPoint | null = null;
    let mssHigh: SwingPoint | null = null;

    for (let j = i - 1; j >= 0; j--) {
      if (recentSwings[j].type === 'LOW' && sweepNode.price < recentSwings[j].price) {
        prevLow = recentSwings[j];
        let maxPrice = -Infinity;
        for (let k = j; k <= i; k++) {
          if (recentSwings[k].type === 'HIGH' && recentSwings[k].price > maxPrice) {
            maxPrice = recentSwings[k].price;
            mssHigh = recentSwings[k];
          }
        }
        break; 
      }
    }

    if (!prevLow || !mssHigh) continue;

    let mssIdx = -1;
    let highestAfterMSS = sweepNode.price;

    for (let c = sweepNode.index + 1; c < candles.length - 1; c++) {
      if (candles[c].high > highestAfterMSS) highestAfterMSS = candles[c].high;
      if (mssIdx === -1 && candles[c].close > mssHigh.price) {
        mssIdx = c;
      }
    }

    if (mssIdx === -1 || (candles.length - 1 - mssIdx > 12)) continue;

    const impulseLow = sweepNode.price;
    const equilibrium = impulseLow + (highestAfterMSS - impulseLow) * 0.5;

    // استخراج وتأكيد الأوردر بلوك البكر
    const ob = findBullishOrderBlock(candles, sweepNode.index, mssIdx);
    if (!ob) continue;
    if (!isOBUnmitigated(candles, ob, mssIdx)) continue;

    // رصد الفجوة المتقاطعة مع الأوردر بلوك داخل منطقة الخصم
    const fvgs = detectFVGs(candles, sweepNode.index, mssIdx);
    const overlappingFVG = fvgs.find(
      (f) => f.bottom <= ob.top && f.top >= ob.bottom && f.bottom <= equilibrium
    );
    if (!overlappingFVG) continue;

    // حدود منطقة التقاطع المشتركة
    const zoneTop = Math.min(ob.top, overlappingFVG.top);
    const zoneBottom = Math.max(ob.bottom, overlappingFVG.bottom);
    if (zoneTop <= zoneBottom) continue;

    // الدخول عند منتصف منطقة التقاطع (50% Consequent Encroachment)
    const entryPrice = parseFloat(((zoneTop + zoneBottom) / 2).toFixed(6));

    // الوقف المحكم أسفل قاع التقاطع بنسبة 0.3%
    const stopLoss = parseFloat((zoneBottom * 0.997).toFixed(6));
    const risk = entryPrice - stopLoss;

    if (risk <= 0 || currentPrice < zoneBottom) continue;

    // الأهداف الاستراتيجية (الهدف الأساسي 1.5R)
    const tp1 = parseFloat((entryPrice + risk * 1.5).toFixed(6));
    const tp2 = parseFloat((entryPrice + risk * 2.5).toFixed(6));
    const tp3 = parseFloat((entryPrice + risk * 4.0).toFixed(6));

    return {
      opportunity: {
        symbol,
        baseAsset,
        market: 'crypto' as const,
        timeframe,
        type: 'SPOT_BUY' as const,
        currentPrice,
        entryZone: { min: parseFloat(zoneBottom.toFixed(6)), max: entryPrice },
        stopLoss,
        targets: { tp1, tp2, tp3 },
        riskRewardRatio: '1:1.5',
        confluenceScore: 99,
        fulfilledConditions: [
          { title: 'Liquidity Sweep', description: `سحب سيولة القاع $${prevLow.price}` },
          { title: 'True MSS', description: `كسر حقيقي للهيكل الصاعد فوق $${mssHigh.price}` },
          { title: 'OB + FVG Confluence', description: `تقاطع متطابق بين كتلة الأوامر والفجوة السعرية` },
          { title: 'Optimized 50% CE Entry', description: `دخول مؤسسي من منتصف منطقة التقاطع` },
        ],
        analysisReasons: {
          entryReason: `شراء Limit عند منتصف تقاطع OB+FVG بسعر $${entryPrice}.`,
          stopLossReason: `وقف محكم أسفل قاع منطقة التقاطع $${stopLoss}.`,
          takeProfitReason: `TP1 (هدف الخروج الكامل): $${tp1} بمعدل عائد 1.5R.`
        },
        status: 'PENDING_ENTRY' as const,
      },
      chartOptions: {
        symbol,
        timeframe,
        entry: entryPrice,
        stopLoss,
        tp1,
        tp2,
        tp3,
        fvgTop: zoneTop,
        fvgBottom: zoneBottom
      },
    };
  }

  return null;
};

// ==========================================
// 5. تشغيل المسح الدوري الشامل (فريم 4H)
// ==========================================
export const runFullCryptoScan = async () => {
  const targetTimeframes = ['4h'];
  console.log('🚀 [Crypto Scanner] بدء فحص استراتيجية OB + FVG Confluence على فريم 4H...');

  let symbols: string[] = [];
  try {
    symbols = await getActiveUSDTSpotPairs();
    console.log(`🔍 تم تثبيت ${symbols.length} زوج للفحص المتقدم على فريم 4H.`);
  } catch (error) {
    return;
  }

  let discoveredCount = 0;

  for (const symbol of symbols) {
    for (const tf of targetTimeframes) {
      try {
        const candles = await fetchCandles(symbol, tf, 120);
        if (candles.length < 50) continue;

        const result = analyzeOBFVGSetup(candles, symbol, tf);

        if (result) {
          // حماية 24 ساعة لعدم تكرار نفس الزوج نظراً لطبيعة فريم الـ 4H
          const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const existing = await Opportunity.findOne({
            symbol,
            $or: [
              { status: { $in: ['PENDING_ENTRY', 'ACTIVE', 'BREAK_EVEN', 'TP1_SECURED'] } },
              { createdAt: { $gte: twentyFourHoursAgo } }
            ]
          });

          if (existing) {
            continue;
          }

          const entryPrice = result.opportunity.entryZone.max;
          const orderResult = await placeLimitBuyOrder(symbol, entryPrice);

          let orderId: string | undefined = undefined;
          if (orderResult.success && orderResult.orderId) {
            orderId = orderResult.orderId;
            console.log(`⚡ [Binance] تم وضع أمر شراء Limit لـ ${symbol} بسعر $${entryPrice} (Order ID: ${orderId})`);
          } else {
            console.warn(`⚠️ [Binance] تنبيه التنفيذ لـ ${symbol}: ${orderResult.error}`);
          }

          const createdOpp = await Opportunity.create({
            ...result.opportunity,
            orderId,
          });

          discoveredCount++;
          console.log(`🎯 [فرصة 4H OB+FVG]: ${symbol} - تم الحفظ والتجهيز للإرسال.`);

          const chartBuffer = generateChartPngBuffer(candles as CandlePlotData[], result.chartOptions);
          await sendOpportunityToTelegram(createdOpp, chartBuffer);
        }
      } catch (error) {
        // الاستمرار في الفحص في حال وجود أخطاء في زوج معين
      }
      await sleep(150);
    }
  }

  console.log(`✨ [Crypto Scanner] اكتمل فحص 4H: رُصدت ${discoveredCount} فرصة ذهبية.`);
};
