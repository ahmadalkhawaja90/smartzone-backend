import { Resvg } from '@resvg/resvg-js';

export interface CandlePlotData {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface HarmonicPoint {
  index: number; // رقم الشمعة ضمن آخر 35 شمعة (0 إلى 34)
  price: number;
}

export interface HarmonicPattern {
  name: string; // مثال: "Gartley", "Bat", "Butterfly", "Crab", "Cypher"
  type?: 'bullish' | 'bearish';
  x: HarmonicPoint;
  a: HarmonicPoint;
  b: HarmonicPoint;
  c: HarmonicPoint;
  d: HarmonicPoint;
  fibRatios?: {
    xb?: number | string; // نسبة تصحيح B من XA
    ac?: number | string; // نسبة تصحيح C من AB
    bd?: number | string; // نسبة امتداد D من BC
    xd?: number | string; // نسبة تصحيح/امتداد D من XA (PRZ)
  };
}

export interface ChartOverlayOptions {
  symbol: string;
  timeframe: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  fvgTop?: number;
  fvgBottom?: number;
  harmonicPattern?: HarmonicPattern; // إضافة الهارمونيك الاختيارية
}

export const generateChartPngBuffer = (
  candles: CandlePlotData[],
  options: ChartOverlayOptions
): Buffer => {
  const width = 800;
  const height = 450;
  const padding = { top: 40, bottom: 40, left: 20, right: 95 };

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const visibleCandles = candles.slice(-35);
  const count = visibleCandles.length;

  let allPrices = visibleCandles.flatMap((c) => [c.high, c.low]);
  allPrices.push(options.entry, options.stopLoss, options.tp1, options.tp2, options.tp3);
  if (options.fvgTop) allPrices.push(options.fvgTop);
  if (options.fvgBottom) allPrices.push(options.fvgBottom);

  // احتساب نقاط الهارمونيك ضمن النطاق السعري
  if (options.harmonicPattern) {
    const { x, a, b, c, d } = options.harmonicPattern;
    allPrices.push(x.price, a.price, b.price, c.price, d.price);
  }

  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const priceRange = maxPrice - minPrice || 1;

  const getY = (price: number) => {
    return padding.top + plotHeight - ((price - minPrice) / priceRange) * plotHeight;
  };

  const candleSpacing = plotWidth / Math.max(count, 1);
  const candleBodyWidth = Math.max(candleSpacing * 0.65, 4);

  const getX = (index: number) => {
    const clampedIndex = Math.max(0, Math.min(index, count - 1));
    return padding.left + clampedIndex * candleSpacing + candleSpacing / 2;
  };

  let elements = '';

  // شبكة الأسعار (ICT Grid)
  const gridLevels = 5;
  for (let i = 0; i <= gridLevels; i++) {
    const p = minPrice + (priceRange / gridLevels) * i;
    const y = getY(p);
    elements += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#232733" stroke-width="1" stroke-dasharray="3,3" />`;
    elements += `<text x="${width - padding.right + 8}" y="${y + 4}" fill="#787b86" font-size="11" font-family="Arial">${p.toFixed(2)}</text>`;
  }

  // رسم منطقة ICT FVG
  if (options.fvgTop && options.fvgBottom) {
    const fvgY = getY(Math.max(options.fvgTop, options.fvgBottom));
    const fvgH = Math.max(Math.abs(getY(options.fvgTop) - getY(options.fvgBottom)), 4);
    elements += `<rect x="${padding.left}" y="${fvgY}" width="${plotWidth}" height="${fvgH}" fill="rgba(41, 98, 255, 0.18)" stroke="#2962ff" stroke-width="1" stroke-dasharray="4,4" />`;
    elements += `<text x="${padding.left + 10}" y="${fvgY + 14}" fill="#2962ff" font-size="11" font-weight="bold" font-family="Arial">ICT FVG Zone</text>`;
  }

  // رسم نموذج الهارمونيك (Harmonic Pattern XABCD & Ratios)
  if (options.harmonicPattern) {
    const hp = options.harmonicPattern;
    const ptX = { x: getX(hp.x.index), y: getY(hp.x.price) };
    const ptA = { x: getX(hp.a.index), y: getY(hp.a.price) };
    const ptB = { x: getX(hp.b.index), y: getY(hp.b.price) };
    const ptC = { x: getX(hp.c.index), y: getY(hp.c.price) };
    const ptD = { x: getX(hp.d.index), y: getY(hp.d.price) };

    const harmonicColor = hp.type === 'bearish' ? '#f59e0b' : '#00bcd4';
    const polyFill = hp.type === 'bearish' ? 'rgba(245, 158, 11, 0.14)' : 'rgba(0, 188, 212, 0.14)';

    // تظليل مثلثات النمط (XAB و BCD)
    elements += `<polygon points="${ptX.x},${ptX.y} ${ptA.x},${ptA.y} ${ptB.x},${ptB.y}" fill="${polyFill}" />`;
    elements += `<polygon points="${ptB.x},${ptB.y} ${ptC.x},${ptC.y} ${ptD.x},${ptD.y}" fill="${polyFill}" />`;

    // أضلاع النمط X-A-B-C-D
    elements += `<polyline points="${ptX.x},${ptX.y} ${ptA.x},${ptA.y} ${ptB.x},${ptB.y} ${ptC.x},${ptC.y} ${ptD.x},${ptD.y}" fill="none" stroke="${harmonicColor}" stroke-width="2" stroke-linejoin="round" />`;

    // خطوط داخلية منقطة لقياس نسب الفيبوناتشي (XB و AC و XD)
    elements += `<line x1="${ptX.x}" y1="${ptX.y}" x2="${ptB.x}" y2="${ptB.y}" stroke="${harmonicColor}" stroke-width="1" stroke-dasharray="2,2" opacity="0.6" />`;
    elements += `<line x1="${ptA.x}" y1="${ptA.y}" x2="${ptC.x}" y2="${ptC.y}" stroke="${harmonicColor}" stroke-width="1" stroke-dasharray="2,2" opacity="0.6" />`;
    elements += `<line x1="${ptX.x}" y1="${ptX.y}" x2="${ptD.x}" y2="${ptD.y}" stroke="${harmonicColor}" stroke-width="1" stroke-dasharray="2,2" opacity="0.6" />`;

    // دوائر وتسميات النقاط (X, A, B, C, D)
    const points = [
      { label: 'X', ...ptX },
      { label: 'A', ...ptA },
      { label: 'B', ...ptB },
      { label: 'C', ...ptC },
      { label: 'D (PRZ)', ...ptD },
    ];

    points.forEach((p) => {
      elements += `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="#ffffff" stroke="${harmonicColor}" stroke-width="2" />`;
      elements += `<text x="${p.x}" y="${p.y - 8}" fill="#ffffff" font-size="10" font-weight="bold" font-family="Arial" text-anchor="middle">${p.label}</text>`;
    });

    // تسميات نسب الفيبوناتشي على الأضلاع إن وُجدت
    if (hp.fibRatios) {
      if (hp.fibRatios.xb) {
        const mx = (ptX.x + ptB.x) / 2;
        const my = (ptX.y + ptB.y) / 2;
        elements += `<text x="${mx}" y="${my - 3}" fill="${harmonicColor}" font-size="9" font-weight="bold" font-family="Arial" text-anchor="middle">${hp.fibRatios.xb}</text>`;
      }
      if (hp.fibRatios.ac) {
        const mx = (ptA.x + ptC.x) / 2;
        const my = (ptA.y + ptC.y) / 2;
        elements += `<text x="${mx}" y="${my - 3}" fill="${harmonicColor}" font-size="9" font-weight="bold" font-family="Arial" text-anchor="middle">${hp.fibRatios.ac}</text>`;
      }
      if (hp.fibRatios.xd) {
        const mx = (ptX.x + ptD.x) / 2;
        const my = (ptX.y + ptD.y) / 2;
        elements += `<text x="${mx}" y="${my + 11}" fill="${harmonicColor}" font-size="9" font-weight="bold" font-family="Arial" text-anchor="middle">${hp.fibRatios.xd}</text>`;
      }
    }
  }

  // رسم الشموع اليابانية
  visibleCandles.forEach((c, i) => {
    const x = getX(i);
    const isBull = c.close >= c.open;
    const color = isBull ? '#089981' : '#f23645';

    const yHigh = getY(c.high);
    const yLow = getY(c.low);
    const yOpen = getY(c.open);
    const yClose = getY(c.close);

    const bodyY = Math.min(yOpen, yClose);
    const bodyH = Math.max(Math.abs(yOpen - yClose), 1.5);

    elements += `<line x1="${x}" y1="${yHigh}" x2="${x}" y2="${yLow}" stroke="${color}" stroke-width="1.2" />`;
    elements += `<rect x="${x - candleBodyWidth / 2}" y="${bodyY}" width="${candleBodyWidth}" height="${bodyH}" fill="${color}" rx="1" />`;
  });

  // رسم مستويات التداول ICT (Entry, SL, TP1, TP2, TP3)
  const drawLevel = (price: number, color: string, label: string) => {
    const y = getY(price);
    elements += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="${color}" stroke-width="1.8" stroke-dasharray="${label.includes('TP') ? '5,3' : 'none'}" />`;
    elements += `<rect x="${width - padding.right + 4}" y="${y - 9}" width="85" height="18" fill="${color}" rx="3" />`;
    elements += `<text x="${width - padding.right + 8}" y="${y + 4}" fill="#ffffff" font-size="10" font-weight="bold" font-family="Arial">${label}</text>`;
  };

  drawLevel(options.tp3, '#089981', `TP3 ${options.tp3}`);
  drawLevel(options.tp2, '#089981', `TP2 ${options.tp2}`);
  drawLevel(options.tp1, '#089981', `TP1 ${options.tp1}`);
  drawLevel(options.entry, '#2962ff', `Entry ${options.entry}`);
  drawLevel(options.stopLoss, '#f23645', `SL ${options.stopLoss}`);

  const headerTitle = options.harmonicPattern
    ? `${options.symbol} • ${options.timeframe} • ICT + Harmonic (${options.harmonicPattern.name})`
    : `${options.symbol} • ${options.timeframe} • SmartZone ICT Model`;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#131722" />
      <text x="${padding.left}" y="25" fill="#d1d4dc" font-size="15" font-weight="bold" font-family="Arial">
        ${headerTitle}
      </text>
      ${elements}
    </svg>
  `;

  const resvg = new Resvg(svg, {
    background: '#131722',
    fitTo: { mode: 'width', value: width },
  });

  const pngData = resvg.render();
  return pngData.asPng();
};
