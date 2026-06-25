import { db } from './firebase.js';
import { MENU_DATA } from './data.js';
import {
  collection, onSnapshot, doc, updateDoc, deleteDoc, query, orderBy
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const AdminPage = {
  filter: 'received',
  orders: [],

  init() {
    this.updateClock();
    setInterval(() => this.updateClock(), 1000);
    this.subscribeToOrders();
  },

  updateClock() {
    const el = document.getElementById('adminClock');
    if (el) el.textContent = new Date().toLocaleTimeString('ja-JP');
  },

  subscribeToOrders() {
    const q = query(collection(db, 'orders'), orderBy('timestamp', 'desc'));
    onSnapshot(q, snap => {
      this.orders = snap.docs.map(d => d.data());
      this.render();
    });
  },

  setFilter(filter, btn) {
    this.filter = filter;
    document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    this.render();
  },

  render() {
    const filtered = this.orders.filter(o =>
      this.filter === 'all' || (o.status || 'received') === this.filter
    );

    const pending = this.orders.filter(o => (o.status || 'received') !== 'done').length;
    document.getElementById('pendingCount').textContent = `${pending}件`;

    const container = document.getElementById('adminContent');
    if (!container) return;

    if (filtered.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:60px 20px;color:#718096;">
          <div style="font-size:48px;margin-bottom:12px;">📭</div>
          <div style="font-size:16px;font-weight:700;color:#A0AEC0;">注文はありません</div>
        </div>`;
      return;
    }

    container.innerHTML = filtered.map(order => {
      const status = order.status || 'received';
      const cardClass = status === 'cooking' ? 'cooking' : status === 'done' ? 'done' : '';
      const statusLabel = { received: '📥 受付済み', cooking: '🔥 調理中', done: '✅ 完了' }[status] || '';
      const elapsed = Math.floor((Date.now() - order.timestamp) / 60000);

      const actionBtns = status === 'received' ? `
        <button class="admin-action-btn start" data-id="${order.id}" data-status="cooking">🔥 調理開始</button>
        <button class="admin-action-btn complete" data-id="${order.id}" data-status="done">✅ 完了</button>
      ` : status === 'cooking' ? `
        <button class="admin-action-btn complete" style="flex:1;" data-id="${order.id}" data-status="done">✅ 完了にする</button>
      ` : `<div style="font-size:13px;color:#4A5568;text-align:center;padding:8px;">配膳完了</div>`;

      return `
        <div class="admin-order-card ${cardClass}">
          <div class="admin-order-top">
            <div>
              <div class="admin-order-id">${order.id}</div>
              <div class="admin-order-time">${elapsed === 0 ? 'たった今' : elapsed + '分前'} — ${statusLabel}</div>
            </div>
            <div class="admin-table-badge">テーブル ${order.tableNumber}</div>
          </div>
          <div class="admin-items">
            ${order.items.map(item => {
              const customParts = [];
              const menuItem = MENU_DATA.items.find(i => i.id === item.itemId);
              if (menuItem) {
                menuItem.customizable.forEach(opt => {
                  if (opt.type === 'select' && item.customizations?.[opt.id]) customParts.push(item.customizations[opt.id]);
                  if (opt.type === 'toggle' && item.toggles?.[opt.id]) customParts.push(opt.label + 'あり');
                });
              }
              return `
                <div class="admin-item-row">
                  <span>${item.emoji}</span>
                  <span class="admin-item-qty">×${item.qty}</span>
                  <span>${item.name}</span>
                  ${customParts.length ? `<span class="admin-item-custom">(${customParts.join('/')})</span>` : ''}
                  ${item.note ? `<span class="admin-item-custom">📝${item.note}</span>` : ''}
                </div>`;
            }).join('')}
          </div>
          <div style="font-size:13px;font-weight:700;color:#A0AEC0;margin-bottom:10px;">
            合計: ¥${order.total.toLocaleString()}
          </div>
          <div class="admin-action-row">${actionBtns}</div>
        </div>`;
    }).join('');

    container.querySelectorAll('[data-id][data-status]').forEach(btn => {
      btn.addEventListener('click', () => this.updateStatus(btn.dataset.id, btn.dataset.status));
    });
  },

  async updateStatus(orderId, status) {
    try {
      await updateDoc(doc(db, 'orders', orderId), { status });
    } catch (e) { console.error(e); }
  },

  async clearAll() {
    if (!confirm('すべての注文をFirestoreから削除しますか？')) return;
    for (const order of this.orders) {
      try { await deleteDoc(doc(db, 'orders', order.id)); } catch (e) {}
    }
  },
};

window.AdminPage = AdminPage;
document.addEventListener('DOMContentLoaded', () => AdminPage.init());
