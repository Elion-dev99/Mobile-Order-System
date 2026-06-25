/* ===== ORDER STATUS PAGE ===== */
const StatusPage = {
  order: null,
  orderId: null,
  tableNumber: null,
  currentStep: 0,
  steps: [
    { label: '注文を受け付けました', desc: 'ご注文ありがとうございます！', icon: '✓' },
    { label: '調理を開始しました', desc: 'キッチンで丁寧に準備しています', icon: '👨‍🍳' },
    { label: '仕上げ中です', desc: 'もうすぐ完成です！', icon: '⏱' },
    { label: 'お料理が完成しました！', desc: 'スタッフがお席にお持ちします', icon: '🎉' },
  ],
  etaMinutes: 0,
  etaTimer: null,
  stepTimer: null,

  init() {
    const params = new URLSearchParams(location.search);
    this.orderId = params.get('order');
    this.tableNumber = params.get('table') || '1';

    document.querySelectorAll('.table-number').forEach(el => el.textContent = `テーブル ${this.tableNumber}`);

    this.loadOrder();
    this.renderOrderSummary();
    this.startSimulation();
  },

  loadOrder() {
    try {
      const allOrders = JSON.parse(localStorage.getItem('mos_all_orders') || '[]');
      this.order = allOrders.find(o => o.id === this.orderId) || null;
    } catch(e) { this.order = null; }
  },

  renderOrderSummary() {
    const el = document.getElementById('orderSummaryItems');
    if (!el || !this.order) return;

    document.getElementById('orderIdBadge').textContent = this.orderId;
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

  startSimulation() {
    this.etaMinutes = 12 + Math.floor(Math.random() * 6);
    this.updateETA();
    this.setStep(0);

    const etaInterval = setInterval(() => {
      if (this.etaMinutes > 0) {
        this.etaMinutes--;
        this.updateETA();
      }
    }, 60000);

    const stepDelays = [3000, 12000, 22000];
    stepDelays.forEach((delay, i) => {
      setTimeout(() => {
        this.setStep(i + 1);
        if (i === stepDelays.length - 1) {
          clearInterval(etaInterval);
          this.etaMinutes = 0;
          this.updateETA();
          this.showComplete();
        }
      }, delay);
    });
  },

  updateETA() {
    const etaEl = document.getElementById('etaTime');
    if (!etaEl) return;
    if (this.etaMinutes === 0) {
      etaEl.textContent = '完成！';
    } else {
      etaEl.textContent = `約${this.etaMinutes}分`;
    }
  },

  setStep(stepIndex) {
    this.currentStep = stepIndex;
    const timeline = document.getElementById('orderTimeline');
    if (!timeline) return;

    timeline.innerHTML = this.steps.map((step, i) => {
      let dotClass = '';
      let labelClass = '';
      if (i < stepIndex) { dotClass = 'done'; labelClass = 'done'; }
      else if (i === stepIndex) { dotClass = 'active'; labelClass = 'active'; }

      return `
        <div class="timeline-item">
          <div class="timeline-dot ${dotClass}">${i < stepIndex ? '✓' : ''}</div>
          <div class="timeline-label ${labelClass}">${step.label}</div>
          <div class="timeline-desc">${step.desc}</div>
          ${i === stepIndex ? `<div class="timeline-time">${this.getStepTime()}</div>` : ''}
        </div>`;
    }).join('');
  },

  getStepTime() {
    const now = new Date();
    return `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
  },

  showComplete() {
    const hero = document.getElementById('completeHero');
    if (hero) {
      hero.classList.remove('hidden');
      hero.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  },
};

document.addEventListener('DOMContentLoaded', () => StatusPage.init());
