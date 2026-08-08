#!/usr/bin/env node
/**
 * Stripe テストモード: 商品・価格・初月クーポン・Payment Link を一括作成。
 *
 * 設計方針（双方に有利）:
 * - Checkout = 初期費用（一回） + サブスク（月 or 年）
 * - アプリ側 14 日トライアル済み想定 → Stripe サブスクに trial_days は付けない
 * - 月払いのみ初回サブスク請求をクーポン値引き（年払いは月額×10で既に2ヶ月無料）
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-bootstrap.mjs
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-bootstrap.mjs --dry-run
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-bootstrap.mjs --plan lite
 */

import { PLANS, PRODUCT } from '../js/config.js';

const SITE = 'https://mobile-order-system.pages.dev';
const dryRun = process.argv.includes('--dry-run');
const onlyPlan = process.argv.find((a) => a.startsWith('--plan='))?.split('=')[1]
  || (process.argv.includes('--plan') ? process.argv[process.argv.indexOf('--plan') + 1] : null);

const KEY = String(process.env.STRIPE_SECRET_KEY || '').trim();
if (!KEY && !dryRun) {
  console.error('Set STRIPE_SECRET_KEY=sk_test_... or use --dry-run');
  process.exit(1);
}

const commerce = PRODUCT.stripeCommerce || {};
const successUrl = String(commerce.successUrl || `${SITE}/admin.html?billing=success&shop={CHECKOUT_SESSION_CLIENT_REFERENCE_ID}`);

async function stripe(path, params = {}, method = 'POST') {
  const url = `https://api.stripe.com/v1/${path}`;
  if (dryRun) {
    console.log(`[dry-run] ${method} ${path}`);
    if (path === 'payment_links') {
      return { id: `dry_pl_${path}`, url: `https://buy.stripe.com/test_dry_${path}` };
    }
    return { id: `dry_${path.replace(/\//g, '_')}` };
  }
  const opts = {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
    },
  };
  if (method !== 'GET') {
    const body = params instanceof URLSearchParams ? params : new URLSearchParams(params);
    opts.headers['content-type'] = 'application/x-www-form-urlencoded';
    opts.body = body;
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    throw new Error(`${path}: ${msg}`);
  }
  return data;
}

function yenAmount(n) {
  return Math.round(Number(n) || 0);
}

async function ensureCoupon(planId, amountOff) {
  const id = commerce.couponIds?.[planId] || `QO_${planId.toUpperCase()}_INTRO`;
  if (dryRun) return { id };
  try {
    const existing = await stripe(`coupons/${encodeURIComponent(id)}`, {}, 'GET');
    if (existing?.id) return existing;
  } catch {
    /* create */
  }
  const p = new URLSearchParams();
  p.set('id', id);
  p.set('currency', 'jpy');
  p.set('amount_off', String(yenAmount(amountOff)));
  p.set('duration', 'once');
  p.set('name', `QuickOrder ${planId} 初月サブスク値引き`);
  p.set('metadata[planId]', planId);
  return stripe('coupons', p);
}

async function createProduct(plan) {
  const p = new URLSearchParams();
  p.set('name', `QuickOrder ${plan.name}`);
  p.set('description', plan.tagline || '');
  p.set('metadata[planId]', plan.id);
  return stripe('products', p);
}

async function createPrice({ productId, unitAmount, recurring }) {
  const p = new URLSearchParams();
  p.set('product', productId);
  p.set('currency', 'jpy');
  p.set('unit_amount', String(yenAmount(unitAmount)));
  if (recurring) {
    p.set('recurring[interval]', recurring.interval);
    if (recurring.interval_count) p.set('recurring[interval_count]', String(recurring.interval_count));
  }
  return stripe('prices', p);
}

async function createPaymentLink({
  planId,
  cycle,
  setupPriceId,
  subPriceId,
  couponId,
}) {
  const p = new URLSearchParams();
  p.set('line_items[0][price]', setupPriceId);
  p.set('line_items[0][quantity]', '1');
  p.set('line_items[1][price]', subPriceId);
  p.set('line_items[1][quantity]', '1');
  p.set('after_completion[type]', 'redirect');
  p.set('after_completion[redirect][url]', successUrl);
  p.set('billing_address_collection', 'required');
  p.set('customer_creation', 'always');
  p.set('invoice_creation[enabled]', 'true');
  p.set('metadata[planId]', planId);
  p.set('metadata[cycle]', cycle);
  p.set('subscription_data[metadata][planId]', planId);
  p.set('subscription_data[metadata][cycle]', cycle);
  if (couponId && cycle === 'monthly') {
    p.set('discounts[0][coupon]', couponId);
  }
  return stripe('payment_links', p);
}

async function bootstrapPlan(plan) {
  const introOff = Number(commerce.introFirstMonthOff?.[plan.id] || 0);
  const annualTotal = yenAmount(plan.priceMonthly * PRODUCT.annualMultiplier);

  console.log(`\n=== ${plan.id} (${plan.name}) ===`);
  console.log(`  初期 ¥${plan.priceSetup} · 月額 ¥${plan.priceMonthly} · 年額 ¥${annualTotal} · 初月値引き ¥${introOff}`);

  const product = await createProduct(plan);
  const setupPrice = await createPrice({
    productId: product.id,
    unitAmount: plan.priceSetup,
  });
  const monthlyPrice = await createPrice({
    productId: product.id,
    unitAmount: plan.priceMonthly,
    recurring: { interval: 'month' },
  });
  const annualPrice = await createPrice({
    productId: product.id,
    unitAmount: annualTotal,
    recurring: { interval: 'year' },
  });

  let coupon = null;
  if (introOff > 0) {
    coupon = await ensureCoupon(plan.id, introOff);
  }

  const monthlyLink = await createPaymentLink({
    planId: plan.id,
    cycle: 'monthly',
    setupPriceId: setupPrice.id,
    subPriceId: monthlyPrice.id,
    couponId: coupon?.id,
  });
  const annualLink = await createPaymentLink({
    planId: plan.id,
    cycle: 'annual',
    setupPriceId: setupPrice.id,
    subPriceId: annualPrice.id,
    couponId: null,
  });

  return {
    planId: plan.id,
    monthly: monthlyLink.url,
    annual: annualLink.url,
  };
}

async function main() {
  const plans = PLANS.filter((p) => !onlyPlan || p.id === onlyPlan);
  if (!plans.length) {
    console.error('No plans matched', onlyPlan);
    process.exit(1);
  }

  const linksByCycle = {};
  for (const plan of plans) {
    const row = await bootstrapPlan(plan);
    linksByCycle[row.planId] = { monthly: row.monthly, annual: row.annual };
  }

  console.log('\n--- Paste into js/config.js stripePaymentLinksByCycle ---\n');
  console.log(JSON.stringify(linksByCycle, null, 2));
  console.log('\nWebhook: https://mobile-order-system.pages.dev/api/stripe (checkout.session.completed)\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
