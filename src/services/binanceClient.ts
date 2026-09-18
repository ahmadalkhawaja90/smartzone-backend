import axios from 'axios';
import crypto from 'crypto';

const BASE_URL = 'https://testnet.binance.vision';
const API_KEY = process.env.BINANCE_TESTNET_API_KEY || '';
const SECRET_KEY = process.env.BINANCE_TESTNET_SECRET_KEY || '';

// تخصيص رأس المال الافتراضي بـ 100 دولار
export const VIRTUAL_INITIAL_CAPITAL = 100;
export const RISK_PERCENT_PER_TRADE = 0.10; // 10% لكل صفقة = $10

// دالة مساعدة لتوقيع الـ Query Params بتشفير HMAC SHA256 المطلوب من باينانس
const generateSignature = (queryString: string): string => {
  return crypto.createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
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

// 2. إرسال أمر شراء معلق (Limit Buy Order) عند الحد العلوي للفجوة
export const placeLimitBuyOrder = async (
  symbol: string,
  price: number,
  allocatedUsdt: number = VIRTUAL_INITIAL_CAPITAL * RISK_PERCENT_PER_TRADE
): Promise<{ success: boolean; orderId?: string; quantity?: number; error?: string }> => {
  try {
    const rawQuantity = allocatedUsdt / price;
    // تقريب الكمية لتناسب صيغة اللوت في باينانس
    const quantity = parseFloat(rawQuantity.toFixed(4));
    const formattedPrice = parseFloat(price.toFixed(4));

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
      quantity: quantity,
    };
  } catch (error: any) {
    console.error(`❌ فشل إرسال أمر الشراء لـ ${symbol}:`, error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.msg || error.message,
    };
  }
};

// 3. فحص حالة الطلب في المنصة (هل تم تنفيذه FILLED أم ما زال NEW)
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
      status: response.data.status, // 'NEW' | 'FILLED' | 'CANCELED' | 'EXPIRED'
      executedQty: parseFloat(response.data.executedQty),
    };
  } catch (error: any) {
    console.error(`⚠️ خطأ أثناء جلب حالة الطلب ${orderId}:`, error.response?.data || error.message);
    return null;
  }
};

// 4. إغلاق جزء من الصفقة بسعر السوق (لجني أرباح 25% عند TP1 مثلاً)
export const placeMarketSellOrder = async (
  symbol: string,
  quantity: number
): Promise<{ success: boolean; orderId?: string; error?: string }> => {
  try {
    const formattedQty = parseFloat(quantity.toFixed(4));
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
