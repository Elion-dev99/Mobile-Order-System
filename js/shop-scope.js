/**
 * Client-side shop scope for staff sessions.
 * Server custom claims come later; this binds a signed-in email to shopIds locally + shop doc.
 */

import { getShopId, getShop, patchShopFields } from './shop.js';
import { getStaffUser } from './staff-firebase-auth.js';

const BIND_KEY = 'mos_staff_shop_binds';

function readBinds() {
  try { return JSON.parse(localStorage.getItem(BIND_KEY) || '{}'); } catch { return {}; }
}

function writeBinds(map) {
  try { localStorage.setItem(BIND_KEY, JSON.stringify(map)); } catch (_) {}
}

export function bindStaffToShop(email, shopId = getShopId()) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return null;
  const map = readBinds();
  const set = new Set(map[em] || []);
  set.add(shopId);
  map[em] = [...set];
  writeBinds(map);
  return map[em];
}

export function staffAllowedShops(email) {
  const em = String(email || '').trim().toLowerCase();
  return readBinds()[em] || [];
}

export function assertStaffShopAccess(shopId = getShopId()) {
  const user = getStaffUser();
  if (!user) return { ok: false, reason: 'not_signed_in' };
  const allowed = staffAllowedShops(user.email);
  // First login on a shop auto-binds (single-tenant friendly)
  if (!allowed.length) {
    bindStaffToShop(user.email, shopId);
    return { ok: true, bound: true };
  }
  if (!allowed.includes(shopId)) {
    return { ok: false, reason: 'shop_mismatch', allowed };
  }
  return { ok: true };
}

/** Persist staff emails on shop doc for Ops visibility (Auth-free patch key). */
export async function rememberShopStaffEmail(email) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return;
  bindStaffToShop(em);
  const shop = getShop();
  const list = Array.isArray(shop.staffEmails) ? shop.staffEmails.slice() : [];
  if (!list.includes(em)) {
    list.push(em);
    try {
      await patchShopFields({ staffEmails: list.slice(0, 40) });
    } catch (_) {}
  }
}
