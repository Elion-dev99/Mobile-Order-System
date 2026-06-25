import { db } from './firebase.js';
import { doc, onSnapshot, getDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const StatusPage = {
  order: null,
  orderId: null,
  tableNumber: null,
  etaMinutes: 0,
  unsubscribe: null,

  steps: [
    { label: '注文を受け付けました', desc: 'ご注文ありがとうございます！' },
    { label: '調理を開始しました', desc: 'キッチンで丁寧に準備しています' },
    { label: '仕上げ中です', desc: 'もうすぐ完成です！' },
    { label: 'お料理が完成しました！', desc: 'スタッフがお席にお持ちします' },
  ],

  statusToStep: { received: 0, cooking: 1, finishing: 2, done: 3 },

  init() {
    const params = new URLSearchParams(location.search);
    this.orderId = params.get('order');
    this.tableNumber = params.get('table') || '1';
    document.querySelectorAll('.table-number').forEach(el => el.textContent = `テーブル ${this.tableNumber}`);
    document.getElementById('orderIdBadge').textContent = this.orderId;
    document.getElementById('addMoreLink').href = `index.html?table=${this.tableNumber}`;

    if (!this.orderId) return;
    this.subscribeToOrder();
    this.startETA();
  },

  subscribeToOrder() {
    const orderRef = doc(db, 'orders', this.orderId);
    this.unsubscribe = onSnapshot(orderRef, snap => {
      if (!snap.exists()) return;
      this.order = snap.data();
      this.renderOrderSummary();
      this.updateTimeline(this.order.status || 'received');
    });
  },

  renderOrderSummary() {
    const el = document.getElementById('orderSummaryItems');
    if (!el || !this.order) return;
    document.getElementById('orderTotalDisplay').textContent = `¥${this.order.total.toLocaleString()}`;
    el.innerHTML = this.order.items.map(item => `
      <div class="status-order-item">
        <div class="status-item-emoji">${item.emoji}</div>
        <div class="status-item-info">
          <div class="status-item-name">${item.name}</div>
          <div class="status-item-qty">× ${item.qty}</div>
        </div>
        <div class="status-item-price">¥${(item.price * item.qty).toLocaleString()}</div>
      </div>`).join('');
  },

  updateTimeline(status) {
    const stepIndex = this.statusToStep[status] ?? 0;
    const timeline = document.getElementById('orderTimeline');
    if (!timeline) return;

    timeline.innerHTML = this.steps.map((step, i) => {
      let dotClass = '', labelClass = '';
      if (i < stepIndex) { dotClass = 'done'; labelClass = 'done'; }
      else if (i === stepIndex) { dotClass = 'active'; labelClass = 'active'; }
      const now = new Date();
      const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
      return `
        <div class="timeline-item">
          <div class="timeline-dot ${dotClass}">${i < stepIndex ? '✓' : ''}</div>
          <div class="timeline-label ${labelClass}">${step.label}</div>
          <div class="timeline-desc">${step.desc}</div>
          ${i === stepIndex ? `<div class="timeline-time">${timeStr}</div>` : ''}
        </div>`;
    }).join('');

    if (status === 'done') {
      document.getElementById('completeHero')?.classList.remove('hidden');
      this.etaMinutes = 0;
      this.updateETA();
      if (this.unsubscribe) this.unsubscribe();
    }
  },

  startETA() {
    this.etaMinutes = 12 + Math.floor(Math.random() * 6);
    this.updateETA();
    const interval = setInterval(() => {
      if (this.etaMinutes > 0) { this.etaMinutes--; this.updateETA(); }
      else clearInterval(interval);
    }, 60000);
  },

  updateETA() {
    const el = document.getElementById('etaTime');
    if (!el) return;
    el.textContent = this.etaMinutes === 0 ? '完成！' : `約${this.etaMinutes}分`;
  },
};

document.addEventListener('DOMContentLoaded', () => StatusPage.init());
