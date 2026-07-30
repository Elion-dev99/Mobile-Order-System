import { PLANS, PRODUCT, ADDONS } from './config.js';

export function getPlan(planId) {
  return PLANS.find(p => p.id === planId) || PLANS.find(p => p.id === 'growth');
}

export function yen(n) {
  return Number(n || 0).toLocaleString('ja-JP');
}

export function planPrice(plan, cycle = 'monthly') {
  if (cycle === 'annual') {
    return {
      chargeNow: plan.priceMonthly * PRODUCT.annualMultiplier,
      perMonthEffective: Math.round((plan.priceMonthly * PRODUCT.annualMultiplier) / 12),
      label: '年払い',
    };
  }
  return {
    chargeNow: plan.priceMonthly,
    perMonthEffective: plan.priceMonthly,
    label: '月払い',
  };
}

export function estimateMrr({ planId = 'growth', stores = 1, cycle = 'monthly' } = {}) {
  const plan = getPlan(planId);
  let monthly = plan.priceMonthly;
  if (plan.maxStores != null && stores > plan.maxStores) {
    monthly += (stores - plan.maxStores) * PRODUCT.extraStoreMonthly;
  } else if (plan.id === 'chain') {
    monthly = plan.priceMonthly; // 店舗無制限込み
  } else if (stores > 1 && plan.features.multiStore) {
    monthly += (stores - 1) * PRODUCT.extraStoreMonthly;
  }
  if (cycle === 'annual') {
    return Math.round((monthly * PRODUCT.annualMultiplier) / 12);
  }
  return monthly;
}

export function estimateSetup(planId) {
  return getPlan(planId).priceSetup;
}

export function estimateArr(mrr) {
  return mrr * 12;
}

export function featureEnabled(shop, featureKey) {
  const plan = getPlan(shop?.planId || 'lite');
  return !!plan.features[featureKey];
}

/** Recommend next higher plan for upsell copy */
export function nextPlanId(planId) {
  const order = ['lite', 'growth', 'business', 'chain'];
  const i = order.indexOf(planId);
  if (i < 0 || i >= order.length - 1) return null;
  return order[i + 1];
}

export function annualSavings(plan) {
  const full = plan.priceMonthly * 12;
  const annual = plan.priceMonthly * PRODUCT.annualMultiplier;
  return Math.max(0, full - annual);
}

/**
 * Access state for paywall / trial.
 * @returns {{ subscribed: boolean, trialActive: boolean, trialExpired: boolean, daysLeft: number|null, premiumUnlocked: boolean, reason: string }}
 */
export function getAccessState(shop, { subscribed = false } = {}) {
  if (subscribed || shop?.subscribed) {
    return {
      subscribed: true,
      trialActive: false,
      trialExpired: false,
      daysLeft: null,
      premiumUnlocked: true,
      reason: 'subscribed',
    };
  }
  const ends = Number(shop?.trialEndsAt || 0);
  if (!ends) {
    return {
      subscribed: false,
      trialActive: false,
      trialExpired: false,
      daysLeft: PRODUCT.trialDays,
      premiumUnlocked: true, // until trial is stamped, allow then stamp
      reason: 'trial_pending',
    };
  }
  const msLeft = ends - Date.now();
  const daysLeft = Math.max(0, Math.ceil(msLeft / 86400000));
  if (msLeft > 0) {
    return {
      subscribed: false,
      trialActive: true,
      trialExpired: false,
      daysLeft,
      premiumUnlocked: true,
      reason: 'trial',
    };
  }
  return {
    subscribed: false,
    trialActive: false,
    trialExpired: true,
    daysLeft: 0,
    premiumUnlocked: false,
    reason: 'trial_expired',
  };
}

/** Premium features require plan flag AND (subscribed or active trial) */
export function canUseFeature(shop, featureKey, { subscribed = false } = {}) {
  if (!featureEnabled(shop, featureKey)) return false;
  const access = getAccessState(shop, { subscribed });
  return access.premiumUnlocked;
}

export function paymentCta() {
  const link = (PRODUCT.stripePaymentLink || '').trim();
  if (link) {
    return { mode: 'stripe', href: link, label: 'カードで契約する' };
  }
  return { mode: 'lead', href: 'lp.html#contact', label: '見積もり・導入相談' };
}

export function platformFeeForOrder(shop, orderTotal) {
  const plan = getPlan(shop?.planId || 'lite');
  const pct = Number(plan.orderFeePercent || 0);
  if (!pct || !orderTotal) return 0;
  return Math.floor(Number(orderTotal) * (pct / 100));
}

export function planComparisonRows() {
  const keys = [
    { key: 'maxTables', label: 'テーブル数', format: v => (v == null ? '無制限' : `${v}席まで`) },
    { key: 'maxStores', label: '店舗数', format: v => (v == null ? '無制限' : `${v}店舗`) },
    { key: 'analytics', label: '売上分析', feature: true },
    { key: 'exportCsv', label: '期間CSV出力', feature: true },
    { key: 'coupons', label: 'クーポン', feature: true },
    { key: 'inventory', label: '在庫・自動売切', feature: true },
    { key: 'kdsModes', label: 'KDS表示切替', feature: true },
    { key: 'kitchenTickets', label: '厨房伝票印刷', feature: true },
    { key: 'serviceCharge', label: 'サービス料・チップ', feature: true },
    { key: 'multiLang', label: '日英メニュー', feature: true },
    { key: 'staffRoles', label: 'スタッフ権限', feature: true },
    { key: 'slaTimer', label: '配膳SLA', feature: true },
    { key: 'tableBoard', label: 'テーブル状況ボード', feature: true },
    { key: 'brandCustom', label: 'ブランドカスタム', feature: true },
    { key: 'payments', label: '決済UI（形）', feature: true },
    { key: 'takeout', label: 'テイクアウト', feature: true },
    { key: 'delivery', label: 'デリバリー', feature: true },
    { key: 'reservations', label: '予約', feature: true },
    { key: 'waitlist', label: '待ち行列', feature: true },
    { key: 'loyalty', label: 'ポイント会員', feature: true },
    { key: 'posBridge', label: 'POS連携（形）', feature: true },
    { key: 'deepAnalytics', label: '深い分析', feature: true },
    { key: 'autoPrint', label: '厨房自動印刷', feature: true },
    { key: 'orderFeePercent', label: '注文手数料', format: v => (v ? `${v}%` : 'なし') },
  ];
  return keys.map(row => ({
    label: row.label,
    values: PLANS.map(plan => {
      if (row.feature) return plan.features[row.key] ? '●' : '—';
      const raw = plan[row.key];
      return row.format ? row.format(raw) : String(raw);
    }),
  }));
}

export { PLANS, PRODUCT, ADDONS };
