import { db } from './firebase.js';
import { TablePin } from './pin.js';
import { doc, onSnapshot, collection, query, where, orderBy } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { activateDemoFromUrl, withDemo, ensureDemoBanner, isDemoMode } from './demo.js';
import { resolveShopId } from './tenant.js';
import { loadShop, getShopId } from './shop.js';
import { mountSurveyCard, estimateWaitMinutes } from './guest-features.js';
import { mountGuestOrderHistory } from './order-history.js';
import { playReadyChime } from './guest-extras.js';

const StatusPage = {
  order: null,
  orderId: null,
  tableNumber: null,
  etaMinutes: 0,
  unsubscribe: null,
  demoTimers: [],
  _prevStatus: null,
  _etaTimer: null,

  steps: [
    { label: '注文を受け付けました', desc: 'ご注文ありがとうございます！' },
    { label: '調理を開始しました', desc: 'キッチンで丁寧に準備しています' },
    { label: '仕上げ中です', desc: 'もうすぐ完成です！' },
    { label: 'お料理が完成しました！', desc: 'スタッフがお席にお持ちします' },
  ],

  statusToStep: { received: 0, cooking: 1, finishing: 2, done: 3 },

  async init() {
    activateDemoFromUrl();
    resolveShopId();
    ensureDemoBanner();
    await loadShop();
    const params = new URLSearchParams(location.search);
    this.orderId = params.get('order');
    this.tableNumber = params.get('table') || (isDemoMode() ? 'デモ' : '1');
    document.querySelectorAll('.table-number').forEach(el => el.textContent = `テーブル ${this.tableNumber}`);
    document.getElementById('orderIdBadge').textContent = this.orderId;
    document.getElementById('addMoreLink').href = withDemo(`index.html?table=${encodeURIComponent(this.tableNumber)}`);
    document.querySelector('.status-action-bar a.primary')?.setAttribute(
      'href',
      withDemo(`index.html?table=${encodeURIComponent(this.tableNumber)}`)
    );
    if (isDemoMode()) document.title = '注文状況 | テストモード';

    if (!this.ensurePinAccess()) return;
    if (!this.orderId) return;

    if (isDemoMode()) this.runDemoOrder();
    else this.subscribeToOrder();
    this.startETA();
    this.loadTableHistory();
  },

  loadTableHistory() {
    const host = document.getElementById('statusTableHistory');
    if (!host) return;
    mountGuestOrderHistory({
      host,
      tableNumber: this.tableNumber,
      locale: 'ja',
    }).catch(() => {
      host.innerHTML = '<p class="oh-empty">履歴を読めませんでした</p>';
    });
  },

  ensurePinAccess() {
    if (isDemoMode()) return true;
    if (!TablePin.isProtected(this.tableNumber) || TablePin.isAuthenticated(this.tableNumber)) return true;
    while (true) {
      const pin = prompt(`テーブル${this.tableNumber}の暗証番号を入力してください`);
      if (pin === null) {
        const badge = document.getElementById('orderIdBadge');
        if (badge) badge.textContent = '保護された注文';
        return false;
      }
      if (TablePin.validatePin(this.tableNumber, pin)) {
        TablePin.setAuthenticated(this.tableNumber);
        return true;
      }
      alert('暗証番号が違います。もう一度入力してください。');
    }
  },

  runDemoOrder() {
    let order = null;
    try {
      order = JSON.parse(sessionStorage.getItem('mos_demo_order_' + this.orderId) || 'null');
    } catch (_) {}
    if (!order) {
      order = {
        id: this.orderId,
        tableNumber: this.tableNumber,
        items: [],
        total: 0,
        status: 'received',
        demo: true,
        timestamp: Date.now(),
      };
    }
    this.order = order;
    this.renderOrderSummary();
    this.updateTimeline(order.status || 'received');

    this.demoTimers.push(setTimeout(() => this.applyDemoStatus('cooking'), 2500));
    this.demoTimers.push(setTimeout(() => this.applyDemoStatus('finishing'), 5500));
    this.demoTimers.push(setTimeout(() => this.applyDemoStatus('done'), 8500));
  },

  applyDemoStatus(status) {
    if (!this.order) return;
    this.order.status = status;
    try {
      sessionStorage.setItem('mos_demo_order_' + this.orderId, JSON.stringify(this.order));
    } catch (_) {}
    this.updateTimeline(status);
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
    document.getElementById('orderTotalDisplay').textContent = `¥${(this.order.total || 0).toLocaleString()}`;
    el.innerHTML = (this.order.items || []).map(item => `
      <div class="status-order-item">
        <div class="status-item-emoji">${item.emoji}</div>
        <div class="status-item-info">
          <div class="status-item-name">${item.name}</div>
          <div class="status-item-qty">× ${item.qty}</div>
        </div>
        <div class="status-item-price">¥${(item.price * item.qty).toLocaleString()}</div>
      </div>`).join('') || '<div style="color:var(--g-muted);font-size:14px;">明細なし</div>';
  },

  updateTimeline(status) {
    const stepIndex = this.statusToStep[status] ?? 0;
    const timeline = document.getElementById('orderTimeline');
    if (!timeline) return;

    if (this._prevStatus && this._prevStatus !== 'done' && status === 'done') {
      playReadyChime();
      try {
        if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
      } catch (_) {}
    }
    this._prevStatus = status;

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
      mountSurveyCard({ orderId: this.orderId, locale: 'ja' });
    } else if (status === 'finishing') {
      this.etaMinutes = Math.min(this.etaMinutes || 5, 4);
      this.updateETA();
    } else if (status === 'cooking') {
      this.etaMinutes = Math.min(this.etaMinutes || 10, 8);
      this.updateETA();
    }
  },

  startETA() {
    if (isDemoMode()) {
      this.etaMinutes = 3;
      this.updateETA();
      this._etaTimer = setInterval(() => {
        if (this.etaMinutes > 0) { this.etaMinutes--; this.updateETA(); }
        else clearInterval(this._etaTimer);
      }, 2000);
      return;
    }
    // Seed from kitchen load, then tick down
    this.etaMinutes = 10;
    this.updateETA();
    try {
      const q = query(
        collection(db, 'orders'),
        where('shopId', '==', getShopId()),
        orderBy('timestamp', 'desc')
      );
      onSnapshot(q, (snap) => {
        if (this.order?.status === 'done') return;
        const orders = snap.docs.map((d) => d.data());
        const est = estimateWaitMinutes(orders);
        // Don't jump ETA up aggressively once ticking
        if (!this._etaSeeded) {
          this.etaMinutes = est;
          this._etaSeeded = true;
        } else {
          this.etaMinutes = Math.max(1, Math.min(est, this.etaMinutes));
        }
        this.updateETA();
      }, () => {
        this.updateETA();
      });
    } catch (_) {
      this.updateETA();
    }
    this._etaTimer = setInterval(() => {
      if (this.order?.status === 'done') {
        clearInterval(this._etaTimer);
        return;
      }
      if (this.etaMinutes > 1) {
        this.etaMinutes--;
        this.updateETA();
      }
    }, 60000);
  },

  updateETA() {
    const el = document.getElementById('etaTime') || document.getElementById('etaMinutes');
    if (!el) return;
    if (this.order?.status === 'done' || this.etaMinutes <= 0) {
      el.textContent = '完成！';
      return;
    }
    el.textContent = `約${this.etaMinutes}分`;
  },
};

document.addEventListener('DOMContentLoaded', () => StatusPage.init());
