import axios from 'axios';
import crypto from 'crypto';

const BASE_URL = 'https://testnet.binance.vision';
const API_KEY = process.env.BINANCE_TESTNET_API_KEY || '';
const SECRET_KEY = process.env.BINANCE_TESTNET_SECRET_KEY || '';

export const VIRTUAL_INITIAL_CAPITAL = 100;
export const RISK_PERCENT_PER_TRADE = 0.10; // 10% لكل صفقة = $10

// ذاكرة تخزين مؤقت لقواعد التداول للرموز لتجنب استدعاء API متكرر
interface SymbolFilterRules {
  stepSize: number;
  minQty: number;
  maxQty: number;
  tickSize: number;
  minNotional: number;
}
const symbolRulesCache = new Map<string, SymbolFilterRules>();

const generateSignature = (queryString: string): string => {
  return crypto.createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
};

// جلب وتخزين فلاتر الرمز (LOT_SIZE, PRICE_FILTER, NOTIONAL)
const getSymbolRules = async (symbol: string): Promise<SymbolFilterRules | null> => {
  if (symbolRulesCache.has(symbol)) {
    return symbolRulesCache.get(symbol)!;
  }
  try {
    const res = await axios.get(`${BASE_URL}/api/v3/exchangeInfo?symbol=${symbol}`, { timeout: 5000 });
    const symbolInfo = res.data.symbols?.[0];
    if (!symbolInfo) return null;

    const lotFilter = symbolInfo.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
    const priceFilter = symbolInfo.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
    const notionalFilter = symbolInfo.filters?.find((f: any) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');

    const rules: SymbolFilterRules = {
      stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : 0.0001,
      minQty: lotFilter ? parseFloat(lotFilter.minQty) : 0.0001,
      maxQty: lotFilter ? parseFloat(lotFilter.maxQty) : 9999999,
      tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.0001,
      minNotional: notionalFilter ? parseFloat(notionalFilter.minNotional || notionalFilter.notional || '5') : 5,
    };

    symbolRulesCache.set(symbol, rules);
    return rules;
  } catch {
    return null;
  }
};

// ضبط الرقم بدقة وفق الخطوة (stepSize / tickSize) لمنع الخطأ -1013
const formatToStep = (value: number, step: number): string => {
  if (!step || step <= 0) return value.toString();
  const precision = Math.max(0, -Math.floor(Math.log10(step)));
  const factor = Math.pow(10, precision);
  const rounded = Math.floor(value * factor) / factor;
  return rounded.toFixed(precision);
};

// 1. فحص الاتصال وقراءة معلومات الحساب من Testnet
export const checkBinanceConnection = async (): Promise<boolean> => {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = generateSignature(queryString);

    const response = await axios.get(`${BASE_URL}/api/v3/account?${queryString}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': API_KEY },
    });

    if (response.data && response.data.balances) {
      console.log('✅ تم الاتصال بنجاح بـ Binance Testnet API.');
      console.log(`💼 تم اعتماد رأس المال الافتراضي للتداول: $${VIRTUAL_INITIAL_CAPITAL} USDT`);
      return true;
    }
    return false;
  } catch (error: any) {
    console.error('❌ فشل الاتصال بـ Binance Testnet:', error.response?.data || error.message);
    return false;
  }
};

// 2. إرسال أمر شراء معلق (Limit Buy Order) بفلترة دقيقة
export const placeLimitBuyOrder = async (
  symbol: string,
  price: number,
  allocatedUsdt: number = VIRTUAL_INITIAL_CAPITAL * RISK_PERCENT_PER_TRADE
): Promise<{ success: boolean; orderId?: string; quantity?: number; error?: string }> => {
  try {
    const rules = await getSymbolRules(symbol);
    const rawQty = allocatedUsdt / price;

    let finalQtyStr: string;
    let finalPriceStr: string;

    if (rules) {
      if (rawQty < rules.minQty) {
        return { success: false, error: `الكمية المحسوبة أقل من الحد الأدنى للرمز (${rules.minQty})` };
      }
      const cappedQty = Math.min(rawQty, rules.maxQty);
      finalQtyStr = formatToStep(cappedQty, rules.stepSize);
      finalPriceStr = formatToStep(price, rules.tickSize);

      const notional = parseFloat(finalQtyStr) * parseFloat(finalPriceStr);
      if (notional < rules.minNotional) {
        return { success: false, error: `قيمة الصفقة $${notional.toFixed(2)} أقل من Min Notional ($${rules.minNotional})` };
      }
    } else {
      finalQtyStr = rawQty.toFixed(4);
      finalPriceStr = price.toFixed(4);
    }

    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&side=BUY&type=LIMIT&timeInForce=GTC&quantity=${finalQtyStr}&price=${finalPriceStr}&timestamp=${timestamp}`;
    const signature = generateSignature(queryString);

    const response = await axios.post(
      `${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`,
      null,
      { headers: { 'X-MBX-APIKEY': API_KEY } }
    );

    return {
      success: true,
      orderId: response.data.orderId.toString(),
      quantity: parseFloat(finalQtyStr),
    };
  } catch (error: any) {
    console.error(`❌ فشل إرسال أمر الشراء لـ ${symbol}:`, error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.msg || error.message,
    };
  }
};

// 3. فحص حالة الطلب في المنصة
export const checkOrderStatus = async (
  symbol: string,
  orderId: string
): Promise<{ status: string; executedQty: number } | null> => {
  try {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
    const signature = generateSignature(queryString);

    const response = await axios.get(
      `${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`,
      { headers: { 'X-MBX-APIKEY': API_KEY } }
    );

    return {
      status: response.data.status,
      executedQty: parseFloat(response.data.executedQty),
    };
  } catch (error: any) {
    console.error(`⚠️ خطأ أثناء جلب حالة الطلب ${orderId}:`, error.response?.data || error.message);
    return null;
  }
};

// 4. إغلاق جزء من الصفقة بسعر السوق مع فحص LOT_SIZE
export const placeMarketSellOrder = async (
  symbol: string,
  quantity: number
): Promise<{ success: boolean; orderId?: string; error?: string }> => {
  try {
    const rules = await getSymbolRules(symbol);
    let finalQtyStr: string;

    if (rules) {
      if (quantity < rules.minQty) {
        console.warn(`⚠️ كمية البيع ${quantity} لـ ${symbol} أقل من minQty (${rules.minQty})`);
        return { success: false, error: 'Quantity below minQty' };
      }
      finalQtyStr = formatToStep(quantity, rules.stepSize);
    } else {
      finalQtyStr = quantity.toFixed(4);
    }

    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&side=SELL&type=MARKET&quantity=${finalQtyStr}&timestamp=${timestamp}`;
    const signature = generateSignature(queryString);

    const response = await axios.post(
      `${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`,
      null,
      { headers: { 'X-MBX-APIKEY': API_KEY } }
    );

    return {
      success: true,
      orderId: response.data.orderId.toString(),
    };
  } catch (error: any) {
    console.error(`❌ فشل أمر البيع السوقي لـ ${symbol}:`, error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.msg || error.message,
    };
  }
};

// 5. إلغاء أمر معلق لم يتفعل
export const cancelBinanceOrder = async (symbol: string, orderId: string): Promise<boolean> => {
  try {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
    const signature = generateSignature(queryString);

    await axios.delete(
      `${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`,
      { headers: { 'X-MBX-APIKEY': API_KEY } }
    );

    return true;
  } catch (error: any) {
    console.error(`⚠️ فشل إلغاء الطلب ${orderId}:`, error.response?.data || error.message);
    return false;
  }
};
