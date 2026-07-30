import { TablePin } from './pin.js';
import {
  loadShop, loadMenu, getShop, getMenu, getShopId, isItemSoldOut,
  getItemUnitPrice, isSaleActive, getOrderingBlockReason,
} from './shop.js';
import { ITEM_I18N, CAT_I18N, ALLERGEN_I18N, UI_I18N } from './i18n-menu.js';
import { activateDemoFromUrl, cartStorageKey, withDemo, ensureDemoBanner, isDemoMode } from './demo.js';
import { resolveShopId } from './tenant.js';
import { db } from './firebase.js';
import { collection, onSnapshot, query, where, orderBy } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import {
  mountGuestServiceActions, mountWaitBadge, estimateWaitMinutes,
  subscribeTableBillLock, showBillLockOverlay, hideBillLockOverlay,
  recommendUpsells,
} from './guest-features.js';
import { mountGuestOrderHistory } from './order-history.js';
import { placeGuestOrder } from './place-order.js';

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
  menuDelegated: false,
  view: 'menu',
  splitPeople: 1,
  spaCartBound: false,

  async init() {
    activateDemoFromUrl();
    resolveShopId();
    ensureDemoBanner();
    this.tableNumber = new URLSearchParams(location.search).get('table') || (isDemoMode() ? 'デモ' : '1');
    await Promise.all([loadShop(), loadMenu()]);
    const shop = getShop();
    if (shop.isOpen === false && !isDemoMode()) {
      document.body.classList.add('shop-closed');
    }
    const brand = isDemoMode() ? `${shop.name || 'QuickOrder'}（デモ）` : (shop.name || 'QuickOrder');
    document.querySelectorAll('.nav-large-title').forEach(el => { el.textContent = brand; });
    document.title = isDemoMode()
      ? `${shop.name || 'QuickOrder'} | テストモード`
      : `${shop.name || 'Menu'} | ${getShopId()}`;

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
    this.ensureMenuDelegation();
    this.renderMenu();
    this.bindEvents();
    this.bindSpaCart();
    this.updateCartBar();
    mountGuestServiceActions({
      tableNumber: this.tableNumber,
      locale: this.locale,
      onToast: showToast,
      onBillLocked: () => this.applyOrderingLock(),
    });
    this.subscribeBillLock();
    this.mountOrderGateBanner();
    this.subscribeKitchenLoad();
    // Defer history so first paint / taps stay snappy
    const defer = window.requestIdleCallback || ((fn) => setTimeout(fn, 600));
    defer(() => this.loadGuestHistory());
    document.getElementById('guestHistoryRefresh')?.addEventListener('click', () => this.loadGuestHistory());

    const params = new URLSearchParams(location.search);
    const initialView = params.get('view') || (location.hash === '#cart' ? 'cart' : 'menu');
    if (initialView === 'cart') this.showView('cart', { replace: true });
    window.addEventListener('popstate', () => {
      const v = new URLSearchParams(location.search).get('view') || 'menu';
      this.showView(v === 'cart' ? 'cart' : 'menu', { skipHistory: true });
    });
  },

  loadGuestHistory() {
    const host = document.getElementById('guestHistoryList');
    if (!host) return;
    mountGuestOrderHistory({
      host,
      tableNumber: this.tableNumber,
      locale: this.locale,
    }).catch(() => {
      host.innerHTML = `<p class="oh-empty">${this.locale === 'en' ? 'Could not load history' : '履歴を読めませんでした'}</p>`;
    });
  },

  subscribeBillLock() {
    subscribeTableBillLock(this.tableNumber, ({ locked }) => {
      if (locked) {
        showBillLockOverlay({ tableNumber: this.tableNumber, locale: this.locale });
        this.applyOrderingLock();
      } else {
        hideBillLockOverlay();
        document.body.classList.remove('ordering-locked-bill');
        this.mountOrderGateBanner();
        document.querySelectorAll('#menuList .menu-card').forEach(card => {
          this.updateCard(card.dataset.id);
        });
        this.updateCartBar();
        if (this.view === 'cart') this.renderSpaCart();
      }
    });
  },

  orderingBlocked() {
    return getOrderingBlockReason(this.tableNumber, getShop());
  },

  applyOrderingLock() {
    document.body.classList.add('ordering-locked-bill');
    this.closeModal();
    this.mountOrderGateBanner();
    // Patch visible cards only — do not rebuild the whole menu
    document.querySelectorAll('#menuList .menu-card').forEach(card => {
      this.updateCard(card.dataset.id);
    });
    this.updateCartBar();
    if (this.view === 'cart') this.renderSpaCart();
  },

  mountOrderGateBanner() {
    let el = document.getElementById('orderGateBanner');
    const block = this.orderingBlocked();
    if (block.reason === 'bill') {
      if (el) el.hidden = true;
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'orderGateBanner';
      el.className = 'order-gate-banner';
      const host = document.querySelector('.guest-header') || document.body;
      host.appendChild(el);
    }
    if (block.blocked) {
      el.hidden = false;
      el.dataset.reason = block.reason || '';
      el.textContent = block.label;
    } else if (getShop().lastOrderEnabled && getShop().lastOrderTime) {
      el.hidden = false;
      el.dataset.reason = 'last_order_info';
      el.textContent = this.locale === 'en'
        ? `Last order ${getShop().lastOrderTime}`
        : `ラストオーダー ${getShop().lastOrderTime}`;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  },

  canOrder() {
    return !this.orderingBlocked().blocked;
  },

  subscribeKitchenLoad() {
    if (isDemoMode()) {
      mountWaitBadge(5, this.locale);
      return;
    }
    try {
      const q = query(
        collection(db, 'orders'),
        where('shopId', '==', getShopId()),
        orderBy('timestamp', 'desc')
      );
      onSnapshot(q, snap => {
        const orders = snap.docs.map(d => d.data());
        mountWaitBadge(estimateWaitMinutes(orders), this.locale);
      }, () => {
        mountWaitBadge(8, this.locale);
      });
    } catch (_) {
      mountWaitBadge(8, this.locale);
    }
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
    if (isDemoMode()) {
      area.innerHTML = '';
      return;
    }
    const protectedState = TablePin.isProtected(this.tableNumber);
    area.innerHTML = `
      <button class="nav-action pin-action" id="pinSetupBtn" type="button">
        ${protectedState ? this.t('pinEdit') : this.t('pinSet')}
      </button>`;
    document.getElementById('pinSetupBtn')?.addEventListener('click', () => this.promptPinSettings());
  },

  ensurePinAccess() {
    if (isDemoMode()) return true;
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
      const saved = localStorage.getItem(cartStorageKey());
      if (saved) this.cart = JSON.parse(saved);
    } catch (e) { this.cart = []; }
  },

  saveCart() {
    localStorage.setItem(cartStorageKey(), JSON.stringify(this.cart));
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
    if (delta > 0 && !this.canOrder()) {
      showToast(this.orderingBlocked().label);
      return;
    }
    let line = this.cart.find(e => e.itemId === item.id && this.isPlainLine(e));
    if (!line && delta > 0) {
      const text = this.itemText(item);
      line = {
        id: Date.now() + Math.random(),
        itemId: item.id,
        name: text.name,
        emoji: item.emoji,
        price: getItemUnitPrice(item),
        qty: 0,
        customizations: {},
        toggles: {},
        note: '',
        saleApplied: isSaleActive(item),
      };
      this.cart.push(line);
    }
    if (!line) return;
    line.qty += delta;
    if (line.qty <= 0) this.cart = this.cart.filter(e => e !== line);
    this.saveCart();
    this.updateCartBar();
    this.updateCard(item.id);
  },

  /** Replace a single card in-place (SPA realtime — no full menu rebuild). */
  updateCard(itemId) {
    const id = String(itemId);
    const item = getMenu().items.find(i => i.id === id);
    if (!item) return;
    const card = [...document.querySelectorAll('#menuList .menu-card')]
      .find(el => el.dataset.id === id);
    if (!card) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = this.renderCard(item).trim();
    const next = tmp.firstElementChild;
    if (next) card.replaceWith(next);
  },

  ensureMenuDelegation() {
    if (this.menuDelegated) return;
    const container = document.getElementById('menuList');
    if (!container) return;
    this.menuDelegated = true;

    container.addEventListener('click', (e) => {
      const card = e.target.closest('.menu-card');
      if (!card || !container.contains(card)) return;
      const itemId = card.dataset.id;
      const item = getMenu().items.find(i => i.id === itemId);
      if (!item) return;

      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (isItemSoldOut(itemId)) return;
        const action = actionBtn.dataset.action;
        if (action === 'minus') {
          this.bumpPlain(item, -1);
          return;
        }
        if (!this.canOrder()) {
          showToast(this.orderingBlocked().label);
          return;
        }
        if (action === 'customize' || (action === 'plus' && this.isCustomizable(item))) {
          this.openModal(itemId);
          return;
        }
        if (action === 'plus') {
          this.bumpPlain(item, 1);
          showToast(`${this.itemText(item).name} ${this.t('added')}`);
        }
        return;
      }

      if (e.target.closest('.qty-stepper')) return;
      if (isItemSoldOut(itemId) || !this.canOrder()) return;
      this.openModal(itemId);
    });
  },

  filteredItems() {
    const MENU_DATA = getMenu();
    return MENU_DATA.items.filter(item => {
      if (isItemSoldOut(item.id)) return true; // still show, marked sold out
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

    this.ensureMenuDelegation();
    this.setupScrollSpy();
    if (scrollY != null) window.scrollTo(0, scrollY);
  },

  renderCard(item) {
    const text = this.itemText(item);
    const soldOut = isItemSoldOut(item.id);
    const blocked = !this.canOrder();
    const qty = this.qtyForItem(item.id);
    const customizable = this.isCustomizable(item);
    const onSale = isSaleActive(item);
    const unit = getItemUnitPrice(item);
    const allergenHTML = (item.allergens || []).map(a => {
      const matched = this.activeAllergens.includes(a);
      return `<span class="allergen-tag ${matched ? 'matched' : ''}">${this.allergenLabel(a)}</span>`;
    }).join('');

    const controls = soldOut || blocked
      ? `<span class="soldout-pill">${soldOut
        ? (this.locale === 'en' ? 'Sold out' : '品切れ')
        : (this.locale === 'en' ? 'Unavailable' : '注文不可')}</span>`
      : customizable
      ? `<button class="add-btn" type="button" data-action="customize" aria-label="${text.name}">${qty > 0 ? `${qty}` : '＋'}</button>`
      : qty > 0
        ? `<div class="qty-stepper" data-id="${item.id}">
             <button type="button" data-action="minus" aria-label="minus">−</button>
             <span>${qty}</span>
             <button type="button" data-action="plus" aria-label="plus">＋</button>
           </div>`
        : `<button class="add-btn" type="button" data-action="plus" aria-label="${text.name}">＋</button>`;

    const priceHtml = onSale
      ? `<div class="menu-card-price is-sale">
           <span class="sale-badge">${this.locale === 'en' ? 'Sale' : 'セール'}</span>
           <s>¥${Number(item.price).toLocaleString()}</s>
           <strong>¥${unit.toLocaleString()}</strong><span>${this.t('tax')}</span>
         </div>`
      : `<div class="menu-card-price">¥${unit.toLocaleString()}<span>${this.t('tax')}</span></div>`;

    return `
      <article class="menu-card ${qty > 0 ? 'in-cart' : ''} ${soldOut || blocked ? 'sold-out' : ''} ${onSale ? 'on-sale' : ''}" data-id="${item.id}">
        <div class="menu-card-emoji" aria-hidden="true">${item.emoji || ''}</div>
        <div class="menu-card-body">
          <div class="menu-card-header">
            <div class="menu-card-name">${text.name}</div>
            ${item.popular ? `<span class="popular-badge">${this.t('popular')}</span>` : ''}
          </div>
          <div class="menu-card-desc">${text.description}</div>
          ${allergenHTML ? `<div class="allergen-tags">${allergenHTML}</div>` : ''}
          ${customizable && !soldOut && !blocked ? `<div class="custom-hint">${this.t('customize')}</div>` : ''}
          <div class="menu-card-footer">
            ${priceHtml}
            ${controls}
          </div>
        </div>
      </article>`;
  },

  bindCardEvents() {
    // Deprecated: clicks are handled once via ensureMenuDelegation()
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
    if (!this.canOrder()) {
      showToast(this.orderingBlocked().label);
      return;
    }
    const item = getMenu().items.find(i => i.id === itemId);
    if (!item || isItemSoldOut(itemId)) return;
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
    const onSale = isSaleActive(item);
    const base = getItemUnitPrice(item);
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

    const priceLine = onSale
      ? `<div class="modal-price is-sale" id="modalPrice"><s>¥${Number(item.price).toLocaleString()}</s> ¥${base.toLocaleString()}</div>`
      : `<div class="modal-price" id="modalPrice">¥${base.toLocaleString()}</div>`;

    document.getElementById('itemModal').querySelector('.modal-sheet').innerHTML = `
      <div class="modal-handle"></div>
      <div class="modal-header">
        <span class="modal-item-emoji">${item.emoji || ''}</span>
        <div class="modal-item-name">${text.name}</div>
        <div class="modal-item-desc">${text.description}</div>
        ${priceLine}
        ${onSale ? `<p class="modal-sale-note">${this.locale === 'en' ? 'Timed sale' : '時間帯セール中'} ${item.saleFrom || ''}–${item.saleUntil || ''}</p>` : ''}
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
        ${this.t('add')} <span id="modalAddPrice">¥${base.toLocaleString()}</span>
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
    let total = getItemUnitPrice(item);
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
    const priceEl = document.getElementById('modalPrice');
    if (priceEl) {
      if (isSaleActive(item)) {
        priceEl.innerHTML = `<s>¥${Number(item.price).toLocaleString()}</s> ¥${unit.toLocaleString()}`;
      } else {
        priceEl.textContent = `¥${unit.toLocaleString()}`;
      }
    }
    const addEl = document.getElementById('modalAddPrice');
    if (addEl) addEl.textContent = `¥${(unit * this.modalQty).toLocaleString()}`;
  },

  addToCart(item) {
    if (!this.canOrder()) {
      showToast(this.orderingBlocked().label);
      return;
    }
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
      saleApplied: isSaleActive(item),
    });
    this.saveCart();
    this.updateCartBar();
    this.updateCard(item.id);
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
      this.showView('cart');
    });
  },

  bindSpaCart() {
    if (this.spaCartBound) return;
    this.spaCartBound = true;
    document.getElementById('spaCartBack')?.addEventListener('click', () => this.showView('menu'));
    document.getElementById('splitMinus')?.addEventListener('click', () => {
      if (this.splitPeople > 1) { this.splitPeople--; this.renderSpaCartSummary(); }
    });
    document.getElementById('splitPlus')?.addEventListener('click', () => {
      this.splitPeople++; this.renderSpaCartSummary();
    });
    document.getElementById('placeOrderBtn')?.addEventListener('click', () => this.placeOrderFromSpa());
    document.getElementById('cartItems')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.cart-qty-btn');
      if (!btn) return;
      this.updateSpaCartQty(btn.dataset.id, btn.dataset.action);
    });
  },

  showView(view, { skipHistory = false, replace = false } = {}) {
    const next = view === 'cart' ? 'cart' : 'menu';
    this.view = next;
    const menuView = document.getElementById('spaMenuView');
    const cartView = document.getElementById('spaCartView');
    const header = document.querySelector('.guest-header');
    const allergen = document.querySelector('.guest-allergen');
    const cartBar = document.getElementById('cartBar');

    if (next === 'cart') {
      if (menuView) menuView.hidden = true;
      if (header) header.hidden = true;
      if (allergen) allergen.hidden = true;
      if (cartBar) cartBar.classList.remove('visible');
      if (cartView) cartView.hidden = false;
      document.body.classList.add('spa-cart-open');
      this.renderSpaCart();
      window.scrollTo(0, 0);
    } else {
      if (cartView) cartView.hidden = true;
      if (menuView) menuView.hidden = false;
      if (header) header.hidden = false;
      if (allergen) allergen.hidden = false;
      document.body.classList.remove('spa-cart-open');
      this.updateCartBar();
    }

    if (!skipHistory) {
      const url = new URL(location.href);
      if (next === 'cart') url.searchParams.set('view', 'cart');
      else url.searchParams.delete('view');
      const method = replace ? 'replaceState' : 'pushState';
      history[method]({ view: next }, '', `${url.pathname}${url.search}${url.hash}`);
    }
  },

  renderSpaCart() {
    const container = document.getElementById('cartItems');
    if (!container) return;
    if (!this.cart.length) {
      container.innerHTML = `
        <div class="no-items-cart fade-in">
          <span class="emoji">🛒</span>
          <h3>カートが空です</h3>
          <p>メニューからお好みの料理を<br>選んでカートに追加してください</p>
          <button type="button" class="menu-link-btn" id="spaEmptyBack">← メニューに戻る</button>
        </div>`;
      container.querySelector('#spaEmptyBack')?.addEventListener('click', () => this.showView('menu'));
      this.renderSpaCartSummary();
      this.updateSpaPlaceBtn();
      return;
    }

    const MENU_DATA = getMenu();
    container.innerHTML = '<div class="cart-items-group">' + this.cart.map(entry => {
      const customLines = [];
      const item = MENU_DATA.items.find(i => i.id === entry.itemId);
      if (item) {
        (item.customizable || []).forEach(opt => {
          if (opt.type === 'select' && entry.customizations?.[opt.id]) customLines.push(`${opt.label}: ${entry.customizations[opt.id]}`);
          if (opt.type === 'toggle' && entry.toggles?.[opt.id]) customLines.push(`${opt.label}: あり`);
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
                <button class="cart-qty-btn ${entry.qty === 1 ? 'remove' : ''}" type="button" data-action="${entry.qty === 1 ? 'remove' : 'minus'}" data-id="${entry.id}">
                  ${entry.qty === 1 ? '🗑' : '−'}
                </button>
                <div class="cart-qty-num">${entry.qty}</div>
                <button class="cart-qty-btn" type="button" data-action="plus" data-id="${entry.id}">＋</button>
              </div>
            </div>
          </div>
        </div>`;
    }).join('') + '</div>';

    this.renderSpaUpsells(container);
    this.renderSpaCartSummary();
    this.updateSpaPlaceBtn();
  },

  renderSpaUpsells(container) {
    let wrap = document.getElementById('cartUpsells');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'cartUpsells';
      wrap.className = 'cart-upsells';
      container.after(wrap);
    }
    const recs = recommendUpsells(this.cart, 3).filter(i => !isItemSoldOut(i.id));
    if (!recs.length || !this.cart.length) {
      wrap.innerHTML = '';
      return;
    }
    wrap.innerHTML = `
      <h3>あわせていかがですか</h3>
      <div class="cart-upsell-list">
        ${recs.map(item => `
          <button type="button" class="cart-upsell-item" data-upsell="${item.id}">
            <span>${item.emoji || ''} ${item.name}</span>
            <strong>¥${getItemUnitPrice(item).toLocaleString()}</strong>
          </button>
        `).join('')}
      </div>`;
    wrap.querySelectorAll('[data-upsell]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!this.canOrder()) {
          showToast(this.orderingBlocked().label);
          return;
        }
        const item = getMenu().items.find(i => i.id === btn.dataset.upsell);
        if (!item || isItemSoldOut(item.id)) return;
        this.cart.push({
          id: Date.now() + Math.random(),
          itemId: item.id,
          name: item.name,
          emoji: item.emoji,
          price: getItemUnitPrice(item),
          qty: 1,
          customizations: {},
          toggles: {},
          note: '',
        });
        this.saveCart();
        this.updateCard(item.id);
        this.updateCartBar();
        this.renderSpaCart();
        showToast(`${item.name} を追加しました`);
      });
    });
  },

  updateSpaCartQty(entryId, action) {
    if (action === 'plus' && !this.canOrder()) {
      showToast(this.orderingBlocked().label);
      return;
    }
    const idx = this.cart.findIndex(e => String(e.id) === String(entryId));
    if (idx === -1) return;
    const itemId = this.cart[idx].itemId;
    if (action === 'plus') this.cart[idx].qty++;
    else if (action === 'minus') {
      this.cart[idx].qty--;
      if (this.cart[idx].qty <= 0) this.cart.splice(idx, 1);
    } else if (action === 'remove') this.cart.splice(idx, 1);
    this.saveCart();
    this.updateCard(itemId);
    this.updateCartBar();
    this.renderSpaCart();
  },

  renderSpaCartSummary() {
    const subtotal = this.cart.reduce((s, e) => s + e.price * e.qty, 0);
    const tax = Math.floor(subtotal * 0.1);
    const total = subtotal + tax;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('subtotalAmount', `¥${subtotal.toLocaleString()}`);
    set('taxAmount', `¥${tax.toLocaleString()}`);
    set('totalAmount', `¥${total.toLocaleString()}`);
    set('splitNum', String(this.splitPeople));
    if (this.splitPeople > 1) {
      set('splitAmount', `お一人様 ¥${Math.ceil(total / this.splitPeople).toLocaleString()}`);
      document.getElementById('splitResult')?.classList.remove('hidden');
    } else {
      document.getElementById('splitResult')?.classList.add('hidden');
    }
  },

  updateSpaPlaceBtn() {
    const btn = document.getElementById('placeOrderBtn');
    if (!btn) return;
    const block = this.orderingBlocked();
    if (block.blocked) {
      btn.disabled = true;
      btn.textContent = block.reason === 'bill'
        ? 'お会計中（レジへお進みください）'
        : block.label;
      return;
    }
    btn.disabled = this.cart.length === 0;
    btn.textContent = '注文を確定する';
  },

  async placeOrderFromSpa() {
    if (!this.cart.length) return;
    if (!this.canOrder()) {
      showToast(this.orderingBlocked().label);
      this.updateSpaPlaceBtn();
      return;
    }
    const btn = document.getElementById('placeOrderBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = isDemoMode() ? 'テスト注文を送信中...' : '注文を送信中...';
    }
    const result = await placeGuestOrder({
      cart: this.cart,
      tableNumber: this.tableNumber,
    });
    this.cart = [];
    this.saveCart();
    this.updateCartBar();
    if (result.queued) {
      showToast(`通信障害のため注文を端末に一時保存しました（保留${result.pending}件）`);
    }
    location.href = result.statusUrl;
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());

// Light tick: banners only — never rebuild the whole menu
setInterval(() => {
  try {
    if (typeof App.mountOrderGateBanner === 'function') {
      App.mountOrderGateBanner();
    }
  } catch (_) {}
}, 60_000);