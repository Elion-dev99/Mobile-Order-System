/**
 * Client-side Stripe Payment Link helpers (prep — links live in config.js).
 */

import { PRODUCT } from './config.js';
import { resolveShopId } from './tenant.js';

function normalizeCycle(cycle) {
  const c = String(cycle || PRODUCT.defaultBillingCycle || 'monthly').toLowerCase();
  return c === 'annual' ? 'annual' : 'monthly';
}

export function paymentLinkForPlan(planId = 'growth', cycle = null) {
  const p = String(planId || 'growth');
  const cy = normalizeCycle(cycle);
  const byCycle = PRODUCT.stripePaymentLinksByCycle || {};
  const row = byCycle[p];
  if (row && typeof row === 'object') {
    const url = String(row[cy] || row.monthly || row.annual || '').trim();
    if (url) return url;
  }
  const links = PRODUCT.stripePaymentLinks || {};
  const legacy = String(PRODUCT.stripePaymentLink || '').trim();
  return String(links[p] || links.growth || legacy || '').trim();
}

export function isStripeConfigured(planId = 'growth', cycle = null) {
  return !!paymentLinkForPlan(planId, cycle);
}

/**
 * Build Payment Link URL with shop binding (client_reference_id).
 * Success URL is configured on the Payment Link — see docs/stripe-setup.md
 */
export function buildStripePaymentUrl(shopId, planId = 'growth', { email, billingCycle } = {}) {
  const base = paymentLinkForPlan(planId, billingCycle);
  if (!base) return null;
  try {
    const u = new URL(base);
    const sid = String(shopId || resolveShopId() || '').trim().slice(0, 200);
    if (sid) u.searchParams.set('client_reference_id', sid);
    if (email) u.searchParams.set('prefilled_email', String(email).trim().slice(0, 200));
    return u.href;
  } catch {
    return base;
  }
}

export function stripeModeLabel() {
  const m = String(PRODUCT.stripeMode || 'off').toLowerCase();
  if (m === 'live') return '本番';
  if (m === 'test') return 'テスト';
  return '未設定';
}

export function stripeIntroFirstMonth(planId) {
  const off = PRODUCT.stripeCommerce?.introFirstMonthOff || {};
  return Number(off[planId] || 0);
}
