import { db } from './firebase.js';
import { getShopId, getMenu, getShop, isItemSoldOut } from './shop.js';
import { isDemoMode } from './demo.js';
import {
  collection, addDoc, doc, onSnapshot, query, where, orderBy, updateDoc
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

/** Kitchen-load based ETA (minutes) from open orders */
export function estimateWaitMinutes(orders = []) {
  const open = orders.filter(o => {
    const s = o.status || 'received';
    return s !== 'done';
  });
  const itemCount = open.reduce((n, o) => n + (o.items || []).reduce((a, i) => a + (i.qty || 1), 0), 0);
  const base = 4;
  const load = Math.ceil(itemCount * 1.4) + open.length * 2;
  return Math.max(3, Math.min(45, base + load));
}

export function recommendUpsells(cart = [], limit = 3) {
  const menu = getMenu();
  const inCart = new Set(cart.map(c => c.itemId));
  const candidates = (menu.items || [])
    .filter(i => !inCart.has(i.id) && !isItemSoldOut(i.id))
    .filter(i => i.popular || i.category === 'side' || i.category === 'drink' || i.category === 'dessert')
    .sort((a, b) => Number(!!b.popular) - Number(!!a.popular) || a.price - b.price);
  return candidates.slice(0, limit);
}

export async function createServiceRequest({ type, tableNumber, note = '' }) {
  const payload = {
    shopId: getShopId(),
    tableNumber: String(tableNumber),
    type, // 'staff' | 'bill'
    note: String(note || '').slice(0, 200),
    status: 'open',
    timestamp: Date.now(),
    demo: isDemoMode(),
  };
  if (isDemoMode()) {
    const id = 'REQ-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    try {
      sessionStorage.setItem('mos_demo_req_' + id, JSON.stringify({ ...payload, id }));
      const all = JSON.parse(localStorage.getItem('mos_local_requests') || '[]');
      all.unshift({ ...payload, id });
      localStorage.setItem('mos_local_requests', JSON.stringify(all.slice(0, 50)));
    } catch (_) {}
    return { ...payload, id };
  }
  try {
    const ref = await addDoc(collection(db, 'serviceRequests'), payload);
    return { ...payload, id: ref.id };
  } catch (e) {
    console.warn('serviceRequest firestore failed, local fallback', e);
    const id = 'LOCAL-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    try {
      const all = JSON.parse(localStorage.getItem('mos_local_requests') || '[]');
      all.unshift({ ...payload, id });
      localStorage.setItem('mos_local_requests', JSON.stringify(all.slice(0, 50)));
    } catch (_) {}
    return { ...payload, id };
  }
}

export function subscribeServiceRequests(shopId, cb) {
  const q = query(
    collection(db, 'serviceRequests'),
    where('shopId', '==', shopId),
    orderBy('timestamp', 'desc')
  );
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }, () => cb([]));
}

export async function resolveServiceRequest(id) {
  await updateDoc(doc(db, 'serviceRequests', id), { status: 'done', resolvedAt: Date.now() });
}

export async function submitSurvey({ orderId, score, comment = '' }) {
  const payload = {
    shopId: getShopId(),
    orderId: orderId || '',
    score: Number(score) || 0,
    comment: String(comment || '').slice(0, 500),
    timestamp: Date.now(),
    shopName: getShop().name || '',
    demo: isDemoMode(),
  };
  if (isDemoMode()) {
    try {
      sessionStorage.setItem('mos_demo_survey_' + (orderId || Date.now()), JSON.stringify(payload));
    } catch (_) {}
    return payload;
  }
  await addDoc(collection(db, 'surveys'), payload);
  return payload;
}

/** Mount guest action chips: call staff / request bill */
export function mountGuestServiceActions({ tableNumber, locale = 'ja', onToast }) {
  if (document.getElementById('guestServiceBar')) return;
  const bar = document.createElement('div');
  bar.id = 'guestServiceBar';
  bar.className = 'guest-service-bar';
  const staffLabel = locale === 'en' ? 'Call staff' : '店員を呼ぶ';
  const billLabel = locale === 'en' ? 'Request bill' : 'お会計';
  bar.innerHTML = `
    <button type="button" data-svc="staff">${staffLabel}</button>
    <button type="button" data-svc="bill">${billLabel}</button>
  `;
  const header = document.querySelector('.guest-header') || document.body;
  header.appendChild(bar);

  bar.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await createServiceRequest({ type: btn.dataset.svc, tableNumber });
        onToast?.(
          locale === 'en'
            ? (btn.dataset.svc === 'bill' ? 'Bill requested' : 'Staff called')
            : (btn.dataset.svc === 'bill' ? '会計をリクエストしました' : '店員を呼び出しました')
        );
      } catch (e) {
        console.error(e);
        onToast?.(locale === 'en' ? 'Failed' : '送信に失敗しました');
      } finally {
        setTimeout(() => { btn.disabled = false; }, 2500);
      }
    });
  });
}

export function mountWaitBadge(minutes, locale = 'ja') {
  let el = document.getElementById('guestWaitBadge');
  if (!el) {
    el = document.createElement('div');
    el.id = 'guestWaitBadge';
    el.className = 'guest-wait-badge';
    const host = document.querySelector('.guest-brand-block') || document.querySelector('.guest-header');
    host?.appendChild(el);
  }
  el.textContent = locale === 'en'
    ? `Kitchen ~${minutes} min`
    : `厨房の混雑 約${minutes}分`;
}

export function mountSurveyCard({ orderId, locale = 'ja', onDone }) {
  if (document.getElementById('guestSurvey')) return;
  const card = document.createElement('div');
  card.id = 'guestSurvey';
  card.className = 'guest-survey';
  card.innerHTML = `
    <h3>${locale === 'en' ? 'How was your visit?' : 'ご来店はいかがでしたか？'}</h3>
    <p>${locale === 'en' ? '1 = poor · 5 = great' : '1＝不満 · 5＝大満足'}</p>
    <div class="guest-survey-scores">
      ${[1, 2, 3, 4, 5].map(n => `<button type="button" data-score="${n}">${n}</button>`).join('')}
    </div>
    <textarea id="surveyComment" rows="2" placeholder="${locale === 'en' ? 'Optional comment' : '任意コメント'}"></textarea>
    <button type="button" class="guest-survey-send" id="surveySend" disabled>${locale === 'en' ? 'Send' : '送信'}</button>
  `;
  const main = document.querySelector('.status-main') || document.querySelector('main') || document.body;
  main.appendChild(card);

  let score = 0;
  card.querySelectorAll('[data-score]').forEach(btn => {
    btn.addEventListener('click', () => {
      score = Number(btn.dataset.score);
      card.querySelectorAll('[data-score]').forEach(b => b.classList.toggle('active', b === btn));
      card.querySelector('#surveySend').disabled = !score;
    });
  });
  card.querySelector('#surveySend')?.addEventListener('click', async () => {
    const comment = card.querySelector('#surveyComment')?.value || '';
    const send = card.querySelector('#surveySend');
    send.disabled = true;
    try {
      await submitSurvey({ orderId, score, comment });
      card.innerHTML = `<p class="guest-survey-thanks">${locale === 'en' ? 'Thank you!' : 'ご協力ありがとうございました'}</p>`;
      onDone?.();
    } catch (e) {
      send.disabled = false;
    }
  });
}
