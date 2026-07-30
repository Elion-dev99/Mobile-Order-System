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

export function planComparisonRows() {
  const keys = [
    { key: 'maxTables', label: 'テーブル数', format: v => (v == null ? '無制限' : `${v}席まで`) },
    { key: 'maxStores', label: '店舗数', format: v => (v == null ? '無制限' : `${v}店舗`) },
    { key: 'analytics', label: '売上分析', feature: true },
    { key: 'multiLang', label: '日英メニュー', feature: true },
    { key: 'soundAlert', label: '厨房サウンド', feature: true },
    { key: 'slaTimer', label: '配膳SLA', feature: true },
    { key: 'brandCustom', label: 'ブランドカスタム', feature: true },
    { key: 'prioritySupport', label: '優先サポート', feature: true },
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
