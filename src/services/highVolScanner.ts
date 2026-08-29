import axios from 'axios';
import { Opportunity } from '../models/Opportunity';
import { sendHighVolOpportunityToTelegram } from './telegramHighVol';
import { generateChartPngBuffer } from './chartRenderer';

export const HIGH_VOL_PAIRS = [
  'BEAMUSDT', 'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', 'FLOKIUSDT', 'BOMEUSDT', 'MEWUSDT', 'POPCATUSDT',
  'INJUSDT', 'FETUSDT', 'RNDRUSDT', 'RENDERUSDT', 'TAOUSDT', 'ARKMUSDT', 'WLDUSDT',
  'SUIUSDT', 'SEIUSDT', 'APTUSDT', 'TIAUSDT', 'ORDIUSDT', '1000SATSUSDT', 'KASUSDT',
  'TRBUSDT', 'UMAUSDT', 'GASUSDT', 'CYBERUSDT', 'YGGUSDT', 'GALAUSDT', 'CFXUSDT',
  'STXUSDT', 'IMXUSDT', 'PENDLEUSDT', 'JUPUSDT', 'STRKUSDT', 'PYTHUSDT', 'ENAUSDT',
  'ONDOUSDT', 'ZETAUSDT', 'ALTUSDT', 'MANTAUSDT', 'DYMUSDT', 'OMNIUSDT', 'REZUSDT',
  'BBUSDT', 'NOTUSDT', 'TONUSDT', 'PEOPLEUSDT', 'ENSUSDT', 'MEMEUSDT', 'WUSDT', 'BLURUSDT'
];

interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// جلب الشموع من بينانس
const fetchKlines = async (symbol: string, interval: string, limit: number = 100): Promise<Candle[]> => {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await axios.get(url, { timeout: 10000 });
  return res.data.map((c: any) => ({
    openTime: c[0],
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
};

// فحص استراتيجية ICT للعملات السريعة (شراء فقط)
const analyzeHighVolICT = (candles: Candle[]): any | null => {
  if (candles.length < 30) return null;

  const current = candles[candles.length - 1];
  const recent = candles.slice(-25);

  // 1. تحديد قاع السحب الأخير (Liquidity Sweep)
  const lowestLow = Math.min(...recent.map(c => c.low));
  const lowestIdx = recent.findIndex(c => c.low === lowestLow);

  if (lowestIdx < 2 || lowestIdx > recent.length - 3) return null;

  // 2. التحقق من كسر الهيكل الصاعد (True Bullish MSS)
  const priorHigh = Math.max(...recent.slice(0, lowestIdx).map(c => c.high));
  const hasBrokenMSS = recent.slice(lowestIdx).some(c => c.close > priorHigh);

  if (!hasBrokenMSS) return null;

  // 3. البحث عن فجوة سعرية صاعدة (Bullish FVG)
  let fvgFound = false;
  let fvgMin = 0;
  let fvgMax = 0;

  for (let i = candles.length - 6; i < candles.length - 1; i++) {
    if (i < 2) continue;
    const c1 = candles[i - 2];
    const c3 = candles[i];
    if (c3.low > c1.high) {
      fvgFound = true;
      fvgMin = c1.high;
      fvgMax = c3.low;
      break;
    }
  }

  if (!fvgFound) return null;

  // إعداد مستويات الصفقة
  const entryMin = fvgMin;
  const entryMax = fvgMax;
  const stopLoss = lowestLow * 0.995; // تحت قاع السحب
  const risk = (entryMax - stopLoss);

  if (risk <= 0) return null;

  const tp1 = entryMax + (risk * 1.5);
  const tp2 = entryMax + (risk * 2.5);
  const tp3 = entryMax + (risk * 3.5);

  return {
    type: 'BUY',
    entryZone: { min: entryMin, max: entryMax },
    stopLoss: Number(stopLoss.toFixed(6)),
    targets: {
      tp1: Number(tp1.toFixed(6)),
      tp2: Number(tp2.toFixed(6)),
      tp3: Number(tp3.toFixed(6))
    },
    riskRewardRatio: '1:2.5',
    score: 95
  };
};

// دالة التشغيل الرئيسية للفاحص
export const runHighVolCryptoScan = async () => {
  console.log(`⚡ [HighVol Scanner] بدء فحص ${HIGH_VOL_PAIRS.length} زوج من العملات عالية التقلب (1h, 4h)...`);
  const timeframes = ['1h', '4h'];
  let detectedCount = 0;

  for (const symbol of HIGH_VOL_PAIRS) {
    for (const tf of timeframes) {
      try {
        const candles = await fetchKlines(symbol, tf, 80);
        const analysis = analyzeHighVolICT(candles);

        if (analysis) {
          // منع تكرار نفس الصفقة
          const existing = await Opportunity.findOne({
            symbol,
            timeframe: tf,
            market: 'crypto',
            status: 'active',
            createdAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) }
          });

          if (existing) continue;

          const oppData = {
            symbol,
            market: 'crypto',
            timeframe: tf,
            type: analysis.type,
            entryZone: analysis.entryZone,
            stopLoss: analysis.stopLoss,
            targets: analysis.targets,
            riskRewardRatio: analysis.riskRewardRatio,
            score: analysis.score,
            status: 'active',
            createdAt: new Date()
          };

          // حفظ في قاعدة البيانات
          const savedOpp = await Opportunity.create(oppData);

          // توليد الشارت
          let chartBuffer: Buffer | undefined;
          try {
            chartBuffer = await generateChartPngBuffer({
              symbol,
              timeframe: tf,
              candles,
              entryZone: analysis.entryZone,
              stopLoss: analysis.stopLoss,
              targets: analysis.targets,
              fvgZone: analysis.entryZone,
              sweepPrice: analysis.stopLoss
            });
          } catch (chartErr: any) {
            console.warn(`⚠️ تعذر توليد الشارت لـ ${symbol}:`, chartErr.message);
          }

          // الإرسال إلى قناة التليجرام الجديدة
          await sendHighVolOpportunityToTelegram(savedOpp, chartBuffer);
          detectedCount++;
        }

        // فاصل زمني صغير لحماية API الذاكرة والاتصال
        await new Promise(r => setTimeout(r, 150));
      } catch (err: any) {
        // تجاهل أخطاء الأزواج غير المتوفرة مؤقتاً
      }
    }
  }

  console.log(`✨ [HighVol Scanner] اكتمل فحص العملات السريعة. رُصدت ${detectedCount} فرصة جديدة.`);
};
