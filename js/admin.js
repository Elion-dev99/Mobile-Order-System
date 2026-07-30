import { db } from './firebase.js';
import {
  loadShop, saveShop, ensureMenuSeeded, saveMenu, getMenu, getShop,
  isSubscribed, markSubscribed
} from './shop.js';
import { PRODUCT } from './config.js';
import {
  collection, onSnapshot, doc, updateDoc, deleteDoc, query, orderBy
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const AdminPage = {
  filter: 'received',
  view: 'orders',
  orders: [],
  leads: [],
  menuDraft: null,
  unlocked: false,

  async init() {
    this.updateClock();
    setInterval(() => this.updateClock(), 1000);

    const params = new URLSearchParams(location.search);
    if (params.get('billing') === 'success') {
      await markSubscribed();
      history.replaceState({}, '', 'admin.html');
      alert('課金が有効になりました。ありがとうございます。');
    }

    await loadShop();
    this.menuDraft = await ensureMenuSeeded();
    this.applyShopBranding();
    this.bindChrome();

    if (!this.ensureAdminAccess()) return;

    this.subscribeToOrders();
    this.subscribeToLeads();
    this.renderMenuEditor();
    this.renderBilling();
    this.renderSettingsForm();

    if (params.get('view')) this.setView(params.get('view'));
  },

  ensureAdminAccess() {
    const shop = getShop();
    if (!shop.adminPin) {
      this.unlocked = true;
      return true;
    }
    try {
      if (sessionStorage.getItem('mos_admin_ok') === '1') {
        this.unlocked = true;
        return true;
      }
    } catch (_) {}

    document.getElementById('adminGate')?.classList.remove('hidden');
    document.getElementById('adminPinSubmit')?.addEventListener('click', () => {
      const val = document.getElementById('adminPinInput')?.value || '';
      if (val === shop.adminPin) {
        try { sessionStorage.setItem('mos_admin_ok', '1'); } catch (_) {}
        document.getElementById('adminGate')?.classList.add('hidden');
        this.unlocked = true;
        this.subscribeToOrders();
        this.subscribeToLeads();
        this.renderMenuEditor();
        this.renderBilling();
        this.renderSettingsForm();
      } else {
        alert('PINが違います');
      }
    });
    return false;
  },

  applyShopBranding() {
    const shop = getShop();
    const title = document.getElementById('adminShopName');
    if (title) title.textContent = `${shop.name} · 厨房`;
    document.title = `管理画面 | ${shop.name}`;
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
  },

  setView(view) {
    this.view = view;
    document.querySelectorAll('#adminViewTabs .admin-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
    });
    const map = {
      orders: 'ordersPanel',
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
  },

  subscribeToOrders() {
    if (!this.unlocked && getShop().adminPin) return;
    const q = query(collection(db, 'orders'), orderBy('timestamp', 'desc'));
    onSnapshot(q, snap => {
      this.orders = snap.docs.map(d => d.data());
      this.renderOrders();
      this.renderBilling();
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

    const menu = this.menuDraft || getMenu();

    container.innerHTML = filtered.map(order => {
      const status = order.status || 'received';
      const cardClass = status === 'cooking' ? 'cooking' : status === 'done' ? 'done' : '';
      const statusLabel = { received: '📥 受付済み', cooking: '🔥 調理中', done: '✅ 完了' }[status] || '';
      const elapsed = Math.floor((Date.now() - order.timestamp) / 60000);

      const actionBtns = status === 'received' ? `
        <button class="admin-action-btn start" data-id="${order.id}" data-status="cooking">🔥 調理開始</button>
        <button class="admin-action-btn complete" data-id="${order.id}" data-status="done">✅ 完了</button>
      ` : status === 'cooking' ? `
        <button class="admin-action-btn complete" style="flex:1;" data-id="${order.id}" data-status="done">✅ 完了にする</button>
      ` : `<div style="font-size:13px;color:#4A5568;text-align:center;padding:8px;">配膳完了</div>`;

      return `
        <div class="admin-order-card ${cardClass}">
          <div class="admin-order-top">
            <div>
              <div class="admin-order-id">${order.id}</div>
              <div class="admin-order-time">${elapsed === 0 ? 'たった今' : elapsed + '分前'} — ${statusLabel}</div>
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
            合計: ¥${(order.total || 0).toLocaleString()}
          </div>
          <div class="admin-action-row">${actionBtns}</div>
        </div>`;
    }).join('');

    container.querySelectorAll('[data-id][data-status]').forEach(btn => {
      btn.addEventListener('click', () => this.updateStatus(btn.dataset.id, btn.dataset.status));
    });
  },

  async updateStatus(orderId, status) {
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
    list.innerHTML = this.menuDraft.items.map((item, idx) => `
      <div class="menu-edit-row" data-idx="${idx}">
        <input class="me-emoji" value="${item.emoji || ''}" maxlength="4" title="絵文字">
        <input class="me-name" value="${this.escapeAttr(item.name)}" placeholder="商品名">
        <input class="me-price" type="number" value="${item.price}" min="0" step="10" placeholder="価格">
        <select class="me-cat">
          ${this.menuDraft.categories.filter(c => c.id !== 'all').map(c =>
            `<option value="${c.id}" ${c.id === item.category ? 'selected' : ''}>${c.label}</option>`
          ).join('')}
        </select>
        <label class="me-pop"><input type="checkbox" class="me-popular" ${item.popular ? 'checked' : ''}>人気</label>
        <button type="button" class="me-del" data-idx="${idx}">削除</button>
      </div>
    `).join('');

    list.querySelectorAll('.me-del').forEach(btn => {
      btn.addEventListener('click', () => {
        this.syncMenuDraftFromDom();
        this.menuDraft.items.splice(Number(btn.dataset.idx), 1);
        this.renderMenuEditor();
      });
    });
  },

  escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
  },

  syncMenuDraftFromDom() {
    const rows = document.querySelectorAll('#menuEditorList .menu-edit-row');
    rows.forEach((row, idx) => {
      if (!this.menuDraft.items[idx]) return;
      this.menuDraft.items[idx] = {
        ...this.menuDraft.items[idx],
        emoji: row.querySelector('.me-emoji')?.value || '🍽️',
        name: row.querySelector('.me-name')?.value || '無題',
        price: Number(row.querySelector('.me-price')?.value) || 0,
        category: row.querySelector('.me-cat')?.value || 'side',
        popular: !!row.querySelector('.me-popular')?.checked,
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
    });
    this.renderMenuEditor();
  },

  async persistMenu() {
    this.syncMenuDraftFromDom();
    try {
      await saveMenu(this.menuDraft);
      alert('メニューを保存しました');
    } catch (e) {
      console.error(e);
      alert('保存に失敗しました。Firestoreルールを確認してください。');
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
        <div class="lead-meta">席数: ${lead.tables || '-'} · ${lead.createdAt ? new Date(lead.createdAt).toLocaleString('ja-JP') : ''}</div>
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
          await updateDoc(doc(db, 'leads', btn.dataset.lead), { status: btn.dataset.leadStatus });
        } catch (e) { console.error(e); }
      });
    });
  },

  renderBilling() {
    const priceEl = document.getElementById('billingPrice');
    const leadsEl = document.getElementById('billingLeads');
    const mrrEl = document.getElementById('billingMrr');
    const subStatus = document.getElementById('subStatus');
    if (priceEl) priceEl.textContent = `¥${PRODUCT.priceMonthly.toLocaleString()}`;
    const openLeads = this.leads.filter(l => (l.status || 'new') === 'new').length;
    if (leadsEl) leadsEl.textContent = String(openLeads);
    const won = this.leads.filter(l => l.status === 'won').length;
    const subs = (isSubscribed() ? 1 : 0) + won;
    if (mrrEl) mrrEl.textContent = `¥${(subs * PRODUCT.priceMonthly).toLocaleString()}`;
    if (subStatus) {
      subStatus.textContent = isSubscribed()
        ? 'このデモ店舗は課金有効です'
        : '未課金 — Stripeリンク設定後、または下のボタンで有効化';
    }
  },

  async activateSubscription() {
    await markSubscribed();
    this.renderBilling();
    alert('課金フラグを有効化しました（MRRに反映）');
  },

  renderSettingsForm() {
    const shop = getShop();
    const name = document.getElementById('settingName');
    const subtitle = document.getElementById('settingSubtitle');
    const tables = document.getElementById('settingTables');
    const pin = document.getElementById('settingAdminPin');
    if (name) name.value = shop.name || '';
    if (subtitle) subtitle.value = shop.subtitle || '';
    if (tables) tables.value = shop.tableCount || 12;
    if (pin) pin.value = shop.adminPin || '';
  },

  async persistSettings() {
    const payload = {
      name: document.getElementById('settingName')?.value?.trim() || 'QuickOrder',
      subtitle: document.getElementById('settingSubtitle')?.value?.trim() || '',
      tableCount: Number(document.getElementById('settingTables')?.value) || 12,
      adminPin: document.getElementById('settingAdminPin')?.value || '',
    };
    try {
      await saveShop(payload);
      this.applyShopBranding();
      alert('設定を保存しました');
    } catch (e) {
      console.error(e);
      alert('保存に失敗しました');
    }
  },
};

window.AdminPage = AdminPage;
document.addEventListener('DOMContentLoaded', () => AdminPage.init());
