/**
 * Platform-wide maintenance mode (Ops kill switch + Cardinal auto).
 *
 * Sources (merged):
 *  1) Firestore platform/config — when Auth can write / FS is up
 *  2) GET /api/maintenance — Cloudflare edge copy (works when Firestore is down)
 *
 * Distinct from per-shop shop.isOpen.
 */

import { db } from './firebase.js';
import {
  doc, getDoc, setDoc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { notifyDiscordEvent } from './notify.js';
import { opsAuthHeaders } from './ops-secret.js';

const DOC_PATH = ['platform', 'config'];
const CACHE_KEY = 'mos_platform_maintenance';
const API_PATH = '/api/maintenance';
export const DEFAULT_MESSAGE = 'メンテナンス中です。ご注文はレジにてお願いいたします。';
export const AUTO_MESSAGE = 'システム障害を検知したため一時停止中です。ご注文はレジにてお願いいたします。';

let cache = readLocalCache();
let unsub = null;
let pollTimer = null;
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
    source: 'manual',
    auto: false,
  };
}

export function normalize(raw = {}) {
  const message = String(raw.message || DEFAULT_MESSAGE).trim().slice(0, 200)
    || DEFAULT_MESSAGE;
  const source = raw.source === 'cardinal' ? 'cardinal' : 'manual';
  return {
    maintenance: raw.maintenance === true || raw.maintenance === 'true' || raw.maintenance === 1,
    message,
    updatedAt: Number(raw.updatedAt) || 0,
    updatedBy: String(raw.updatedBy || '').slice(0, 120),
    source,
    auto: raw.auto === true || source === 'cardinal',
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

/** Prefer ON if either source is ON; else newer updatedAt wins. */
export function mergeMaintenanceStates(a, b) {
  const x = a ? normalize(a) : null;
  const y = b ? normalize(b) : null;
  if (!x && !y) return defaultState();
  if (!x) return y;
  if (!y) return x;
  if (x.maintenance !== y.maintenance) {
    // ON wins (safer during outages); prefer cardinal auto message if that side is on
    const on = x.maintenance ? x : y;
    return on;
  }
  return (x.updatedAt || 0) >= (y.updatedAt || 0) ? x : y;
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

async function loadFromFirestore() {
  const snap = await getDoc(configRef());
  if (!snap.exists()) return defaultState();
  return normalize(snap.data());
}

async function loadFromApi() {
  const res = await fetch(API_PATH, { method: 'GET', cache: 'no-store' });
  if (!res.ok) throw new Error(`maintenance_api_${res.status}`);
  const data = await res.json();
  return normalize(data);
}

/** POST edge copy (Ops secret). Soft-fails if secret missing. */
export async function pushMaintenanceApi(partial = {}) {
  try {
    const res = await fetch(API_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...opsAuthHeaders(),
      },
      body: JSON.stringify(partial),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** One-shot load (API + Firestore merge; cache on total failure). */
export async function loadMaintenance() {
  const settled = await Promise.allSettled([loadFromFirestore(), loadFromApi()]);
  const fs = settled[0].status === 'fulfilled' ? settled[0].value : null;
  const api = settled[1].status === 'fulfilled' ? settled[1].value : null;
  if (!fs && !api) {
    console.warn('loadMaintenance failed, using cache');
    return cache;
  }
  return persistLocal(mergeMaintenanceStates(fs, api));
}

/** Live updates: Firestore snapshot + API poll (for FS outages). */
export function subscribeMaintenance(cb) {
  if (typeof cb === 'function') listeners.add(cb);
  if (!unsub) {
    unsub = onSnapshot(configRef(), (snap) => {
      const fs = snap.exists() ? normalize(snap.data()) : defaultState();
      loadFromApi()
        .then((api) => persistLocal(mergeMaintenanceStates(fs, api)))
        .catch(() => persistLocal(mergeMaintenanceStates(fs, cache)));
    }, (err) => {
      console.warn('subscribeMaintenance firestore', err);
      loadFromApi()
        .then((api) => persistLocal(mergeMaintenanceStates(cache, api)))
        .catch(() => {});
    });
  }
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      loadFromApi().then((api) => {
        persistLocal(mergeMaintenanceStates(cache, api));
      }).catch(() => {});
    }, 45_000);
  }
  return () => {
    if (typeof cb === 'function') listeners.delete(cb);
  };
}

/**
 * Ops / Cardinal toggle.
 * Writes Firestore when possible + always mirrors to /api/maintenance when authed.
 * @param {{ enabled: boolean, message?: string, updatedBy?: string, source?: string, auto?: boolean }} opts
 */
export async function setMaintenanceMode({
  enabled,
  message,
  updatedBy = '',
  source = 'manual',
  auto = false,
} = {}) {
  const next = normalize({
    maintenance: !!enabled,
    message: message != null ? message : cache.message,
    updatedAt: Date.now(),
    updatedBy,
    source: source === 'cardinal' || auto ? 'cardinal' : 'manual',
    auto: auto || source === 'cardinal',
  });

  let fsOk = false;
  try {
    await setDoc(configRef(), next, { merge: true });
    fsOk = true;
  } catch (e) {
    console.warn('setMaintenanceMode firestore failed', e);
  }

  const api = await pushMaintenanceApi({
    maintenance: next.maintenance,
    message: next.message,
    updatedBy: next.updatedBy,
    source: next.source,
    auto: next.auto,
  });

  if (!fsOk && !api.ok) {
    // Still apply locally so this Ops session blocks; guests need API or FS
    persistLocal(next);
    throw new Error(api.error || 'メンテナンス状態を保存できませんでした（Firestore / Ops鍵を確認）');
  }

  persistLocal(next);
  notifyDiscordEvent(
    next.maintenance ? 'メンテナンス開始' : 'メンテナンス解除',
    {
      状態: next.maintenance ? 'ON' : 'OFF',
      案内: next.message,
      操作: next.updatedBy || 'ops',
      経路: next.source === 'cardinal' ? 'Cardinal自動' : '手動',
    },
    next.maintenance ? '🛠️' : '✅',
    'system_health'
  ).catch(() => {});
  return next;
}

/**
 * Cardinal / AutoHeal: enter or leave auto-maintenance.
 * Never clears a manual Ops lock.
 */
export async function syncAutoMaintenance({
  shouldMaintain,
  reason = '',
  streak = 0,
} = {}) {
  const cur = cache;
  if (shouldMaintain) {
    if (cur.maintenance && cur.source === 'manual' && !cur.auto) {
      return { skipped: true, reason: 'manual_lock', state: cur };
    }
    if (cur.maintenance && cur.auto) {
      return { skipped: true, reason: 'already_on', state: cur };
    }
    const state = await setMaintenanceMode({
      enabled: true,
      message: AUTO_MESSAGE,
      updatedBy: `cardinal${reason ? `:${reason}` : ''}`,
      source: 'cardinal',
      auto: true,
    });
    return { ok: true, enabled: true, streak, state };
  }

  // Recovery — only clear Cardinal auto locks
  if (!cur.maintenance) return { skipped: true, reason: 'already_off', state: cur };
  if (!(cur.auto || cur.source === 'cardinal')) {
    return { skipped: true, reason: 'manual_lock', state: cur };
  }
  const state = await setMaintenanceMode({
    enabled: false,
    updatedBy: 'cardinal:recovery',
    source: 'cardinal',
    auto: true,
  });
  return { ok: true, enabled: false, streak, state };
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
    const who = state.auto || state.source === 'cardinal' ? '（自動）' : '';
    el.innerHTML = compact
      ? `<strong>メンテナンス中${who}</strong> <span>${escapeHtml(state.message)}</span>`
      : `<strong>メンテナンス中${who}</strong><span>${escapeHtml(state.message)}</span>`;
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
