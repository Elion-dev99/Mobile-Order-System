/**
 * Money / billing primitives — single source of truth for yen amounts and audits.
 */

import { PRODUCT } from './config.js';
import { planPrice } from './plans.js';

/** Stripe zero-decimal currencies (amount_total is whole yen, not cents). */
export const STRIPE_ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF',
  'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

export function normalizeBillingCycle(cycle) {
  const c = String(cycle || PRODUCT.defaultBillingCycle || 'monthly').toLowerCase();
  return c === 'annual' ? 'annual' : 'monthly';
}

export function stripeAmountToMajor(amount, currency = 'JPY') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const cur = String(currency || 'JPY').toUpperCase();
  if (STRIPE_ZERO_DECIMAL.has(cur)) return Math.round(n);
  return Math.round(n / 100);
}

export function introFirstMonthOff(planId) {
  const off = PRODUCT.stripeCommerce?.introFirstMonthOff || {};
  return Math.max(0, Number(off[planId] || 0));
}

export function introCouponId(planId) {
  return String(PRODUCT.stripeCommerce?.couponIds?.[planId] || '').trim();
}

/**
 * First Checkout estimate (tax excluded) — must match shop billing dashboard.
 */
export function computeFirstCheckoutEstimate(plan, cycle = 'monthly') {
  const cy = normalizeBillingCycle(cycle);
  const price = planPrice(plan, cy);
  const setup = Number(plan.priceSetup) || 0;
  const introOff = introFirstMonthOff(plan.id);
  const firstMonthSub = cy === 'monthly' && introOff > 0
    ? Math.max(0, plan.priceMonthly - introOff)
    : plan.priceMonthly;
  const total = cy === 'annual' ? setup + price.chargeNow : setup + firstMonthSub;
  return {
    cycle: cy,
    setup,
    subscriptionPart: cy === 'annual' ? price.chargeNow : firstMonthSub,
    firstMonthList: plan.priceMonthly,
    introOff: cy === 'monthly' ? introOff : 0,
    total,
  };
}

export function isValidShopIdForBilling(shopId) {
  const s = String(shopId || '').trim();
  if (!s || s.length > 64) return false;
  return /^[a-z0-9][a-z0-9_-]*$/i.test(s);
}

/**
 * Run consistency checks for UI / ops debug panels.
 */
export function auditBillingState({
  shopId,
  shopSubscribed,
  accessSubscribed,
  cycle,
  plan,
  chargeEstimate,
  paymentLinkConfigured,
  stripeHintOk,
  stripeHintError,
}) {
  const checks = [];
  const est = computeFirstCheckoutEstimate(plan, cycle);
  if (chargeEstimate != null && chargeEstimate !== est.total) {
    checks.push({
      level: 'error',
      code: 'charge_estimate_mismatch',
      message: `初回見積もり ¥${chargeEstimate} が計算値 ¥${est.total} と一致しません`,
    });
  }
  if (shopSubscribed !== accessSubscribed) {
    checks.push({
      level: 'warn',
      code: 'subscribed_flag_mismatch',
      message: `課金フラグ不整合: shop.subscribed=${shopSubscribed} / access=${accessSubscribed}`,
    });
  }
  if (!isValidShopIdForBilling(shopId)) {
    checks.push({
      level: 'error',
      code: 'invalid_shop_id',
      message: `店舗ID "${shopId}" は契約紐付けに不適切です`,
    });
  }
  if (!paymentLinkConfigured) {
    checks.push({
      level: 'warn',
      code: 'no_payment_link',
      message: 'このプラン・周期の Payment Link が未設定です',
    });
  }
  if (stripeHintError) {
    checks.push({
      level: 'warn',
      code: 'stripe_hint_fetch_failed',
      message: stripeHintError,
    });
  } else if (stripeHintOk === false) {
    checks.push({
      level: 'warn',
      code: 'stripe_hint_unavailable',
      message: 'Stripe 状態 API に接続できませんでした',
    });
  }
  return checks;
}

export function billingDebugEnabled(searchParams = null) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('mos_billing_debug') === '1') return true;
  } catch (_) {}
  if (searchParams) return searchParams.get('billing_debug') === '1';
  if (typeof location !== 'undefined') {
    return new URLSearchParams(location.search).get('billing_debug') === '1';
  }
  return false;
}
