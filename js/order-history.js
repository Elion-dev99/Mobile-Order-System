/**
 * Shared order history helpers for guest + store UIs.
 */

import { db } from './firebase.js';
import { getShopId } from './shop.js';
import { isDemoMode } from './demo.js';
import {
  collection, getDocs, query, where, orderBy, limit
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

export const ORDER_STATUS_LABEL = {
  received: '受付',
  cooking: '調理中',
  finishing: '仕上げ',
  done: '完了',
};

export function formatOrderTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('ja-JP', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function orderLineHtml(item) {
  const name = escapeHtml(item.name || '');
  const emoji = escapeHtml(item.emoji || '');
  const qty = Number(item.qty) || 1;
  const line = (Number(item.price) || 0) * qty;
  const customs = [];
  if (item.customizations && typeof item.customizations === 'object') {
    Object.entries(item.customizations).forEach(([, v]) => {
      if (v) customs.push(String(v));
    });
  }
  if (item.toggles && typeof item.toggles === 'object') {
    Object.entries(item.toggles).forEach(([k, v]) => {
      if (v) customs.push(k);
    });
  }
  if (item.note) customs.push(String(item.note));
  const custom = customs.length
    ? `<div class="oh-line-meta">${escapeHtml(customs.join(' · '))}</div>`
    : '';
  return `
    <div class="oh-line">
      <span class="oh-line-name">${emoji} ${name} ×${qty}</span>
      <span class="oh-line-price">¥${line.toLocaleString()}</span>
      ${custom}
    </div>`;
}

export function orderDetailHtml(order, { showTable = false, reorder = false, locale = 'ja' } = {}) {
  const status = ORDER_STATUS_LABEL[order.status] || order.status || '受付';
  const items = (order.items || []).map(orderLineHtml).join('') || '<p class="oh-empty">明細なし</p>';
  const table = showTable ? `<span class="oh-pill">席 ${escapeHtml(String(order.tableNumber ?? ''))}</span>` : '';
  const party = order.partySize
    ? `<span class="oh-pill">${escapeHtml(String(order.partySize))}${locale === 'en' ? ' guests' : '名'}</span>`
    : '';
  const reorderBtn = reorder
    ? `<button type="button" class="oh-reorder" data-oh-reorder="${escapeHtml(order.id || '')}">${locale === 'en' ? 'Order again' : 'もう一度注文'}</button>`
    : '';
  return `
    <article class="oh-card" data-order-id="${escapeHtml(order.id || '')}">
      <button type="button" class="oh-card-head" data-oh-toggle>
        <div class="oh-card-title">
          <strong>${escapeHtml(order.id || 'ORDER')}</strong>
          <span class="oh-pill">${escapeHtml(status)}</span>
          ${table}
          ${party}
        </div>
        <div class="oh-card-meta">
          <span>${formatOrderTime(order.timestamp)}</span>
          <strong>¥${Number(order.total || 0).toLocaleString()}</strong>
        </div>
      </button>
      <div class="oh-card-body" hidden>
        <div class="oh-lines">${items}</div>
        <div class="oh-totals">
          <div><span>小計</span><span>¥${Number(order.subtotal || 0).toLocaleString()}</span></div>
          <div><span>税</span><span>¥${Number(order.tax || 0).toLocaleString()}</span></div>
          <div class="oh-total"><span>合計</span><span>¥${Number(order.total || 0).toLocaleString()}</span></div>
        </div>
        ${reorderBtn}
      </div>
    </article>`;
}

export function bindOrderHistoryToggles(root) {
  root?.querySelectorAll('[data-oh-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = btn.parentElement?.querySelector('.oh-card-body');
      if (!body) return;
      body.hidden = !body.hidden;
      btn.classList.toggle('is-open', !body.hidden);
    });
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readDemoOrders() {
  const out = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key || !key.startsWith('mos_demo_order_')) continue;
      const order = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (order) out.push(order);
    }
  } catch (_) {}
  return out.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

/** Load recent orders for one table (guest). */
export async function loadTableOrderHistory(tableNumber, { max = 20 } = {}) {
  const shopId = getShopId();
  const table = String(tableNumber);
  if (isDemoMode()) {
    return readDemoOrders().filter(o => String(o.tableNumber) === table).slice(0, max);
  }
  try {
    const q = query(
      collection(db, 'orders'),
      where('shopId', '==', shopId),
      where('tableNumber', '==', table),
      orderBy('timestamp', 'desc'),
      limit(max)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    // Missing composite index → client filter fallback
    try {
      const q = query(
        collection(db, 'orders'),
        where('shopId', '==', shopId),
        orderBy('timestamp', 'desc'),
        limit(80)
      );
      const snap = await getDocs(q);
      return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(o => String(o.tableNumber) === table)
        .slice(0, max);
    } catch (err) {
      console.warn('loadTableOrderHistory', err);
      return [];
    }
  }
}

/** Mount expandable history block into a host element. */
export async function mountGuestOrderHistory({ host, tableNumber, locale = 'ja', onReorder } = {}) {
  if (!host) return;
  host.innerHTML = `<p class="oh-loading">${locale === 'en' ? 'Loading…' : '履歴を読み込み中…'}</p>`;
  const orders = await loadTableOrderHistory(tableNumber);
  if (!orders.length) {
    host.innerHTML = `<p class="oh-empty">${locale === 'en' ? 'No orders yet' : 'まだ注文履歴はありません'}</p>`;
    return orders;
  }
  host.innerHTML = `
    <div class="oh-list">
      ${orders.map(o => orderDetailHtml(o, { reorder: !!onReorder, locale })).join('')}
    </div>`;
  bindOrderHistoryToggles(host);
  if (onReorder) {
    host.querySelectorAll('[data-oh-reorder]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.ohReorder;
        const order = orders.find((o) => o.id === id);
        if (order) onReorder(order);
      });
    });
  }
  return orders;
}
