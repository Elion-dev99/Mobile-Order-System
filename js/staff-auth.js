/**
 * Store staff roles: kitchen / floor / manager (Business+).
 * Session-scoped after PIN unlock.
 */

import { getShop, shopCanUse } from './shop.js';
import { scopedKey } from './tenant.js';

export const STAFF_ROLES = {
  kitchen: {
    id: 'kitchen',
    label: '厨房',
    allow: ['orders', 'kds', 'tickets'],
  },
  floor: {
    id: 'floor',
    label: 'ホール',
    allow: ['orders', 'requests', 'tables'],
  },
  manager: {
    id: 'manager',
    label: '店長',
    allow: ['*'],
  },
};

function sessionKey() {
  return scopedKey('mos_staff_role');
}

export function getStaffRole() {
  if (!shopCanUse('staffRoles')) return 'manager'; // ungated plans act as full access
  try {
    return sessionStorage.getItem(sessionKey()) || '';
  } catch {
    return '';
  }
}

export function setStaffRole(role) {
  try {
    if (!role) sessionStorage.removeItem(sessionKey());
    else sessionStorage.setItem(sessionKey(), role);
  } catch (_) {}
}

export function clearStaffRole() {
  setStaffRole('');
}

export function staffCan(action) {
  if (!shopCanUse('staffRoles')) return true;
  const role = getStaffRole();
  if (!role) return false;
  const def = STAFF_ROLES[role];
  if (!def) return false;
  if (def.allow.includes('*')) return true;
  return def.allow.includes(action);
}

export function verifyStaffPin(pin) {
  const shop = getShop();
  const pins = shop.staffPins || {};
  const raw = String(pin || '');
  if (!raw) return null;
  // manager pin falls back to adminPin
  if (pins.manager && raw === pins.manager) return 'manager';
  if (shop.adminPin && raw === shop.adminPin) return 'manager';
  if (pins.kitchen && raw === pins.kitchen) return 'kitchen';
  if (pins.floor && raw === pins.floor) return 'floor';
  return null;
}

export function staffRoleLabel() {
  const r = getStaffRole();
  return STAFF_ROLES[r]?.label || (shopCanUse('staffRoles') ? '未認証' : '全権限');
}
