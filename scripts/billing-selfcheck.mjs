#!/usr/bin/env node
/**
 * Billing money math + payment link sanity checks (CI / pre-release).
 * Usage: node scripts/billing-selfcheck.mjs
 */

import { PLANS, PRODUCT } from '../js/config.js';
import { planPrice } from '../js/plans.js';
import {
  computeFirstCheckoutEstimate,
  stripeAmountToMajor,
  isValidShopIdForBilling,
} from '../js/billing-money.js';
import { paymentLinkForPlan, isStripeConfigured } from '../js/stripe-billing.js';
import { STRIPE_PAYMENT_LINKS_BY_CYCLE } from '../js/stripe-links.generated.js';

const failures = [];

function fail(msg) {
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
}

function ok(msg) {
  console.log(`ok: ${msg}`);
}

for (const plan of PLANS) {
  for (const cycle of ['monthly', 'annual']) {
    const est = computeFirstCheckoutEstimate(plan, cycle);
    const price = planPrice(plan, cycle);
    const expectedAnnual = plan.priceSetup + price.chargeNow;
    const introOff = PRODUCT.stripeCommerce?.introFirstMonthOff?.[plan.id] || 0;
    const expectedMonthly = plan.priceSetup + (introOff > 0 ? Math.max(0, plan.priceMonthly - introOff) : plan.priceMonthly);
    const want = cycle === 'annual' ? expectedAnnual : expectedMonthly;
    if (est.total !== want) {
      fail(`${plan.id}/${cycle}: total ${est.total} !== ${want}`);
    } else {
      ok(`${plan.id}/${cycle} first checkout ¥${est.total}`);
    }
  }
}

if (stripeAmountToMajor(32780, 'JPY') !== 32780) {
  fail('JPY stripe amount should not divide by 100');
} else {
  ok('JPY zero-decimal conversion');
}

if (stripeAmountToMajor(999, 'USD') !== 10) {
  fail('USD stripe amount should divide by 100');
} else {
  ok('USD major unit conversion');
}

if (!isValidShopIdForBilling('demo')) fail('demo shop id should be valid');
if (isValidShopIdForBilling('')) fail('empty shop id invalid');
if (isValidShopIdForBilling('bad/id')) fail('slash shop id invalid');

for (const planId of Object.keys(STRIPE_PAYMENT_LINKS_BY_CYCLE)) {
  const row = STRIPE_PAYMENT_LINKS_BY_CYCLE[planId];
  for (const cy of ['monthly', 'annual']) {
    const url = row?.[cy];
    if (!url) continue;
    if (!/^https:\/\/buy\.stripe\.com\/(test_|live_)/.test(url)) {
      fail(`${planId}/${cy}: payment link URL format suspicious: ${url}`);
    } else {
      ok(`${planId}/${cy} link format`);
    }
    if (!isStripeConfigured(planId, cy)) {
      fail(`${planId}/${cy}: isStripeConfigured false but URL set`);
    }
  }
}

if (failures.length) {
  console.error(`\n${failures.length} billing selfcheck failure(s)`);
  process.exit(1);
}
console.log('\nAll billing selfchecks passed.');
