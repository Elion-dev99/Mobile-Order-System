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
import {
  defaultSchedule,
  normalizeSchedule,
  evaluateSchedule,
  describeSchedule,
  SCHEDULE_DEFAULT_MESSAGE,
} from './maint-schedule.js';

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
    schedule: defaultSchedule(),
  };
}

export function normalize(raw = {}) {
  const message = String(raw.message || DEFAULT_MESSAGE).trim().slice(0, 200)
    || DEFAULT_MESSAGE;
  let source = 'manual';
  if (raw.source === 'cardinal') source = 'cardinal';
  else if (raw.source === 'schedule') source = 'schedule';
  return {
    maintenance: raw.maintenance === true || raw.maintenance === 'true' || raw.maintenance === 1,
    message,
    updatedAt: Number(raw.updatedAt) || 0,
    updatedBy: String(raw.updatedBy || '').slice(0, 120),
    source,
    auto: raw.auto === true || source === 'cardinal' || source === 'schedule',
    schedule: normalizeSchedule(raw.schedule || defaultSchedule()),
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

export function getScheduleEval(nowMs = Date.now()) {
  return evaluateSchedule(cache.schedule, nowMs);
}

/** Flag ON or active schedule window */
export function isMaintenanceMode() {
  if (cache.maintenance) return true;
  return evaluateSchedule(cache.schedule).active;
}

export function maintenanceMessage() {
  if (cache.maintenance) return cache.message || DEFAULT_MESSAGE;
  const ev = evaluateSchedule(cache.schedule);
  if (ev.active) return ev.message || SCHEDULE_DEFAULT_MESSAGE;
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
  schedule,
} = {}) {
  let src = 'manual';
  if (source === 'cardinal' || auto) src = 'cardinal';
  else if (source === 'schedule') src = 'schedule';
  const next = normalize({
    ...cache,
    maintenance: !!enabled,
    message: message != null ? message : cache.message,
    updatedAt: Date.now(),
    updatedBy,
    source: src,
    auto: auto || src === 'cardinal' || src === 'schedule',
    schedule: schedule != null ? schedule : cache.schedule,
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
    schedule: next.schedule,
  });

  if (!fsOk && !api.ok) {
    persistLocal(next);
    throw new Error(api.error || 'メンテナンス状態を保存できませんでした（Firestore / Ops鍵を確認）');
  }

  persistLocal(next);
  const pathLabel = next.source === 'cardinal'
    ? 'Cardinal自動'
    : (next.source === 'schedule' ? 'スケジュール' : '手動');
  notifyDiscordEvent(
    next.maintenance ? 'メンテナンス開始' : 'メンテナンス解除',
    {
      状態: next.maintenance ? 'ON' : 'OFF',
      案内: next.message,
      操作: next.updatedBy || 'ops',
      経路: pathLabel,
    },
    next.maintenance ? '🛠️' : '✅',
    'system_health'
  ).catch(() => {});
  return next;
}

/** Persist weekly / one-shot schedule (Ops). */
export async function saveMaintenanceSchedule(schedulePartial, { updatedBy = 'ops' } = {}) {
  const schedule = normalizeSchedule({ ...cache.schedule, ...schedulePartial });
  let fsOk = false;
  const payload = normalize({
    ...cache,
    schedule,
    updatedAt: Date.now(),
    updatedBy,
  });
  try {
    await setDoc(configRef(), payload, { merge: true });
    fsOk = true;
  } catch (e) {
    console.warn('saveMaintenanceSchedule firestore', e);
  }
  const api = await pushMaintenanceApi({
    action: 'schedule',
    schedule,
    updatedBy,
  });
  if (!fsOk && !api.ok) {
    persistLocal(payload);
    throw new Error(api.error || 'スケジュール保存に失敗しました（Ops鍵を確認）');
  }
  // Prefer API effective state after schedule apply
  if (api.ok && api.data) {
    persistLocal(normalize({ ...payload, ...api.data, schedule }));
  } else {
    persistLocal(payload);
  }
  notifyDiscordEvent(
    'メンテスケジュール更新',
    {
      有効: schedule.enabled ? 'ON' : 'OFF',
      内容: describeSchedule(schedule),
    },
    '🗓️',
    'system_health'
  ).catch(() => {});
  return getMaintenance();
}

/**
 * End-to-end drill: Cardinal outage maintenance path (edge + local).
 * Does not launch Cursor agents.
 */
export async function runOutageMaintenanceDrill({ clearAfter = false } = {}) {
  const before = { ...cache };
  const steps = [];

  const apiOn = await pushMaintenanceApi({
    action: 'drill_outage',
    autoClear: !!clearAfter,
    updatedBy: 'ops-drill',
  });
  steps.push({
    step: 'edge_drill_outage',
    ok: !!apiOn.ok,
    detail: apiOn.data || apiOn.error || apiOn,
  });

  // Also flip via client Cardinal path (Firestore mirror when possible)
  let clientSync = null;
  try {
    clientSync = await syncAutoMaintenance({
      shouldMaintain: true,
      reason: 'drill',
      streak: 99,
    });
    steps.push({ step: 'client_sync_on', ok: !clientSync.skipped || clientSync.reason === 'already_on', detail: clientSync });
  } catch (e) {
    steps.push({ step: 'client_sync_on', ok: false, detail: String(e?.message || e) });
  }

  await loadMaintenance().catch(() => {});
  const mid = getMaintenance();
  const guestWouldBlock = isMaintenanceMode();
  steps.push({
    step: 'verify_on',
    ok: guestWouldBlock && (mid.auto || mid.source === 'cardinal'),
    detail: { maintenance: mid.maintenance, source: mid.source, auto: mid.auto, guestWouldBlock },
  });

  let cleared = null;
  if (clearAfter) {
    try {
      cleared = await syncAutoMaintenance({ shouldMaintain: false, reason: 'drill-clear' });
      steps.push({ step: 'client_sync_off', ok: true, detail: cleared });
    } catch (e) {
      const apiOff = await pushMaintenanceApi({ action: 'drill_clear' });
      steps.push({ step: 'edge_drill_clear', ok: !!apiOff.ok, detail: apiOff.data || apiOff.error });
    }
    await loadMaintenance().catch(() => {});
  }

  const after = getMaintenance();
  const passed = steps.every((s) => s.ok);
  return {
    ok: passed,
    passed,
    before,
    after,
    clearAfter,
    steps,
    hint: clearAfter
      ? '投入→確認→解除まで実行しました。'
      : '自動メンテ ON を確認しました。客席バナーを見てから「ドリル解除」またはメンテナンス解除を押してください。',
  };
}

/** Call Cardinal tick with simulated outage (server path). */
export async function runCardinalOutageTickDrill() {
  const { cardinalApi } = await import('./cardinal.js');
  const tick = await cardinalApi('tick', {
    simulateUnhealthy: true,
    dispatchOnDrill: false,
    source: 'ops-drill',
  });
  await loadMaintenance().catch(() => {});
  const state = getMaintenance();
  return {
    ok: !!tick.ok && (tick.data?.shouldMaintain || state.maintenance),
    tick,
    maintenance: state,
    guestWouldBlock: isMaintenanceMode(),
    hint: tick.ok
      ? 'サーバー tick（模擬障害）を実行しました。メンテが ON なら成功です。'
      : 'tick 失敗。Ops鍵（OPS_API_SECRET）と Pages デプロイを確認してください。',
  };
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
    if (cur.maintenance && (cur.auto || cur.source === 'cardinal' || cur.source === 'schedule')) {
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

  // Recovery — only clear Cardinal auto locks (never schedule window / manual)
  if (!cur.maintenance) return { skipped: true, reason: 'already_off', state: cur };
  if (cur.source === 'manual' && !cur.auto) {
    return { skipped: true, reason: 'manual_lock', state: cur };
  }
  if (cur.source === 'schedule' || evaluateSchedule(cur.schedule).active) {
    return { skipped: true, reason: 'schedule_active', state: cur };
  }
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

export { describeSchedule, normalizeSchedule, evaluateSchedule, defaultSchedule, WEEKDAYS } from './maint-schedule.js';

/** Shared banner UI — idempotent. */
export function mountMaintenanceBanner({ compact = false } = {}) {
  const apply = () => {
    let el = document.getElementById('platformMaintenanceBanner');
    const on = isMaintenanceMode();
    if (!on) {
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
    const state = cache;
    const schedOn = evaluateSchedule(state.schedule).active && !state.maintenance;
    const who = state.source === 'schedule' || schedOn
      ? '（定期）'
      : (state.auto || state.source === 'cardinal' ? '（自動）' : '');
    const msg = maintenanceMessage();
    el.innerHTML = compact
      ? `<strong>メンテナンス中${who}</strong> <span>${escapeHtml(msg)}</span>`
      : `<strong>メンテナンス中${who}</strong><span>${escapeHtml(msg)}</span>`;
  };
  apply();
  return onMaintenanceChange(apply);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
