/**
 * Durable-enough maintenance flag for Pages Functions via Cache API.
 * Survives Firestore outages so Cardinal can still flip the kill switch.
 */

import {
  defaultSchedule,
  normalizeSchedule,
  evaluateSchedule,
  SCHEDULE_DEFAULT_MESSAGE,
} from './_maint-schedule.js';

const CACHE_URL = 'https://mobile-order-system.pages.dev/__platform_maintenance_v1';
const DEFAULT_MESSAGE = 'システム障害を検知したため一時停止中です。ご注文はレジにてお願いいたします。';

export function defaultMaintenanceState() {
  return {
    maintenance: false,
    message: DEFAULT_MESSAGE,
    updatedAt: 0,
    updatedBy: '',
    source: 'manual', // manual | cardinal | schedule
    auto: false,
    schedule: defaultSchedule(),
  };
}

export function normalizeMaintenance(raw = {}) {
  const base = defaultMaintenanceState();
  const message = String(raw.message || base.message).trim().slice(0, 200) || base.message;
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
    schedule: normalizeSchedule(raw.schedule || base.schedule),
  };
}

/** Effective public view: flag OR active schedule window */
export function effectiveMaintenance(raw, nowMs = Date.now()) {
  const state = normalizeMaintenance(raw);
  const ev = evaluateSchedule(state.schedule, nowMs);
  if (state.maintenance) {
    return { ...state, effective: true, scheduleEval: ev };
  }
  if (ev.active) {
    return {
      ...state,
      maintenance: true,
      effective: true,
      message: ev.message || SCHEDULE_DEFAULT_MESSAGE,
      source: 'schedule',
      auto: true,
      scheduleEval: ev,
    };
  }
  return { ...state, effective: false, scheduleEval: ev };
}

export async function readMaintenanceState(cachesObj) {
  try {
    const cache = cachesObj?.default;
    if (!cache) return defaultMaintenanceState();
    const hit = await cache.match(CACHE_URL);
    if (!hit) return defaultMaintenanceState();
    const data = await hit.json();
    return normalizeMaintenance(data);
  } catch {
    return defaultMaintenanceState();
  }
}

export async function writeMaintenanceState(cachesObj, partial) {
  const prev = await readMaintenanceState(cachesObj);
  const next = normalizeMaintenance({
    ...prev,
    ...partial,
    schedule: partial.schedule != null ? partial.schedule : prev.schedule,
    updatedAt: Date.now(),
  });
  const cache = cachesObj?.default;
  if (cache) {
    const res = new Response(JSON.stringify(next), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=604800',
      },
    });
    await cache.put(CACHE_URL, res);
  }
  return next;
}

/**
 * Apply schedule window onto stored flag (called from Cardinal tick).
 * Does not clear manual locks. Clears schedule-sourced flag when outside window
 * unless outage still requires maintenance.
 */
export async function applyScheduleToState(cachesObj, { outageMaintain = false } = {}) {
  const prev = await readMaintenanceState(cachesObj);
  const ev = evaluateSchedule(prev.schedule);
  if (ev.active) {
    if (prev.maintenance && prev.source === 'manual' && !prev.auto) {
      return { state: prev, scheduleEval: ev, changed: false, skipped: 'manual_lock' };
    }
    if (prev.maintenance && prev.source === 'schedule' && prev.message === ev.message) {
      return { state: prev, scheduleEval: ev, changed: false };
    }
    const state = await writeMaintenanceState(cachesObj, {
      maintenance: true,
      message: ev.message,
      updatedBy: 'schedule',
      source: 'schedule',
      auto: true,
      schedule: prev.schedule,
    });
    return { state, scheduleEval: ev, changed: true, action: 'schedule_on' };
  }
  // Outside window: clear only schedule-sourced auto flag (not cardinal outage / manual)
  if (prev.maintenance && prev.source === 'schedule' && !outageMaintain) {
    const state = await writeMaintenanceState(cachesObj, {
      maintenance: false,
      updatedBy: 'schedule',
      source: 'schedule',
      auto: true,
      schedule: prev.schedule,
    });
    return { state, scheduleEval: ev, changed: true, action: 'schedule_off' };
  }
  return { state: prev, scheduleEval: ev, changed: false };
}

export { DEFAULT_MESSAGE, CACHE_URL, SCHEDULE_DEFAULT_MESSAGE };
