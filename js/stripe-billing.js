/**
 * Client-side Stripe Payment Link helpers (prep — links live in config.js).
 */

import { PRODUCT } from './config.js';
import { resolveShopId } from './tenant.js';

export function paymentLinkForPlan(planId = 'growth') {
  const links = PRODUCT.stripePaymentLinks || {};
  const legacy = String(PRODUCT.stripePaymentLink || '').trim();
  const p = String(planId || 'growth');
  return String(links[p] || links.growth || legacy || '').trim();
}

export function isStripeConfigured(planId = 'growth') {
  return !!paymentLinkForPlan(planId);
}

/**
 * Build Payment Link URL with shop binding (client_reference_id).
 * Success URL is configured in Stripe Dashboard — see docs/stripe-setup.md
 */
export function buildStripePaymentUrl(shopId, planId = 'growth', { email } = {}) {
  const base = paymentLinkForPlan(planId);
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
