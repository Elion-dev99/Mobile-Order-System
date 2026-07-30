/**
 * Client-side auto-heal: retry, flush queues, escalate persistent outages to Cursor.
 */

import {
  checkSystemHealth,
  flushPendingOrders,
  listPendingOrders,
  getLastHealthState,
} from './health.js';
import { getDiscordWebhook, isLikelyDiscordWebhook } from './notify.js';

const ESCALATE_KEY = 'mos_autoheal_escalated_at';
const FAIL_STREAK_KEY = 'mos_autoheal_fail_streak';
const INCIDENT_PATH = '/api/incident';

let started = false;
let timer = null;

function getStreak() {
  try { return Number(localStorage.getItem(FAIL_STREAK_KEY) || 0) || 0; } catch { return 0; }
}
function setStreak(n) {
  try { localStorage.setItem(FAIL_STREAK_KEY, String(n)); } catch (_) {}
}
function getEscalatedAt() {
  try { return Number(localStorage.getItem(ESCALATE_KEY) || 0) || 0; } catch { return 0; }
}
function setEscalatedAt(ts = Date.now()) {
  try { localStorage.setItem(ESCALATE_KEY, String(ts)); } catch (_) {}
}

async function tryFlushOrders() {
  if (!listPendingOrders().length) return { sent: 0, left: 0 };
  try {
    const { db } = await import('./firebase.js');
    const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js');
    return flushPendingOrders(async (order) => {
      await setDoc(doc(db, 'orders', order.id), order);
    });
  } catch (e) {
    return { sent: 0, left: listPendingOrders().length, error: String(e?.message || e) };
  }
}

/**
 * Escalate to /api/incident → Discord + Cursor Cloud Agent (if secrets configured).
 */
export async function escalateToCursor(incident = {}) {
  const webhook = getDiscordWebhook();
  const body = {
    ...incident,
    source: 'quickorder-autoheal',
    url: typeof location !== 'undefined' ? location.href : '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    pendingOrders: listPendingOrders().length,
  };
  if (webhook && isLikelyDiscordWebhook(webhook)) body.webhook = webhook;

  try {
    const res = await fetch(INCIDENT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * One auto-heal cycle: probe → flush on recovery → escalate on persistent failure.
 */
export async function runAutoHealCycle({ escalateAfterFails = 2, escalateCooldownMs = 30 * 60 * 1000 } = {}) {
  const health = await checkSystemHealth();
  const prev = getLastHealthState();
  let flush = { sent: 0, left: 0 };
  let escalated = null;

  if (health.status === 'ok' || health.firestore?.ok) {
    flush = await tryFlushOrders();
    setStreak(0);
  } else if (health.status === 'offline') {
    // Browser offline — do not burn Cursor API credits
    setStreak(0);
  } else {
    const streak = getStreak() + 1;
    setStreak(streak);
    const cooled = Date.now() - getEscalatedAt() > escalateCooldownMs;
    if (streak >= escalateAfterFails && cooled) {
      escalated = await escalateToCursor({
        status: health.status,
        severity: health.status === 'down' ? 'critical' : 'warning',
        summary: `自動検知: ${health.label}（連続${streak}回）`,
        message: 'Ops/客席のヘルスチェックが連続失敗したため、Cursor自動対処を依頼します',
        firestoreOk: !!health.firestore?.ok,
        notifyApiOk: !!health.notifyApi?.functionReady,
        firestoreError: health.firestore?.error || '',
        online: !!health.online,
        prevStatus: prev?.status || null,
      });
      if (escalated.ok) setEscalatedAt();
    }
  }

  // Recovery: if we just came back, clear escalation gate gently and flush again
  if (prev && prev.status !== 'ok' && health.status === 'ok') {
    flush = await tryFlushOrders();
    setStreak(0);
  }

  return { health, flush, escalated, streak: getStreak() };
}

/** Start background auto-heal while Ops (or any page) is open. */
export function startAutoHeal({
  intervalMs = 45_000,
  escalateAfterFails = 2,
  escalateCooldownMs = 30 * 60 * 1000,
} = {}) {
  if (started) return;
  started = true;

  const opts = { escalateAfterFails, escalateCooldownMs };
  const tick = () => {
    runAutoHealCycle(opts).catch(() => {});
  };
  tick();
  timer = setInterval(tick, intervalMs);

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      setTimeout(() => runAutoHealCycle(opts).catch(() => {}), 800);
    });
  }
}

/** Snapshot for Ops UI. */
export function getAutoHealState() {
  return {
    consecutiveFails: getStreak(),
    lastEscalationAt: getEscalatedAt() || null,
    running: started,
  };
}

export function stopAutoHeal() {
  started = false;
  if (timer) clearInterval(timer);
  timer = null;
}
