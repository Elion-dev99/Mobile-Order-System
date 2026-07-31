import { TablePin } from './pin.js';
import {
  loadShop, loadMenu, getShop, getMenu, getShopId, isItemSoldOut,
  getItemUnitPrice, isSaleActive, getOrderingBlockReason, shopCanUse,
} from './shop.js';
import { ITEM_I18N, CAT_I18N, ALLERGEN_I18N, UI_I18N } from './i18n-menu.js';
import { activateDemoFromUrl, cartStorageKey, ensureDemoBanner, isDemoMode } from './demo.js';
import { resolveShopId } from './tenant.js';
import { db } from './firebase.js';
import { collection, onSnapshot, query, where, orderBy } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import {
  mountGuestServiceActions, mountWaitBadge, estimateWaitMinutes,
  subscribeTableBillLock, showBillLockOverlay, hideBillLockOverlay,
  recommendUpsells,
} from './guest-features.js';
import { mountGuestOrderHistory, loadTableOrderHistory } from './order-history.js';
import { placeGuestOrder, computeOrderTotals } from './place-order.js';
import { loadMaintenance, subscribeMaintenance, mountMaintenanceBanner } from './maintenance.js';
import { validateCoupon, setAppliedCoupon, getAppliedCoupon, discountForCoupon } from './coupons.js';
import {
  applyBrandTheme, mountQuickFilters, mountPartySizePrompt, mountShareTableLink,
  loadFavorites, toggleFavorite, isFavorite, itemHasTag, confirmAlcoholAge,
  getPartySize, tagBadgesHtml, suggestSetCombos,
} from './guest-extras.js';
import {
  curateTonightPicks, curatorTitle, tablePulseCopy, flyToCart, hourBucket,
} from './guest-smart.js';
import { CHANNELS, getSelectedChannel, setSelectedChannel, channelLabel } from './channels.js';
import { listPaymentMethods } from './payments.js';
import {
  getLocalMember, upsertMember, setLocalMember,
} from './loyalty.js';
import { createReservation, createWaitlistEntry, estimateWaitlistMinutes } from './reservations.js';
import { startOfflineSync } from './offline-sync.js';
import { applyLangToDocument, ensureA11yBasics, normalizeLang, t as tUi } from './i18n-ui.js';
import { captureGrowthAttribution, mountGrowthWatermark } from './growth.js';

