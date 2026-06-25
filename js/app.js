import { MENU_DATA } from './data.js';

export function showToast(msg) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

const App = {
  cart: [],
  selectedCategory: 'all',
  activeAllergens: [],
  searchQuery: '',
  modalItem: null,
  modalQty: 1,
  modalCustomizations: {},
  modalToggles: {},
  tableNumber: null,

  init() {
    this.tableNumber = new URLSearchParams(location.search).get('table') || '1';
    document.querySelectorAll('.table-number').forEach(el => el.textContent = `テーブル ${this.tableNumber}`);
    this.loadCart();
    this.renderMenu();
    this.bindEvents();
    this.updateCartBar();
  },

  loadCart() {
    try {
      const saved = localStorage.getItem('mos_cart');
      if (saved) this.cart = JSON.parse(saved);
    } catch (e) { this.cart = []; }
  },

  saveCart() {
    localStorage.setItem('mos_cart', JSON.stringify(this.cart));
  },

  renderMenu() {
    const container = document.getElementById('menuList');
    if (!container) return;

    const filtered = MENU_DATA.items.filter(item => {
      const catMatch = this.selectedCategory === 'all' || item.category === this.selectedCategory;
      const allergenMatch = this.activeAllergens.length === 0 ||
        !this.activeAllergens.some(a => item.allergens.includes(a));
      const searchMatch = this.searchQuery === '' ||
        item.name.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
        item.description.toLowerCase().includes(this.searchQuery.toLowerCase());
      return catMatch && allergenMatch && searchMatch;
    });

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="empty-state fade-in">
          <div class="emoji">🔍</div>
          <h3>該当するメニューがありません</h3>
          <p>検索条件やアレルギーフィルターを変えてみてください</p>
        </div>`;
      return;
    }

    container.innerHTML = filtered.map(item => this.renderCard(item)).join('');
    container.querySelectorAll('.menu-card').forEach(card => {
      card.addEventListener('click', () => this.openModal(card.dataset.id));
    });
    container.querySelectorAll('.add-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const item = MENU_DATA.items.find(i => i.id === btn.closest('.menu-card').dataset.id);
        if (item && item.customizable.length === 0) {
          this.addToCartDirect(item);
          btn.classList.add('bounce-add');
          setTimeout(() => btn.classList.remove('bounce-add'), 300);
        } else {
          this.openModal(btn.closest('.menu-card').dataset.id);
        }
      });
    });
  },

  renderCard(item) {
    const allergenHTML = item.allergens.map(a => {
      const al = MENU_DATA.allergens.find(al => al.id === a);
      const matched = this.activeAllergens.includes(a);
      return `<span class="allergen-tag ${matched ? 'matched' : ''}">${al ? al.emoji + al.label : a}</span>`;
    }).join('');

    return `
      <div class="menu-card fade-in" data-id="${item.id}">
        <div class="menu-card-emoji">${item.emoji}</div>
        <div class="menu-card-body">
          <div class="menu-card-header">
            <div class="menu-card-name">${item.name}</div>
            ${item.popular ? '<span class="popular-badge">人気</span>' : ''}
          </div>
          <div class="menu-card-desc">${item.description}</div>
          ${allergenHTML ? `<div class="allergen-tags">${allergenHTML}</div>` : ''}
          <div class="menu-card-footer">
            <div class="menu-card-price">¥${item.price.toLocaleString()}<span>(税込)</span></div>
            <button class="add-btn" aria-label="${item.name}を追加">＋</button>
          </div>
        </div>
      </div>`;
  },

  addToCartDirect(item) {
    this.cart.push({ id: Date.now(), itemId: item.id, name: item.name, emoji: item.emoji, price: item.price, qty: 1, customizations: {}, toggles: {}, note: '' });
    this.saveCart();
    this.updateCartBar();
    showToast(`🛒 ${item.name} を追加しました`);
  },

  openModal(itemId) {
    const item = MENU_DATA.items.find(i => i.id === itemId);
    if (!item) return;
    this.modalItem = item;
    this.modalQty = 1;
    this.modalCustomizations = {};
    this.modalToggles = {};
    item.customizable.forEach(opt => {
      if (opt.type === 'select') this.modalCustomizations[opt.id] = opt.default;
      if (opt.type === 'toggle') this.modalToggles[opt.id] = false;
    });
    this.renderModal(item);
    document.getElementById('itemModal').classList.add('open');
    document.body.style.overflow = 'hidden';
  },

  renderModal(item) {
    const allergenHTML = item.allergens.length ? `
      <div class="modal-allergen-list">
        ${item.allergens.map(a => {
          const al = MENU_DATA.allergens.find(al => al.id === a);
          return `<span class="modal-allergen-tag">${al ? al.emoji + ' ' + al.label : a}</span>`;
        }).join('')}
      </div>` : '';

    const customizeHTML = item.customizable.map(opt => {
      if (opt.type === 'select') {
        return `
          <div class="customize-group" data-opt-id="${opt.id}">
            <div class="customize-label">${opt.label}</div>
            <div class="customize-options">
              ${opt.options.map(o => `
                <button class="option-chip ${o === opt.default ? 'selected' : ''}" data-opt="${opt.id}" data-val="${o}">${o}</button>
              `).join('')}
            </div>
          </div>`;
      }
      if (opt.type === 'toggle') {
        return `
          <div class="toggle-option">
            <div>
              <div class="toggle-label">${opt.label}</div>
              ${opt.price ? `<div class="toggle-price">+¥${opt.price}</div>` : ''}
            </div>
            <div class="toggle-switch" data-toggle="${opt.id}"><div class="toggle-knob"></div></div>
          </div>`;
      }
      return '';
    }).join('');

    document.getElementById('itemModal').querySelector('.modal-sheet').innerHTML = `
      <div class="modal-handle"></div>
      <div class="modal-header">
        <span class="modal-item-emoji">${item.emoji}</span>
        <div class="modal-item-name">${item.name}</div>
        <div class="modal-item-desc">${item.description}</div>
        <div class="modal-price" id="modalPrice">¥${item.price.toLocaleString()}</div>
        ${allergenHTML}
      </div>
      ${customizeHTML ? `<div class="modal-divider"></div><div class="modal-customize">${customizeHTML}</div>` : ''}
      <div class="modal-divider"></div>
      <div class="modal-quantity-row">
        <button class="qty-btn minus" id="qtyMinus">−</button>
        <div class="qty-number" id="qtyNum">1</div>
        <button class="qty-btn plus" id="qtyPlus">＋</button>
      </div>
      <div class="modal-note-area">
        <div class="note-label">📝 特別リクエスト（任意）</div>
        <textarea class="note-input" id="itemNote" rows="2" placeholder="アレルギーや特別なご要望があればお知らせください"></textarea>
      </div>
      <button class="modal-add-btn" id="modalAddBtn">
        🛒 カートに追加 <span id="modalAddPrice">¥${item.price.toLocaleString()}</span>
      </button>
    `;
    this.bindModalEvents(item);
  },

  bindModalEvents(item) {
    const modal = document.getElementById('itemModal');
    modal.querySelectorAll('.option-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const optId = chip.dataset.opt;
        this.modalCustomizations[optId] = chip.dataset.val;
        modal.querySelectorAll(`.option-chip[data-opt="${optId}"]`).forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
        this.updateModalPrice(item);
      });
    });
    modal.querySelectorAll('.toggle-switch').forEach(sw => {
      sw.addEventListener('click', () => {
        const toggleId = sw.dataset.toggle;
        this.modalToggles[toggleId] = !this.modalToggles[toggleId];
        sw.classList.toggle('on', this.modalToggles[toggleId]);
        this.updateModalPrice(item);
      });
    });
    document.getElementById('qtyMinus').addEventListener('click', () => {
      if (this.modalQty > 1) { this.modalQty--; document.getElementById('qtyNum').textContent = this.modalQty; this.updateModalPrice(item); }
    });
    document.getElementById('qtyPlus').addEventListener('click', () => {
      this.modalQty++; document.getElementById('qtyNum').textContent = this.modalQty; this.updateModalPrice(item);
    });
    document.getElementById('modalAddBtn').addEventListener('click', () => {
      this.addToCart(item); this.closeModal();
    });
  },

  calcUnitPrice(item) {
    let total = item.price;
    item.customizable.forEach(opt => {
      if (opt.type === 'select') {
        const val = this.modalCustomizations[opt.id] || '';
        if (val.includes('+100円')) total += 100;
        if (val.includes('+200円')) total += 200;
        if (val.includes('+280円')) total += 280;
        if (val.includes('+80円')) total += 80;
        if (val.includes('+50円')) total += 50;
      }
      if (opt.type === 'toggle' && this.modalToggles[opt.id]) total += opt.price || 0;
    });
    return total;
  },

  updateModalPrice(item) {
    const unit = this.calcUnitPrice(item);
    document.getElementById('modalPrice').textContent = `¥${unit.toLocaleString()}`;
    document.getElementById('modalAddPrice').textContent = `¥${(unit * this.modalQty).toLocaleString()}`;
  },

  addToCart(item) {
    const note = document.getElementById('itemNote')?.value || '';
    this.cart.push({
      id: Date.now(), itemId: item.id, name: item.name, emoji: item.emoji,
      price: this.calcUnitPrice(item), qty: this.modalQty,
      customizations: { ...this.modalCustomizations }, toggles: { ...this.modalToggles }, note,
    });
    this.saveCart();
    this.updateCartBar();
    showToast(`🛒 ${item.name} をカートに追加しました`);
  },

  closeModal() {
    document.getElementById('itemModal').classList.remove('open');
    document.body.style.overflow = '';
    this.modalItem = null;
  },

  updateCartBar() {
    const bar = document.getElementById('cartBar');
    if (!bar) return;
    const total = this.cart.reduce((s, e) => s + e.price * e.qty, 0);
    const count = this.cart.reduce((s, e) => s + e.qty, 0);
    if (count === 0) { bar.classList.remove('visible'); return; }
    bar.classList.add('visible');
    bar.querySelector('.cart-count-pill').textContent = `${count}点`;
    bar.querySelector('.cart-bar-total').textContent = `¥${total.toLocaleString()}`;
  },

  bindEvents() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedCategory = btn.dataset.cat;
        this.renderMenu();
      });
    });
    document.querySelectorAll('.allergen-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.allergen;
        if (this.activeAllergens.includes(id)) {
          this.activeAllergens = this.activeAllergens.filter(a => a !== id);
          chip.classList.remove('active');
        } else {
          this.activeAllergens.push(id);
          chip.classList.add('active');
        }
        this.renderMenu();
      });
    });
    const toggleBtn = document.getElementById('allergenToggleBtn');
    const allergenFilters = document.getElementById('allergenFilters');
    if (toggleBtn && allergenFilters) {
      toggleBtn.addEventListener('click', () => {
        allergenFilters.classList.toggle('open');
        toggleBtn.classList.toggle('active');
      });
    }
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      let timer;
      searchInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { this.searchQuery = searchInput.value.trim(); this.renderMenu(); }, 200);
      });
    }
    document.getElementById('itemModal')?.addEventListener('click', e => {
      if (e.target === document.getElementById('itemModal')) this.closeModal();
    });
    document.getElementById('cartBarBtn')?.addEventListener('click', () => {
      location.href = `cart.html?table=${this.tableNumber}`;
    });
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
