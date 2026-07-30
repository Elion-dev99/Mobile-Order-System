import {
  isOpsAuthed, verifyOpsPassword, setOpsRole, clearOpsAuth, getOpsRole, setCustomOpsPassword
} from './ops-auth.js';
import {
  listShops, upsertShop, deleteShop, ensureSeedShops
} from './shop.js';
import { guestEntryUrl, DEFAULT_SHOP_ID } from './tenant.js';
import { db } from './firebase.js';
import { yen, getPlan, estimateMrr } from './plans.js';
import {
  collection, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { resolveServiceRequest } from './guest-features.js';
import {
  testDiscordNotify,
  testAllDiscordEvents,
  loadNotifySettings,
  saveNotifySettings,
  getSetupStatus,
  getNotifyEvents,
  getNotifySettings,
  NOTIFY_EVENTS,
} from './notify.js';
import { maybeNotifySystemLoad, notifySystemLoadNow, assessSystemLoad } from './load-monitor.js';
import {
  runHealthCheckAndNotify,
  playbookFor,
  listPendingOrders,
} from './health.js';
import { startAutoHeal, escalateToCursor, runAutoHealCycle, getAutoHealState } from './auto-heal.js';

const OpsPage = {
  shops: [],
  orders: [],
  leads: [],
  surveys: [],
  requests: [],
  unsubReq: null,
  _loadNotifyTimer: null,
  _healthTimer: null,
  health: null,

  async init() {
    if (!isOpsAuthed()) {
      this.showGate();
      return;
    }
    await this.enterApp();
  },

  async enterApp() {
    this.showApp();
    this.renderRole();
    this.bind();
    try {
      await ensureSeedShops();
    } catch (e) {
      console.warn('ensureSeedShops', e);
    }
    try {
      await this.refreshShops();
    } catch (e) {
      console.warn('refreshShops', e);
    }
    try {
      this.subscribeGlobal();
    } catch (e) {
      console.warn('subscribeGlobal', e);
    }
    this.renderLabs();
    await this.refreshNotifySetup();
    await this.refreshHealth();
    this.startHealthPolling();
    startAutoHeal({ intervalMs: 45_000 });
    const params = new URLSearchParams(location.search);
    if (params.get('tab') === 'notify') this.switchTab('notify');
    else {
      const status = await getSetupStatus().catch(() => null);
      if (status?.needsSetup) this.switchTab('notify');
    }
    window.scrollTo(0, 0);
  },

  startHealthPolling() {
    clearInterval(this._healthTimer);
    this._healthTimer = setInterval(() => {
      this.refreshHealth({ notify: true }).catch(() => {});
    }, 60_000);
    window.addEventListener('online', () => this.refreshHealth({ notify: true }));
    window.addEventListener('offline', () => this.refreshHealth({ notify: true }));
  },

  async refreshHealth({ notify = true } = {}) {
    try {
      if (notify) {
        const { health } = await runHealthCheckAndNotify();
        this.health = health;
      } else {
        const { checkSystemHealth } = await import('./health.js');
        this.health = await checkSystemHealth();
      }
    } catch (_) {
      this.health = {
        status: 'down',
        label: '障害',
        emoji: '🔴',
        firestore: { ok: false },
        notifyApi: { functionReady: false },
        online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
      };
    }
    this.renderHealth();
  },

  renderHealth() {
    const h = this.health;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    if (!h) {
      set('hqHealth', '確認中');
      return;
    }
    set('hqHealth', `${h.emoji || ''} ${h.label || h.status}`);
    const banner = document.getElementById('opsHealthBanner');
    const book = document.getElementById('opsHealthPlaybook');
    const list = document.getElementById('opsHealthPlaybookList');
    const pending = listPendingOrders().length;
    const heal = getAutoHealState();
    if (banner) {
      if (h.status === 'ok') {
        banner.hidden = true;
        banner.innerHTML = '';
      } else {
        banner.hidden = false;
        banner.dataset.level = h.status;
        const healHint = heal.consecutiveFails
          ? ` · 自動対処カウント ${heal.consecutiveFails}`
          : '';
        banner.innerHTML = `<strong>${h.emoji || ''} サーバー状態: ${escapeHtml(h.label || h.status)}</strong>
          <span>Firestore: ${h.firestore?.ok ? 'OK' : '障害'} · 通知API: ${h.notifyApi?.functionReady ? 'OK' : '障害'}${pending ? ` · 保留注文 ${pending}件` : ''}${healHint}</span>`;
      }
    }
    if (book && list) {
      const show = h.status !== 'ok';
      book.hidden = !show;
      if (show) {
        list.innerHTML = playbookFor(h.status).map(s => `<li>${escapeHtml(s)}</li>`).join('');
      }
    }
  },

  showGate() {
    const gate = document.getElementById('opsGate');
    const app = document.getElementById('opsApp');
    if (gate) {
      gate.hidden = false;
      gate.classList.add('is-visible');
      gate.style.display = '';
    }
    if (app) {
      app.hidden = true;
      app.classList.remove('is-visible');
      app.style.display = 'none';
    }

    document.getElementById('opsShowPw')?.addEventListener('change', (e) => {
      const input = document.getElementById('opsPassword');
      if (input) input.type = e.target.checked ? 'text' : 'password';
    });
    document.querySelectorAll('[data-fill]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const input = document.getElementById('opsPassword');
        if (input) input.value = btn.dataset.fill;
        // ワンタップ入室（入力だけで終わらないようにする）
        await this.tryLogin(btn.dataset.fill, btn);
      });
    });

    const form = document.getElementById('opsLoginForm');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = form.querySelector('button[type="submit"]');
      const pw = document.getElementById('opsPassword').value;
      await this.tryLogin(pw, btn);
    });
  },

  async tryLogin(password, btn) {
    const err = document.getElementById('opsLoginError');
    if (err) {
      err.hidden = true;
      err.textContent = '';
    }
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '入室中...';
    }
    let res;
    try {
      res = await verifyOpsPassword(password);
    } catch (ex) {
      console.error(ex);
      if (err) {
        err.hidden = false;
        err.textContent = '認証処理でエラーが出ました。再読み込みしてください';
      }
      if (btn) { btn.disabled = false; btn.textContent = original || '入室'; }
      return;
    }
    if (!res.ok) {
      if (err) {
        err.hidden = false;
        err.textContent = 'パスワードが違います（Cursor: cursor2026 / Owner: owner2026）';
      }
      if (btn) { btn.disabled = false; btn.textContent = original || '入室'; }
      return;
    }
    setOpsRole(res.role);
    try {
      await this.enterApp();
    } catch (ex) {
      console.error(ex);
      if (err) {
        err.hidden = false;
        err.textContent = '画面の切替に失敗しました。もう一度お試しください';
      }
      if (btn) { btn.disabled = false; btn.textContent = original || '入室'; }
    }
  },

  _removeGateHandlers() {},

  showApp() {
    const gate = document.getElementById('opsGate');
    const app = document.getElementById('opsApp');
    if (gate) {
      gate.hidden = true;
      gate.classList.remove('is-visible');
      gate.style.display = 'none';
    }
    if (app) {
      app.hidden = false;
      app.classList.add('is-visible');
      app.style.display = 'block';
    }
  },

  renderRole() {
    const role = getOpsRole();
    document.getElementById('opsRoleBadge').textContent =
      role === 'cursor' ? 'Cursor' : role === 'owner' ? 'Owner' : '—';
  },

  bind() {
    if (this._bound) return;
    this._bound = true;
    document.getElementById('opsLogout')?.addEventListener('click', () => {
      clearOpsAuth();
      location.href = 'ops.html';
    });
    document.querySelectorAll('[data-ops-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.opsTab));
    });
    document.getElementById('createShopForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rawId = document.getElementById('newShopId').value.trim().toLowerCase();
      const id = rawId.replace(/[^a-z0-9_-]/g, '').slice(0, 48);
      const name = document.getElementById('newShopName').value.trim();
      const status = document.getElementById('createShopStatus');
      status.hidden = false;
      status.textContent = '作成中...';
      if (!id || id.length < 2) {
        status.textContent = '店舗IDは英小文字・数字・ハイフンで2文字以上にしてください';
        return;
      }
      try {
        await upsertShop(id, {
          name: name || id,
          subtitle: document.getElementById('newShopSubtitle').value.trim(),
          tableCount: Number(document.getElementById('newShopTables').value) || 10,
          planId: document.getElementById('newShopPlan').value || 'growth',
          isOpen: true,
        });
        status.textContent = `店舗「${name || id}」(${id}) を作成しました`;
        e.target.reset();
        await this.refreshShops();
        this.switchTab('shops');
      } catch (err) {
        console.error(err);
        status.textContent = '作成に失敗: ' + (err.message || err);
      }
    });
    document.getElementById('opsPwForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const role = document.getElementById('opsPwRole').value;
      const pw = document.getElementById('opsPwNew').value;
      const st = document.getElementById('opsPwStatus');
      try {
        await setCustomOpsPassword(role, pw);
        st.hidden = false;
        st.textContent = `${role} のパスワードを更新しました（このブラウザ）`;
        e.target.reset();
      } catch (err) {
        st.hidden = false;
        st.textContent = String(err.message || err);
      }
    });

    document.getElementById('opsNotifyForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const st = document.getElementById('opsNotifyStatus');
      st.hidden = false;
      st.textContent = '保存中...';
      try {
        await saveNotifySettings({
          webhook: document.getElementById('opsNotifyWebhook')?.value?.trim() || '',
          channel: document.getElementById('opsNotifyChannel')?.value?.trim() || '',
          enabled: !!document.getElementById('opsNotifyEnabled')?.checked,
          events: this.readEventToggles(),
        });
        st.textContent = '通知設定を保存しました（このブラウザ + 可能ならクラウド同期）';
        await this.refreshNotifySetup();
      } catch (err) {
        st.textContent = String(err.message || err);
      }
    });

    document.getElementById('opsNotifyTest')?.addEventListener('click', async () => {
      const st = document.getElementById('opsNotifyStatus');
      st.hidden = false;
      st.textContent = '送信中...';
      try {
        await saveNotifySettings({
          webhook: document.getElementById('opsNotifyWebhook')?.value?.trim() || '',
          channel: document.getElementById('opsNotifyChannel')?.value?.trim() || '',
          enabled: !!document.getElementById('opsNotifyEnabled')?.checked,
          events: this.readEventToggles(),
        });
      } catch (err) {
        st.textContent = String(err.message || err);
        return;
      }
      const res = await testDiscordNotify();
      if (res.ok) {
        st.textContent = 'テスト通知を送信しました。Discord を確認してください。';
        await saveNotifySettings({ setupDone: true });
      } else if (res.data?.error === 'webhook_missing') {
        st.textContent = 'Webhook 未設定です。Discord で Webhook を作成し、②に貼り付けて保存してください。';
      } else {
        st.textContent = '送信失敗: ' + (res.data?.error || res.error || res.status || 'unknown');
      }
      await this.refreshNotifySetup();
    });

    const runAllEventTests = async (btn) => {
      const st = document.getElementById('opsNotifyStatus');
      st.hidden = false;
      st.textContent = '全イベント送信準備中...';
      if (btn) btn.disabled = true;
      try {
        await saveNotifySettings({
          webhook: document.getElementById('opsNotifyWebhook')?.value?.trim() || '',
          channel: document.getElementById('opsNotifyChannel')?.value?.trim() || '',
          enabled: true,
          events: this.readEventToggles(),
        });
      } catch (err) {
        st.textContent = String(err.message || err);
        if (btn) btn.disabled = false;
        return;
      }
      const summary = await testAllDiscordEvents({
        onProgress: ({ index, total, title }) => {
          st.textContent = `全イベントテスト中... ${index}/${total}「${title}」`;
        },
      });
      if (summary.failed === 0 && summary.sent > 0) {
        st.textContent = `全 ${summary.sent} 件のイベント通知を送信しました。Discord を確認してください。`;
        await saveNotifySettings({ setupDone: true });
      } else if (summary.sent === 0) {
        const first = summary.results?.[0];
        st.textContent = '送信失敗: ' + (first?.data?.error || first?.error || first?.status || 'webhook を確認してください');
      } else {
        st.textContent = `送信 ${summary.sent} 件 / 失敗 ${summary.failed} 件。Discord とログを確認してください。`;
      }
      if (btn) btn.disabled = false;
      await this.refreshNotifySetup();
    };

    document.getElementById('opsNotifyTestAll')?.addEventListener('click', (e) => runAllEventTests(e.currentTarget));
    document.getElementById('opsNotifyTestAllBottom')?.addEventListener('click', (e) => runAllEventTests(e.currentTarget));

    document.getElementById('opsNotifyLoadNow')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const st = document.getElementById('opsNotifyStatus');
      st.hidden = false;
      st.textContent = '負荷状況を送信中...';
      if (btn) btn.disabled = true;
      const shopId = document.getElementById('labShop')?.value || this.shops[0]?.id || DEFAULT_SHOP_ID;
      const shop = this.shops.find(s => s.id === shopId) || { id: shopId, name: shopId };
      const orders = (this.orders || []).filter(o => (o.shopId || DEFAULT_SHOP_ID) === shopId);
      const requests = (this.requests || []).filter(r => (r.shopId || DEFAULT_SHOP_ID) === shopId);
      const res = await notifySystemLoadNow({
        shopId,
        shopName: shop.name || shopId,
        orders,
        requests,
      });
      if (res.ok) {
        st.textContent = `負荷「${res.assessment?.emoji || ''} ${res.assessment?.label || ''}」を Discord に送信しました（待ち${res.assessment?.waitMin || 0}分）`;
      } else {
        st.textContent = '送信失敗: ' + (res.data?.error || res.error || res.status || 'unknown');
      }
      if (btn) btn.disabled = false;
    });

    document.getElementById('opsHealthRecheck')?.addEventListener('click', async () => {
      const st = document.getElementById('opsHealthStatus');
      if (st) { st.hidden = false; st.textContent = '再チェック中...'; }
      await this.refreshHealth({ notify: false });
      if (st) st.textContent = `結果: ${this.health?.emoji || ''} ${this.health?.label || ''}`;
    });
    document.getElementById('opsHealthNotify')?.addEventListener('click', async () => {
      const st = document.getElementById('opsHealthStatus');
      if (st) { st.hidden = false; st.textContent = 'Discordへ送信中...'; }
      const { health } = await runHealthCheckAndNotify({ forceNotify: true });
      this.health = health;
      this.renderHealth();
      if (st) st.textContent = `送信しました（${health?.emoji || ''} ${health?.label || ''}）`;
    });

    const requestAutoFix = async (btn) => {
      const st = document.getElementById('opsHealthStatus') || document.createElement('p');
      st.hidden = false;
      st.textContent = 'Cursor自動対処を起動中...';
      if (btn) btn.disabled = true;
      const cycle = await runAutoHealCycle({ escalateAfterFails: 1, escalateCooldownMs: 0 });
      // Force escalate regardless of streak
      const res = await escalateToCursor({
        status: this.health?.status || cycle.health?.status || 'manual',
        severity: 'critical',
        summary: 'Opsから手動で Cursor 自動対処を依頼',
        message: 'ユーザーが「Cursorに自動対処を依頼」を押しました。健康状態を調査し、直せる箇所はPRを作成してください。',
        firestoreOk: !!(this.health?.firestore?.ok ?? cycle.health?.firestore?.ok),
        notifyApiOk: !!(this.health?.notifyApi?.functionReady ?? cycle.health?.notifyApi?.functionReady),
        flush: cycle.flush,
      });
      if (res.ok) {
        const agentOk = res.data?.cursor?.agent?.ok || res.data?.cursor?.automation?.ok;
        st.id = 'opsHealthStatus';
        st.textContent = agentOk
          ? 'Cursor Cloud Agent の起動を依頼しました。cursor.com/agents を確認してください。'
          : (res.data?.hint || '受付ました。CURSOR_API_KEY 未設定の場合は Cloudflare にキーを追加してください。');
        const host = document.getElementById('opsHealthPlaybook') || document.getElementById('opsAutoHealGuide');
        if (host && !document.getElementById('opsHealthStatus')) host.appendChild(st);
      } else {
        st.textContent = '起動失敗: ' + (res.error || res.data?.error || 'unknown');
      }
      if (btn) btn.disabled = false;
    };

    document.getElementById('opsHealthAutoFix')?.addEventListener('click', (e) => requestAutoFix(e.currentTarget));
    document.getElementById('opsHealthAutoFixIdle')?.addEventListener('click', (e) => requestAutoFix(e.currentTarget));

    document.getElementById('opsNotifySaveEvents')?.addEventListener('click', async () => {
      const st = document.getElementById('opsNotifyStatus');
      st.hidden = false;
      try {
        await saveNotifySettings({ events: this.readEventToggles() });
        st.textContent = 'イベント設定を保存しました';
        await this.refreshNotifySetup();
      } catch (err) {
        st.textContent = String(err.message || err);
      }
    });

    document.getElementById('opsNotifyMarkDone')?.addEventListener('click', async () => {
      const st = document.getElementById('opsNotifyStatus');
      st.hidden = false;
      await saveNotifySettings({ setupDone: true, enabled: true });
      st.textContent = 'セットアップ完了にしました';
      await this.refreshNotifySetup();
    });

  },

  readEventToggles() {
    const events = {};
    document.querySelectorAll('#notifyEventList [data-event]').forEach(input => {
      events[input.dataset.event] = !!input.checked;
    });
    return events;
  },

  async refreshNotifySetup() {
    await loadNotifySettings().catch(() => {});
    this.renderNotifyForm();
    const status = await getSetupStatus().catch(() => null);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    if (!status) {
      set('notifyApiStatus', '不明');
      return;
    }

    set('notifyApiStatus', status.api?.functionReady ? '稼働' : '未検出');
    set('notifyWebhookStatus', status.hasWebhook
      ? (status.api?.hasEnvWebhook && !status.settings?.webhook ? 'CF秘密' : '設定済')
      : '未設定');
    set('notifyEnabledStatus', status.settings?.enabled ? 'ON' : 'OFF');
    set('notifyReadyStatus', status.ready ? 'OK' : '要設定');

    const banner = document.getElementById('notifySetupBanner');
    // Webhook設定済みなら黄色い初期設定バナーは出さない
    if (banner) banner.hidden = !status.needsSetup;

    const list = document.getElementById('notifyChecklist');
    if (list) {
      list.innerHTML = `
        <li class="${status.hasWebhook ? 'ok' : ''}">Webhook URL を保存した ${status.hasWebhook ? '✓' : ''}</li>
        <li class="${status.api?.functionReady ? 'ok' : ''}">通知API（/api/notify）が稼働 ${status.api?.functionReady ? '✓' : ''}</li>
        <li class="${status.settings?.setupDone ? 'ok' : ''}">テスト送信 or セットアップ完了 ${status.settings?.setupDone ? '✓' : ''}</li>
      `;
    }
  },

  renderNotifyForm() {
    const settings = getNotifySettings();
    const input = document.getElementById('opsNotifyWebhook');
    const enabled = document.getElementById('opsNotifyEnabled');
    const channel = document.getElementById('opsNotifyChannel');
    if (input) input.value = settings.webhook || '';
    if (enabled) enabled.checked = settings.enabled !== false;
    if (channel) channel.value = settings.channel || '';

    const list = document.getElementById('notifyEventList');
    if (list) {
      const events = getNotifyEvents();
      list.innerHTML = NOTIFY_EVENTS.map(ev => `
        <label class="ops-event-item">
          <input type="checkbox" data-event="${ev.id}" ${events[ev.id] !== false ? 'checked' : ''}>
          <span>${escapeHtml(ev.label)}</span>
        </label>
      `).join('');
    }
  },

  switchTab(id) {
    document.querySelectorAll('[data-ops-tab]').forEach(b => {
      b.classList.toggle('active', b.dataset.opsTab === id);
    });
    document.querySelectorAll('[data-ops-panel]').forEach(p => {
      p.hidden = p.dataset.opsPanel !== id;
    });
    if (id === 'shops') this.renderShops();
    if (id === 'hq') this.renderHq();
    if (id === 'requests') this.renderRequests();
    if (id === 'surveys') this.renderSurveys();
    if (id === 'lab') this.renderLabs();
    if (id === 'notify') this.refreshNotifySetup();
  },

  async refreshShops() {
    this.shops = await listShops();
    this.renderShops();
    this.renderHq();
    this.fillLabSelect();
  },

  renderShops() {
    const el = document.getElementById('shopsList');
    if (!el) return;
    el.innerHTML = this.shops.map(s => {
      const guest = guestEntryUrl(s.id, 1);
      const demo = guestEntryUrl(s.id, 1, { demo: 1 });
      const admin = `admin.html?shop=${encodeURIComponent(s.id)}`;
      const store = `store.html?shop=${encodeURIComponent(s.id)}`;
      return `
        <article class="ops-shop-card">
          <header>
            <h3>${escapeHtml(s.name || s.id)}</h3>
            <code>${escapeHtml(s.id)}</code>
          </header>
          <p>${escapeHtml(s.subtitle || '')} · ${escapeHtml(s.hoursNote || '')} · 席${s.tableCount || 0}</p>
          <p class="ops-muted">${s.isOpen === false ? '準備中' : '営業中'} · ${getPlan(s.planId).name}</p>
          <div class="ops-shop-actions">
            <a href="${guest}" target="_blank">客席</a>
            <a href="${demo}" target="_blank">テスト</a>
            <a href="${admin}" target="_blank">厨房</a>
            <a href="${store}" target="_blank">店舗管理</a>
            ${s.id !== DEFAULT_SHOP_ID ? `<button type="button" data-del="${s.id}">削除</button>` : ''}
          </div>
        </article>`;
    }).join('') || '<p class="ops-muted">店舗がありません</p>';

    el.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`${btn.dataset.del} を削除しますか？`)) return;
        await deleteShop(btn.dataset.del);
        await this.refreshShops();
      });
    });
  },

  scheduleLoadNotify() {
    clearTimeout(this._loadNotifyTimer);
    this._loadNotifyTimer = setTimeout(() => {
      const shops = this.shops?.length ? this.shops : [{ id: DEFAULT_SHOP_ID, name: DEFAULT_SHOP_ID }];
      shops.forEach(shop => {
        const orders = (this.orders || []).filter(o => (o.shopId || DEFAULT_SHOP_ID) === shop.id);
        const requests = (this.requests || []).filter(r => (r.shopId || DEFAULT_SHOP_ID) === shop.id);
        maybeNotifySystemLoad({
          shopId: shop.id,
          shopName: shop.name || shop.id,
          orders,
          requests,
        }).catch(() => {});
      });
    }, 1500);
  },

  subscribeGlobal() {
    onSnapshot(query(collection(db, 'orders'), orderBy('timestamp', 'desc')), snap => {
      this.orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this.renderHq();
      this.renderLabs();
      this.scheduleLoadNotify();
    }, () => {});

    onSnapshot(query(collection(db, 'leads'), orderBy('createdAt', 'desc')), snap => {
      this.leads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this.renderHq();
    }, () => {});

    onSnapshot(query(collection(db, 'surveys'), orderBy('timestamp', 'desc')), snap => {
      this.surveys = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this.renderSurveys();
      this.renderHq();
    }, () => {});

    // All open service requests (across shops) — fallback client filter if composite index missing
    onSnapshot(query(collection(db, 'serviceRequests'), orderBy('timestamp', 'desc')), snap => {
      this.requests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this.renderRequests();
      this.renderHq();
      this.scheduleLoadNotify();
    }, () => {});
  },

  renderHq() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const today = this.orders.filter(o => (o.timestamp || 0) >= start.getTime() && !o.demo);
    const gmv = today.reduce((s, o) => s + (o.total || 0), 0);
    const openReq = this.requests.filter(r => r.status === 'open').length;
    const scores = this.surveys.map(s => s.score).filter(Boolean);
    const nps = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '—';

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('hqShops', String(this.shops.length));
    set('hqOrders', String(today.length));
    set('hqGmv', `¥${yen(gmv)}`);
    set('hqLeads', String(this.leads.filter(l => l.status === 'new').length));
    set('hqRequests', String(openReq));
    set('hqNps', String(nps));

    const byShop = {};
    today.forEach(o => {
      const id = o.shopId || DEFAULT_SHOP_ID;
      byShop[id] = byShop[id] || { orders: 0, gmv: 0 };
      byShop[id].orders += 1;
      byShop[id].gmv += o.total || 0;
    });
    // include shops that have open load even without today sales
    (this.shops || []).forEach(s => {
      if (!byShop[s.id]) byShop[s.id] = { orders: 0, gmv: 0 };
    });
    const rows = document.getElementById('hqShopRows');
    if (rows) {
      rows.innerHTML = Object.entries(byShop).map(([id, v]) => {
        const shop = this.shops.find(s => s.id === id);
        const shopOrders = this.orders.filter(o => (o.shopId || DEFAULT_SHOP_ID) === id);
        const shopReqs = this.requests.filter(r => (r.shopId || DEFAULT_SHOP_ID) === id);
        const load = assessSystemLoad({ orders: shopOrders, requests: shopReqs });
        return `<tr>
          <td>${escapeHtml(shop?.name || id)}</td>
          <td>${v.orders}</td>
          <td>¥${yen(v.gmv)}</td>
          <td>${load.waitMin}分</td>
          <td>${load.emoji} ${escapeHtml(load.label)}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="5">本日の注文なし</td></tr>';
    }

    const mrr = this.shops.reduce((s, shop) => s + estimateMrr({
      planId: shop.planId,
      cycle: shop.billingCycle || 'monthly',
      stores: 1,
    }), 0);
    set('hqMrr', `¥${yen(mrr)}`);
  },

  renderRequests() {
    const el = document.getElementById('requestsList');
    if (!el) return;
    const open = this.requests.filter(r => r.status === 'open');
    el.innerHTML = open.map(r => `
      <div class="ops-req">
        <div>
          <strong>${r.type === 'bill' ? '会計' : '店員呼出'}</strong>
          · ${escapeHtml(r.shopId || '')} · 席${escapeHtml(String(r.tableNumber))}
          <div class="ops-muted">${new Date(r.timestamp || 0).toLocaleString('ja-JP')}</div>
        </div>
        <button type="button" data-resolve="${r.id}">対応済</button>
      </div>
    `).join('') || '<p class="ops-muted">オープンな呼出はありません</p>';

    el.querySelectorAll('[data-resolve]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await resolveServiceRequest(btn.dataset.resolve);
        } catch (e) {
          console.error(e);
        }
      });
    });
  },

  renderSurveys() {
    const el = document.getElementById('surveysList');
    if (!el) return;
    el.innerHTML = this.surveys.slice(0, 40).map(s => `
      <div class="ops-survey">
        <strong>${'★'.repeat(s.score || 0)}${'☆'.repeat(5 - (s.score || 0))}</strong>
        <span>${escapeHtml(s.shopName || s.shopId || '')}</span>
        <p>${escapeHtml(s.comment || '（コメントなし）')}</p>
      </div>
    `).join('') || '<p class="ops-muted">アンケートまだなし</p>';
  },

  fillLabSelect() {
    const sel = document.getElementById('labShop');
    if (!sel) return;
    sel.innerHTML = this.shops.map(s =>
      `<option value="${s.id}">${escapeHtml(s.name)} (${s.id})</option>`
    ).join('');
  },

  renderLabs() {
    const sel = document.getElementById('labShop');
    const shopId = sel?.value || DEFAULT_SHOP_ID;
    const links = document.getElementById('labLinks');
    if (links) {
      links.innerHTML = `
        <a class="ops-btn" href="${guestEntryUrl(shopId, 1, { demo: 1 })}" target="_blank">客席テストモード</a>
        <a class="ops-btn" href="${guestEntryUrl(shopId, 3)}" target="_blank">席3 本番URL</a>
        <a class="ops-btn" href="admin.html?shop=${shopId}" target="_blank">厨房</a>
        <a class="ops-btn" href="store.html?shop=${shopId}" target="_blank">店舗管理</a>
        <a class="ops-btn secondary" href="lp.html" target="_blank">販売LP</a>
      `;
    }
    sel?.addEventListener('change', () => this.renderLabs());

    const checklist = document.getElementById('labChecklist');
    if (checklist) {
      checklist.innerHTML = `
        <li>店舗URLが <code>?shop=</code> で分離されている</li>
        <li>テストモード注文は Firestore に書かれない</li>
        <li>店員呼出・会計リクエストが総合管理に届く</li>
        <li>品切れ反映が客席に即時出る（店舗管理/厨房）</li>
        <li>完了後アンケートが surveys に残る</li>
        <li>カートにサイド・ドリンクのアップセルが出る</li>
      `;
    }

    const featureMatrix = document.getElementById('featureMatrix');
    if (featureMatrix) {
      featureMatrix.innerHTML = `
        <tr><td>店舗テナント分割</td><td>実装</td><td>URL/Firestore を店舗IDで分離</td></tr>
        <tr><td>品切れ（Sold out）</td><td>実装</td><td>業界標準の欠品管理</td></tr>
        <tr><td>店員呼出 / 会計</td><td>実装</td><td>ダイニー等の定番UX</td></tr>
        <tr><td>厨房混雑ETA</td><td>実装</td><td>待ち時間予測</td></tr>
        <tr><td>来店後アンケート</td><td>実装</td><td>QSC改善ループ</td></tr>
        <tr><td>カートアップセル</td><td>実装</td><td>客単価向上</td></tr>
        <tr><td>HQ横断ダッシュボード</td><td>実装</td><td>Chain向け本部視点</td></tr>
      `;
    }
  },
};

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', () => OpsPage.init());
