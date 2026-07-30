/**
 * Shop coupons: percent or fixed yen off. Stored on shop.coupons[].
 * Growth+ via feature flag.
 */

import { getShop, patchShopFields, shopCanUse, isNowInWindow } from './shop.js';

const APPLIED_KEY = (shopId) => `mos_coupon_${shopId}`;

export function listCoupons(shop = getShop()) {
  const raw = Array.isArray(shop?.coupons) ? shop.coupons : [];
  return raw.map((c) => normalizeCoupon(c)).filter((c) => c.code);
}

export function normalizeCoupon(raw = {}) {
  const code = String(raw.code || '').trim().toUpperCase().replace(/\s+/g, '');
  const type = raw.type === 'fixed' ? 'fixed' : 'percent';
  let value = Number(raw.value);
  if (!Number.isFinite(value) || value < 0) value = 0;
  if (type === 'percent') value = Math.min(100, Math.max(0, value));
  else value = Math.max(0, Math.floor(value));
  const maxRaw = raw.maxUses;
  const maxUses = maxRaw == null || maxRaw === '' || Number.isNaN(Number(maxRaw))
    ? null
    : Math.max(0, Number(maxRaw));
  return {
    id: raw.id || ('c_' + Math.random().toString(36).slice(2, 8)),
    code,
    type,
    value,
    label: String(raw.label || code || 'クーポン').slice(0, 40),
    minSubtotal: Math.max(0, Number(raw.minSubtotal) || 0),
    maxUses,
    usedCount: Math.max(0, Number(raw.usedCount) || 0),
    enabled: raw.enabled !== false,
    from: raw.from || '00:00',
    until: raw.until || '23:59',
  };
}

/** Draft row for editors — unique code so "追加" never collides silently */
export function createCouponDraft(partial = {}) {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return normalizeCoupon({
    code: partial.code || `SAVE${suffix}`,
    type: partial.type || 'percent',
    value: partial.value != null ? partial.value : 10,
    label: partial.label || 'クーポン',
    enabled: partial.enabled !== false,
    ...partial,
    id: partial.id || ('c_' + Math.random().toString(36).slice(2, 8)),
  });
}

function dedupeByCode(coupons) {
  const map = new Map();
  for (const c of coupons) {
    if (!c.code) continue;
    map.set(c.code, c);
  }
  return [...map.values()];
}

export async function saveCoupons(coupons) {
  const cleaned = dedupeByCode(
    (coupons || []).map(normalizeCoupon).filter((c) => c.code)
  );
  if ((coupons || []).length && !cleaned.length) {
    throw new Error('有効なクーポンコードがありません');
  }
  // Narrow patch so Store floor tablets can save without Firebase Auth
  return patchShopFields({ coupons: cleaned });
}

export function findCoupon(code, shop = getShop()) {
  const key = String(code || '').trim().toUpperCase();
  if (!key) return null;
  return listCoupons(shop).find((c) => c.code === key && c.enabled) || null;
}

export function validateCoupon(code, subtotal, shop = getShop()) {
  if (!shopCanUse('coupons')) {
    return { ok: false, error: 'クーポンは Growth 以上の機能です' };
  }
  const key = String(code || '').trim();
  if (!key) return { ok: false, error: 'クーポンコードを入力してください' };
  const c = findCoupon(key, shop);
  if (!c) {
    const any = listCoupons(shop).find((x) => x.code === key.toUpperCase());
    if (any && any.enabled === false) {
      return { ok: false, error: 'このクーポンは無効です' };
    }
    return { ok: false, error: 'クーポンコードが無効です' };
  }
  if (!isNowInWindow(c.from, c.until)) {
    return { ok: false, error: `利用時間外です（${c.from}–${c.until}）` };
  }
  if (c.maxUses != null && c.usedCount >= c.maxUses) {
    return { ok: false, error: 'クーポンの利用上限に達しています' };
  }
  if (subtotal < (c.minSubtotal || 0)) {
    return { ok: false, error: `¥${c.minSubtotal.toLocaleString('ja-JP')}以上で利用できます` };
  }
  if (c.type === 'percent' && !(c.value > 0)) {
    return { ok: false, error: '割引率が設定されていません' };
  }
  if (c.type === 'fixed' && !(c.value > 0)) {
    return { ok: false, error: '割引額が設定されていません' };
  }
  return { ok: true, coupon: c };
}

export function discountForCoupon(coupon, subtotal) {
  if (!coupon) return 0;
  const sub = Math.max(0, Number(subtotal) || 0);
  if (coupon.type === 'fixed') return Math.min(sub, coupon.value);
  return Math.floor(sub * (coupon.value / 100));
}

export function getAppliedCoupon(shopId) {
  try {
    const raw = JSON.parse(sessionStorage.getItem(APPLIED_KEY(shopId)) || 'null');
    return raw ? normalizeCoupon(raw) : null;
  } catch {
    return null;
  }
}

export function setAppliedCoupon(shopId, coupon) {
  try {
    if (!coupon) sessionStorage.removeItem(APPLIED_KEY(shopId));
    else sessionStorage.setItem(APPLIED_KEY(shopId), JSON.stringify(normalizeCoupon(coupon)));
  } catch (_) {}
}

export async function markCouponUsed(code) {
  const shop = getShop();
  const key = String(code || '').trim().toUpperCase();
  const list = listCoupons(shop).map((c) => {
    if (c.code === key) {
      return { ...c, usedCount: (Number(c.usedCount) || 0) + 1 };
    }
    return c;
  });
  return patchShopFields({ coupons: list });
}
