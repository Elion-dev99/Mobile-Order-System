import { db } from './firebase.js';
import {
  getShopId, getMenu, getShop, isItemSoldOut, setTableOrderingLocked, isTableOrderingLocked,
} from './shop.js';
import { isDemoMode } from './demo.js';
import { notifyBillRequested } from './notify.js';
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
    orderingLocked: type === 'bill',
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
  }, () => {
    try {
      const all = JSON.parse(localStorage.getItem('mos_local_requests') || '[]');
      cb(all.filter(r => (r.shopId || shopId) === shopId));
    } catch {
      cb([]);
    }
  });
}

export async function resolveServiceRequest(id, { tableNumber: tableHint } = {}) {
  let tableNumber = tableHint != null ? String(tableHint) : null;
  let shopId = getShopId();

  // Local unlock first so guest/store UI feels instant
  try {
    const all = JSON.parse(localStorage.getItem('mos_local_requests') || '[]');
    const hit = all.find(r => r.id === id);
    if (hit) {
      tableNumber = hit.tableNumber || tableNumber;
      shopId = hit.shopId || shopId;
      const next = all.map(r => r.id === id ? { ...r, status: 'done', resolvedAt: Date.now() } : r);
      localStorage.setItem('mos_local_requests', JSON.stringify(next));
    }
  } catch (_) {}

  if (tableNumber != null) {
    setTableOrderingLocked(tableNumber, false);
  }

  // Fire Firestore update in background; don't block the UI on network RTT
  const write = (async () => {
    try {
      await updateDoc(doc(db, 'serviceRequests', id), { status: 'done', resolvedAt: Date.now() });
    } catch (e) {
      if (!String(id).startsWith('LOCAL-') && !String(id).startsWith('REQ-')) {
        console.warn('resolveServiceRequest firestore', e);
        throw e;
      }
    }
  })();

  // Give the write a short head start, then return for optimistic UI
  await Promise.race([
    write,
    new Promise(resolve => setTimeout(resolve, 120)),
  ]);

  return { id, tableNumber, shopId, pendingWrite: write };
}

/**
 * Show / hide full-screen bill lock: seat number + go to register.
 */
export function showBillLockOverlay({ tableNumber, locale = 'ja' }) {
  let el = document.getElementById('billLockOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'billLockOverlay';
    el.className = 'bill-lock-overlay';
    document.body.appendChild(el);
  }
  const seatLabel = locale === 'en' ? 'Table' : '席';
  const title = locale === 'en' ? 'Bill requested' : 'お会計をリクエストしました';
  const msg = locale === 'en'
    ? 'Please proceed to the register. Ordering is locked for this table.'
    : 'レジへお進みください。この席からの追加注文はできません。';
  el.hidden = false;
  el.innerHTML = `
    <div class="bill-lock-card" role="dialog" aria-live="polite">
      <p class="bill-lock-kicker">${title}</p>
      <p class="bill-lock-seat"><span>${seatLabel}</span><strong>${escapeHtml(String(tableNumber))}</strong></p>
      <p class="bill-lock-msg">${msg}</p>
    </div>`;
  document.body.classList.add('ordering-locked-bill');
}

