import { Resvg } from '@resvg/resvg-js';

export interface CandlePlotData {
  open: number;
  high: number;
  low: number;
  close: number;
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

  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const priceRange = maxPrice - minPrice || 1;

  const getY = (price: number) => {
    return padding.top + plotHeight - ((price - minPrice) / priceRange) * plotHeight;
  };

  const candleSpacing = plotWidth / Math.max(count, 1);
  const candleBodyWidth = Math.max(candleSpacing * 0.65, 4);

  let elements = '';

  const gridLevels = 5;
  for (let i = 0; i <= gridLevels; i++) {
    const p = minPrice + (priceRange / gridLevels) * i;
    const y = getY(p);
    elements += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#232733" stroke-width="1" stroke-dasharray="3,3" />`;
    elements += `<text x="${width - padding.right + 8}" y="${y + 4}" fill="#787b86" font-size="11" font-family="Arial">${p.toFixed(2)}</text>`;
  }

  if (options.fvgTop && options.fvgBottom) {
    const fvgY = getY(Math.max(options.fvgTop, options.fvgBottom));
    const fvgH = Math.max(Math.abs(getY(options.fvgTop) - getY(options.fvgBottom)), 4);
    elements += `<rect x="${padding.left}" y="${fvgY}" width="${plotWidth}" height="${fvgH}" fill="rgba(41, 98, 255, 0.18)" stroke="#2962ff" stroke-width="1" stroke-dasharray="4,4" />`;
    elements += `<text x="${padding.left + 10}" y="${fvgY + 14}" fill="#2962ff" font-size="11" font-weight="bold" font-family="Arial">ICT FVG Zone</text>`;
  }

  visibleCandles.forEach((c, i) => {
    const x = padding.left + i * candleSpacing + candleSpacing / 2;
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

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#131722" />
      <text x="${padding.left}" y="25" fill="#d1d4dc" font-size="15" font-weight="bold" font-family="Arial">
        ${options.symbol} • ${options.timeframe} • SmartZone ICT Model
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
