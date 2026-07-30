import { loadShop, saveShop, getShop, isSubscribed } from './shop.js';
import { getPlan, yen } from './plans.js';
import { db } from './firebase.js';
import {
  collection, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const StorePage = {
  orders: [],

  async init() {
    await loadShop();
    this.bind();
    this.renderProfile();
    this.renderTables();
    this.renderMeta();
    this.subscribeOrders();
    setInterval(() => this.tickClock(), 1000);
    this.tickClock();
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
    document.title = `店舗管理 | ${shop.name || 'QuickOrder'}`;
    const sub = [
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
  },

  tableUrl(n) {
    const u = new URL('index.html', location.href);
    u.searchParams.set('table', String(n));
    return u.href;
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

  subscribeOrders() {
    const q = query(collection(db, 'orders'), orderBy('timestamp', 'desc'));
    onSnapshot(q, snap => {
      this.orders = snap.docs.map(d => d.data());
      this.renderStats();
    }, () => {
      this.renderStats();
    });
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
  },
};

document.addEventListener('DOMContentLoaded', () => StorePage.init());
