import { TablePin } from './pin.js';
import { loadShop, loadMenu, getShop, getMenu } from './shop.js';
import { ITEM_I18N, CAT_I18N, ALLERGEN_I18N, UI_I18N } from './i18n-menu.js';

export function showToast(msg) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 2200);
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
  locale: 'ja',
  scrollSpyBound: false,

  async init() {
    this.tableNumber = new URLSearchParams(location.search).get('table') || '1';
    await Promise.all([loadShop(), loadMenu()]);
    const shop = getShop();
    document.querySelectorAll('.nav-large-title').forEach(el => { el.textContent = shop.name || 'QuickOrder'; });
    document.title = shop.name || 'Menu';

    try {
      this.locale = localStorage.getItem('mos_locale') || shop.locale || 'ja';
    } catch {
      this.locale = shop.locale || 'ja';
    }

    this.setupLangToggle();
    this.renderPinControl();
    if (!this.ensurePinAccess()) return;
    this.loadCart();
    this.applyLocaleChrome();
    this.renderMenu();
    this.bindEvents();
    this.updateCartBar();
  },

  t(key) {
    return (UI_I18N[this.locale] || UI_I18N.ja)[key] || UI_I18N.ja[key] || key;
  },

  itemText(item) {
    if (this.locale === 'en' && ITEM_I18N[item.id]) {
      return {
        name: ITEM_I18N[item.id].name,
        description: ITEM_I18N[item.id].description,
      };
    }
    return { name: item.name, description: item.description || '' };
  },

  allergenLabel(id) {
    const row = ALLERGEN_I18N[id];
    if (!row) return id;
    return this.locale === 'en' ? row.en : row.ja;
  },

  catLabel(id) {
    const row = CAT_I18N[id];
    if (!row) return id;
    return this.locale === 'en' ? row.en : row.ja;
  },

  setupLangToggle() {
    const wrap = document.getElementById('langToggle');
    if (!wrap) return;
    wrap.classList.remove('hidden');
    wrap.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === this.locale);
      btn.onclick = () => {
        this.locale = btn.dataset.lang;
        try { localStorage.setItem('mos_locale', this.locale); } catch (_) {}
        wrap.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
        this.applyLocaleChrome();
        this.renderMenu();
      };
    });
  },

  applyLocaleChrome() {
    document.documentElement.lang = this.locale === 'en' ? 'en' : 'ja';
    document.querySelectorAll('.table-number').forEach(el => {
      el.textContent = `${this.t('table')} ${this.tableNumber}`;
    });
    const search = document.getElementById('searchInput');
    if (search) search.placeholder = this.t('search');
    const cartLabel = document.querySelector('.cart-bar-left > span:first-child');
    if (cartLabel) cartLabel.textContent = this.t('cart');
    const allergenSummary = document.querySelector('.guest-allergen summary');
    if (allergenSummary) allergenSummary.textContent = this.t('allergen');

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.textContent = this.catLabel(btn.dataset.cat);
    });
    document.querySelectorAll('.allergen-chip').forEach(chip => {
      chip.textContent = this.allergenLabel(chip.dataset.allergen);
    });
    this.renderPinControl();
  },

  renderPinControl() {
    const area = document.getElementById('pinControlArea');
    if (!area) return;
    const protectedState = TablePin.isProtected(this.tableNumber);
    area.innerHTML = `
      <button class="nav-action pin-action" id="pinSetupBtn" type="button">
        ${protectedState ? this.t('pinEdit') : this.t('pinSet')}
      </button>`;
    document.getElementById('pinSetupBtn')?.addEventListener('click', () => this.promptPinSettings());
  },

  ensurePinAccess() {
    if (!TablePin.isProtected(this.tableNumber) || TablePin.isAuthenticated(this.tableNumber)) return true;
    while (true) {
      const pin = prompt(`${this.t('table')}${this.tableNumber} PIN`);
      if (pin === null) {
        const list = document.getElementById('menuList');
        if (list) list.innerHTML = `<div class="locked-state">${this.locale === 'en' ? 'This table is PIN protected.' : 'このテーブルは暗証番号で保護されています。'}</div>`;
        return false;
      }
      if (TablePin.validatePin(this.tableNumber, pin)) {
        TablePin.setAuthenticated(this.tableNumber);
        return true;
      }
      alert(this.locale === 'en' ? 'Incorrect PIN' : '暗証番号が違います');
    }
  },

  promptPinSettings() {
    const protectedState = TablePin.isProtected(this.tableNumber);
    if (protectedState) {
      const currentPin = prompt(this.locale === 'en' ? 'Current PIN' : '現在の暗証番号');
      if (currentPin === null) return;
      if (!TablePin.validatePin(this.tableNumber, currentPin)) {
        alert(this.locale === 'en' ? 'Incorrect PIN' : '暗証番号が違います');
        return;
      }
    }
    const newPin = prompt(this.locale === 'en' ? 'New PIN (blank to clear)' : '新しい暗証番号（空で解除）');
    if (newPin === null) return;
    if (newPin.trim() === '') {
      TablePin.clearPin(this.tableNumber);
      TablePin.clearAuthenticated(this.tableNumber);
      this.renderPinControl();
      return;
    }
    const confirmPin = prompt(this.locale === 'en' ? 'Confirm PIN' : 'もう一度入力');
    if (confirmPin === null) return;
    if (newPin !== confirmPin) {
      alert(this.locale === 'en' ? 'PIN mismatch' : '暗証番号が一致しません');
      return;
    }
    TablePin.setPin(this.tableNumber, newPin);
    TablePin.clearAuthenticated(this.tableNumber);
    this.renderPinControl();
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

  isCustomizable(item) {
    return Array.isArray(item.customizable) && item.customizable.length > 0;
  },

  isPlainLine(entry) {
    const customs = entry.customizations && Object.keys(entry.customizations).length;
    const toggles = entry.toggles && Object.values(entry.toggles).some(Boolean);
    const note = entry.note && String(entry.note).trim();
    return !customs && !toggles && !note;
  },

  qtyForItem(itemId) {
    return this.cart
      .filter(e => e.itemId === itemId)
      .reduce((s, e) => s + (e.qty || 0), 0);
  },

  plainQty(itemId) {
    return this.cart
      .filter(e => e.itemId === itemId && this.isPlainLine(e))
      .reduce((s, e) => s + (e.qty || 0), 0);
  },

  bumpPlain(item, delta) {
    let line = this.cart.find(e => e.itemId === item.id && this.isPlainLine(e));
    if (!line && delta > 0) {
      const text = this.itemText(item);
      line = {
        id: Date.now() + Math.random(),
        itemId: item.id,
        name: text.name,
        emoji: item.emoji,
        price: item.price,
        qty: 0,
        customizations: {},
        toggles: {},
        note: '',
      };
      this.cart.push(line);
    }
    if (!line) return;
    line.qty += delta;
    if (line.qty <= 0) this.cart = this.cart.filter(e => e !== line);
    this.saveCart();
    this.updateCartBar();
    this.renderMenu({ keepScroll: true });
  },

  filteredItems() {
    const MENU_DATA = getMenu();
    return MENU_DATA.items.filter(item => {
      const allergenMatch = this.activeAllergens.length === 0 ||
        !this.activeAllergens.some(a => (item.allergens || []).includes(a));
      const text = this.itemText(item);
      const q = this.searchQuery.toLowerCase();
      const searchMatch = q === '' ||
        text.name.toLowerCase().includes(q) ||
        text.description.toLowerCase().includes(q) ||
        (item.name || '').toLowerCase().includes(q);
      return allergenMatch && searchMatch;
    });
  },

  renderMenu(opts = {}) {
    const container = document.getElementById('menuList');
    if (!container) return;
    const scrollY = opts.keepScroll ? window.scrollY : null;
    const MENU_DATA = getMenu();
    const items = this.filteredItems().sort((a, b) => Number(!!b.popular) - Number(!!a.popular));

    if (items.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>${this.t('emptyTitle')}</h3>
          <p>${this.t('emptyBody')}</p>
        </div>`;
      return;
    }

    const cats = MENU_DATA.categories.filter(c => c.id !== 'all');
    const byCat = cats.map(cat => ({
      ...cat,
      items: items.filter(i => i.category === cat.id),
    })).filter(c => c.items.length);

    const showAll = this.selectedCategory === 'all';
    const sections = showAll
      ? byCat
      : byCat.filter(c => c.id === this.selectedCategory);

    container.innerHTML = sections.map(section => `
      <section class="menu-section" id="cat-${section.id}" data-cat="${section.id}">
        <h2 class="menu-section-title">${this.catLabel(section.id)}</h2>
        <div class="menu-section-list">
          ${section.items.map(item => this.renderCard(item)).join('')}
        </div>
      </section>
    `).join('');

    this.bindCardEvents(container);
    this.setupScrollSpy();
    if (scrollY != null) window.scrollTo(0, scrollY);
  },

  renderCard(item) {
    const text = this.itemText(item);
    const qty = this.qtyForItem(item.id);
    const customizable = this.isCustomizable(item);
    const allergenHTML = (item.allergens || []).map(a => {
      const matched = this.activeAllergens.includes(a);
      return `<span class="allergen-tag ${matched ? 'matched' : ''}">${this.allergenLabel(a)}</span>`;
    }).join('');

    const controls = customizable
      ? `<button class="add-btn" type="button" data-action="customize" aria-label="${text.name}">${qty > 0 ? `${qty}` : '＋'}</button>`
      : qty > 0
        ? `<div class="qty-stepper" data-id="${item.id}">
             <button type="button" data-action="minus" aria-label="minus">−</button>
             <span>${qty}</span>
             <button type="button" data-action="plus" aria-label="plus">＋</button>
           </div>`
        : `<button class="add-btn" type="button" data-action="plus" aria-label="${text.name}">＋</button>`;

    return `
      <article class="menu-card ${qty > 0 ? 'in-cart' : ''}" data-id="${item.id}">
        <div class="menu-card-emoji" aria-hidden="true">${item.emoji || ''}</div>
        <div class="menu-card-body">
          <div class="menu-card-header">
            <div class="menu-card-name">${text.name}</div>
            ${item.popular ? `<span class="popular-badge">${this.t('popular')}</span>` : ''}
          </div>
          <div class="menu-card-desc">${text.description}</div>
          ${allergenHTML ? `<div class="allergen-tags">${allergenHTML}</div>` : ''}
          ${customizable ? `<div class="custom-hint">${this.t('customize')}</div>` : ''}
          <div class="menu-card-footer">
            <div class="menu-card-price">¥${item.price.toLocaleString()}<span>${this.t('tax')}</span></div>
            ${controls}
          </div>
        </div>
      </article>`;
  },

  bindCardEvents(container) {
    container.querySelectorAll('.menu-card').forEach(card => {
      const itemId = card.dataset.id;
      const item = getMenu().items.find(i => i.id === itemId);
      if (!item) return;

      card.addEventListener('click', e => {
        if (e.target.closest('button') || e.target.closest('.qty-stepper')) return;
        this.openModal(itemId);
      });

      card.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const action = btn.dataset.action;
          if (action === 'customize' || (action === 'plus' && this.isCustomizable(item))) {
            this.openModal(itemId);
            return;
          }
          if (action === 'plus') {
            this.bumpPlain(item, 1);
            showToast(`${this.itemText(item).name} ${this.t('added')}`);
          }
          if (action === 'minus') this.bumpPlain(item, -1);
        });
      });
    });
  },

  setupScrollSpy() {
    if (this.scrollSpyBound) return;
    this.scrollSpyBound = true;
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking || this.selectedCategory !== 'all' || this.searchQuery) return;
      ticking = true;
      requestAnimationFrame(() => {
        const sections = [...document.querySelectorAll('.menu-section')];
        const marker = 140;
        let current = sections[0]?.dataset.cat;
        sections.forEach(sec => {
          if (sec.getBoundingClientRect().top <= marker) current = sec.dataset.cat;
        });
        if (current) {
          document.querySelectorAll('.tab-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.cat === current || (current && b.dataset.cat === 'all' && false));
          });
          // highlight matching category tab (not "all")
          document.querySelectorAll('.tab-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.cat === current);
          });
        }
        ticking = false;
      });
    }, { passive: true });
  },

  scrollToCategory(catId) {
    if (catId === 'all') {
      this.selectedCategory = 'all';
      this.renderMenu();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    this.selectedCategory = 'all';
    this.renderMenu();
    requestAnimationFrame(() => {
      const el = document.getElementById(`cat-${catId}`);
      if (el) {
        const top = el.getBoundingClientRect().top + window.scrollY - 120;
        window.scrollTo({ top, behavior: 'smooth' });
      }
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.cat === catId));
    });
  },

  openModal(itemId) {
    const item = getMenu().items.find(i => i.id === itemId);
    if (!item) return;
    this.modalItem = item;
    this.modalQty = 1;
    this.modalCustomizations = {};
    this.modalToggles = {};
    (item.customizable || []).forEach(opt => {
      if (opt.type === 'select') this.modalCustomizations[opt.id] = opt.default;
      if (opt.type === 'toggle') this.modalToggles[opt.id] = false;
    });
    this.renderModal(item);
    document.getElementById('itemModal').classList.add('open');
    document.body.style.overflow = 'hidden';
  },

  renderModal(item) {
    const text = this.itemText(item);
    const allergens = item.allergens || [];
    const allergenHTML = allergens.length ? `
      <div class="modal-allergen-list">
        ${allergens.map(a => `<span class="modal-allergen-tag">${this.allergenLabel(a)}</span>`).join('')}
      </div>` : '';

    const customizeHTML = (item.customizable || []).map(opt => {
      if (opt.type === 'select') {
        return `
          <div class="customize-group" data-opt-id="${opt.id}">
            <div class="customize-label">${opt.label}</div>
            <div class="customize-options">
              ${opt.options.map(o => `
                <button type="button" class="option-chip ${o === opt.default ? 'selected' : ''}" data-opt="${opt.id}" data-val="${o}">${o}</button>
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
        <span class="modal-item-emoji">${item.emoji || ''}</span>
        <div class="modal-item-name">${text.name}</div>
        <div class="modal-item-desc">${text.description}</div>
        <div class="modal-price" id="modalPrice">¥${item.price.toLocaleString()}</div>
        ${allergenHTML}
      </div>
      ${customizeHTML ? `<div class="modal-divider"></div><div class="modal-customize">${customizeHTML}</div>` : ''}
      <div class="modal-divider"></div>
      <div class="modal-quantity-row">
        <button type="button" class="qty-btn minus" id="qtyMinus">−</button>
        <div class="qty-number" id="qtyNum">1</div>
        <button type="button" class="qty-btn plus" id="qtyPlus">＋</button>
      </div>
      <div class="modal-note-area">
        <div class="note-label">${this.t('note')}</div>
        <textarea class="note-input" id="itemNote" rows="2" placeholder="${this.t('notePh')}"></textarea>
      </div>
      <button type="button" class="modal-add-btn" id="modalAddBtn">
        ${this.t('add')} <span id="modalAddPrice">¥${item.price.toLocaleString()}</span>
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
      if (this.modalQty > 1) {
        this.modalQty--;
        document.getElementById('qtyNum').textContent = this.modalQty;
        this.updateModalPrice(item);
      }
    });
    document.getElementById('qtyPlus').addEventListener('click', () => {
      this.modalQty++;
      document.getElementById('qtyNum').textContent = this.modalQty;
      this.updateModalPrice(item);
    });
    document.getElementById('modalAddBtn').addEventListener('click', () => {
      this.addToCart(item);
      this.closeModal();
    });
  },

  calcUnitPrice(item) {
    let total = item.price;
    (item.customizable || []).forEach(opt => {
      if (opt.type === 'select') {
        const val = this.modalCustomizations[opt.id] || '';
        const m = val.match(/\+(\d+)\s*円/);
        if (m) total += Number(m[1]);
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
    const text = this.itemText(item);
    const note = document.getElementById('itemNote')?.value || '';
    this.cart.push({
      id: Date.now() + Math.random(),
      itemId: item.id,
      name: text.name,
      emoji: item.emoji,
      price: this.calcUnitPrice(item),
      qty: this.modalQty,
      customizations: { ...this.modalCustomizations },
      toggles: { ...this.modalToggles },
      note,
    });
    this.saveCart();
    this.updateCartBar();
    this.renderMenu({ keepScroll: true });
    showToast(`${text.name} ${this.t('added')}`);
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
    const pill = bar.querySelector('.cart-count-pill');
    if (pill) pill.textContent = `${count}${this.locale === 'en' ? '' : this.t('points')}`;
    if (pill && this.locale === 'en') pill.textContent = String(count);
    bar.querySelector('.cart-bar-total').textContent = `¥${total.toLocaleString()}`;
    const cartLabel = document.querySelector('.cart-bar-left > span:first-child');
    if (cartLabel) cartLabel.textContent = this.t('cart');
  },

  bindEvents() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.scrollToCategory(btn.dataset.cat);
      });
    });
    document.querySelectorAll('.allergen-chip').forEach(chip => {
      chip.addEventListener('click', e => {
        e.preventDefault();
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
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      let timer;
      searchInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.searchQuery = searchInput.value.trim();
          this.selectedCategory = 'all';
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.cat === 'all'));
          this.renderMenu();
        }, 160);
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
