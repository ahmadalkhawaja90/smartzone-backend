import axios from 'axios';
import crypto from 'crypto';

const BASE_URL = process.env.BINANCE_TESTNET_URL || 'https://testnet.binance.vision';
const API_KEY = process.env.BINANCE_TESTNET_API_KEY || '';
const SECRET_KEY = process.env.BINANCE_TESTNET_SECRET_KEY || '';

// كاش لمعلومات رموز التداول لتجنب تكرار استدعاء exchangeInfo
const symbolInfoCache: Map<string, { minQty: number; stepSize: number; tickSize: number }> = new Map();

// دالة مساعدة لتوقيع الـ Query Params بتشفير HMAC SHA256 المطلوب من باينانس
const generateSignature = (queryString: string): string => {
  return crypto.createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
};

// جلب قيود اللوت والسعر لكل زوج لضمان قبول الأوامر على Testnet
async function getSymbolFilters(symbol: string) {
  if (symbolInfoCache.has(symbol)) {
    return symbolInfoCache.get(symbol)!;
  }

  try {
    const res = await axios.get(`${BASE_URL}/api/v3/exchangeInfo?symbol=${symbol}`);
    const symbolData = res.data.symbols?.[0];
    let stepSize = 0.0001;
    let minQty = 0.0001;
    let tickSize = 0.0001;

    if (symbolData && symbolData.filters) {
      const lotFilter = symbolData.filters.find((f: any) => f.filterType === 'LOT_SIZE');
      if (lotFilter) {
        stepSize = parseFloat(lotFilter.stepSize);
        minQty = parseFloat(lotFilter.minQty);
      }
      const priceFilter = symbolData.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
      if (priceFilter) {
        tickSize = parseFloat(priceFilter.tickSize);
      }
    }

    const info = { minQty, stepSize, tickSize };
    symbolInfoCache.set(symbol, info);
    return info;
  } catch {
    return { minQty: 0.0001, stepSize: 0.0001, tickSize: 0.0001 };
  }
}

// دالة لضبط وتقريب الأرقام حسب قيود باينانس
function roundToStep(value: number, step: number): number {
  const precision = Math.max(0, -Math.floor(Math.log10(step)));
  return parseFloat((Math.floor(value / step) * step).toFixed(precision));
}

// 1. فحص الاتصال وقراءة معلومات الحساب من Testnet
export const checkBinanceConnection = async (): Promise<boolean> => {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = generateSignature(queryString);

    const response = await axios.get(`${BASE_URL}/api/v3/account?${queryString}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': API_KEY },
      timeout: 8000,
    });

    if (response.data && response.data.balances) {
      console.log('✅ تم الاتصال بنجاح بـ Binance Testnet API.');
      return true;
    }
    return false;
  } catch (error: any) {
    console.error('❌ فشل الاتصال بـ Binance Testnet:', error.response?.data || error.message);
    return false;
  }
};

// 2. إرسال أمر شراء معلق (Limit Buy Order) بأي رأس مال مخصص
export const placeLimitBuyOrder = async (
  symbol: string,
  price: number,
  allocatedUsdt: number
): Promise<{ success: boolean; orderId?: string; quantity?: number; error?: string }> => {
  try {
    const filters = await getSymbolFilters(symbol);
    const rawQuantity = allocatedUsdt / price;
    const quantity = roundToStep(rawQuantity, filters.stepSize);
    const formattedPrice = roundToStep(price, filters.tickSize);

    if (quantity < filters.minQty) {
      return {
        success: false,
        error: `الكمية المحسوبة (${quantity}) أقل من الحد الأدنى للوت (${filters.minQty})`,
      };
    }

    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&side=BUY&type=LIMIT&timeInForce=GTC&quantity=${quantity}&price=${formattedPrice}&timestamp=${timestamp}`;
    const signature = generateSignature(queryString);

    const response = await axios.post(
      `${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`,
      null,
      { headers: { 'X-MBX-APIKEY': API_KEY } }
    );

    return {
      success: true,
      orderId: response.data.orderId.toString(),
      quantity,
    };
  } catch (error: any) {
    console.error(`❌ فشل إرسال أمر الشراء لـ ${symbol}:`, error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.msg || error.message,
    };
  }
};

// 3. فحص حالة الطلب في المنصة (FILLED / NEW / CANCELED)
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

// 4. إغلاق الصفقة بسعر السوق (Market Sell)
export const placeMarketSellOrder = async (
  symbol: string,
  quantity: number
): Promise<{ success: boolean; orderId?: string; error?: string }> => {
  try {
    const filters = await getSymbolFilters(symbol);
    const formattedQty = roundToStep(quantity, filters.stepSize);

    if (formattedQty < filters.minQty) {
      return {
        success: false,
        error: `الكمية المراد بيعها (${formattedQty}) أقل من الحد الأدنى`,
      };
    }

    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&side=SELL&type=MARKET&quantity=${formattedQty}&timestamp=${timestamp}`;
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