export function hideBillLockOverlay() {
  const el = document.getElementById('billLockOverlay');
  if (el) el.hidden = true;
  document.body.classList.remove('ordering-locked-bill');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Keep guest table lock in sync with open bill requests.
 * onChange({ locked, request })
 */
export function subscribeTableBillLock(tableNumber, onChange) {
  const shopId = getShopId();
  const table = String(tableNumber);
  return subscribeServiceRequests(shopId, (rows) => {
    const openBill = (rows || []).find(
      r => r.status === 'open' && r.type === 'bill' && String(r.tableNumber) === table
    );
    if (openBill) {
      setTableOrderingLocked(table, true, { requestId: openBill.id });
      onChange?.({ locked: true, request: openBill });
    } else {
      if (isTableOrderingLocked(table)) setTableOrderingLocked(table, false);
      onChange?.({ locked: false, request: null });
    }
  });
}

/** Mount guest action chips: call staff / request bill / quick service */
export function mountGuestServiceActions({ tableNumber, locale = 'ja', onToast, onBillLocked }) {
  if (document.getElementById('guestServiceBar')) return;
  const bar = document.createElement('div');
  bar.id = 'guestServiceBar';
  bar.className = 'guest-service-bar';
  const shop = getShop();
  const staffLabel = locale === 'en' ? 'Call staff' : '店員を呼ぶ';
  const billLabel = locale === 'en' ? 'Check out' : 'お会計';
  const waterLabel = locale === 'en' ? 'Water' : 'お水';
  const towelLabel = locale === 'en' ? 'Towel' : 'おしぼり';
  const cutleryLabel = locale === 'en' ? 'Cutlery' : 'カトラリー';
  const quick = shop.quickServiceEnabled !== false;
  bar.innerHTML = `
    <button type="button" data-svc="staff">${staffLabel}</button>
    ${quick ? `<button type="button" data-svc="water" data-note="${locale === 'en' ? 'Water please' : 'お水ください'}">${waterLabel}</button>` : ''}
    ${quick ? `<button type="button" data-svc="towel" data-note="${locale === 'en' ? 'Towel please' : 'おしぼりください'}">${towelLabel}</button>` : ''}
    ${quick ? `<button type="button" data-svc="cutlery" data-note="${locale === 'en' ? 'Cutlery please' : 'カトラリーください'}">${cutleryLabel}</button>` : ''}
    <button type="button" data-svc="bill">${billLabel}</button>
  `;
  const header = document.querySelector('.guest-header') || document.body;
  header.appendChild(bar);

  const applyBillUi = () => {
    const billBtn = bar.querySelector('[data-svc="bill"]');
    if (billBtn) {
      billBtn.disabled = true;
      billBtn.textContent = locale === 'en' ? 'At register' : 'レジへ';
    }
    showBillLockOverlay({ tableNumber, locale });
    onBillLocked?.();
  };

  if (isTableOrderingLocked(tableNumber)) applyBillUi();

  bar.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.svc === 'bill' && isTableOrderingLocked(tableNumber)) {
        applyBillUi();
        return;
      }
      btn.disabled = true;
      try {
        const svc = btn.dataset.svc;
        const isBill = svc === 'bill';
        const isStaffLike = svc === 'staff' || svc === 'water' || svc === 'towel' || svc === 'cutlery';
        const type = isBill ? 'bill' : 'staff';
        const note = btn.dataset.note || (svc === 'staff' ? '' : svc);
        const req = await createServiceRequest({ type, tableNumber, note });
        if (isBill) {
          setTableOrderingLocked(tableNumber, true, { requestId: req.id });
          const shopNow = getShop();
          notifyBillRequested({
            shopId: getShopId(),
            shopName: shopNow?.name,
            tableNumber,
            requestId: req.id,
          }).catch(() => {});
          applyBillUi();
          onToast?.(
            locale === 'en'
              ? 'Please go to the register'
              : 'レジへお進みください（店舗に通知しました）'
          );
        } else if (isStaffLike) {
          const msg = {
            water: locale === 'en' ? 'Water requested' : 'お水を依頼しました',
            towel: locale === 'en' ? 'Towel requested' : 'おしぼりを依頼しました',
            cutlery: locale === 'en' ? 'Cutlery requested' : 'カトラリーを依頼しました',
            staff: locale === 'en' ? 'Staff called' : '店員を呼び出しました',
          }[svc] || (locale === 'en' ? 'Sent' : '送信しました');
          onToast?.(msg);
          setTimeout(() => { btn.disabled = false; }, 2500);
        }
      } catch (e) {
        console.error(e);
        onToast?.(locale === 'en' ? 'Failed' : '送信に失敗しました');
        btn.disabled = false;
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