export function showToast(msg) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  // Collapse rapid toasts so + spam does not pile up work
  container.querySelectorAll('.toast').forEach((el, i) => { if (i < 2) el.remove(); });
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 1600);
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
  tipPercent: 0,
  splitPeople: 1,
  spaCartBound: false,
  quickFilters: new Set(),
  favorites: new Set(),
  channel: 'dine_in',
  paymentMethod: 'pay_at_register',
  pointsRedeem: 0,
  member: null,
  waitMinutes: 0,
  lastTableOrder: null,
  cartStep: 1,

  async init() {
    activateDemoFromUrl();
    resolveShopId();
    captureGrowthAttribution();
    ensureDemoBanner();
    ensureA11yBasics();
    startOfflineSync();
    this.tableNumber = new URLSearchParams(location.search).get('table') || (isDemoMode() ? 'デモ' : '1');
    const urlChannel = new URLSearchParams(location.search).get('channel');
    this.channel = setSelectedChannel(urlChannel || getSelectedChannel());
    await Promise.all([loadShop(), loadMenu(), loadMaintenance().catch(() => {})]);
    subscribeMaintenance();
    mountMaintenanceBanner();
    const shop = getShop();
    applyBrandTheme(shop);
    this.member = getLocalMember(getShopId());
    this.favorites = loadFavorites();
    if (shop.isOpen === false && !isDemoMode()) {
      document.body.classList.add('shop-closed');
    }
    const brand = isDemoMode() ? `${shop.name || 'QuickOrder'}（デモ）` : (shop.name || 'QuickOrder');
    document.querySelectorAll('.nav-large-title').forEach(el => { el.textContent = brand; });
    document.title = isDemoMode()
      ? `${shop.name || 'QuickOrder'} | テストモード`
      : `${shop.name || 'Menu'} | ${getShopId()}`;

    try {
      this.locale = normalizeLang(localStorage.getItem('mos_locale') || shop.locale || 'ja');
    } catch {
      this.locale = normalizeLang(shop.locale || 'ja');
    }

    this.setupLangToggle();
    this.renderPinControl();
    if (!this.ensurePinAccess()) return;
    this.loadCart();
    this.applyLocaleChrome();
    applyLangToDocument(this.locale);
    this.ensureMenuDelegation();
    this.mountGuestExtras();
    this.mountReserveBar();
    this.mountTonightRail();
    this.refreshTablePulse();
    this.bindCartSteps();
    this.renderMenu();
    this.bindEvents();
    this.bindSpaCart();
    this.bindEnterpriseCheckout();
    this.renderChannelPaymentUi();
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
    this.primeLastOrder();
    mountGrowthWatermark({ locale: this.locale });
    // Defer history so first paint / taps stay snappy
    const defer = window.requestIdleCallback || ((fn) => setTimeout(fn, 600));
    defer(() => this.loadGuestHistory());
    document.getElementById('guestHistoryRefresh')?.addEventListener('click', () => this.loadGuestHistory());
    document.getElementById('tablePulseReorder')?.addEventListener('click', () => {
      if (this.lastTableOrder) this.reorderFromHistory(this.lastTableOrder);
    });

    const params = new URLSearchParams(location.search);
    const initialView = params.get('view') || (location.hash === '#cart' ? 'cart' : 'menu');
    if (initialView === 'cart') this.showView('cart', { replace: true });
    window.addEventListener('popstate', () => {
      const v = new URLSearchParams(location.search).get('view') || 'menu';
      this.showView(v === 'cart' ? 'cart' : 'menu', { skipHistory: true });
    });
  },

  mountGuestExtras() {
    const shop = getShop();
    mountShareTableLink({
      tableNumber: this.tableNumber,
      locale: this.locale,
      onToast: showToast,
    });
    mountQuickFilters({
      locale: this.locale,
      active: this.quickFilters,
      onChange: (next) => {
        this.quickFilters = next;
        this.mountGuestExtras();
        this.renderMenu();
        this.mountTonightRail();
        this.refreshTablePulse();
      },
    });
    mountPartySizePrompt({
      locale: this.locale,
      required: !!shop.partySizeRequired,
      onDone: (n) => {
        if (n > 0) {
          this.splitPeople = n;
          const splitNum = document.getElementById('splitNum');
          if (splitNum) splitNum.textContent = String(n);
          showToast(this.locale === 'en' ? `${n} guests` : `${n}名様`);
          this.mountTonightRail();
          this.refreshTablePulse();
        }
      },
    });
  },

  loadGuestHistory() {
    const host = document.getElementById('guestHistoryList');
    if (!host) return;
    mountGuestOrderHistory({
      host,
      tableNumber: this.tableNumber,
      locale: this.locale,
      onReorder: (order) => this.reorderFromHistory(order),
    }).then((orders) => {
      if (Array.isArray(orders) && orders.length) {
        this.lastTableOrder = orders.find((o) => (o.items || []).length) || orders[0];
        this.refreshTablePulse();
      }
    }).catch(() => {
      host.innerHTML = `<p class="oh-empty">${this.locale === 'en' ? 'Could not load history' : '履歴を読めませんでした'}</p>`;
    });
  },

  reorderFromHistory(order) {
    if (!this.canOrder()) {
      showToast(this.orderingBlocked().label);
      return;
    }
    const items = order?.items || [];
    if (!items.length) return;
    for (const line of items) {
      if (isItemSoldOut(line.itemId)) continue;
      const menuItem = getMenu().items.find((i) => i.id === line.itemId);
      if (menuItem && itemHasTag(menuItem, 'alcohol') && getShop().ageGateEnabled !== false) {
        if (!confirmAlcoholAge(this.locale)) continue;
      }
      this.cart.push({
        id: Date.now() + Math.random(),
        itemId: line.itemId,
        name: line.name,
        emoji: line.emoji,
        price: line.price,
        qty: line.qty || 1,
        customizations: { ...(line.customizations || {}) },
        toggles: { ...(line.toggles || {}) },
        note: line.note || '',
        saleApplied: !!line.saleApplied,
      });
    }
    this.saveCart();
    this.updateCartBar();
    this.renderMenu();
    this.mountTonightRail();
    this.primeLastOrder();
    showToast(this.t('reorder'));
    this.showView('cart');
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
          this.patchCardControls(card.dataset.id);
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
    document.querySelectorAll('#menuList .menu-card').forEach(card => {
      this.patchCardControls(card.dataset.id);
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
      this.waitMinutes = 5;
      mountWaitBadge(5, this.locale);
      this.refreshTablePulse();
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
        this.waitMinutes = estimateWaitMinutes(orders);
        mountWaitBadge(this.waitMinutes, this.locale);
        this.refreshTablePulse();
      }, () => {
        this.waitMinutes = 8;
        mountWaitBadge(8, this.locale);
        this.refreshTablePulse();
      });
    } catch (_) {
      this.waitMinutes = 8;
      mountWaitBadge(8, this.locale);
      this.refreshTablePulse();
    }
  },

  async primeLastOrder() {
    try {
      const orders = await loadTableOrderHistory(this.tableNumber, { max: 3 });
      this.lastTableOrder = orders.find((o) => (o.items || []).length) || null;
      this.refreshTablePulse();
    } catch (_) {
      this.lastTableOrder = null;
    }
  },

  mountTonightRail() {
    const rail = document.getElementById('tonightRail');
    const track = document.getElementById('tonightRailTrack');
    const title = document.getElementById('tonightRailTitle');
    const sub = document.getElementById('tonightRailSub');
    if (!rail || !track) return;
    const picks = curateTonightPicks({
      cart: this.cart,
      favorites: this.favorites,
      partySize: getPartySize() || 0,
      limit: 6,
    });
    if (title) title.textContent = curatorTitle(this.locale, hourBucket());
    if (sub) {
      sub.textContent = this.locale === 'en'
        ? 'Matched to time, party size, and your cart'
        : '時間帯・人数・カート内容に合わせて選びました';
    }
    if (!picks.length) {
      rail.hidden = true;
      track.innerHTML = '';
      return;
    }
    rail.hidden = false;
    track.innerHTML = picks.map((item) => {
      const text = this.itemText(item);
      const unit = getItemUnitPrice(item);
      const blocked = !this.canOrder() || isItemSoldOut(item.id);
      return `
        <button type="button" class="tonight-card ${item.popular ? 'is-popular' : ''}" data-tonight-id="${item.id}" ${blocked ? 'disabled' : ''} role="listitem">
          <span class="tonight-emoji" aria-hidden="true">${item.emoji || ''}</span>
          <span class="tonight-name">${text.name}</span>
          <span class="tonight-price">¥${unit.toLocaleString()}</span>
          ${item.popular ? `<span class="tonight-badge">${this.locale === 'en' ? 'Hot' : '人気'}</span>` : ''}
        </button>`;
    }).join('');
    if (!this._tonightBound) {
      this._tonightBound = true;
      track.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tonight-id]');
        if (!btn || btn.disabled) return;
        const item = getMenu().items.find((i) => i.id === btn.dataset.tonightId);
        if (!item) return;
        if (this.isCustomizable(item)) {
          this.openModal(item.id);
          return;
        }
        flyToCart(btn.querySelector('.tonight-emoji') || btn);
        this.modalItem = item;
        this.modalQty = 1;
        this.modalCustomizations = {};
        this.modalToggles = {};
        this.addToCart(item);
        this.mountTonightRail();
      });
    }
  },

  refreshTablePulse() {
    const host = document.getElementById('tablePulse');
    if (!host) return;
    host.hidden = false;
    const copy = tablePulseCopy({
      waitMin: this.waitMinutes,
      partySize: getPartySize() || 0,
      channel: this.channel,
      locale: this.locale,
    });
    const waitEl = document.getElementById('tablePulseWait');
    const chEl = document.getElementById('tablePulseChannel');
    const partyEl = document.getElementById('tablePulseParty');
    const reorder = document.getElementById('tablePulseReorder');
    if (waitEl) waitEl.textContent = copy.wait;
    if (chEl) chEl.textContent = copy.channelLabel;
    if (partyEl) {
      if (copy.party) {
        partyEl.hidden = false;
        partyEl.textContent = copy.party;
      } else {
        partyEl.hidden = true;
      }
    }
    if (reorder) {
      const has = !!(this.lastTableOrder?.items?.length) && this.canOrder();
      reorder.hidden = !has;
      reorder.textContent = this.locale === 'en' ? 'Order again' : '前回と同じ';
    }
  },

  bindCartSteps() {
    if (this._cartStepsBound) return;
    this._cartStepsBound = true;
    document.getElementById('cartSteps')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cart-step]');
      if (!btn) return;
      this.setCartStep(Number(btn.dataset.cartStep) || 1);
    });
    document.getElementById('cartStepNext')?.addEventListener('click', () => {
      if (this.cartStep < 3) this.setCartStep(this.cartStep + 1);
    });
  },

  setCartStep(step) {
    this.cartStep = Math.max(1, Math.min(3, Number(step) || 1));
    document.querySelectorAll('[data-cart-step]').forEach((el) => {
      el.classList.toggle('is-active', Number(el.dataset.cartStep) === this.cartStep);
      el.classList.toggle('is-done', Number(el.dataset.cartStep) < this.cartStep);
    });
    document.querySelectorAll('[data-cart-panel]').forEach((panel) => {
      panel.hidden = Number(panel.dataset.cartPanel) !== this.cartStep;
    });
    const next = document.getElementById('cartStepNext');
    const place = document.getElementById('placeOrderBtn');
    if (next && place) {
      const onLast = this.cartStep >= 3;
      next.hidden = onLast;
      place.hidden = !onLast;
      if (!onLast) {
        next.textContent = this.cartStep === 1
          ? (this.locale === 'en' ? 'Continue to pickup' : '受け取りへ')
          : (this.locale === 'en' ? 'Continue to pay' : 'お会計へ');
      }
    }
    this.updateSpaPlaceBtn();
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
    // multiLang is Growth+ (and requires active trial / subscription)
    if (!shopCanUse('multiLang')) {
      wrap.classList.add('hidden');
      this.locale = 'ja';
      return;
    }
    wrap.classList.remove('hidden');
    wrap.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === this.locale);
      btn.onclick = () => {
        if (btn.dataset.lang !== 'ja' && !shopCanUse('multiLang')) {
          showToast('多言語メニューは Growth 以上の機能です');
          return;
        }
        this.locale = normalizeLang(btn.dataset.lang);
        try { localStorage.setItem('mos_locale', this.locale); } catch (_) {}
        wrap.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
        this.applyLocaleChrome();
        applyLangToDocument(this.locale);
        this.renderMenu();
      };
    });
  },

  applyLocaleChrome() {
    applyLangToDocument(this.locale);
    document.querySelectorAll('.table-number').forEach(el => {
      el.textContent = `${this.t('table')} ${this.tableNumber}`;
    });
    const search = document.getElementById('searchInput');
    if (search) search.placeholder = this.t('search') || tUi('search', this.locale);
    const cartLabel = document.querySelector('.cart-bar-left > span:first-child');
    if (cartLabel) cartLabel.textContent = this.t('cart') || tUi('cart', this.locale);
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
    // Paint first, persist next frame — keeps taps realtime on mobile
    this.patchCardControls(item.id);
    this.updateCartBar();
    this.scheduleSaveCart();
    if (delta > 0) {
      const card = this.findCard(item.id);
      flyToCart(card?.querySelector('.menu-card-emoji') || card);
      this.mountTonightRail();
      this.refreshTablePulse();
    } else if (delta < 0) {
      this.mountTonightRail();
    }
  },

  scheduleSaveCart() {
    if (this._saveCartRaf) return;
    this._saveCartRaf = requestAnimationFrame(() => {
      this._saveCartRaf = 0;
      this.saveCart();
    });
  },

  findCard(itemId) {
    const id = String(itemId);
    return [...document.querySelectorAll('#menuList .menu-card')]
      .find(el => el.dataset.id === id) || null;
  },

  /** Update qty controls only — never rebuild the whole card (avoids animation jank). */
  patchCardControls(itemId) {
    const id = String(itemId);
    const item = getMenu().items.find(i => i.id === id);
    const card = this.findCard(id);
    if (!item || !card) return;

    const soldOut = isItemSoldOut(id);
    const blocked = !this.canOrder();
    const qty = this.qtyForItem(id);
    const customizable = this.isCustomizable(item);
    const text = this.itemText(item);
    const footer = card.querySelector('.menu-card-footer');
    if (!footer) {
      this.updateCard(id);
      return;
    }

    card.classList.toggle('in-cart', qty > 0);
    card.classList.toggle('sold-out', soldOut || blocked);

    let controls = footer.querySelector('.add-btn, .qty-stepper, .soldout-pill');
    const html = soldOut || blocked
      ? `<span class="soldout-pill">${soldOut
        ? (this.locale === 'en' ? 'Sold out' : '品切れ')
        : (this.locale === 'en' ? 'Unavailable' : '注文不可')}</span>`
      : customizable
        ? `<button class="add-btn" type="button" data-action="customize" aria-label="${text.name}">${qty > 0 ? `${qty}` : this.t('choose')}</button>`
        : qty > 0
          ? `<div class="qty-stepper" data-id="${item.id}">
               <button type="button" data-action="minus" aria-label="minus">−</button>
               <span>${qty}</span>
               <button type="button" data-action="plus" aria-label="plus">＋</button>
             </div>`
          : `<button class="add-btn" type="button" data-action="plus" aria-label="${text.name}">＋</button>`;

    if (controls) {
      const wrap = document.createElement('div');
      wrap.innerHTML = html.trim();
      const next = wrap.firstElementChild;
      controls.replaceWith(next);
    } else {
      footer.insertAdjacentHTML('beforeend', html);
    }
  },

  /** Full card replace (rare — lock/soldout layout changes). No enter animation. */
  updateCard(itemId) {
    const id = String(itemId);
    const item = getMenu().items.find(i => i.id === id);
    const card = this.findCard(id);
    if (!item || !card) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = this.renderCard(item).trim();
    const next = tmp.firstElementChild;
    if (!next) return;
    next.classList.remove('menu-card-enter');
    card.replaceWith(next);
  },

  ensureMenuDelegation() {
    if (this.menuDelegated) return;
    const container = document.getElementById('menuList');
    if (!container) return;
    this.menuDelegated = true;

    // pointerup feels snappier than click on iOS; still handle click as fallback
    const onAct = (e) => {
      const card = e.target.closest('.menu-card');
      if (!card || !container.contains(card)) return;
      const itemId = card.dataset.id;
      const item = getMenu().items.find(i => i.id === itemId);
      if (!item) return;

      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (this._lastActAt && performance.now() - this._lastActAt < 40) return;
        this._lastActAt = performance.now();
        if (actionBtn.dataset.action === 'fav') {
          this.favorites = toggleFavorite(itemId);
          this.updateCard(itemId);
          return;
        }
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
          if (itemHasTag(item, 'alcohol') && getShop().ageGateEnabled !== false) {
            if (!confirmAlcoholAge(this.locale)) return;
          }
          this.bumpPlain(item, 1);
          // Toast only occasionally — every tap toast was janky on mobile
          if (!this._toastQuietUntil || performance.now() > this._toastQuietUntil) {
            showToast(`${this.itemText(item).name} ${this.t('added')}`);
            this._toastQuietUntil = performance.now() + 700;
          }
        }
        return;
      }

      if (e.target.closest('.qty-stepper')) return;
      if (isItemSoldOut(itemId) || !this.canOrder()) return;
      this.openModal(itemId);
    };

    container.addEventListener('click', onAct);
  },

  filteredItems() {
    const MENU_DATA = getMenu();
    const favs = this.favorites || loadFavorites();
    return MENU_DATA.items.filter(item => {
      if (isItemSoldOut(item.id)) {
        // still show unless quick filters exclude
      }
      const allergenMatch = this.activeAllergens.length === 0 ||
        !this.activeAllergens.some(a => (item.allergens || []).includes(a));
      const text = this.itemText(item);
      const q = this.searchQuery.toLowerCase();
      const searchMatch = q === '' ||
        text.name.toLowerCase().includes(q) ||
        text.description.toLowerCase().includes(q) ||
        (item.name || '').toLowerCase().includes(q);

      const qf = this.quickFilters || new Set();
      let quickMatch = true;
      if (qf.size) {
        quickMatch = [...qf].every((f) => {
          if (f === 'popular') return !!item.popular;
          if (f === 'sale') return isSaleActive(item);
          if (f === 'fav') return isFavorite(item.id, favs);
          if (f === 'veg' || f === 'spicy' || f === 'kids') return itemHasTag(item, f);
          return true;
        });
      }
      return allergenMatch && searchMatch && quickMatch;
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
    // Drop enter animation class after first paint so later patches never re-animate
    requestAnimationFrame(() => {
      container.querySelectorAll('.menu-card-enter').forEach(el => el.classList.remove('menu-card-enter'));
    });
  },

  renderCard(item) {
    const text = this.itemText(item);
    const soldOut = isItemSoldOut(item.id);
    const blocked = !this.canOrder();
    const qty = this.qtyForItem(item.id);
    const customizable = this.isCustomizable(item);
    const onSale = isSaleActive(item);
    const unit = getItemUnitPrice(item);
    const fav = isFavorite(item.id, this.favorites);
    const allergenHTML = (item.allergens || []).map(a => {
      const matched = this.activeAllergens.includes(a);
      return `<span class="allergen-tag ${matched ? 'matched' : ''}">${this.allergenLabel(a)}</span>`;
    }).join('');

    const controls = soldOut || blocked
      ? `<span class="soldout-pill">${soldOut
        ? (this.locale === 'en' ? 'Sold out' : '品切れ')
        : (this.locale === 'en' ? 'Unavailable' : '注文不可')}</span>`
      : customizable
      ? `<button class="add-btn" type="button" data-action="customize" aria-label="${text.name}">${qty > 0 ? `${qty}` : this.t('choose')}</button>`
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
      <article class="menu-card menu-card-enter ${qty > 0 ? 'in-cart' : ''} ${soldOut || blocked ? 'sold-out' : ''} ${onSale ? 'on-sale' : ''} ${item.popular ? 'is-popular' : ''}" data-id="${item.id}">
        <div class="menu-card-emoji" aria-hidden="true">${item.emoji || ''}</div>
        <div class="menu-card-body">
          <div class="menu-card-header">
            <div class="menu-card-name">${text.name}</div>
            <button type="button" class="fav-btn ${fav ? 'is-on' : ''}" data-action="fav" aria-label="${this.t('fav')}">${fav ? '★' : '☆'}</button>
          </div>
          <div class="menu-card-desc">${text.description}</div>
          ${tagBadgesHtml(item, this.locale)}
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
    if (itemHasTag(item, 'alcohol') && getShop().ageGateEnabled !== false) {
      if (!confirmAlcoholAge(this.locale)) return;
    }
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
    document.body.classList.add('scroll-locked');
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
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
        ${tagBadgesHtml(item, this.locale)}
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
    this.patchCardControls(item.id);
    this.mountTonightRail();
    this.refreshTablePulse();
    showToast(`${text.name} ${this.t('added')}`);
  },

  closeModal() {
    document.getElementById('itemModal').classList.remove('open');
    this.unlockPageScroll();
    this.modalItem = null;
  },

  updateCartBar() {
    const bar = document.getElementById('cartBar');
    if (!bar) return;
    const totals = computeOrderTotals(this.cart, getShop(), { tipPercent: this.tipPercent });
    const count = this.cart.reduce((s, e) => s + e.qty, 0);
    if (count === 0) { bar.classList.remove('visible'); return; }
    bar.classList.add('visible');
    const pill = bar.querySelector('.cart-count-pill');
    if (pill) pill.textContent = `${count}${this.locale === 'en' ? '' : this.t('points')}`;
    if (pill && this.locale === 'en') pill.textContent = String(count);
    bar.querySelector('.cart-bar-total').textContent = `¥${totals.total.toLocaleString()}`;
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
    this.bindCheckoutExtras();
  },

  showView(view, { skipHistory = false, replace = false } = {}) {
    const next = view === 'cart' ? 'cart' : 'menu';
    this.view = next;
    this.closeModal();
    this.unlockPageScroll();
    const menuView = document.getElementById('spaMenuView');
    const cartView = document.getElementById('spaCartView');
    const header = document.querySelector('.guest-header');
    const allergen = document.querySelector('.guest-allergen');
    const cartBar = document.getElementById('cartBar');
    const serviceBar = document.getElementById('guestServiceBar');
    const reserveBar = document.getElementById('guestReserveBar');

    if (next === 'cart') {
      if (menuView) menuView.hidden = true;
      if (header) header.hidden = true;
      if (allergen) allergen.hidden = true;
      const pulse = document.getElementById('tablePulse');
      if (pulse) pulse.hidden = true;
      if (serviceBar) serviceBar.hidden = true;
      if (reserveBar) reserveBar.hidden = true;
      if (cartBar) cartBar.classList.remove('visible');
      if (cartView) cartView.hidden = false;
      document.body.classList.add('spa-cart-open');
      this.setCartStep(this.cart.length ? Math.min(this.cartStep || 1, 3) : 1);
      this.renderSpaCart();
      window.scrollTo(0, 0);
    } else {
      if (cartView) cartView.hidden = true;
      if (menuView) menuView.hidden = false;
      if (header) header.hidden = false;
      if (allergen) allergen.hidden = false;
      this.refreshTablePulse();
      if (serviceBar) serviceBar.hidden = false;
      if (reserveBar) reserveBar.hidden = false;
      document.body.classList.remove('spa-cart-open');
      this.updateCartBar();
      this.mountTonightRail();
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
    const setRecs = suggestSetCombos(this.cart, getMenu().items || [], 2).filter(i => !isItemSoldOut(i.id));
    const recs = [...setRecs, ...recommendUpsells(this.cart, 3)]
      .filter((i, idx, arr) => arr.findIndex((x) => x.id === i.id) === idx)
      .filter(i => !isItemSoldOut(i.id))
      .slice(0, 4);
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
        this.patchCardControls(item.id);
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
    this.patchCardControls(itemId);
    this.updateCartBar();
    this.renderSpaCart();
  },

  renderSpaCartSummary() {
    const shop = getShop();
    this.pointsRedeem = Math.max(0, Number(document.getElementById('pointsRedeem')?.value) || this.pointsRedeem || 0);
    const totals = computeOrderTotals(this.cart, shop, {
      tipPercent: this.tipPercent,
      pointsRedeem: this.pointsRedeem,
      member: this.member,
    });
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; };
    set('subtotalAmount', `¥${totals.subtotal.toLocaleString()}`);
    set('discountAmount', `-¥${totals.discount.toLocaleString()}`);
    show('discountRow', totals.discount > 0);
    set('serviceAmount', `¥${totals.serviceCharge.toLocaleString()}`);
    set('serviceLabel', `サービス料（${totals.servicePct}%）`);
    show('serviceRow', totals.serviceCharge > 0);
    set('tipAmount', `¥${totals.tip.toLocaleString()}`);
    show('tipSummaryRow', totals.tip > 0);
    set('taxAmount', `¥${totals.tax.toLocaleString()}`);
    set('totalAmount', `¥${totals.total.toLocaleString()}`);
    set('splitNum', String(this.splitPeople));
    if (this.splitPeople > 1) {
      set('splitAmount', `お一人様 ¥${Math.ceil(totals.total / this.splitPeople).toLocaleString()}`);
      document.getElementById('splitResult')?.classList.remove('hidden');
    } else {
      document.getElementById('splitResult')?.classList.add('hidden');
    }
    // Tip UI visibility
    const tipRow = document.getElementById('tipRow');
    if (tipRow) tipRow.hidden = !(shopCanUse('tip') && shop.tipEnabled !== false);
    const couponRow = document.getElementById('couponRow');
    if (couponRow) couponRow.style.display = shopCanUse('coupons') ? '' : 'none';
    this.renderChannelPaymentUi();
  },

  unlockPageScroll() {
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
    document.body.classList.remove('scroll-locked');
  },

  mountReserveBar() {
    if (document.getElementById('guestReserveBar')) return;
    const header = document.querySelector('.guest-header');
    const bar = document.createElement('div');
    bar.id = 'guestReserveBar';
    bar.className = 'guest-reserve-bar';
    bar.innerHTML = `
      ${shopCanUse('reservations') ? `<button type="button" id="guestReserveBtn">${tUi('reserve', this.locale)}</button>` : ''}
      ${shopCanUse('waitlist') ? `<button type="button" id="guestWaitBtn">${tUi('waitlist', this.locale)}</button>` : ''}
    `;
    // Outside sticky header so scroll-back isn't trapped under a tall sticky block
    if (header?.parentNode) header.insertAdjacentElement('afterend', bar);
    else document.body.prepend(bar);
    document.getElementById('guestReserveBtn')?.addEventListener('click', async () => {
      const name = prompt(this.locale === 'en' ? 'Name' : 'お名前');
      if (!name) return;
      const phone = prompt(this.locale === 'en' ? 'Phone' : '電話番号') || '';
      const party = Number(prompt(this.locale === 'en' ? 'Party size' : '人数', '2')) || 2;
      const at = Date.now() + 60 * 60 * 1000;
      try {
        const r = await createReservation({ name, phone, partySize: party, at });
        showToast(`予約しました（${new Date(r.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}）`);
      } catch (e) { showToast(String(e?.message || e)); }
    });
    document.getElementById('guestWaitBtn')?.addEventListener('click', async () => {
      const name = prompt(this.locale === 'en' ? 'Name' : 'お名前', 'ゲスト') || 'ゲスト';
      const phone = prompt(this.locale === 'en' ? 'Phone' : '電話番号') || '';
      const party = Number(prompt(this.locale === 'en' ? 'Party size' : '人数', String(this.splitPeople || 2))) || 2;
      try {
        const w = await createWaitlistEntry({ name, phone, partySize: party });
        const mins = estimateWaitlistMinutes([], party);
        showToast(`順番待ち登録（目安 ${mins}分）ID:${w.id}`);
      } catch (e) { showToast(String(e?.message || e)); }
    });
  },

  renderChannelPaymentUi() {
    const shop = getShop();
    const enabled = Array.isArray(shop.channelsEnabled) ? shop.channelsEnabled : CHANNELS.map((c) => c.id);
    document.getElementById('channelRow')?.querySelectorAll('[data-channel]').forEach((btn) => {
      const id = btn.dataset.channel;
      const on = enabled.includes(id) && (
        id === 'dine_in'
        || (id === 'takeout' && shopCanUse('takeout'))
        || (id === 'delivery' && shopCanUse('delivery'))
      );
      btn.hidden = !on;
      btn.classList.toggle('active', id === this.channel);
      btn.textContent = channelLabel(id);
    });
    const payHost = document.getElementById('paymentRow');
    if (payHost) {
      const methods = shopCanUse('payments') ? listPaymentMethods(shop) : [];
      payHost.hidden = !methods.length;
      document.getElementById('paymentTitle')?.toggleAttribute('hidden', !methods.length);
      if (!methods.some((m) => m.id === this.paymentMethod) && methods[0]) {
        this.paymentMethod = methods[0].id;
      }
      payHost.innerHTML = methods.map((m) =>
        `<button type="button" class="payment-btn ${m.id === this.paymentMethod ? 'active' : ''}" data-pay="${m.id}">${m.label}</button>`
      ).join('');
      payHost.querySelectorAll('[data-pay]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.paymentMethod = btn.dataset.pay;
          this.renderChannelPaymentUi();
        });
      });
    }
    const memberRow = document.getElementById('memberRow');
    const loyaltyOn = shopCanUse('loyalty') && shop.loyaltyEnabled !== false;
    if (memberRow) memberRow.hidden = !loyaltyOn;
    document.getElementById('memberTitle')?.toggleAttribute('hidden', !loyaltyOn);
    if (loyaltyOn && this.member) {
      const phone = document.getElementById('memberPhone');
      const name = document.getElementById('memberName');
      const msg = document.getElementById('memberMsg');
      const redeemWrap = document.getElementById('memberRedeemWrap');
      if (phone) phone.value = this.member.phone || '';
      if (name) name.value = this.member.name || '';
      if (msg) {
        msg.hidden = false;
        msg.textContent = `残高 ${this.member.points || 0} pt · 来店 ${this.member.visitCount || 0}回`;
      }
      if (redeemWrap) redeemWrap.hidden = false;
    }
  },

  bindEnterpriseCheckout() {
    document.getElementById('channelRow')?.querySelectorAll('[data-channel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.channel = setSelectedChannel(btn.dataset.channel);
        this.renderChannelPaymentUi();
        this.refreshTablePulse();
      });
    });
    document.getElementById('memberSaveBtn')?.addEventListener('click', async () => {
      try {
        const phone = document.getElementById('memberPhone')?.value || '';
        const name = document.getElementById('memberName')?.value || '';
        this.member = await upsertMember({ phone, name });
        setLocalMember(this.member);
        showToast('会員を登録しました');
        this.renderChannelPaymentUi();
        this.renderSpaCartSummary();
      } catch (e) {
        showToast(String(e?.message || e));
      }
    });
    document.getElementById('pointsRedeem')?.addEventListener('input', () => {
      this.pointsRedeem = Math.max(0, Number(document.getElementById('pointsRedeem')?.value) || 0);
      this.renderSpaCartSummary();
      this.updateCartBar();
    });
  },

  bindCheckoutExtras() {
    const applyCoupon = async () => {
      const msg = document.getElementById('couponMsg');
      try { await loadShop(); } catch (_) {}
      const code = document.getElementById('couponInput')?.value || '';
      const subtotal = this.cart.reduce((s, e) => s + e.price * e.qty, 0);
      const v = validateCoupon(code, subtotal, getShop());
      if (!v.ok) {
        setAppliedCoupon(getShopId(), null);
        if (msg) { msg.hidden = false; msg.textContent = v.error; msg.classList.add('is-error'); }
        this.renderSpaCartSummary();
        this.updateCartBar();
        return;
      }
      setAppliedCoupon(getShopId(), v.coupon);
      const off = discountForCoupon(v.coupon, subtotal);
      if (msg) {
        msg.hidden = false;
        msg.classList.remove('is-error');
        msg.textContent = `${v.coupon.label || v.coupon.code} を適用（-¥${off.toLocaleString()}）`;
      }
      this.renderSpaCartSummary();
      this.updateCartBar();
    };
    document.getElementById('couponApplyBtn')?.addEventListener('click', () => { applyCoupon(); });
    document.getElementById('couponInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyCoupon();
      }
    });
    document.getElementById('tipRow')?.querySelectorAll('[data-tip]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.tipPercent = Number(btn.dataset.tip) || 0;
        document.getElementById('tipRow')?.querySelectorAll('[data-tip]').forEach((b) => {
          b.classList.toggle('active', Number(b.dataset.tip) === this.tipPercent);
        });
        this.renderSpaCartSummary();
        this.updateCartBar();
        // Make tip line obvious even at 0% after a change
        const tipSummary = document.getElementById('tipSummaryRow');
        const tipAmount = document.getElementById('tipAmount');
        if (tipSummary && this.tipPercent > 0) tipSummary.hidden = false;
        if (tipAmount) {
          const totals = computeOrderTotals(this.cart, getShop(), { tipPercent: this.tipPercent });
          tipAmount.textContent = `¥${totals.tip.toLocaleString()}`;
        }
      });
    });
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
    const subtotal = this.cart.reduce((s, e) => s + e.price * e.qty, 0);
    const min = Number(getShop().minOrderAmount) || 0;
    if (min > 0 && subtotal < min) {
      btn.disabled = true;
      btn.textContent = `${this.t('minOrder')}（¥${min.toLocaleString()}）`;
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
    const subtotal = this.cart.reduce((s, e) => s + e.price * e.qty, 0);
    const min = Number(getShop().minOrderAmount) || 0;
    if (min > 0 && subtotal < min) {
      showToast(`${this.t('minOrder')} ¥${min.toLocaleString()}`);
      this.updateSpaPlaceBtn();
      return;
    }
    const btn = document.getElementById('placeOrderBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = isDemoMode() ? 'テスト注文を送信中...' : '注文を送信中...';
    }
    const party = getPartySize() || this.splitPeople || 0;
    this.pointsRedeem = Math.max(0, Number(document.getElementById('pointsRedeem')?.value) || 0);
    const result = await placeGuestOrder({
      cart: this.cart,
      tableNumber: this.tableNumber,
      partySize: party,
      tipPercent: this.tipPercent,
      channel: this.channel,
      paymentMethod: this.paymentMethod,
      pointsRedeem: this.pointsRedeem,
      memberPhone: document.getElementById('memberPhone')?.value || '',
    });
    if (!result?.ok) {
      showToast(result?.message || result?.error || '注文に失敗しました');
      this.updateSpaPlaceBtn();
      return;
    }
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