/**
 * Staff action audit trail (local + best-effort Firestore).
 */

import { db } from './firebase.js';
import {
  collection, addDoc, query, where, orderBy, limit, onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getShopId } from './shop.js';

const LOCAL_KEY = 'mos_audit_log';

function pushLocal(entry) {
  try {
    const all = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
    all.unshift(entry);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all.slice(0, 200)));
  } catch (_) {}
}

export async function writeAudit({
  action, actor = 'staff', detail = '', shopId = getShopId(), meta = {},
} = {}) {
  const entry = {
    shopId,
    action: String(action || 'unknown').slice(0, 64),
    actor: String(actor || 'staff').slice(0, 80),
    detail: String(detail || '').slice(0, 300),
    meta,
    timestamp: Date.now(),
  };
  pushLocal(entry);
  try {
    await addDoc(collection(db, 'auditLogs'), entry);
  } catch (e) {
    // rules may deny anonymous — local still kept
  }
  return entry;
}

export function readLocalAudit(max = 50) {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]').slice(0, max);
  } catch {
    return [];
  }
}

export function subscribeAudit(shopId, cb, max = 60) {
  const q = query(
    collection(db, 'auditLogs'),
    where('shopId', '==', shopId),
    orderBy('timestamp', 'desc'),
    limit(max),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, () => cb(readLocalAudit(max).filter((e) => e.shopId === shopId)));
}
