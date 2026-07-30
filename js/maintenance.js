/**
 * Platform-wide maintenance mode (Ops kill switch).
 * Stored at Firestore platform/config — public read, signed-in write.
 * Distinct from per-shop shop.isOpen.
 */

import { db } from './firebase.js';
import {
  doc, getDoc, setDoc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { notifyDiscordEvent } from './notify.js';

const DOC_PATH = ['platform', 'config'];
const CACHE_KEY = 'mos_platform_maintenance';
const DEFAULT_MESSAGE = 'メンテナンス中です。ご注文はレジにてお願いいたします。';

let cache = readLocalCache();
let unsub = null;
const listeners = new Set();

function readLocalCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return defaultState();
    return normalize(raw);
  } catch {
    return defaultState();
  }
}

function defaultState() {
  return {
    maintenance: false,
    message: DEFAULT_MESSAGE,
    updatedAt: 0,
    updatedBy: '',
  };
}

export function normalize(raw = {}) {
  const message = String(raw.message || DEFAULT_MESSAGE).trim().slice(0, 200)
    || DEFAULT_MESSAGE;
  return {
    maintenance: raw.maintenance === true || raw.maintenance === 'true' || raw.maintenance === 1,
    message,
    updatedAt: Number(raw.updatedAt) || 0,
    updatedBy: String(raw.updatedBy || '').slice(0, 120),
  };
}

function persistLocal(state) {
  cache = normalize(state);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) {}
  listeners.forEach((fn) => {
    try { fn(cache); } catch (_) {}
  });
  return cache;
}

export function getMaintenance() {
  return cache;
}

export function isMaintenanceMode() {
  return !!cache.maintenance;
}

export function maintenanceMessage() {
  return cache.message || DEFAULT_MESSAGE;
}

export function onMaintenanceChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function configRef() {
  return doc(db, ...DOC_PATH);
}

/** One-shot load (uses cache on failure). */
export async function loadMaintenance() {
  try {
    const snap = await getDoc(configRef());
    if (snap.exists()) {
      return persistLocal(snap.data());
    }
    // No doc yet → not in maintenance
    return persistLocal(defaultState());
  } catch (e) {
    console.warn('loadMaintenance failed, using cache', e);
    return cache;
  }
}

/** Live updates for guest/store/admin banners. */
export function subscribeMaintenance(cb) {
  if (typeof cb === 'function') listeners.add(cb);
  if (unsub) return () => { if (typeof cb === 'function') listeners.delete(cb); };
  unsub = onSnapshot(configRef(), (snap) => {
    if (snap.exists()) persistLocal(snap.data());
    else persistLocal(defaultState());
  }, (err) => {
    console.warn('subscribeMaintenance', err);
  });
  return () => {
    if (typeof cb === 'function') listeners.delete(cb);
  };
}

/**
 * Ops toggle — requires Firebase Auth (rules: signedIn write).
 * @param {{ enabled: boolean, message?: string, updatedBy?: string }} opts
 */
export async function setMaintenanceMode({ enabled, message, updatedBy = '' } = {}) {
  const next = normalize({
    maintenance: !!enabled,
    message: message != null ? message : cache.message,
    updatedAt: Date.now(),
    updatedBy,
  });
  await setDoc(configRef(), next, { merge: true });
  persistLocal(next);
  notifyDiscordEvent(
    next.maintenance ? 'メンテナンス開始' : 'メンテナンス解除',
    {
      状態: next.maintenance ? 'ON' : 'OFF',
      案内: next.message,
      操作: next.updatedBy || 'ops',
    },
    next.maintenance ? '🛠️' : '✅',
    'system_health'
  ).catch(() => {});
  return next;
}

/** Shared banner UI — idempotent. */
export function mountMaintenanceBanner({ compact = false } = {}) {
  const apply = (state) => {
    let el = document.getElementById('platformMaintenanceBanner');
    if (!state.maintenance) {
      if (el) el.hidden = true;
      document.body.classList.remove('platform-maintenance');
      return;
    }
    document.body.classList.add('platform-maintenance');
    if (!el) {
      el = document.createElement('div');
      el.id = 'platformMaintenanceBanner';
      el.className = 'platform-maintenance-banner';
      el.setAttribute('role', 'status');
      document.body.prepend(el);
    }
    el.hidden = false;
    el.innerHTML = compact
      ? `<strong>メンテナンス中</strong> <span>${escapeHtml(state.message)}</span>`
      : `<strong>メンテナンス中</strong><span>${escapeHtml(state.message)}</span>`;
  };
  apply(cache);
  return onMaintenanceChange(apply);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export { DEFAULT_MESSAGE };
