import WebSocket from 'ws';

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'da7bdi9r01qqqkkitr70da7bdi9r01qqqkkitr7g';
const WATCH_TIMEOUT_MS = 20 * 60 * 1000; // نلغي المراقبة لو السعر ما دخل المنطقة خلال 20 دقيقة (الفرصة أصبحت قديمة)

interface WatchParams {
  finnhubSymbol: string;
  entryMin: number;
  entryMax: number;
  onEntryTriggered: (price: number) => void | Promise<void>;
}

// اتصال WebSocket واحد مشترك لكل الرموز، بدل ما نفتح اتصال جديد لكل فرصة
let sharedSocket: WebSocket | null = null;
const activeWatches = new Map<string, WatchParams[]>(); // finnhubSymbol -> قائمة المراقبات النشطة عليه

const ensureSocket = (): WebSocket => {
  if (sharedSocket && sharedSocket.readyState === WebSocket.OPEN) return sharedSocket;

  const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`);
  sharedSocket = ws;

  ws.on('open', () => {
    console.log('🔌 [Price Watcher] تم الاتصال بـ Finnhub WebSocket');
    // إعادة الاشتراك بكل الرموز يلي عندها مراقبة شغالة (مفيد لو الاتصال انقطع وانعمل reconnect)
    for (const symbol of activeWatches.keys()) {
      ws.send(JSON.stringify({ type: 'subscribe', symbol }));
    }
  });

  ws.on('message', (raw: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type !== 'trade' || !Array.isArray(msg.data)) return;

    for (const trade of msg.data) {
      const symbol: string = trade.s;
      const price: number = trade.p;
      const watches = activeWatches.get(symbol);
      if (!watches || !watches.length) continue;

      const remaining: WatchParams[] = [];
      for (const w of watches) {
        const priceInZone = price >= w.entryMin && price <= w.entryMax;
        if (priceInZone) {
          w.onEntryTriggered(price);
          // ما منضيفه لـ remaining — انتهت مهمته
        } else {
          remaining.push(w);
        }
      }

      if (remaining.length) {
        activeWatches.set(symbol, remaining);
      } else {
        activeWatches.delete(symbol);
        unsubscribe(symbol);
      }
    }
  });

  ws.on('close', () => {
    console.log('🔌 [Price Watcher] انقطع اتصال Finnhub WebSocket — محاولة إعادة اتصال بعد 3 ثواني');
    sharedSocket = null;
    if (activeWatches.size) {
      setTimeout(() => ensureSocket(), 3000);
    }
  });

  ws.on('error', (err) => {
    console.error('❌ [Price Watcher] خطأ WebSocket:', err.message);
  });

  return ws;
};

const subscribe = (symbol: string) => {
  const ws = ensureSocket();
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', symbol }));
  }
  // لو لسا عم يفتح الاتصال (CONNECTING)، رح ينعمل الاشتراك تلقائياً بالـ 'open' handler فوق
};

const unsubscribe = (symbol: string) => {
  if (sharedSocket && sharedSocket.readyState === WebSocket.OPEN) {
    sharedSocket.send(JSON.stringify({ type: 'unsubscribe', symbol }));
  }
};

/**
 * يراقب رمز معيّن لحظياً، وينادي onEntryTriggered أول ما السعر يدخل فعلياً
 * بين entryMin و entryMax (منطقة الـ FVG). هاد بيلغي فرق التأخير بين
 * لحظة اكتشاف الفرصة على الشمعة المقفولة ولحظة وصول التنبيه.
 */
export const watchEntryZone = (params: WatchParams) => {
  const { finnhubSymbol } = params;

  const existing = activeWatches.get(finnhubSymbol) || [];
  existing.push(params);
  activeWatches.set(finnhubSymbol, existing);

  subscribe(finnhubSymbol);

  // مهلة أمان: لو السعر ما رجع لمنطقة الدخول خلال الوقت المحدد، نلغي المراقبة
  // (منطق الاستراتيجية نفسه ما تغيّر — هاد بس تنظيف موارد)
  setTimeout(() => {
    const current = activeWatches.get(finnhubSymbol);
    if (!current) return;
    const filtered = current.filter((w) => w !== params);
    if (filtered.length) {
      activeWatches.set(finnhubSymbol, filtered);
    } else {
      activeWatches.delete(finnhubSymbol);
      unsubscribe(finnhubSymbol);
    }
  }, WATCH_TIMEOUT_MS);
};
