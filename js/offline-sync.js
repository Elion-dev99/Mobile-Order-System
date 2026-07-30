/**
 * Offline mutation queue + flush when back online.
 * Complements health.js pending orders.
 */

import { db } from './firebase.js';
import { doc, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { flushPendingOrders } from './health.js';

const QUEUE_KEY = 'mos_offline_queue';

export function enqueueMutation(mutation) {
  const item = {
    id: 'mut_' + Math.random().toString(36).slice(2, 10),
    ...mutation,
    queuedAt: Date.now(),
  };
  const q = readQueue();
  q.push(item);
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-100))); } catch (_) {}
  return item;
}

export function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}

function saveQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (_) {}
}

async function applyMutation(m) {
  if (m.type === 'setDoc') {
    await setDoc(doc(db, m.collection, m.docId), m.data, { merge: !!m.merge });
    return;
  }
  if (m.type === 'updateDoc') {
    await updateDoc(doc(db, m.collection, m.docId), m.data);
    return;
  }
  if (m.type === 'orderCreate') {
    await setDoc(doc(db, 'orders', m.docId), m.data);
    return;
  }
  throw new Error('unknown_mutation');
}

export async function flushOfflineQueue() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, reason: 'offline', flushed: 0 };
  }
  const q = readQueue();
  const remain = [];
  let flushed = 0;
  for (const m of q) {
    try {
      await applyMutation(m);
      flushed += 1;
    } catch (e) {
      remain.push({ ...m, lastError: String(e?.message || e) });
    }
  }
  saveQueue(remain);

  const pending = await flushPendingOrders(async (order) => {
    await setDoc(doc(db, 'orders', order.id), order);
  });

  return {
    ok: remain.length === 0 && pending.left === 0,
    flushed,
    remain: remain.length,
    ordersFlushed: pending.sent,
  };
}

export function startOfflineSync() {
  if (typeof window === 'undefined') return () => {};
  const run = () => { flushOfflineQueue().catch(() => {}); };
  window.addEventListener('online', run);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });
  setTimeout(run, 1200);
  return () => window.removeEventListener('online', run);
}
