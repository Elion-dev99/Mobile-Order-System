/**
 * Shop coupons: percent or fixed yen off. Stored on shop.coupons[].
 * Growth+ via feature flag.
 */

import { getShop, saveShop, shopCanUse } from './shop.js';
import { isNowInWindow } from './shop.js';

const APPLIED_KEY = (shopId) => `mos_coupon_${shopId}`;

export function listCoupons(shop = getShop()) {
  return Array.isArray(shop?.coupons) ? shop.coupons : [];
}

export function normalizeCoupon(raw = {}) {
  const code = String(raw.code || '').trim().toUpperCase().replace(/\s+/g, '');
  const type = raw.type === 'fixed' ? 'fixed' : 'percent';
  let value = Number(raw.value) || 0;
  if (type === 'percent') value = Math.min(100, Math.max(0, value));
  else value = Math.max(0, Math.floor(value));
  return {
    id: raw.id || ('c_' + Math.random().toString(36).slice(2, 8)),
    code,
    type,
    value,
    label: String(raw.label || code).slice(0, 40),
    minSubtotal: Math.max(0, Number(raw.minSubtotal) || 0),
    maxUses: raw.maxUses == null || raw.maxUses === '' ? null : Number(raw.maxUses),
    usedCount: Number(raw.usedCount) || 0,
    enabled: raw.enabled !== false,
    from: raw.from || '00:00',
    until: raw.until || '23:59',
  };
}

export async function saveCoupons(coupons) {
  const cleaned = (coupons || []).map(normalizeCoupon).filter((c) => c.code);
  return saveShop({ coupons: cleaned });
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
  const c = findCoupon(code, shop);
  if (!c) return { ok: false, error: 'クーポンコードが無効です' };
  if (!isNowInWindow(c.from, c.until)) {
    return { ok: false, error: 'このクーポンは現在利用時間外です' };
  }
  if (c.maxUses != null && c.usedCount >= c.maxUses) {
    return { ok: false, error: 'クーポンの利用上限に達しています' };
  }
  if (subtotal < (c.minSubtotal || 0)) {
    return { ok: false, error: `¥${c.minSubtotal.toLocaleString('ja-JP')}以上で利用できます` };
  }
  return { ok: true, coupon: c };
}

export function discountForCoupon(coupon, subtotal) {
  if (!coupon) return 0;
  if (coupon.type === 'fixed') return Math.min(subtotal, coupon.value);
  return Math.floor(subtotal * (coupon.value / 100));
}

export function getAppliedCoupon(shopId) {
  try {
    return JSON.parse(sessionStorage.getItem(APPLIED_KEY(shopId)) || 'null');
  } catch {
    return null;
  }
}

export function setAppliedCoupon(shopId, coupon) {
  try {
    if (!coupon) sessionStorage.removeItem(APPLIED_KEY(shopId));
    else sessionStorage.setItem(APPLIED_KEY(shopId), JSON.stringify(coupon));
  } catch (_) {}
}

export async function markCouponUsed(code) {
  const shop = getShop();
  const list = listCoupons(shop).map((c) => {
    if (c.code === String(code || '').toUpperCase()) {
      return { ...c, usedCount: (c.usedCount || 0) + 1 };
    }
    return c;
  });
  return saveCoupons(list);
}
