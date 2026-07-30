/**
 * Payment layer — shape only until a real provider is wired.
 * UI and order fields are production-ready; charge() is a stub.
 */

export const PAYMENT_METHODS = [
  { id: 'pay_at_register', label: 'レジでお会計', provider: 'register' },
  { id: 'card', label: 'クレジットカード', provider: 'stripe_stub' },
  { id: 'paypay', label: 'PayPay', provider: 'paypay_stub' },
  { id: 'transit', label: '交通系IC', provider: 'transit_stub' },
  { id: 'split_later', label: '割り勘（後で精算）', provider: 'split_stub' },
];

export function listPaymentMethods(shop = {}) {
  const enabled = shop.paymentMethodsEnabled;
  if (!Array.isArray(enabled) || !enabled.length) return PAYMENT_METHODS;
  return PAYMENT_METHODS.filter((m) => enabled.includes(m.id));
}

/** Create a checkout session shape (no real network charge). */
export async function createPaymentSession({
  orderId, amount, currency = 'JPY', method = 'pay_at_register', shopId,
} = {}) {
  const meta = PAYMENT_METHODS.find((m) => m.id === method) || PAYMENT_METHODS[0];
  const session = {
    id: 'pay_' + Math.random().toString(36).slice(2, 10),
    orderId: orderId || null,
    shopId: shopId || null,
    amount: Math.max(0, Number(amount) || 0),
    currency,
    method: meta.id,
    provider: meta.provider,
    status: meta.id === 'pay_at_register' ? 'awaiting_register' : 'requires_provider',
    clientSecret: `stub_secret_${Date.now()}`,
    stub: true,
    createdAt: Date.now(),
  };
  return session;
}

/**
 * Attempt charge — always stub. Real providers will replace this body.
 * @returns {{ ok: boolean, payment: object, nextAction?: string }}
 */
export async function authorizePayment(session) {
  if (!session) return { ok: false, error: 'no_session' };
  if (session.method === 'pay_at_register') {
    return {
      ok: true,
      payment: {
        ...session,
        status: 'awaiting_register',
        authorizedAt: null,
      },
      nextAction: 'pay_at_register',
    };
  }
  // Stub: pretend provider SDK would open here
  return {
    ok: true,
    payment: {
      ...session,
      status: 'stub_authorized',
      authorizedAt: Date.now(),
      stubNote: 'Replace payments.authorizePayment with Stripe/PayPay SDK',
    },
    nextAction: 'stub_complete',
  };
}

export function paymentBadge(payment) {
  const s = payment?.status || 'none';
  const map = {
    none: '未設定',
    awaiting_register: 'レジ待ち',
    requires_provider: '決済待ち',
    stub_authorized: '仮認可（stub）',
    paid: '支払済',
    failed: '失敗',
    refunded: '返金済',
  };
  return map[s] || s;
}

export async function markOrderPaid(orderPatch = {}) {
  return {
    paymentStatus: 'paid',
    paidAt: Date.now(),
    closedAt: Date.now(),
    payment: {
      ...(orderPatch.payment || {}),
      status: 'paid',
      paidAt: Date.now(),
      stub: true,
    },
  };
}
