import { loadShop, saveShop, getShop, isSubscribed, getShopId, getMenu, loadMenu, setItemSoldOut, isItemSoldOut } from './shop.js';
import { getPlan, yen } from './plans.js';
import { db } from './firebase.js';
import {
  collection, onSnapshot, query, where, orderBy
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { resolveShopId, guestEntryUrl } from './tenant.js';
import { subscribeServiceRequests, resolveServiceRequest } from './guest-features.js';
import { orderDetailHtml, bindOrderHistoryToggles } from './order-history.js';

const StorePage = {
  orders: [],
  requests: [],
  _knownReqIds: new Set(),

  async init() {
    resolveShopId();
    await Promise.all([loadShop(), loadMenu()]);
    this.bind();
    this.patchNav();
    this.renderProfile();
    this.renderTables();
    this.renderMeta();
    this.renderSoldOut();
    this.subscribeOrders();
    this.subscribeRequests();
    setInterval(() => this.tickClock(), 1000);
    this.tickClock();
  },

  patchNav() {
    const id = getShopId();
    const set = (sel, href) => {
      const el = document.querySelector(sel);
      if (el) el.setAttribute('href', href);
    };
    set('#navAdmin', `admin.html?shop=${encodeURIComponent(id)}`);
    set('#navMenu', `admin.html?shop=${encodeURIComponent(id)}&view=menu`);
    set('#navAnalytics', `admin.html?shop=${encodeURIComponent(id)}&view=analytics`);
    set('#navGuest', guestEntryUrl(id, 1));
  },

  bind() {
    document.getElementById('openToggle')?.addEventListener('click', async () => {
      const shop = getShop();
      await saveShop({ isOpen: !shop.isOpen });
      this.renderMeta();
    });
    document.getElementById('regenTables')?.addEventListener('click', () => this.renderTables());
    document.getElementById('storeForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = document.getElementById('storeStatus');
      status.hidden = false;
      status.classList.remove('error');
      status.textContent = '保存中...';
      try {
        await saveShop({
          name: document.getElementById('storeName').value.trim() || 'QuickOrder',
          subtitle: document.getElementById('storeSubtitle').value.trim(),
          hoursNote: document.getElementById('storeHours').value.trim(),
          address: document.getElementById('storeAddress').value.trim(),
          tableCount: Number(document.getElementById('storeTables').value) || 12,
          ownerEmail: document.getElementById('storeEmail').value.trim(),
          ownerPhone: document.getElementById('storePhone').value.trim(),
          locale: document.getElementById('storeLocale').value || 'ja',
          lastOrderEnabled: !!document.getElementById('storeLastOrderEnabled')?.checked,
          lastOrderTime: document.getElementById('storeLastOrderTime')?.value || '21:30',
          accentColor: document.getElementById('storeAccent')?.value || '#0D5C4D',
          minOrderAmount: Number(document.getElementById('storeMinOrder')?.value) || 0,
          partySizeRequired: !!document.getElementById('storePartyRequired')?.checked,
          ageGateEnabled: !!document.getElementById('storeAgeGate')?.checked,
          quickServiceEnabled: !!document.getElementById('storeQuickService')?.checked,
        });
        this.renderProfile();
        this.renderMeta();
        this.renderTables();
        status.textContent = '保存しました';
      } catch (err) {
        console.error(err);
        status.classList.add('error');
        status.textContent = '保存に失敗しました';
      }
    });
  },

  tickClock() {
    const el = document.getElementById('storeClock');
    if (el) el.textContent = new Date().toLocaleString('ja-JP');
  },

  renderMeta() {
    const shop = getShop();
    const plan = getPlan(shop.planId);
    document.getElementById('storeTitle').textContent = shop.name || 'QuickOrder';
    document.title = `店舗管理 | ${shop.name || 'QuickOrder'} (${getShopId()})`;
    const sub = [
      getShopId(),
      plan.name,
      shop.hoursNote || '営業時間未設定',
      isSubscribed() ? '課金中' : '未課金',
    ].join(' · ');
    document.getElementById('storePlanLine').textContent = sub;

    const btn = document.getElementById('openToggle');
    if (btn) {
      const open = shop.isOpen !== false;
      btn.textContent = open ? '営業中' : '準備中';
      btn.classList.toggle('is-closed', !open);
    }
  },

  renderProfile() {
    const shop = getShop();
    document.getElementById('storeName').value = shop.name || '';
    document.getElementById('storeSubtitle').value = shop.subtitle || '';
    document.getElementById('storeHours').value = shop.hoursNote || '';
    document.getElementById('storeAddress').value = shop.address || '';
    document.getElementById('storeTables').value = shop.tableCount || 12;
    document.getElementById('storeEmail').value = shop.ownerEmail || '';
    document.getElementById('storePhone').value = shop.ownerPhone || '';
    document.getElementById('storeLocale').value = shop.locale || 'ja';
    const loEn = document.getElementById('storeLastOrderEnabled');
    const loTime = document.getElementById('storeLastOrderTime');
    if (loEn) loEn.checked = !!shop.lastOrderEnabled;
    if (loTime) loTime.value = shop.lastOrderTime || '21:30';
    const accent = document.getElementById('storeAccent');
    if (accent) accent.value = shop.accentColor || '#0D5C4D';
    const minOrder = document.getElementById('storeMinOrder');
    if (minOrder) minOrder.value = Number(shop.minOrderAmount) || 0;
    const partyReq = document.getElementById('storePartyRequired');
    if (partyReq) partyReq.checked = !!shop.partySizeRequired;
    const ageGate = document.getElementById('storeAgeGate');
    if (ageGate) ageGate.checked = shop.ageGateEnabled !== false;
    const quick = document.getElementById('storeQuickService');
    if (quick) quick.checked = shop.quickServiceEnabled !== false;
  },

  tableUrl(n) {
    return new URL(guestEntryUrl(getShopId(), n), location.href).href;
  },

  renderTables() {
    const shop = getShop();
    const count = Math.min(Math.max(Number(shop.tableCount) || 12, 1), 80);
    const list = document.getElementById('tableList');
    list.innerHTML = Array.from({ length: count }, (_, i) => {
      const n = i + 1;
      const url = this.tableUrl(n);
      return `
        <div class="store-table-row">
          <strong>席 ${n}</strong>
          <code title="${url}">${url}</code>
          <div style="display:flex;gap:6px;">
            <button type="button" data-copy="${url}">コピー</button>
            <a href="${url}" target="_blank" rel="noopener">開く</a>
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-copy]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.copy);
          btn.textContent = 'OK';
          setTimeout(() => { btn.textContent = 'コピー'; }, 1200);
        } catch {
          prompt('URLをコピーしてください', btn.dataset.copy);
        }
      });
    });
  },

  renderSoldOut() {
    let host = document.getElementById('soldOutPanel');
    if (!host) {
      host = document.createElement('section');
      host.id = 'soldOutPanel';
      host.className = 'store-card';
      host.innerHTML = `<h2>品切れ管理</h2><div id="soldOutList"></div>`;
      document.querySelector('main')?.appendChild(host)
        || document.body.appendChild(host);
    }
    const list = document.getElementById('soldOutList');
    const items = getMenu().items || [];
    list.innerHTML = items.map(item => `
      <label class="store-soldout-row">
        <input type="checkbox" data-soldout="${item.id}" ${isItemSoldOut(item.id) ? 'checked' : ''}>
        <span>${item.emoji || ''} ${item.name}</span>
      </label>
    `).join('');
    list.querySelectorAll('[data-soldout]').forEach(input => {
      input.addEventListener('change', async () => {
        await setItemSoldOut(input.dataset.soldout, input.checked);
      });
    });
  },

  subscribeOrders() {
    const q = query(
      collection(db, 'orders'),
      where('shopId', '==', getShopId()),
      orderBy('timestamp', 'desc')
    );
    onSnapshot(q, snap => {
      this.orders = snap.docs.map(d => d.data());
      this.renderStats();
    }, () => {
      // fallback: all orders filtered client-side (missing index)
      onSnapshot(query(collection(db, 'orders'), orderBy('timestamp', 'desc')), snap => {
        this.orders = snap.docs.map(d => d.data()).filter(o => (o.shopId || 'default') === getShopId());
        this.renderStats();
      }, () => this.renderStats());
    });
  },

  subscribeRequests() {
    this.unsubReq = subscribeServiceRequests(getShopId(), (rows) => {
      const open = rows.filter(r => r.status === 'open');
      const primed = this._knownReqIds.size > 0 || this._reqPrimed;
      const newBills = primed
        ? open.filter(r => r.type === 'bill' && !this._knownReqIds.has(r.id))
        : [];
      open.forEach(r => this._knownReqIds.add(r.id));
      this._reqPrimed = true;
      this.requests = open;
      this.renderRequests();
      if (newBills.length) this.playBillAlert(newBills[0]);
    });
  },

  playBillAlert(req) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = 880;
      g.gain.value = 0.08;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      setTimeout(() => { o.stop(); ctx.close(); }, 220);
    } catch (_) {}
    if (typeof document !== 'undefined' && document.title) {
      document.title = `🧾 席${req.tableNumber} 会計 | 店舗管理`;
    }
  },

  renderRequests() {
    let host = document.getElementById('storeRequests');
    if (!host) {
      host = document.createElement('section');
      host.id = 'storeRequests';
      host.className = 'store-card';
      host.innerHTML = `<h2>呼出・会計</h2><div id="storeRequestList"></div>`;
      document.querySelector('main')?.prepend(host);
    }
    const list = document.getElementById('storeRequestList');
    list.innerHTML = this.requests.map(r => {
      const note = (r.note || '').toLowerCase();
      let label = r.type === 'bill' ? '会計' : '店員呼出';
      if (r.type !== 'bill') {
        if (/water|お水/.test(note)) label = 'お水';
        else if (/towel|おしぼり/.test(note)) label = 'おしぼり';
        else if (/cutlery|カトラリー/.test(note)) label = 'カトラリー';
      }
      return `
      <div class="store-req-row ${r.type === 'bill' ? 'is-bill' : ''}">
        <div class="store-req-main">
          <strong>${label}</strong>
          <span class="store-req-seat">席 ${r.tableNumber}</span>
          ${r.type === 'bill' ? '<span class="store-req-hint">お客様はレジへ向かいます</span>' : ''}
          ${r.note && r.type !== 'bill' ? `<span class="store-req-hint">${r.note}</span>` : ''}
        </div>
        <button type="button" data-resolve="${r.id}" data-table="${r.tableNumber}">対応済</button>
      </div>`;
    }).join('') || '<p class="store-muted">現在なし</p>';
    list.querySelectorAll('[data-resolve]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.resolve;
        const table = btn.dataset.table;
        btn.disabled = true;
        btn.textContent = '済';
        // Optimistic: drop from list immediately
        this.requests = this.requests.filter(r => r.id !== id);
        this.renderRequests();
        document.title = `店舗管理 | ${getShop().name || 'QuickOrder'} (${getShopId()})`;
        resolveServiceRequest(id, { tableNumber: table }).catch((e) => {
          console.error(e);
          // Snapshot will refresh if write failed
        });
      });
    });
  },

  renderOrderHistory() {
    let host = document.getElementById('storeOrderHistory');
    if (!host) {
      host = document.createElement('section');
      host.id = 'storeOrderHistory';
      host.className = 'store-card';
      host.innerHTML = `<div class="store-card-head"><h2>注文履歴・明細</h2><button type="button" class="store-mini-btn" id="storeHistoryRefresh">更新</button></div><div id="storeHistoryList" class="oh-list"></div>`;
      const soldOut = document.getElementById('soldOutPanel');
      if (soldOut) soldOut.before(host);
      else document.querySelector('main')?.appendChild(host);
      document.getElementById('storeHistoryRefresh')?.addEventListener('click', () => this.renderOrderHistory());
    }
    const list = document.getElementById('storeHistoryList');
    if (!list) return;
    const rows = [...this.orders]
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 40);
    if (!rows.length) {
      list.innerHTML = '<p class="store-muted">まだ注文はありません</p>';
      return;
    }
    list.innerHTML = rows.map(o => orderDetailHtml(o, { showTable: true })).join('');
    bindOrderHistoryToggles(list);
  },

  renderStats() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const today = this.orders.filter(o => (o.timestamp || 0) >= start.getTime());
    const pending = this.orders.filter(o => (o.status || 'received') !== 'done').length;
    const gmv = today.reduce((s, o) => s + (o.total || 0), 0);
    document.getElementById('statPending').textContent = String(pending);
    document.getElementById('statToday').textContent = String(today.length);
    document.getElementById('statGmv').textContent = `¥${yen(gmv)}`;
    this.renderOrderHistory();
  },
};

document.addEventListener('DOMContentLoaded', () => StorePage.init());
