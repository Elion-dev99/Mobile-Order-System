import { db } from './firebase.js';
import {
  loadShop, saveShop, ensureMenuSeeded, saveMenu, getMenu, getShop, getShopId,
  isSubscribed, markSubscribed, setItemSoldOut, isItemSoldOut
} from './shop.js';
import { PLANS } from './config.js';
import { getPlan, yen, estimateMrr, estimateArr, featureEnabled } from './plans.js';
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

const AdminPage = {
  filter: 'received',
  view: 'orders',
  orders: [],
  leads: [],
  menuDraft: null,
  unlocked: false,
  knownOrderIds: new Set(),
  soundReady: false,

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
    this.menuDraft = await ensureMenuSeeded();
    this._menuSnapshot = JSON.parse(JSON.stringify(this.menuDraft?.items || []));
    this.applyShopBranding();
    this.bindChrome();
    this.patchNavLinks();

    if (!this.ensureAdminAccess()) return;

    this.subscribeToOrders();
    this.subscribeToLeads();
    this.subscribeRequests();
    this.renderMenuEditor();
    this.renderBilling();
    this.renderAnalytics();
    this.renderSettingsForm();

    if (params.get('view')) this.setView(params.get('view'));
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
    if (!shop.adminPin) {
      this.unlocked = true;
      return true;
    }
    try {
      if (sessionStorage.getItem(scopedKey('mos_admin_ok')) === '1') {
        this.unlocked = true;
        return true;
      }
    } catch (_) {}

    document.getElementById('adminGate')?.classList.remove('hidden');
    document.getElementById('adminPinSubmit')?.addEventListener('click', () => {
      const val = document.getElementById('adminPinInput')?.value || '';
      if (val === shop.adminPin) {
        try { sessionStorage.setItem(scopedKey('mos_admin_ok'), '1'); } catch (_) {}
        document.getElementById('adminGate')?.classList.add('hidden');
        this.unlocked = true;
        this.subscribeToOrders();
        this.subscribeToLeads();
        this.subscribeRequests();
        this.renderMenuEditor();
        this.renderBilling();
        this.renderAnalytics();
        this.renderSettingsForm();
      } else {
        alert('PINが違います');
      }
    });
    return false;
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
  },

  playNewOrderSound() {
    if (!featureEnabled(getShop(), 'soundAlert') || !this.soundReady) return;
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
        <div class="admin-req-chip">
          <span>${r.type === 'bill' ? '会計' : '呼出'} · 席${r.tableNumber}</span>
          <button type="button" data-resolve="${r.id}">済</button>
        </div>
      `).join('');
      host.querySelectorAll('[data-resolve]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await resolveServiceRequest(btn.dataset.resolve); } catch (e) { console.error(e); }
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

    const menu = this.menuDraft || getMenu();
    const slaOn = featureEnabled(getShop(), 'slaTimer');

    container.innerHTML = filtered.map(order => {
      const status = order.status || 'received';
      const cardClass = status === 'cooking' ? 'cooking' : status === 'done' ? 'done' : '';
      const statusLabel = { received: '📥 受付済み', cooking: '🔥 調理中', done: '✅ 完了' }[status] || '';
      const elapsed = Math.floor((Date.now() - order.timestamp) / 60000);
      const slaClass = slaOn && status !== 'done' && elapsed >= 15 ? 'sla-late' : slaOn && status !== 'done' && elapsed >= 8 ? 'sla-warn' : '';

      const actionBtns = status === 'received' ? `
        <button class="admin-action-btn start" data-id="${order.id}" data-status="cooking">🔥 調理開始</button>
        <button class="admin-action-btn complete" data-id="${order.id}" data-status="done">✅ 完了</button>
      ` : status === 'cooking' ? `
        <button class="admin-action-btn complete" style="flex:1;" data-id="${order.id}" data-status="done">✅ 完了にする</button>
      ` : `<div style="font-size:13px;color:#4A5568;text-align:center;padding:8px;">配膳完了</div>`;

      return `
        <div class="admin-order-card ${cardClass} ${slaClass}">
          <div class="admin-order-top">
            <div>
              <div class="admin-order-id">${order.id}</div>
              <div class="admin-order-time">${elapsed === 0 ? 'たった今' : elapsed + '分前'} — ${statusLabel}${slaOn && status !== 'done' ? ` · SLA ${elapsed}分` : ''}</div>
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
    list.innerHTML = this.menuDraft.items.map((item, idx) => {
      const customs = Array.isArray(item.customizable) ? item.customizable : [];
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
          <label class="me-check"><input type="checkbox" class="me-popular" ${item.popular ? 'checked' : ''}><span>人気</span></label>
          <label class="me-check"><input type="checkbox" class="me-soldout" data-id="${item.id}" ${isItemSoldOut(item.id) ? 'checked' : ''}><span>品切れ</span></label>
          <button type="button" class="me-del" data-idx="${idx}">削除</button>
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

      this.menuDraft.items[idx] = {
        ...this.menuDraft.items[idx],
        emoji: row.querySelector('.me-emoji')?.value || '🍽️',
        name: row.querySelector('.me-name')?.value || '無題',
        description: row.querySelector('.me-desc')?.value || '',
        price: Number(row.querySelector('.me-price')?.value) || 0,
        category: row.querySelector('.me-cat')?.value || 'side',
        popular: !!row.querySelector('.me-popular')?.checked,
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
    const unlocked = featureEnabled(shop, 'analytics');
    if (hint) {
      hint.textContent = unlocked
        ? `${getPlan(shop.planId).name}プラン · リアルタイム集計`
        : 'Growth以上で利用可能（設定でプランを変更）';
    }
    if (!unlocked) {
      document.getElementById('anTodayGmv').textContent = '—';
      document.getElementById('anTodayOrders').textContent = '—';
      document.getElementById('anAov').textContent = '—';
      document.getElementById('analyticsTopItems').innerHTML = '<p class="admin-muted">アップセルでGrowthに切り替えると表示されます。</p>';
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
    const selfMrr = isSubscribed()
      ? estimateMrr({ planId: shop.planId, stores: shop.stores || 1, cycle: shop.billingCycle || 'monthly' })
      : 0;

    const openLeads = this.leads.filter(l => (l.status || 'new') === 'new').length;
    const wonMrr = this.leads
      .filter(l => l.status === 'won')
      .reduce((s, l) => s + (l.estimatedMrr || getPlan(l.planId || 'growth').priceMonthly), 0);
    const pipelineMrr = selfMrr + wonMrr;

    const planName = document.getElementById('billingPlanName');
    const priceEl = document.getElementById('billingPrice');
    const leadsEl = document.getElementById('billingLeads');
    const mrrEl = document.getElementById('billingMrr');
    const arrEl = document.getElementById('billingArr');
    const subStatus = document.getElementById('subStatus');
    const catalog = document.getElementById('billingCatalog');

    if (planName) planName.textContent = plan.name;
    if (priceEl) priceEl.textContent = `¥${yen(plan.priceMonthly)}/月 · 初期¥${yen(plan.priceSetup)}`;
    if (leadsEl) leadsEl.textContent = String(openLeads);
    if (mrrEl) mrrEl.textContent = `¥${yen(pipelineMrr)}`;
    if (arrEl) arrEl.textContent = `¥${yen(estimateArr(pipelineMrr))}`;
    if (subStatus) {
      subStatus.textContent = isSubscribed()
        ? `課金有効 · ${plan.name} · 自店舗MRR ¥${yen(selfMrr)}`
        : '未課金 — 成約後に有効化するとMRRに反映されます';
    }
    if (catalog) {
      catalog.innerHTML = PLANS.map(p => `
        <div class="catalog-card ${p.id === plan.id ? 'active' : ''}">
          <div class="catalog-name">${p.name}${p.recommended ? ' ★' : ''}</div>
          <div class="catalog-price">¥${yen(p.priceMonthly)}<span>/月</span></div>
          <div class="catalog-setup">初期 ¥${yen(p.priceSetup)}</div>
          <div class="catalog-meta">${p.maxTables == null ? '席数無制限' : `〜${p.maxTables}席`} · ${p.maxStores == null ? '店舗無制限' : `${p.maxStores}店舗`}</div>
        </div>
      `).join('');
    }
  },

  async activateSubscription() {
    await markSubscribed();
    this.renderBilling();
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
  },

  async persistSettings() {
    const payload = {
      name: document.getElementById('settingName')?.value?.trim() || 'QuickOrder',
      subtitle: document.getElementById('settingSubtitle')?.value?.trim() || '',
      planId: document.getElementById('settingPlan')?.value || 'growth',
      billingCycle: document.getElementById('settingCycle')?.value || 'monthly',
      stores: Number(document.getElementById('settingStores')?.value) || 1,
      tableCount: Number(document.getElementById('settingTables')?.value) || 12,
      locale: document.getElementById('settingLocale')?.value || 'ja',
      adminPin: document.getElementById('settingAdminPin')?.value || '',
    };
    const prevPlan = getShop()?.planId;
    try {
      await saveShop(payload);
      notifyPlanChanged({ ...getShop(), id: getShopId() }, prevPlan, payload.planId);
      this.applyShopBranding();
      this.renderBilling();
      this.renderAnalytics();
      alert('設定を保存しました');
    } catch (e) {
      console.error(e);
      alert('保存に失敗しました');
    }
  },
};

window.AdminPage = AdminPage;
document.addEventListener('DOMContentLoaded', () => AdminPage.init());
