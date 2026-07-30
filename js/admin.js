import { db } from './firebase.js';
import {
  loadShop, saveShop, ensureMenuSeeded, saveMenu, getMenu, getShop, getShopId,
  isSubscribed, markSubscribed, setItemSoldOut, isItemSoldOut,
  ensureTrialStarted, getShopAccess, shopCanUse, getItemStock, setItemStock,
} from './shop.js';
import { PLANS, PRODUCT } from './config.js';
import {
  getPlan, yen, estimateMrr, estimateArr, featureEnabled,
  nextPlanId, annualSavings, paymentCta, planPrice,
} from './plans.js';
import { resolveShopId, scopedKey, withShop, guestEntryUrl } from './tenant.js';
import {
  collection, onSnapshot, doc, updateDoc, deleteDoc, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { subscribeServiceRequests, resolveServiceRequest } from './guest-features.js';
import {
  notifyMenuItemsAdded,
  notifyMenuItemsRemoved,
  notifyLeadWon,
  notifyPlanChanged,
} from './notify.js';
import { maybeNotifySystemLoad } from './load-monitor.js';
import { ordersToCsv, downloadCsv, applyBrandTheme, filterOrdersByDateRange } from './guest-extras.js';
import { notifyOrderStatus } from './notify-orders.js';
import { listCoupons, normalizeCoupon, saveCoupons } from './coupons.js';
import {
  getStaffRole, setStaffRole, verifyStaffPin, staffCan, staffRoleLabel,
} from './staff-auth.js';

const AdminPage = {
  filter: 'received',
  view: 'orders',
  orders: [],
  leads: [],
  requests: [],
  menuDraft: null,
  unlocked: false,
  knownOrderIds: new Set(),
  soundReady: false,
  _loadNotifyTimer: null,
  kdsMode: 'timeline',
  couponDraft: [],

  async init() {
    resolveShopId();
    this.updateClock();
    setInterval(() => this.updateClock(), 1000);

    const params = new URLSearchParams(location.search);
    if (params.get('billing') === 'success') {
      await markSubscribed();
      history.replaceState({}, '', withShop('admin.html'));
      alert('課金が有効になりました。ありがとうございます。');
    }

    await loadShop();
    await ensureTrialStarted();
    this.menuDraft = await ensureMenuSeeded();
    this._menuSnapshot = JSON.parse(JSON.stringify(this.menuDraft?.items || []));
    this.kdsMode = getShop().kdsMode || 'timeline';
    this.applyShopBranding();
    applyBrandTheme(getShop());
    this.bindChrome();
    this.patchNavLinks();
    this.renderRevenueBanner();
    this.syncOpsChrome();

    if (!this.ensureAdminAccess()) return;

    this.subscribeToOrders();
    this.subscribeToLeads();
    this.subscribeRequests();
    this.renderMenuEditor();
    this.renderBilling();
    this.renderAnalytics();
    this.renderSettingsForm();
    this.applyStaffUiGates();

    if (params.get('view')) this.setView(params.get('view'));
  },

  renderRevenueBanner() {
    const el = document.getElementById('adminRevenueBanner');
    if (!el) return;
    const shop = getShop();
    const access = getShopAccess();
    const plan = getPlan(shop.planId);
    const next = nextPlanId(shop.planId);
    const pay = paymentCta();

    if (access.subscribed) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }

    el.hidden = false;
    if (access.trialActive) {
      el.dataset.level = access.daysLeft <= 3 ? 'warn' : 'info';
      el.innerHTML = `
        <strong>無料トライアル残り ${access.daysLeft} 日</strong>
        <span>${plan.name}のプレミアム機能を試用中。年払いなら実質2ヶ月分お得です。</span>
        <a class="admin-banner-cta" href="${pay.href}">${pay.label}</a>
        <button type="button" class="admin-banner-link" data-go-billing>料金を見る</button>`;
    } else if (access.trialExpired) {
      el.dataset.level = 'critical';
      el.innerHTML = `
        <strong>トライアル終了 — 分析・CSV・多言語などがロックされています</strong>
        <span>厨房の基本運用は継続できます。契約でGrowth以上に戻すと全機能が復活します。</span>
        <a class="admin-banner-cta" href="${pay.href}">${pay.label}</a>
        <button type="button" class="admin-banner-link" data-go-billing>プランを選ぶ</button>`;
    } else {
      el.dataset.level = 'info';
      el.innerHTML = `
        <strong>収益最大化モード</strong>
        <span>${PRODUCT.introSlotsLabel} 残り ${PRODUCT.introSlotsRemaining} 店 · ${next ? `${getPlan(next).name}へアップセル可能` : plan.name}</span>
        <a class="admin-banner-cta" href="${pay.href}">${pay.label}</a>`;
    }
    el.querySelector('[data-go-billing]')?.addEventListener('click', () => this.setView('billing'));
  },

  patchNavLinks() {
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!href || href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:')) return;
      if (href.includes('lp.html')) return;
      try {
        a.setAttribute('href', withShop(href));
      } catch (_) {}
    });
    const guest = document.querySelector('a[href*="index.html"]');
    if (guest) guest.setAttribute('href', guestEntryUrl(getShopId(), 1));
  },

  ensureAdminAccess() {
    const shop = getShop();
    const staffOn = shopCanUse('staffRoles');
    const hasAnyStaffPin = !!(shop.staffPins?.kitchen || shop.staffPins?.floor || shop.staffPins?.manager);
    const needsPin = !!(shop.adminPin || (staffOn && hasAnyStaffPin));

    if (!needsPin) {
      this.unlocked = true;
      if (staffOn) setStaffRole('manager');
      return true;
    }
    try {
      if (sessionStorage.getItem(scopedKey('mos_admin_ok')) === '1') {
        this.unlocked = true;
        if (staffOn && !getStaffRole()) setStaffRole('manager');
        return true;
      }
      if (staffOn && getStaffRole()) {
        this.unlocked = true;
        return true;
      }
    } catch (_) {}

    const title = document.getElementById('adminGateTitle');
    const hint = document.getElementById('adminGateHint');
    if (title) title.textContent = staffOn ? 'スタッフPIN' : '管理者PIN';
    if (hint) {
      hint.textContent = staffOn
        ? '厨房 / ホール / 店長のPIN、または管理者PINを入力'
        : '店舗設定でPINが有効です';
    }

    document.getElementById('adminGate')?.classList.remove('hidden');
    document.getElementById('adminPinSubmit')?.addEventListener('click', () => {
      const val = document.getElementById('adminPinInput')?.value || '';
      let role = null;
      if (staffOn) role = verifyStaffPin(val);
      if (!role && shop.adminPin && val === shop.adminPin) role = 'manager';
      if (role) {
        try { sessionStorage.setItem(scopedKey('mos_admin_ok'), '1'); } catch (_) {}
        if (staffOn) setStaffRole(role);
        document.getElementById('adminGate')?.classList.add('hidden');
        this.unlocked = true;
        this.subscribeToOrders();
        this.subscribeToLeads();
        this.subscribeRequests();
        this.renderMenuEditor();
        this.renderBilling();
        this.renderAnalytics();
        this.renderSettingsForm();
        this.syncOpsChrome();
        this.applyStaffUiGates();
      } else {
        alert('PINが違います');
      }
    }, { once: false });
    return false;
  },

  syncOpsChrome() {
    const kdsBar = document.getElementById('kdsModeBar');
    if (kdsBar) {
      const on = shopCanUse('kdsModes');
      kdsBar.hidden = !on;
      kdsBar.querySelectorAll('[data-kds]').forEach((b) => {
        b.classList.toggle('active', b.dataset.kds === this.kdsMode);
      });
    }
    const printBtn = document.getElementById('printKitchenBtn');
    if (printBtn) printBtn.style.display = shopCanUse('kitchenTickets') ? '' : 'none';
    const csvBtn = document.getElementById('exportCsvBtn');
    if (csvBtn) csvBtn.style.display = shopCanUse('exportCsv') ? '' : 'none';
    const badge = document.getElementById('staffRoleBadge');
    if (badge) {
      badge.textContent = shopCanUse('staffRoles') ? `権限: ${staffRoleLabel()}` : '';
    }
  },

  applyStaffUiGates() {
    if (!shopCanUse('staffRoles')) return;
    const manager = staffCan('*') || getStaffRole() === 'manager';
    const canOrders = staffCan('orders') || manager;
    const canMenu = manager;
    const canBilling = manager;
    const canSettings = manager;
    const canAnalytics = manager;
    const canLeads = manager;
    document.querySelectorAll('#adminViewTabs .admin-tab').forEach((btn) => {
      const v = btn.dataset.view;
      let ok = true;
      if (v === 'orders') ok = canOrders;
      if (v === 'menu') ok = canMenu;
      if (v === 'billing') ok = canBilling;
      if (v === 'settings') ok = canSettings;
      if (v === 'analytics') ok = canAnalytics;
      if (v === 'leads') ok = canLeads;
      btn.hidden = !ok;
    });
    if (!canOrders && this.view === 'orders') {
      if (canMenu) this.setView('menu');
      else if (canSettings) this.setView('settings');
    }
  },

  applyShopBranding() {
    const shop = getShop();
    const plan = getPlan(shop.planId);
    const title = document.getElementById('adminShopName');
    if (title) {
      title.textContent = shop.name || '厨房モニター';
      title.title = `${shop.name || ''} · ${plan.name} · ${getShopId()}`;
    }
    document.title = `管理画面 | ${shop.name || 'QuickOrder'}`;
  },

  updateClock() {
    const el = document.getElementById('adminClock');
    if (el) el.textContent = new Date().toLocaleTimeString('ja-JP');
  },

  bindChrome() {
    document.querySelectorAll('#adminViewTabs .admin-tab').forEach(btn => {
      btn.addEventListener('click', () => this.setView(btn.dataset.view));
    });
    document.querySelectorAll('#orderFilterTabs .admin-tab').forEach(btn => {
      btn.addEventListener('click', () => this.setFilter(btn.dataset.filter, btn));
    });
    document.getElementById('clearOrdersBtn')?.addEventListener('click', () => this.clearAll());
    document.getElementById('saveMenuBtn')?.addEventListener('click', () => this.persistMenu());
    document.getElementById('addMenuItemBtn')?.addEventListener('click', () => this.addMenuItem());
    document.getElementById('saveSettingsBtn')?.addEventListener('click', () => this.persistSettings());
    document.getElementById('activateSubBtn')?.addEventListener('click', () => this.activateSubscription());
    document.getElementById('billingUpgradeBtn')?.addEventListener('click', () => this.upgradeToGrowthAnnual());
    document.getElementById('exportCsvBtn')?.addEventListener('click', () => this.exportRangeCsv());
    document.getElementById('printKitchenBtn')?.addEventListener('click', () => this.printKitchenTickets());
    document.getElementById('kdsModeBar')?.querySelectorAll('[data-kds]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!shopCanUse('kdsModes')) return;
        this.kdsMode = btn.dataset.kds || 'timeline';
        saveShop({ kdsMode: this.kdsMode }).catch(() => {});
        this.syncOpsChrome();
        this.renderOrders();
      });
    });
    document.getElementById('addCouponBtn')?.addEventListener('click', () => {
      this.couponDraft.push(normalizeCoupon({ code: 'NEW', type: 'percent', value: 10, label: '新規クーポン' }));
      this.renderCouponEditor();
    });
    // default CSV range = today
    const today = new Date().toISOString().slice(0, 10);
    const from = document.getElementById('csvFrom');
    const to = document.getElementById('csvTo');
    if (from && !from.value) from.value = today;
    if (to && !to.value) to.value = today;
    document.body.addEventListener('click', () => { this.soundReady = true; }, { once: true });
  },

  setView(view) {
    this.view = view;
    document.querySelectorAll('#adminViewTabs .admin-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
    });
    const map = {
      orders: 'ordersPanel',
      analytics: 'analyticsPanel',
      menu: 'menuPanel',
      leads: 'leadsPanel',
      billing: 'billingPanel',
      settings: 'settingsPanel',
    };
    Object.entries(map).forEach(([key, id]) => {
      document.getElementById(id)?.classList.toggle('hidden', key !== view);
    });
    if (view === 'billing') this.renderBilling();
    if (view === 'leads') this.renderLeads();
    if (view === 'analytics') this.renderAnalytics();
    if (view === 'menu') this.renderMenuEditor();
    this.renderRevenueBanner();
  },

  playNewOrderSound() {
    if (!shopCanUse('soundAlert') || !this.soundReady) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.05;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      setTimeout(() => { osc.stop(); ctx.close(); }, 180);
    } catch (_) {}
  },

  scheduleLoadNotify() {
    clearTimeout(this._loadNotifyTimer);
    this._loadNotifyTimer = setTimeout(() => {
      maybeNotifySystemLoad({
        shopId: getShopId(),
        shopName: getShop()?.name || '',
        orders: this.orders || [],
        requests: this.requests || [],
      }).catch(() => {});
    }, 1200);
  },

  subscribeToOrders() {
    if (!this.unlocked && getShop().adminPin) return;
    const shopId = getShopId();
    const apply = (next) => {
      if (this.knownOrderIds.size) {
        next.forEach(o => {
          if (o.id && !this.knownOrderIds.has(o.id) && (o.status || 'received') === 'received') {
            this.playNewOrderSound();
          }
        });
      }
      this.knownOrderIds = new Set(next.map(o => o.id).filter(Boolean));
      this.orders = next;
      this.renderOrders();
      this.renderBilling();
      this.renderAnalytics();
      this.scheduleLoadNotify();
    };

    const scoped = query(
      collection(db, 'orders'),
      where('shopId', '==', shopId),
      orderBy('timestamp', 'desc')
    );
    onSnapshot(scoped, snap => {
      apply(snap.docs.map(d => d.data()));
    }, () => {
      onSnapshot(query(collection(db, 'orders'), orderBy('timestamp', 'desc')), snap => {
        apply(
          snap.docs.map(d => d.data())
            .filter(o => (o.shopId || 'default') === shopId)
        );
      });
    });
  },

  subscribeRequests() {
    if (!this.unlocked && getShop().adminPin) return;
    subscribeServiceRequests(getShopId(), (rows) => {
      this.requests = rows || [];
      this.scheduleLoadNotify();
      const open = rows.filter(r => r.status === 'open');
      let host = document.getElementById('adminRequestsBanner');
      if (!host) {
        host = document.createElement('div');
        host.id = 'adminRequestsBanner';
        host.className = 'admin-requests-banner';
        document.querySelector('.admin-header')?.after(host);
      }
      if (!open.length) {
        host.innerHTML = '';
        host.hidden = true;
        return;
      }
      host.hidden = false;
      host.innerHTML = open.map(r => `
        <div class="admin-req-chip ${r.type === 'bill' ? 'is-bill' : ''}">
          <span>${r.type === 'bill' ? '🧾 会計' : '呼出'} · <strong>席${r.tableNumber}</strong>${r.type === 'bill' ? ' → レジ' : ''}</span>
          <button type="button" data-resolve="${r.id}" data-table="${r.tableNumber}">済</button>
        </div>
      `).join('');
      host.querySelectorAll('[data-resolve]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.resolve;
          const table = btn.dataset.table;
          btn.disabled = true;
          btn.textContent = '…';
          // Optimistic hide this chip
          btn.closest('.admin-req-chip')?.remove();
          if (!host.querySelector('.admin-req-chip')) host.hidden = true;
          resolveServiceRequest(id, { tableNumber: table }).catch((e) => console.error(e));
        });
      });
    });
  },

  subscribeToLeads() {
    if (!this.unlocked && getShop().adminPin) return;
    const q = query(collection(db, 'leads'), orderBy('createdAt', 'desc'));
    onSnapshot(q, snap => {
      this.leads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this.renderLeads();
      this.renderBilling();
    }, () => {
      const list = document.getElementById('leadsList');
      if (list) {
        list.innerHTML = `<p class="admin-muted">リードを読めません。Firestoreで leads コレクションへの読み取りを許可してください。</p>`;
      }
    });
  },

  setFilter(filter, btn) {
    this.filter = filter;
    document.querySelectorAll('#orderFilterTabs .admin-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    this.renderOrders();
  },

  renderOrders() {
    const filtered = this.orders.filter(o =>
      this.filter === 'all' || (o.status || 'received') === this.filter
    );

    const pending = this.orders.filter(o => (o.status || 'received') !== 'done').length;
    const pendingEl = document.getElementById('pendingCount');
    if (pendingEl) pendingEl.textContent = `${pending}件`;

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

    const mode = shopCanUse('kdsModes') ? this.kdsMode : 'timeline';
    if (mode === 'byItem') {
      container.innerHTML = this.renderKdsByItem(filtered);
      this.bindOrderActions(container);
      return;
    }
    if (mode === 'byTable') {
      const groups = {};
      filtered.forEach((o) => {
        const t = String(o.tableNumber ?? '?');
        if (!groups[t]) groups[t] = [];
        groups[t].push(o);
      });
      container.innerHTML = Object.keys(groups).sort((a, b) => Number(a) - Number(b)).map((t) => `
        <section class="kds-group">
          <h3 class="kds-group-title">テーブル ${t}</h3>
          ${groups[t].map((o) => this.renderOrderCard(o)).join('')}
        </section>
      `).join('');
      this.bindOrderActions(container);
      return;
    }

    container.innerHTML = filtered.map((order) => this.renderOrderCard(order)).join('');
    this.bindOrderActions(container);
  },

  renderKdsByItem(orders) {
    const map = new Map();
    orders.forEach((o) => {
      (o.items || []).forEach((item) => {
        const key = item.itemId || item.name;
        const hit = map.get(key) || { name: item.name, emoji: item.emoji, qty: 0, tables: [] };
        hit.qty += Number(item.qty) || 1;
        hit.tables.push({ table: o.tableNumber, qty: item.qty, orderId: o.id, status: o.status || 'received' });
        map.set(key, hit);
      });
    });
    const rows = [...map.values()].sort((a, b) => b.qty - a.qty);
    if (!rows.length) return '<p class="admin-muted">集計対象なし</p>';
    return `
      <div class="kds-item-board">
        ${rows.map((r) => `
          <article class="kds-item-card">
            <div class="kds-item-head">
              <span>${r.emoji || '🍽️'}</span>
              <strong>${r.name}</strong>
              <em>×${r.qty}</em>
            </div>
            <ul>${r.tables.map((t) => `
              <li>卓${t.table} · ×${t.qty} · ${t.status}
                ${t.status !== 'done' ? `<button type="button" class="admin-action-btn complete" data-id="${t.orderId}" data-status="done">完了</button>` : ''}
              </li>`).join('')}
            </ul>
          </article>
        `).join('')}
      </div>`;
  },

  renderOrderCard(order) {
    const menu = this.menuDraft || getMenu();
    const slaOn = shopCanUse('slaTimer');
    const status = order.status || 'received';
    const cardClass = status === 'cooking' ? 'cooking' : status === 'finishing' ? 'finishing' : status === 'done' ? 'done' : '';
    const statusLabel = {
      received: '📥 受付済み',
      cooking: '🔥 調理中',
      finishing: '✨ 仕上げ',
      done: '✅ 完了',
    }[status] || '';
    const elapsed = Math.floor((Date.now() - order.timestamp) / 60000);
    const slaClass = slaOn && status !== 'done' && elapsed >= 15 ? 'sla-late' : slaOn && status !== 'done' && elapsed >= 8 ? 'sla-warn' : '';
    const party = order.partySize ? ` · ${order.partySize}名` : '';
    const extras = [];
    if (order.couponCode) extras.push(`クーポン ${order.couponCode}`);
    if (order.serviceCharge) extras.push(`サ料 ¥${order.serviceCharge.toLocaleString()}`);
    if (order.tip) extras.push(`チップ ¥${order.tip.toLocaleString()}`);

    const actionBtns = status === 'received' ? `
      <button class="admin-action-btn start" data-id="${order.id}" data-status="cooking">🔥 調理開始</button>
      <button class="admin-action-btn complete" data-id="${order.id}" data-status="done">✅ 完了</button>
    ` : status === 'cooking' ? `
      <button class="admin-action-btn start" data-id="${order.id}" data-status="finishing">✨ 仕上げへ</button>
      <button class="admin-action-btn complete" data-id="${order.id}" data-status="done">✅ 完了</button>
    ` : status === 'finishing' ? `
      <button class="admin-action-btn complete" style="flex:1;" data-id="${order.id}" data-status="done">✅ 配膳完了</button>
    ` : `<div style="font-size:13px;color:#4A5568;text-align:center;padding:8px;">配膳完了</div>`;

    return `
      <div class="admin-order-card ${cardClass} ${slaClass}">
        <div class="admin-order-top">
          <div>
            <div class="admin-order-id">${order.id}</div>
            <div class="admin-order-time">${elapsed === 0 ? 'たった今' : elapsed + '分前'} — ${statusLabel}${party}${slaOn && status !== 'done' ? ` · SLA ${elapsed}分` : ''}</div>
          </div>
          <div class="admin-table-badge">テーブル ${order.tableNumber}</div>
        </div>
        <div class="admin-items">
          ${(order.items || []).map(item => {
            const customParts = [];
            const menuItem = menu.items.find(i => i.id === item.itemId);
            if (menuItem) {
              (menuItem.customizable || []).forEach(opt => {
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
          小計 ¥${(order.subtotal || 0).toLocaleString()} · 税 ¥${(order.tax || 0).toLocaleString()} · 合計 ¥${(order.total || 0).toLocaleString()}
          ${extras.length ? `<br><span style="font-weight:500;">${extras.join(' · ')}</span>` : ''}
        </div>
        <div class="admin-action-row">${actionBtns}</div>
      </div>`;
  },

  bindOrderActions(container) {
    container.querySelectorAll('[data-id][data-status]').forEach(btn => {
      btn.addEventListener('click', () => this.updateStatus(btn.dataset.id, btn.dataset.status));
    });
  },

  exportRangeCsv() {
    if (!shopCanUse('exportCsv')) {
      const pay = paymentCta();
      const access = getShopAccess();
      const reason = !featureEnabled(getShop(), 'exportCsv')
        ? 'CSV出力は Growth 以上のプラン機能です。'
        : access.trialExpired
          ? 'トライアル終了のため CSV はロックされています。'
          : 'この機能は利用できません。';
      if (confirm(`${reason}\n\n${pay.label}へ進みますか？`)) {
        location.href = pay.href;
      }
      return;
    }
    const from = document.getElementById('csvFrom')?.value || '';
    const to = document.getElementById('csvTo')?.value || '';
    const rows = filterOrdersByDateRange(this.orders, from, to);
    const csv = ordersToCsv(rows);
    const stamp = (from || 'all') + '_' + (to || 'all');
    downloadCsv(`orders-${getShopId()}-${stamp}.csv`, csv);
  },

  printKitchenTickets() {
    if (!shopCanUse('kitchenTickets')) {
      const pay = paymentCta();
      if (confirm(`厨房伝票印刷は Growth 以上です。\n\n${pay.label}へ進みますか？`)) {
        location.href = pay.href;
      }
      return;
    }
    const open = this.orders.filter((o) => (o.status || 'received') !== 'done');
    const root = document.getElementById('kitchenPrintRoot');
    if (!root) {
      window.print();
      return;
    }
    if (!open.length) {
      alert('印刷対象の未完了注文がありません');
      return;
    }
    root.innerHTML = open.map((o) => {
      const items = (o.items || []).map((i) =>
        `<li><strong>×${i.qty}</strong> ${i.emoji || ''} ${i.name}${i.note ? ` <em>${i.note}</em>` : ''}</li>`
      ).join('');
      return `
        <article class="kitchen-ticket">
          <header>
            <div class="kt-table">卓 ${o.tableNumber}</div>
            <div class="kt-id">${o.id}</div>
          </header>
          <p class="kt-meta">${new Date(o.timestamp || Date.now()).toLocaleString('ja-JP')} · ${o.status || 'received'}</p>
          <ul>${items}</ul>
          <footer>合計 ¥${(o.total || 0).toLocaleString()}</footer>
        </article>`;
    }).join('');
    document.body.classList.add('printing-kitchen');
    const cleanup = () => {
      document.body.classList.remove('printing-kitchen');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
  },

  async updateStatus(orderId, status) {
    // Optimistic UI
    const hit = this.orders.find((o) => o.id === orderId);
    if (hit) {
      hit.status = status;
      this.renderOrders();
      notifyOrderStatus({
        shopId: getShopId(),
        shopName: getShop()?.name,
        orderId,
        tableNumber: hit.tableNumber,
        status,
        total: hit.total,
      }).catch(() => {});
    }
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

  renderMenuEditor() {
    const list = document.getElementById('menuEditorList');
    if (!list || !this.menuDraft) return;
    const allergenIds = (this.menuDraft.allergens || []).map((a) => a.id);
    list.innerHTML = this.menuDraft.items.map((item, idx) => {
      const customs = Array.isArray(item.customizable) ? item.customizable : [];
      const tags = Array.isArray(item.tags) ? item.tags : [];
      const allers = Array.isArray(item.allergens) ? item.allergens : [];
      return `
      <article class="menu-edit-card" data-idx="${idx}">
        <div class="menu-edit-main">
          <input class="me-emoji" value="${item.emoji || ''}" maxlength="4" title="絵文字" aria-label="絵文字">
          <input class="me-name" value="${this.escapeAttr(item.name)}" placeholder="商品名" aria-label="商品名">
          <div class="me-price-wrap">
            <span>¥</span>
            <input class="me-price" type="number" value="${item.price}" min="0" step="10" placeholder="価格" aria-label="価格">
          </div>
        </div>
        <label class="me-field me-desc-field">説明
          <input class="me-desc" value="${this.escapeAttr(item.description || '')}" placeholder="客席に表示する説明">
        </label>
        <div class="menu-edit-meta">
          <label class="me-field">カテゴリ
            <select class="me-cat" aria-label="カテゴリ">
              ${this.menuDraft.categories.filter(c => c.id !== 'all').map(c =>
                `<option value="${c.id}" ${c.id === item.category ? 'selected' : ''}>${c.label}</option>`
              ).join('')}
            </select>
          </label>
          <label class="me-field">カロリー
            <input class="me-cal" type="number" min="0" step="10" value="${Number(item.calories) || 0}" aria-label="カロリー">
          </label>
          <label class="me-check"><input type="checkbox" class="me-popular" ${item.popular ? 'checked' : ''}><span>人気</span></label>
          <label class="me-check"><input type="checkbox" class="me-alcohol" ${item.alcohol || tags.includes('alcohol') ? 'checked' : ''}><span>アルコール</span></label>
          <label class="me-check"><input type="checkbox" class="me-soldout" data-id="${item.id}" ${isItemSoldOut(item.id) ? 'checked' : ''}><span>品切れ</span></label>
          ${shopCanUse('inventory') ? `
          <label class="me-field me-stock-field">在庫
            <input class="me-stock" type="number" min="0" step="1" data-stock-id="${item.id}"
              value="${getItemStock(item.id) == null ? '' : getItemStock(item.id)}"
              placeholder="無制限" title="空欄=無制限">
          </label>` : ''}
          <button type="button" class="me-del" data-idx="${idx}">削除</button>
        </div>
        <div class="me-tag-row">
          ${['veg', 'spicy', 'kids', 'set'].map((t) => `
            <label class="me-check"><input type="checkbox" class="me-tag" data-tag="${t}" ${tags.includes(t) ? 'checked' : ''}><span>${t}</span></label>
          `).join('')}
        </div>
        <div class="me-allergen-row">
          <strong style="font-size:12px;color:#A0AEC0;">アレルギー</strong>
          ${(allergenIds.length ? allergenIds : ['gluten', 'egg', 'dairy', 'shrimp', 'peanut', 'soy']).map((a) => `
            <label class="me-check"><input type="checkbox" class="me-allergen" data-allergen="${a}" ${allers.includes(a) ? 'checked' : ''}><span>${a}</span></label>
          `).join('')}
        </div>

        <div class="me-sale-block">
          <div class="me-custom-head">
            <strong>時間帯セール</strong>
            <span>指定時間だけ値引き価格で表示</span>
          </div>
          <div class="me-sale-grid">
            <label class="me-check"><input type="checkbox" class="me-sale-on" ${item.saleEnabled ? 'checked' : ''}><span>セール有効</span></label>
            <label class="me-field">セール価格
              <div class="me-price-wrap"><span>¥</span>
                <input class="me-sale-price" type="number" min="0" step="10" value="${Number(item.salePrice) || 0}" aria-label="セール価格">
              </div>
            </label>
            <label class="me-field">開始
              <input class="me-sale-from" type="time" value="${this.escapeAttr(item.saleFrom || '11:00')}">
            </label>
            <label class="me-field">終了
              <input class="me-sale-until" type="time" value="${this.escapeAttr(item.saleUntil || '14:00')}">
            </label>
          </div>
        </div>

        <div class="me-custom-block">
          <div class="me-custom-head">
            <strong>カスタム項目</strong>
            <span>辛さ・大盛り・トッピングなど</span>
          </div>
          <div class="me-custom-list" data-item-idx="${idx}">
            ${customs.length ? customs.map((opt, oi) => this.renderCustomOptionRow(opt, oi, idx)).join('') : '<p class="me-custom-empty">まだカスタム項目はありません</p>'}
          </div>
          <div class="me-custom-actions">
            <button type="button" class="me-custom-add" data-add-custom="${idx}" data-type="select">＋ 選択肢</button>
            <button type="button" class="me-custom-add" data-add-custom="${idx}" data-type="toggle">＋ トグル（追加料金）</button>
          </div>
        </div>
      </article>`;
    }).join('');

    list.querySelectorAll('.me-del').forEach(btn => {
      btn.addEventListener('click', () => {
        this.syncMenuDraftFromDom();
        this.menuDraft.items.splice(Number(btn.dataset.idx), 1);
        this.renderMenuEditor();
      });
    });
    list.querySelectorAll('.me-soldout').forEach(input => {
      input.addEventListener('change', async () => {
        await setItemSoldOut(input.dataset.id, input.checked);
      });
    });
    list.querySelectorAll('.me-stock').forEach((input) => {
      input.addEventListener('change', async () => {
        const raw = input.value;
        await setItemStock(input.dataset.stockId, raw === '' ? null : Number(raw));
      });
    });
    list.querySelectorAll('[data-add-custom]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.syncMenuDraftFromDom();
        const idx = Number(btn.dataset.addCustom);
        const item = this.menuDraft.items[idx];
        if (!item) return;
        if (!Array.isArray(item.customizable)) item.customizable = [];
        const type = btn.dataset.type || 'select';
        const id = 'opt_' + Date.now().toString(36);
        if (type === 'toggle') {
          item.customizable.push({ id, label: 'トッピング', type: 'toggle', price: 100 });
        } else {
          item.customizable.push({
            id,
            label: 'オプション',
            type: 'select',
            options: ['普通', '大盛り(+100円)'],
            default: '普通',
          });
        }
        this.renderMenuEditor();
      });
    });
    list.querySelectorAll('[data-del-custom]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.syncMenuDraftFromDom();
        const itemIdx = Number(btn.dataset.itemIdx);
        const optIdx = Number(btn.dataset.delCustom);
        const item = this.menuDraft.items[itemIdx];
        if (!item?.customizable) return;
        item.customizable.splice(optIdx, 1);
        this.renderMenuEditor();
      });
    });
  },

  renderCustomOptionRow(opt, oi, itemIdx) {
    const type = opt.type === 'toggle' ? 'toggle' : 'select';
    if (type === 'toggle') {
      return `
        <div class="me-custom-row" data-opt-idx="${oi}" data-opt-type="toggle">
          <input type="hidden" class="me-opt-id" value="${this.escapeAttr(opt.id || '')}">
          <span class="me-opt-badge">トグル</span>
          <input class="me-opt-label" value="${this.escapeAttr(opt.label || '')}" placeholder="表示名（例: チャーシュー追加）">
          <div class="me-opt-price-wrap"><span>+¥</span>
            <input class="me-opt-price" type="number" min="0" step="10" value="${Number(opt.price) || 0}">
          </div>
          <button type="button" class="me-opt-del" data-del-custom="${oi}" data-item-idx="${itemIdx}">削除</button>
        </div>`;
    }
    const optionsText = Array.isArray(opt.options) ? opt.options.join(', ') : '';
    return `
      <div class="me-custom-row" data-opt-idx="${oi}" data-opt-type="select">
        <input type="hidden" class="me-opt-id" value="${this.escapeAttr(opt.id || '')}">
        <span class="me-opt-badge">選択</span>
        <input class="me-opt-label" value="${this.escapeAttr(opt.label || '')}" placeholder="表示名（例: 辛さ）">
        <input class="me-opt-options" value="${this.escapeAttr(optionsText)}" placeholder="選択肢（カンマ区切り）例: 甘口, 中辛, 辛口">
        <input class="me-opt-default" value="${this.escapeAttr(opt.default || '')}" placeholder="初期値">
        <button type="button" class="me-opt-del" data-del-custom="${oi}" data-item-idx="${itemIdx}">削除</button>
      </div>`;
  },

  escapeAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  },

  syncMenuDraftFromDom() {
    const rows = document.querySelectorAll('#menuEditorList .menu-edit-card, #menuEditorList .menu-edit-row');
    rows.forEach((row, idx) => {
      if (!this.menuDraft.items[idx]) return;
      const customizable = [];
      row.querySelectorAll('.me-custom-row').forEach((optRow) => {
        const type = optRow.dataset.optType === 'toggle' ? 'toggle' : 'select';
        const id = (optRow.querySelector('.me-opt-id')?.value || '').trim() || ('opt_' + Math.random().toString(36).slice(2, 8));
        const label = (optRow.querySelector('.me-opt-label')?.value || '').trim() || 'オプション';
        if (type === 'toggle') {
          customizable.push({
            id,
            label,
            type: 'toggle',
            price: Number(optRow.querySelector('.me-opt-price')?.value) || 0,
          });
          return;
        }
        const optionsRaw = optRow.querySelector('.me-opt-options')?.value || '';
        const options = optionsRaw.split(/[,、]/).map(s => s.trim()).filter(Boolean);
        let def = (optRow.querySelector('.me-opt-default')?.value || '').trim();
        if (!def && options.length) def = options[0];
        customizable.push({
          id,
          label,
          type: 'select',
          options: options.length ? options : ['普通'],
          default: def || '普通',
        });
      });

      const tags = [...row.querySelectorAll('.me-tag:checked')].map((el) => el.dataset.tag).filter(Boolean);
      const alcohol = !!row.querySelector('.me-alcohol')?.checked;
      if (alcohol && !tags.includes('alcohol')) tags.push('alcohol');
      const allergens = [...row.querySelectorAll('.me-allergen:checked')].map((el) => el.dataset.allergen).filter(Boolean);

      this.menuDraft.items[idx] = {
        ...this.menuDraft.items[idx],
        emoji: row.querySelector('.me-emoji')?.value || '🍽️',
        name: row.querySelector('.me-name')?.value || '無題',
        description: row.querySelector('.me-desc')?.value || '',
        price: Number(row.querySelector('.me-price')?.value) || 0,
        category: row.querySelector('.me-cat')?.value || 'side',
        popular: !!row.querySelector('.me-popular')?.checked,
        calories: Number(row.querySelector('.me-cal')?.value) || 0,
        alcohol,
        tags,
        allergens,
        saleEnabled: !!row.querySelector('.me-sale-on')?.checked,
        salePrice: Number(row.querySelector('.me-sale-price')?.value) || 0,
        saleFrom: row.querySelector('.me-sale-from')?.value || '11:00',
        saleUntil: row.querySelector('.me-sale-until')?.value || '14:00',
        customizable,
      };
    });
  },

  addMenuItem() {
    this.syncMenuDraftFromDom();
    this.menuDraft.items.push({
      id: 'item_' + Date.now(),
      category: 'side',
      name: '新しいメニュー',
      description: '',
      price: 500,
      emoji: '🍽️',
      popular: false,
      allergens: [],
      customizable: [],
      saleEnabled: false,
      salePrice: 0,
      saleFrom: '11:00',
      saleUntil: '14:00',
    });
    this.renderMenuEditor();
  },

  async persistMenu() {
    this.syncMenuDraftFromDom();
    const before = Array.isArray(this._menuSnapshot) ? this._menuSnapshot : [];
    const after = Array.isArray(this.menuDraft?.items) ? this.menuDraft.items : [];
    const beforeIds = new Set(before.map(i => i.id));
    const afterIds = new Set(after.map(i => i.id));
    const added = after.filter(i => !beforeIds.has(i.id));
    const removed = before.filter(i => !afterIds.has(i.id));
    try {
      await saveMenu(this.menuDraft);
      this._menuSnapshot = JSON.parse(JSON.stringify(after));
      const shop = getShop();
      const shopId = getShopId();
      notifyMenuItemsAdded(shopId, shop?.name, added);
      notifyMenuItemsRemoved(shopId, shop?.name, removed);
      alert('メニューを保存しました（カスタム項目含む）');
    } catch (e) {
      console.error(e);
      alert('保存に失敗しました。通信または権限を確認してください。');
    }
  },

  renderLeads() {
    const list = document.getElementById('leadsList');
    if (!list) return;
    if (!this.leads.length) {
      list.innerHTML = `<p class="admin-muted">まだリードはありません。<a href="lp.html" style="color:#0A84FF;">販売LP</a>を共有してください。</p>`;
      return;
    }
    list.innerHTML = this.leads.map(lead => `
      <div class="lead-card">
        <div class="lead-top">
          <strong>${lead.shopName || '無題'}</strong>
          <span>${lead.status || 'new'}</span>
        </div>
        <div class="lead-meta">${lead.email || ''} ${lead.phone ? '· ' + lead.phone : ''}</div>
        <div class="lead-meta">
          プラン: ${lead.planName || lead.planId || '-'}
          · 見込みMRR ¥${yen(lead.estimatedMrr || lead.planPrice || 0)}
          · 席数 ${lead.tables || '-'}
          · 店舗 ${lead.stores || 1}
        </div>
        <div class="lead-meta">${lead.createdAt ? new Date(lead.createdAt).toLocaleString('ja-JP') : ''}</div>
        ${lead.message ? `<p class="lead-msg">${lead.message}</p>` : ''}
        <div class="admin-action-row" style="margin-top:10px;">
          <button class="admin-action-btn start" data-lead="${lead.id}" data-lead-status="contacted">対応中</button>
          <button class="admin-action-btn complete" data-lead="${lead.id}" data-lead-status="won">成約</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('[data-lead]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const status = btn.dataset.leadStatus;
          await updateDoc(doc(db, 'leads', btn.dataset.lead), { status });
          if (status === 'won') {
            const lead = this.leads.find(l => l.id === btn.dataset.lead);
            if (lead) notifyLeadWon({ ...lead, status });
          }
        } catch (e) { console.error(e); }
      });
    });
  },

  renderAnalytics() {
    const shop = getShop();
    const hint = document.getElementById('analyticsPlanHint');
    const planOk = featureEnabled(shop, 'analytics');
    const access = getShopAccess();
    const unlocked = shopCanUse('analytics');
    if (hint) {
      if (!planOk) {
        hint.textContent = 'Growth以上で利用可能 — 下の課金タブからアップグレード';
      } else if (access.trialExpired) {
        hint.textContent = 'トライアル終了のためロック中 — 契約すると分析が復活します';
      } else if (access.trialActive) {
        hint.textContent = `${getPlan(shop.planId).name} · トライアル中（残り${access.daysLeft}日）`;
      } else {
        hint.textContent = `${getPlan(shop.planId).name}プラン · リアルタイム集計`;
      }
    }
    if (!unlocked) {
      const pay = paymentCta();
      document.getElementById('anTodayGmv').textContent = '—';
      document.getElementById('anTodayOrders').textContent = '—';
      document.getElementById('anAov').textContent = '—';
      document.getElementById('analyticsTopItems').innerHTML = `
        <p class="admin-muted">分析は有料機能です。Growth年払いなら実質2ヶ月分お得。</p>
        <p><a class="admin-save-btn" style="display:inline-block;width:auto;padding:10px 16px;text-decoration:none;" href="${pay.href}">${pay.label}</a></p>`;
      document.getElementById('analyticsHours').innerHTML = '';
      return;
    }

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const today = this.orders.filter(o => (o.timestamp || 0) >= start.getTime());
    const gmv = today.reduce((s, o) => s + (o.total || 0), 0);
    const count = today.length;
    const aov = count ? Math.round(gmv / count) : 0;
    document.getElementById('anTodayGmv').textContent = `¥${yen(gmv)}`;
    document.getElementById('anTodayOrders').textContent = String(count);
    document.getElementById('anAov').textContent = `¥${yen(aov)}`;

    const itemMap = new Map();
    this.orders.slice(0, 200).forEach(o => {
      (o.items || []).forEach(it => {
        const cur = itemMap.get(it.name) || { name: it.name, emoji: it.emoji, qty: 0, sales: 0 };
        cur.qty += it.qty || 0;
        cur.sales += (it.price || 0) * (it.qty || 0);
        itemMap.set(it.name, cur);
      });
    });
    const top = [...itemMap.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);
    document.getElementById('analyticsTopItems').innerHTML = top.length
      ? top.map(t => `<div class="analytics-row"><span>${t.emoji || ''} ${t.name}</span><strong>×${t.qty} · ¥${yen(t.sales)}</strong></div>`).join('')
      : '<p class="admin-muted">まだ注文データがありません</p>';

    const hours = Array.from({ length: 24 }, () => 0);
    today.forEach(o => {
      const h = new Date(o.timestamp).getHours();
      hours[h] += o.total || 0;
    });
    const max = Math.max(...hours, 1);
    document.getElementById('analyticsHours').innerHTML = `
      <div class="hour-bars">
        ${hours.map((v, h) => `
          <div class="hour-bar" title="${h}:00 ¥${yen(v)}">
            <div class="hour-fill" style="height:${Math.round((v / max) * 100)}%"></div>
            <span>${h}</span>
          </div>`).join('')}
      </div>`;
  },

  renderBilling() {
    const shop = getShop();
    const plan = getPlan(shop.planId);
    const cycle = shop.billingCycle || PRODUCT.defaultBillingCycle || 'annual';
    const annual = planPrice(plan, 'annual');
    const selfMrr = isSubscribed()
      ? estimateMrr({ planId: shop.planId, stores: shop.stores || 1, cycle })
      : 0;

    const openLeads = this.leads.filter(l => (l.status || 'new') === 'new').length;
    const wonMrr = this.leads
      .filter(l => l.status === 'won')
      .reduce((s, l) => s + (l.estimatedMrr || getPlan(l.planId || 'growth').priceMonthly), 0);
    const pipelineMrr = selfMrr + wonMrr;
    const access = getShopAccess();
    const pay = paymentCta();

    const planName = document.getElementById('billingPlanName');
    const priceEl = document.getElementById('billingPrice');
    const leadsEl = document.getElementById('billingLeads');
    const mrrEl = document.getElementById('billingMrr');
    const arrEl = document.getElementById('billingArr');
    const subStatus = document.getElementById('subStatus');
    const trialStatus = document.getElementById('trialStatus');
    const catalog = document.getElementById('billingCatalog');
    const payLink = document.getElementById('billingPayLink');

    if (planName) planName.textContent = plan.name;
    if (priceEl) {
      priceEl.textContent = `月額 ¥${yen(plan.priceMonthly)} · 年払い実質 ¥${yen(annual.perMonthEffective)}/月（年額¥${yen(annual.chargeNow)}・¥${yen(annualSavings(plan))}お得）· 初期¥${yen(plan.priceSetup)}`;
    }
    if (leadsEl) leadsEl.textContent = String(openLeads);
    if (mrrEl) mrrEl.textContent = `¥${yen(pipelineMrr)}`;
    if (arrEl) arrEl.textContent = `¥${yen(estimateArr(pipelineMrr))}`;
    if (subStatus) {
      subStatus.textContent = isSubscribed()
        ? `課金有効 · ${plan.name} · 自店舗MRR ¥${yen(selfMrr)}`
        : '未課金 — 契約または手動有効化でMRRに反映';
    }
    if (trialStatus) {
      if (access.subscribed) trialStatus.textContent = 'トライアル不要（契約済み）';
      else if (access.trialActive) trialStatus.textContent = `無料トライアル残り ${access.daysLeft} 日 · ${PRODUCT.introSlotsLabel} 残り ${PRODUCT.introSlotsRemaining} 店`;
      else if (access.trialExpired) trialStatus.textContent = 'トライアル終了 — プレミアム機能はロック中';
      else trialStatus.textContent = `初回アクセスで ${PRODUCT.trialDays} 日トライアルが開始されます`;
    }
    if (payLink) {
      payLink.href = pay.href;
      payLink.textContent = pay.label;
      if (pay.mode === 'stripe') payLink.target = '_blank';
      else payLink.removeAttribute('target');
    }
    if (catalog) {
      catalog.innerHTML = PLANS.map(p => {
        const ap = planPrice(p, 'annual');
        return `
        <div class="catalog-card ${p.id === plan.id ? 'active' : ''}" data-pick-plan="${p.id}">
          <div class="catalog-name">${p.name}${p.recommended ? ' ★' : ''}</div>
          <div class="catalog-price">¥${yen(ap.perMonthEffective)}<span>/月（年払）</span></div>
          <div class="catalog-setup">初期 ¥${yen(p.priceSetup)} · 年額 ¥${yen(ap.chargeNow)}</div>
          <div class="catalog-meta">${p.maxTables == null ? '席数無制限' : `〜${p.maxTables}席`} · ${p.maxStores == null ? '店舗無制限' : `${p.maxStores}店舗`}${p.orderFeePercent ? ` · 手数料${p.orderFeePercent}%` : ''}</div>
        </div>`;
      }).join('');
      catalog.querySelectorAll('[data-pick-plan]').forEach((card) => {
        card.addEventListener('click', async () => {
          const id = card.dataset.pickPlan;
          const prev = getShop()?.planId;
          await saveShop({ planId: id, billingCycle: 'annual' });
          notifyPlanChanged({ ...getShop(), id: getShopId() }, prev, id);
          this.applyShopBranding();
          this.renderBilling();
          this.renderAnalytics();
          this.renderRevenueBanner();
          this.renderSettingsForm();
        });
      });
    }
    this.renderRevenueBanner();
  },

  async upgradeToGrowthAnnual() {
    const prev = getShop()?.planId;
    await saveShop({ planId: 'growth', billingCycle: 'annual' });
    notifyPlanChanged({ ...getShop(), id: getShopId() }, prev, 'growth');
    this.renderBilling();
    this.renderAnalytics();
    this.renderRevenueBanner();
    this.renderSettingsForm();
    const growth = getPlan('growth');
    const ap = planPrice(growth, 'annual');
    alert(`Growth・年払いに切り替えました（実質 ¥${yen(ap.perMonthEffective)}/月）。契約手続きは「${paymentCta().label}」へ。`);
  },

  async activateSubscription() {
    await markSubscribed();
    this.renderBilling();
    this.renderRevenueBanner();
    this.renderAnalytics();
    alert('課金フラグを有効化しました（MRRに反映）');
  },

  renderSettingsForm() {
    const shop = getShop();
    const planSel = document.getElementById('settingPlan');
    if (planSel) {
      planSel.innerHTML = PLANS.map(p =>
        `<option value="${p.id}" ${p.id === (shop.planId || 'growth') ? 'selected' : ''}>${p.name}（¥${yen(p.priceMonthly)}/月）</option>`
      ).join('');
    }
    document.getElementById('settingName').value = shop.name || '';
    document.getElementById('settingSubtitle').value = shop.subtitle || '';
    document.getElementById('settingCycle').value = shop.billingCycle || 'monthly';
    document.getElementById('settingStores').value = shop.stores || 1;
    document.getElementById('settingTables').value = shop.tableCount || 12;
    document.getElementById('settingLocale').value = shop.locale || 'ja';
    document.getElementById('settingAdminPin').value = shop.adminPin || '';

    const svc = document.getElementById('settingServiceCharge');
    if (svc) svc.value = Number(shop.serviceChargePercent) || 0;
    const tip = document.getElementById('settingTipEnabled');
    if (tip) tip.checked = !!shop.tipEnabled;

    const showSvc = shopCanUse('serviceCharge') || shopCanUse('tip');
    document.getElementById('settingServiceWrap')?.toggleAttribute('hidden', !shopCanUse('serviceCharge'));
    document.getElementById('settingTipWrap')?.toggleAttribute('hidden', !shopCanUse('tip'));
    document.getElementById('opsFeaturesHead')?.toggleAttribute('hidden', !showSvc && !shopCanUse('coupons') && !shopCanUse('staffRoles'));

    const pins = shop.staffPins || {};
    const staffBlock = document.getElementById('staffPinsBlock');
    if (staffBlock) staffBlock.hidden = !shopCanUse('staffRoles');
    const pk = document.getElementById('settingPinKitchen');
    const pf = document.getElementById('settingPinFloor');
    const pm = document.getElementById('settingPinManager');
    if (pk) pk.value = pins.kitchen || '';
    if (pf) pf.value = pins.floor || '';
    if (pm) pm.value = pins.manager || '';

    const couponsBlock = document.getElementById('couponsBlock');
    if (couponsBlock) couponsBlock.hidden = !shopCanUse('coupons');
    this.couponDraft = listCoupons(shop).map((c) => ({ ...c }));
    this.renderCouponEditor();
    this.syncOpsChrome();
  },

  renderCouponEditor() {
    const list = document.getElementById('couponEditorList');
    if (!list) return;
    if (!this.couponDraft.length) {
      list.innerHTML = '<p class="admin-muted">クーポンはまだありません</p>';
      return;
    }
    list.innerHTML = this.couponDraft.map((c, i) => `
      <article class="coupon-edit-card" data-ci="${i}">
        <label class="admin-field">コード
          <input class="ce-code" value="${this.escapeAttr(c.code)}" maxlength="24">
        </label>
        <label class="admin-field">表示名
          <input class="ce-label" value="${this.escapeAttr(c.label || '')}">
        </label>
        <label class="admin-field">種別
          <select class="ce-type">
            <option value="percent" ${c.type === 'percent' ? 'selected' : ''}>％割引</option>
            <option value="fixed" ${c.type === 'fixed' ? 'selected' : ''}>定額</option>
          </select>
        </label>
        <label class="admin-field">値
          <input class="ce-value" type="number" min="0" value="${Number(c.value) || 0}">
        </label>
        <label class="admin-field">最低金額
          <input class="ce-min" type="number" min="0" value="${Number(c.minSubtotal) || 0}">
        </label>
        <label class="admin-field">利用上限（空=無制限）
          <input class="ce-max" type="number" min="0" value="${c.maxUses == null ? '' : c.maxUses}">
        </label>
        <label class="admin-field">開始
          <input class="ce-from" type="time" value="${this.escapeAttr(c.from || '00:00')}">
        </label>
        <label class="admin-field">終了
          <input class="ce-until" type="time" value="${this.escapeAttr(c.until || '23:59')}">
        </label>
        <label class="admin-field admin-check">
          <input type="checkbox" class="ce-enabled" ${c.enabled !== false ? 'checked' : ''}>
          <span>有効</span>
        </label>
        <button type="button" class="me-del ce-del" data-ci="${i}">削除</button>
      </article>
    `).join('');
    list.querySelectorAll('.ce-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.syncCouponDraftFromDom();
        this.couponDraft.splice(Number(btn.dataset.ci), 1);
        this.renderCouponEditor();
      });
    });
  },

  syncCouponDraftFromDom() {
    const rows = document.querySelectorAll('#couponEditorList .coupon-edit-card');
    if (!rows.length) return;
    this.couponDraft = [...rows].map((row) => normalizeCoupon({
      ...this.couponDraft[Number(row.dataset.ci)],
      code: row.querySelector('.ce-code')?.value,
      label: row.querySelector('.ce-label')?.value,
      type: row.querySelector('.ce-type')?.value,
      value: row.querySelector('.ce-value')?.value,
      minSubtotal: row.querySelector('.ce-min')?.value,
      maxUses: row.querySelector('.ce-max')?.value,
      from: row.querySelector('.ce-from')?.value,
      until: row.querySelector('.ce-until')?.value,
      enabled: !!row.querySelector('.ce-enabled')?.checked,
    }));
  },

  async persistSettings() {
    this.syncCouponDraftFromDom();
    const payload = {
      name: document.getElementById('settingName')?.value?.trim() || 'QuickOrder',
      subtitle: document.getElementById('settingSubtitle')?.value?.trim() || '',
      planId: document.getElementById('settingPlan')?.value || 'growth',
      billingCycle: document.getElementById('settingCycle')?.value || 'monthly',
      stores: Number(document.getElementById('settingStores')?.value) || 1,
      tableCount: Number(document.getElementById('settingTables')?.value) || 12,
      locale: document.getElementById('settingLocale')?.value || 'ja',
      adminPin: document.getElementById('settingAdminPin')?.value || '',
      serviceChargePercent: Math.max(0, Number(document.getElementById('settingServiceCharge')?.value) || 0),
      tipEnabled: !!document.getElementById('settingTipEnabled')?.checked,
      staffPins: {
        kitchen: document.getElementById('settingPinKitchen')?.value || '',
        floor: document.getElementById('settingPinFloor')?.value || '',
        manager: document.getElementById('settingPinManager')?.value || '',
      },
      kdsMode: this.kdsMode || 'timeline',
    };
    const prevPlan = getShop()?.planId;
    try {
      await saveShop(payload);
      if (shopCanUse('coupons')) await saveCoupons(this.couponDraft);
      notifyPlanChanged({ ...getShop(), id: getShopId() }, prevPlan, payload.planId);
      this.applyShopBranding();
      this.renderBilling();
      this.renderAnalytics();
      this.renderSettingsForm();
      this.applyStaffUiGates();
      alert('設定を保存しました');
    } catch (e) {
      console.error(e);
      alert('保存に失敗しました');
    }
  },
};

window.AdminPage = AdminPage;
document.addEventListener('DOMContentLoaded', () => AdminPage.init());
