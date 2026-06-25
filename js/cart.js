/* ===== CART PAGE LOGIC ===== */
const CartPage = {
  cart: [],
  splitPeople: 1,
  tableNumber: null,

  init() {
    this.tableNumber = new URLSearchParams(location.search).get('table') || '1';
    document.querySelectorAll('.table-number').forEach(el => el.textContent = `テーブル ${this.tableNumber}`);
    this.loadCart();
    this.render();
    this.bindEvents();
  },

  loadCart() {
    try {
      const saved = localStorage.getItem('mos_cart');
      if (saved) this.cart = JSON.parse(saved);
    } catch(e) { this.cart = []; }
  },

  saveCart() {
    localStorage.setItem('mos_cart', JSON.stringify(this.cart));
  },

  render() {
    this.renderCartItems();
    this.renderReorder();
    this.renderSummary();
    this.updatePlaceBtn();
  },

  renderCartItems() {
    const container = document.getElementById('cartItems');
    if (!container) return;

    if (this.cart.length === 0) {
      container.innerHTML = `
        <div class="no-items-cart fade-in">
          <span class="emoji">🛒</span>
          <h3>カートが空です</h3>
          <p>メニューからお好みの料理を<br>選んでカートに追加してください</p>
          <a href="index.html?table=${this.tableNumber}" class="menu-link-btn">← メニューに戻る</a>
        </div>`;
      return;
    }

    container.innerHTML = this.cart.map(entry => {
      const customLines = [];
      const item = MENU_DATA.items.find(i => i.id === entry.itemId);
      if (item) {
        item.customizable.forEach(opt => {
          if (opt.type === 'select' && entry.customizations[opt.id]) {
            customLines.push(`${opt.label}: ${entry.customizations[opt.id]}`);
          }
          if (opt.type === 'toggle' && entry.toggles[opt.id]) {
            customLines.push(`${opt.label}: あり`);
          }
        });
      }

      return `
        <div class="cart-item fade-in" data-entry-id="${entry.id}">
          <div class="cart-item-emoji">${entry.emoji}</div>
          <div class="cart-item-info">
            <div class="cart-item-name">${entry.name}</div>
            ${customLines.length ? `<div class="cart-item-customizations">${customLines.join(' / ')}</div>` : ''}
            ${entry.note ? `<div class="cart-item-note">📝 ${entry.note}</div>` : ''}
            <div class="cart-item-bottom">
              <div class="cart-item-price">¥${(entry.price * entry.qty).toLocaleString()}</div>
              <div class="cart-qty-controls">
                <button class="cart-qty-btn ${entry.qty === 1 ? 'remove' : ''}" data-action="${entry.qty === 1 ? 'remove' : 'minus'}" data-id="${entry.id}">
                  ${entry.qty === 1 ? '🗑' : '−'}
                </button>
                <div class="cart-qty-num">${entry.qty}</div>
                <button class="cart-qty-btn" data-action="plus" data-id="${entry.id}">＋</button>
              </div>
            </div>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.cart-qty-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id);
        const action = btn.dataset.action;
        this.updateQty(id, action);
      });
    });
  },

  updateQty(entryId, action) {
    const idx = this.cart.findIndex(e => e.id === entryId);
    if (idx === -1) return;
    if (action === 'plus') {
      this.cart[idx].qty++;
    } else if (action === 'minus') {
      this.cart[idx].qty--;
      if (this.cart[idx].qty <= 0) this.cart.splice(idx, 1);
    } else if (action === 'remove') {
      this.cart.splice(idx, 1);
    }
    this.saveCart();
    this.render();
  },

  renderReorder() {
    const container = document.getElementById('reorderSection');
    if (!container) return;
    try {
      const history = JSON.parse(localStorage.getItem('mos_order_history') || '[]');
      if (!history.length) { container.classList.add('hidden'); return; }
      const recent = history[history.length - 1];
      if (!recent || !recent.items) { container.classList.add('hidden'); return; }

      container.classList.remove('hidden');
      const listEl = document.getElementById('reorderList');
      listEl.innerHTML = recent.items.slice(0, 3).map(item => `
        <div class="reorder-card fade-in">
          <div style="font-size:28px;flex-shrink:0;">${item.emoji}</div>
          <div class="reorder-info">
            <div class="reorder-name">${item.name}</div>
            <div class="reorder-detail">¥${item.price.toLocaleString()} × ${item.qty}</div>
          </div>
          <button class="reorder-btn-add" data-item-id="${item.itemId}">再注文</button>
        </div>`).join('');

      listEl.querySelectorAll('.reorder-btn-add').forEach(btn => {
        btn.addEventListener('click', () => {
          const sourceItem = recent.items.find(i => i.itemId === btn.dataset.itemId);
          if (sourceItem) {
            const newEntry = { ...sourceItem, id: Date.now() };
            this.cart.push(newEntry);
            this.saveCart();
            this.render();
            showToast(`🔄 ${sourceItem.name} を再注文しました`);
          }
        });
      });
    } catch(e) {
      container.classList.add('hidden');
    }
  },

  renderSummary() {
    const subtotal = this.cart.reduce((s, e) => s + e.price * e.qty, 0);
    const tax = Math.floor(subtotal * 0.1);
    const total = subtotal + tax;

    const el = id => document.getElementById(id);
    if (el('subtotalAmount')) el('subtotalAmount').textContent = `¥${subtotal.toLocaleString()}`;
    if (el('taxAmount')) el('taxAmount').textContent = `¥${tax.toLocaleString()}`;
    if (el('totalAmount')) el('totalAmount').textContent = `¥${total.toLocaleString()}`;

    const perPerson = this.splitPeople > 1 ? Math.ceil(total / this.splitPeople) : null;
    if (el('splitAmount')) {
      if (perPerson) {
        el('splitAmount').textContent = `お一人様 ¥${perPerson.toLocaleString()}`;
        document.getElementById('splitResult')?.classList.remove('hidden');
      } else {
        document.getElementById('splitResult')?.classList.add('hidden');
      }
    }
    if (el('splitNum')) el('splitNum').textContent = this.splitPeople;
  },

  updatePlaceBtn() {
    const btn = document.getElementById('placeOrderBtn');
    if (!btn) return;
    btn.disabled = this.cart.length === 0;
  },

  bindEvents() {
    document.getElementById('backBtn')?.addEventListener('click', () => {
      history.back();
    });

    document.getElementById('splitMinus')?.addEventListener('click', () => {
      if (this.splitPeople > 1) { this.splitPeople--; this.renderSummary(); }
    });
    document.getElementById('splitPlus')?.addEventListener('click', () => {
      this.splitPeople++;
      this.renderSummary();
    });

    document.getElementById('placeOrderBtn')?.addEventListener('click', () => {
      this.placeOrder();
    });
  },

  placeOrder() {
    if (this.cart.length === 0) return;
    const btn = document.getElementById('placeOrderBtn');
    btn.textContent = '⏳ 注文を送信中...';
    btn.disabled = true;

    setTimeout(() => {
      const orderId = 'ORD-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      const subtotal = this.cart.reduce((s, e) => s + e.price * e.qty, 0);
      const tax = Math.floor(subtotal * 0.1);
      const order = {
        id: orderId,
        tableNumber: this.tableNumber,
        items: this.cart,
        subtotal,
        tax,
        total: subtotal + tax,
        timestamp: Date.now(),
        status: 'received',
      };

      const allOrders = JSON.parse(localStorage.getItem('mos_all_orders') || '[]');
      allOrders.push(order);
      localStorage.setItem('mos_all_orders', JSON.stringify(allOrders));

      const history = JSON.parse(localStorage.getItem('mos_order_history') || '[]');
      history.push(order);
      if (history.length > 10) history.shift();
      localStorage.setItem('mos_order_history', JSON.stringify(history));

      localStorage.removeItem('mos_cart');
      location.href = `status.html?order=${orderId}&table=${this.tableNumber}`;
    }, 1200);
  },
};

function showToast(msg) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

document.addEventListener('DOMContentLoaded', () => CartPage.init());
