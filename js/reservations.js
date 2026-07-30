/**
 * Reservations + walk-in waitlist.
 */

import { db } from './firebase.js';
import {
  collection, addDoc, doc, updateDoc, onSnapshot, query, where, orderBy,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getShopId } from './shop.js';
import { isDemoMode } from './demo.js';

export async function createReservation({
  name, phone, partySize = 2, at, note = '', channel = 'web',
} = {}, shopId = getShopId()) {
  const payload = {
    shopId,
    name: String(name || '').slice(0, 40),
    phone: String(phone || '').slice(0, 20),
    partySize: Math.max(1, Number(partySize) || 1),
    at: Number(at) || Date.now(),
    note: String(note || '').slice(0, 200),
    channel,
    status: 'booked', // booked | seated | cancelled | no_show
    createdAt: Date.now(),
    demo: isDemoMode(),
  };
  if (!payload.name) throw new Error('お名前を入力してください');
  if (isDemoMode()) {
    const id = 'RSV-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    try {
      const all = JSON.parse(localStorage.getItem('mos_local_reservations') || '[]');
      all.unshift({ ...payload, id });
      localStorage.setItem('mos_local_reservations', JSON.stringify(all.slice(0, 100)));
    } catch (_) {}
    return { ...payload, id };
  }
  const ref = await addDoc(collection(db, 'reservations'), payload);
  return { ...payload, id: ref.id };
}

export async function createWaitlistEntry({
  name, phone, partySize = 2, note = '',
} = {}, shopId = getShopId()) {
  const payload = {
    shopId,
    name: String(name || 'ゲスト').slice(0, 40),
    phone: String(phone || '').slice(0, 20),
    partySize: Math.max(1, Number(partySize) || 1),
    note: String(note || '').slice(0, 200),
    status: 'waiting', // waiting | called | seated | left
    createdAt: Date.now(),
    positionHint: 0,
    demo: isDemoMode(),
  };
  if (isDemoMode()) {
    const id = 'WAIT-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    try {
      const all = JSON.parse(localStorage.getItem('mos_local_waitlist') || '[]');
      all.unshift({ ...payload, id });
      localStorage.setItem('mos_local_waitlist', JSON.stringify(all.slice(0, 100)));
    } catch (_) {}
    return { ...payload, id };
  }
  const ref = await addDoc(collection(db, 'waitlist'), payload);
  return { ...payload, id: ref.id };
}

export function subscribeReservations(shopId, cb) {
  const q = query(
    collection(db, 'reservations'),
    where('shopId', '==', shopId),
    orderBy('at', 'asc'),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, () => {
    try {
      const all = JSON.parse(localStorage.getItem('mos_local_reservations') || '[]');
      cb(all.filter((r) => r.shopId === shopId));
    } catch { cb([]); }
  });
}

export function subscribeWaitlist(shopId, cb) {
  const q = query(
    collection(db, 'waitlist'),
    where('shopId', '==', shopId),
    orderBy('createdAt', 'asc'),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, () => {
    try {
      const all = JSON.parse(localStorage.getItem('mos_local_waitlist') || '[]');
      cb(all.filter((r) => r.shopId === shopId));
    } catch { cb([]); }
  });
}

export async function updateReservationStatus(id, status) {
  await updateDoc(doc(db, 'reservations', id), { status, updatedAt: Date.now() });
}

export async function updateWaitlistStatus(id, status) {
  await updateDoc(doc(db, 'waitlist', id), { status, updatedAt: Date.now() });
}

export function estimateWaitlistMinutes(entries = [], partySize = 2) {
  const waiting = entries.filter((e) => e.status === 'waiting');
  const ahead = waiting.length;
  return Math.max(5, Math.min(90, 8 + ahead * 6 + partySize));
}
