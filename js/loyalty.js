/**
 * Simple CRM / points membership (per shop).
 */

import { db } from './firebase.js';
import {
  doc, getDoc, setDoc, collection, query, where, onSnapshot, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getShopId } from './shop.js';

const MEMBER_KEY = (shopId) => `mos_member_${shopId}`;

export function earnPointsForTotal(total, rate = 1) {
  return Math.max(0, Math.floor((Number(total) || 0) / 100) * rate); // ¥100 = 1pt
}

export function getLocalMember(shopId = getShopId()) {
  try { return JSON.parse(localStorage.getItem(MEMBER_KEY(shopId)) || 'null'); } catch { return null; }
}

export function setLocalMember(member, shopId = getShopId()) {
  try {
    if (!member) localStorage.removeItem(MEMBER_KEY(shopId));
    else localStorage.setItem(MEMBER_KEY(shopId), JSON.stringify(member));
  } catch (_) {}
  return member;
}

export async function upsertMember({ phone, name = '', email = '' } = {}, shopId = getShopId()) {
  const cleanPhone = String(phone || '').replace(/\D/g, '').slice(0, 15);
  if (cleanPhone.length < 8) throw new Error('電話番号を入力してください');
  const id = `${shopId}_${cleanPhone}`;
  const ref = doc(db, 'members', id);
  let prev = {};
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) prev = snap.data();
  } catch (_) {}
  const member = {
    id,
    shopId,
    phone: cleanPhone,
    name: String(name || prev.name || '').slice(0, 40),
    email: String(email || prev.email || '').slice(0, 120),
    points: Number(prev.points) || 0,
    visitCount: Number(prev.visitCount) || 0,
    totalSpent: Number(prev.totalSpent) || 0,
    updatedAt: Date.now(),
    createdAt: prev.createdAt || Date.now(),
  };
  try {
    await setDoc(ref, member, { merge: true });
  } catch (e) {
    console.warn('member cloud save failed', e);
  }
  setLocalMember(member, shopId);
  return member;
}

export async function applyOrderToMember(member, order, { redeem = 0 } = {}) {
  if (!member?.id) return null;
  const earn = earnPointsForTotal(order?.total || 0);
  const redeemPts = Math.min(Number(redeem) || 0, Number(member.points) || 0);
  const next = {
    ...member,
    points: Math.max(0, (Number(member.points) || 0) - redeemPts + earn),
    visitCount: (Number(member.visitCount) || 0) + 1,
    totalSpent: (Number(member.totalSpent) || 0) + (Number(order?.total) || 0),
    lastOrderId: order?.id || null,
    lastVisitAt: Date.now(),
    updatedAt: Date.now(),
  };
  try {
    await setDoc(doc(db, 'members', member.id), next, { merge: true });
  } catch (e) {
    console.warn('member update failed', e);
  }
  setLocalMember(next, member.shopId);
  return { member: next, earned: earn, redeemed: redeemPts };
}

export function subscribeMembers(shopId, cb, max = 80) {
  const q = query(
    collection(db, 'members'),
    where('shopId', '==', shopId),
    orderBy('updatedAt', 'desc'),
    limit(max),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, () => cb([]));
}

export function pointsYenValue(points) {
  return Math.max(0, Number(points) || 0); // 1pt = ¥1 (simple)
}
