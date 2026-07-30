import {
  isOpsAuthed, verifyOpsPassword, setOpsRole, clearOpsAuth, getOpsRole, setCustomOpsPassword
} from './ops-auth.js';
import { getOpsApiSecret, setOpsApiSecret, clearOpsApiSecret } from './ops-secret.js';
import {
  listShops, upsertShop, deleteShop, ensureSeedShops
} from './shop.js';
import { guestEntryUrl, DEFAULT_SHOP_ID, listSeedShops } from './tenant.js';
import { db, firebaseConfig } from './firebase.js';
import { yen, getPlan, estimateMrr, planComparisonRows, PLANS, PRODUCT } from './plans.js';
import {
  collection, onSnapshot, query, orderBy, doc, updateDoc, deleteDoc, setDoc,
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
  getDiscordWebhook,
  isLikelyDiscordWebhook,
  notifyLeadWon,
  NOTIFY_EVENTS,
} from './notify.js';
import { maybeNotifySystemLoad, notifySystemLoadNow, assessSystemLoad } from './load-monitor.js';
import {
  runHealthCheckAndNotify,
  playbookFor,
  listPendingOrders,
  flushPendingOrders,
} from './health.js';
import { runFullLoadTest, ensureWebhookReady, cleanupLoadTestShops } from './load-test.js';
import {
  startCardinal,
  runCardinalCycle,
  runCardinalDrill,
  getCardinalSnapshot,
  cardinalApi,
} from './cardinal.js';
import { escalateToCursor, runAutoHealCycle, getAutoHealState } from './auto-heal.js';
import { ordersToCsv, downloadCsv } from './guest-extras.js';

const OpsPage = {
  shops: [],
  orders: [],
  leads: [],
  surveys: [],
  requests: [],
  unsubReq: null,
  _loadNotifyTimer: null,
  _healthTimer: null,
  _cardinalTimer: null,
  health: null,
  cardinal: null,

  async init() {
    if (!isOpsAuthed()) {
      this.showGate();
      return;
    }
    await this.bootstrapWebhookFromQuery();
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
    startCardinal({ intervalMs: 60_000 });
    await this.refreshCardinal();
    this.startCardinalPolling();
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    const knownTabs = ['hq', 'shops', 'orders', 'leads', 'fees', 'notify', 'requests', 'surveys', 'lab', 'tools', 'cardinal', 'security'];
    if (tab && knownTabs.includes(tab)) this.switchTab(tab);
    else {
      const status = await getSetupStatus().catch(() => null);
      if (status?.needsSetup) this.switchTab('notify');
    }
    window.scrollTo(0, 0);
  },

  startCardinalPolling() {
    clearInterval(this._cardinalTimer);
    this._cardinalTimer = setInterval(() => {
      this.refreshCardinal().catch(() => {});
    }, 30_000);
  },

  async refreshCardinal() {
    this.cardinal = getCardinalSnapshot();
    let api = null;
    try {
      api = await cardinalApi('status');
    } catch (_) {}
    this.renderCardinal(api);
  },

  renderCardinal(apiRes = null) {
    const snap = this.cardinal || getCardinalSnapshot();
    const fmt = (role) => {
      const r = snap[role] || {};
      if (!r.lastHeartbeatAt) return '未受信';
      const ageMin = Math.round((Date.now() - r.lastHeartbeatAt) / 60000);
      return `${r.status || 'ok'}（${ageMin}分前）`;
    };
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('cardinalGuardianStatus', fmt('guardian'));
    set('cardinalExecutorStatus', fmt('executor'));
    set('cardinalCycles', String(snap.cycles || 0));
    set('cardinalDispatches', String(snap.dispatches || 0));
    set('cardinalHealStreak', String(snap.autoHeal?.consecutiveFails ?? getAutoHealState().consecutiveFails ?? 0));
    if (apiRes?.data?.configured) {
      const c = apiRes.data.configured;
      const ok = c.guardianWebhook || c.executorWebhook || c.apiKey;
      set('cardinalApiStatus', ok ? '設定あり' : '未設定');
    } else if (apiRes?.ok === false) {
      set('cardinalApiStatus', '到達不可');
    } else {
      set('cardinalApiStatus', '確認中');
    }
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
          ? ` · Cardinal/AutoHeal ${heal.consecutiveFails}`
          : '';
        banner.innerHTML = `<strong>${h.emoji || ''} サーバー状態: ${escapeHtml(h.label || h.status)}</strong>
          <span>注文DB: ${h.firestore?.ok ? 'OK' : (h.firestore?.soft ? '応答遅延' : '障害')} · 通知API: ${h.notifyApi?.functionReady ? 'OK' : '障害'}${pending ? ` · 保留注文 ${pending}件` : ''}${healHint}${h.firestore?.error && !h.firestore?.ok ? ` · ${escapeHtml(String(h.firestore.error).slice(0, 40))}` : ''}</span>
          <span class="ops-health-hint">※定期チェック結果です。店舗作成や注文が動いていれば実害はないことが多いです</span>`;
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
        err.textContent = 'パスワードが違います';
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

    document.getElementById('opsSecretForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const secret = document.getElementById('opsApiSecret')?.value || '';
      const persist = !!document.getElementById('opsSecretPersist')?.checked;
      const st = document.getElementById('opsSecretStatus');
      if (secret.trim().length < 8) {
        if (st) { st.hidden = false; st.textContent = '8文字以上のシークレットを入力してください'; }
        return;
      }
      setOpsApiSecret(secret, { persist });
      if (st) {
        st.hidden = false;
        st.textContent = persist
          ? 'OPS_API_SECRET をこのブラウザに保存しました'
          : 'OPS_API_SECRET をセッションに保存しました';
      }
      const input = document.getElementById('opsApiSecret');
      if (input) input.value = '';
    });
    document.getElementById('opsSecretClear')?.addEventListener('click', () => {
      clearOpsApiSecret();
      const st = document.getElementById('opsSecretStatus');
      if (st) { st.hidden = false; st.textContent = 'シークレットを消去しました'; }
    });
    // Prefill indicator only (never echo secret into DOM as text)
    const secretInput = document.getElementById('opsApiSecret');
    if (secretInput && getOpsApiSecret()) {
      secretInput.placeholder = '（保存済み — 変更する場合のみ入力）';
    }

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
      st.id = 'opsHealthStatus';
      st.hidden = false;
      st.textContent = 'Cardinal Executor（自動対処）を起動中...';
      if (btn) btn.disabled = true;
      const cycle = await runAutoHealCycle({ escalateAfterFails: 1, escalateCooldownMs: 0 });
      const res = await escalateToCursor({
        status: this.health?.status || cycle.health?.status || 'manual',
        severity: 'critical',
        summary: 'Opsから手動で Cardinal Executor を依頼',
        message: 'ユーザーが「Cursorに自動対処を依頼」を押しました。Executor として健康状態を調査し、直せる箇所は draft PR を作成してください。',
        firestoreOk: !!(this.health?.firestore?.ok ?? cycle.health?.firestore?.ok),
        notifyApiOk: !!(this.health?.notifyApi?.functionReady ?? cycle.health?.notifyApi?.functionReady),
        cardinalRole: 'executor',
        flush: cycle.flush,
      });
      if (res.ok) {
        const agentOk = res.data?.cursor?.agent?.ok || res.data?.cursor?.automation?.ok;
        st.textContent = agentOk
          ? 'Executor 起動を依頼しました。cursor.com/agents を確認してください。'
          : (res.data?.hint || '受付ました。CURSOR_API_KEY / Cardinal Automations 未設定なら Cloudflare secrets を追加してください。');
        const host = document.getElementById('opsHealthPlaybook');
        if (host && !host.contains(st)) host.appendChild(st);
      } else {
        st.textContent = '起動失敗: ' + (res.error || res.data?.error || 'unknown');
      }
      if (btn) btn.disabled = false;
      await this.refreshCardinal();
    };
    document.getElementById('opsHealthAutoFix')?.addEventListener('click', (e) => requestAutoFix(e.currentTarget));

    document.getElementById('opsCardinalRefresh')?.addEventListener('click', () => this.refreshCardinal());
    document.getElementById('opsCardinalCycle')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const st = document.getElementById('opsCardinalStatus');
      const log = document.getElementById('opsCardinalLog');
      btn.disabled = true;
      if (st) { st.hidden = false; st.textContent = 'Cardinal サイクル実行中...'; }
      try {
        const result = await runCardinalCycle({ escalateAfterFails: 2 });
        this.health = result.health;
        this.renderHealth();
        await this.refreshCardinal();
        if (log) {
          log.hidden = false;
          log.textContent = JSON.stringify({
            health: result.health?.status,
            actions: result.actions,
            cycles: result.state?.cycles,
            dispatches: result.state?.dispatches,
          }, null, 2);
        }
        if (st) st.textContent = `完了: health=${result.health?.status} / actions=${result.actions?.length || 0}`;
      } catch (err) {
        if (st) st.textContent = '失敗: ' + (err?.message || err);
      }
      btn.disabled = false;
    });
    document.getElementById('opsCardinalDrill')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const st = document.getElementById('opsCardinalStatus');
      const log = document.getElementById('opsCardinalLog');
      if (!confirm('Guardian と Executor のドリル起動を送ります。CURSOR secrets が無い場合は Discord/ヒントのみになります。続行しますか？')) return;
      btn.disabled = true;
      if (st) { st.hidden = false; st.textContent = '2体ドリル起動中...'; }
      try {
        const result = await runCardinalDrill();
        await this.refreshCardinal();
        if (log) {
          log.hidden = false;
          log.textContent = JSON.stringify(result, null, 2);
        }
        if (st) {
          const g = result.guardian?.ok || result.guardian?.data?.launched;
          const x = result.executor?.ok || result.executor?.data?.launched;
          st.textContent = `ドリル送信: Guardian=${g ? 'OK' : '未起動/設定不足'} / Executor=${x ? 'OK' : '未起動/設定不足'}`;
        }
      } catch (err) {
        if (st) st.textContent = '失敗: ' + (err?.message || err);
      }
      btn.disabled = false;
    });

    document.getElementById('opsLoadTestRun')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const stopBtn = document.getElementById('opsLoadTestStop');
      const st = document.getElementById('opsLoadTestStatus');
      const log = document.getElementById('opsLoadTestLog');
      const shopCount = Number(document.getElementById('loadTestShops')?.value) || 25;
      const ordersPerShop = Number(document.getElementById('loadTestOrders')?.value) || 10;
      const webhook = document.getElementById('loadTestWebhook')?.value?.trim()
        || document.getElementById('opsNotifyWebhook')?.value?.trim()
        || getDiscordWebhook();
      if (st) { st.hidden = false; st.textContent = '準備中...'; }
      if (log) { log.hidden = false; log.textContent = ''; }
      this._loadTestAbort = false;
      if (stopBtn) stopBtn.disabled = false;
      btn.disabled = true;
      if (webhook && isLikelyDiscordWebhook(webhook)) {
        await ensureWebhookReady(webhook);
      } else if (st) {
        st.textContent = '警告: Discord Webhook 未設定。注文負荷は実行しますが通知は失敗します。通知タブで URL を保存してください。';
      }
      const lines = [];
      const pushLog = (msg, meta) => {
        const line = meta ? `${msg} ${typeof meta === 'object' ? JSON.stringify(meta) : meta}` : msg;
        lines.push(line);
        if (log) {
          log.textContent = lines.slice(-80).join('\n');
          log.scrollTop = log.scrollHeight;
        }
        if (st) st.textContent = msg;
      };
      const autoCleanup = document.getElementById('loadTestAutoCleanup')?.checked !== false;
      try {
        const summary = await runFullLoadTest({
          shopCount,
          ordersPerShop,
          webhook,
          cleanup: autoCleanup,
          onProgress: (msg, meta) => {
            if (this._loadTestAbort) throw new Error('aborted');
            pushLog(msg, meta);
          },
        });
        pushLog('=== 完了 ===', {
          shops: summary.shopsCreated,
          orders: summary.ordersCreated,
          cleaned: summary.cleanedShops,
          discordOk: summary.discordOk,
          discordFail: summary.discordFail,
          sec: summary.elapsedSec,
        });
        if (st) {
          st.textContent = `完了: 店舗${summary.shopsCreated} / 注文${summary.ordersCreated}`
            + (autoCleanup ? ` / 自動削除${summary.cleanedShops || 0}` : '')
            + ` / Discord成功${summary.discordOk} 失敗${summary.discordFail}（${summary.elapsedSec}s）`;
        }
        await this.refreshShops();
      } catch (err) {
        pushLog('エラー: ' + (err?.message || err));
        if (st) st.textContent = '中断または失敗: ' + (err?.message || err);
      }
      btn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
    });
    document.getElementById('opsLoadTestStop')?.addEventListener('click', () => {
      this._loadTestAbort = true;
      const st = document.getElementById('opsLoadTestStatus');
      if (st) { st.hidden = false; st.textContent = '停止リクエスト中...'; }
    });
    document.getElementById('opsLoadTestCleanup')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const st = document.getElementById('opsLoadTestStatus');
      const log = document.getElementById('opsLoadTestLog');
      if (!confirm('負荷テスト用店舗（load-* / loadTest）をすべて削除します。よろしいですか？')) return;
      btn.disabled = true;
      if (st) { st.hidden = false; st.textContent = 'クリーンアップ中...'; }
      if (log) { log.hidden = false; log.textContent = ''; }
      const lines = [];
      const pushLog = (msg, meta) => {
        const line = meta ? `${msg} ${typeof meta === 'object' ? JSON.stringify(meta) : meta}` : msg;
        lines.push(line);
        if (log) {
          log.textContent = lines.slice(-80).join('\n');
          log.scrollTop = log.scrollHeight;
        }
        if (st) st.textContent = msg;
      };
      try {
        const result = await cleanupLoadTestShops({
          deleteRelated: true,
          onProgress: pushLog,
        });
        pushLog('=== 削除完了 ===', {
          deleted: result.shopsDeleted,
          failed: result.shopsFailed,
          orders: result.ordersDeleted,
          requests: result.requestsDeleted,
        });
        if (st) {
          st.textContent = `削除完了: 店舗${result.shopsDeleted}件`
            + (result.shopsFailed ? ` / 失敗${result.shopsFailed}` : '')
            + ` / 注文${result.ordersDeleted} / リクエスト${result.requestsDeleted}`;
        }
        await this.refreshShops();
      } catch (err) {
        pushLog('エラー: ' + (err?.message || err));
        if (st) st.textContent = '削除失敗: ' + (err?.message || err);
      }
      btn.disabled = false;
    });

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

    this.bindPowerTools();
  },

  bindPowerTools() {
    document.getElementById('shopsFilter')?.addEventListener('input', () => this.renderShops());
    document.getElementById('shopsRefresh')?.addEventListener('click', () => this.refreshShops());
    document.getElementById('shopsReseed')?.addEventListener('click', async () => {
      const st = document.getElementById('createShopStatus');
      if (st) { st.hidden = false; st.textContent = 'シード投入中...'; }
      try {
        await ensureSeedShops();
        await this.refreshShops();
        if (st) st.textContent = `シード完了（${listSeedShops().length}件）`;
      } catch (e) {
        if (st) st.textContent = '失敗: ' + (e?.message || e);
      }
    });

    document.getElementById('shopEditForm')?.addEventListener('submit', async (e) => {
      const submitter = e.submitter;
      if (submitter?.value === 'cancel') return;
      e.preventDefault();
      const id = document.getElementById('shopEditId')?.textContent?.trim();
      const st = document.getElementById('shopEditStatus');
      if (!id) return;
      if (st) { st.hidden = false; st.textContent = '保存中...'; }
      try {
        const subscribed = !!document.getElementById('editShopSubscribed')?.checked;
        await upsertShop(id, {
          name: document.getElementById('editShopName')?.value?.trim() || id,
          planId: document.getElementById('editShopPlan')?.value || 'growth',
          billingCycle: document.getElementById('editShopCycle')?.value || 'annual',
          tableCount: Number(document.getElementById('editShopTables')?.value) || 12,
          stores: Number(document.getElementById('editShopStores')?.value) || 1,
          isOpen: !!document.getElementById('editShopOpen')?.checked,
          subscribed,
          subscribedAt: subscribed ? (Date.now()) : null,
        });
        if (st) st.textContent = '保存しました';
        document.getElementById('shopEditDialog')?.close();
        await this.refreshShops();
      } catch (err) {
        if (st) st.textContent = '失敗: ' + (err?.message || err);
      }
    });

    ['ordersShopFilter', 'ordersStatusFilter', 'ordersHideDemo', 'ordersOnlyLoad', 'ordersSearch'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => this.renderOrders());
      document.getElementById(id)?.addEventListener('input', () => this.renderOrders());
    });
    document.getElementById('ordersSelectAll')?.addEventListener('change', (e) => {
      document.querySelectorAll('#ordersRows [data-order-check]').forEach((cb) => {
        cb.checked = !!e.target.checked;
      });
    });
    document.getElementById('ordersExportCsv')?.addEventListener('click', () => {
      const rows = this.filteredOrders();
      downloadCsv(`ops-orders-${new Date().toISOString().slice(0, 10)}.csv`, ordersToCsv(rows));
    });
    document.getElementById('ordersDeleteSelected')?.addEventListener('click', () => this.deleteSelectedOrders());
    document.getElementById('ordersPurgeLoad')?.addEventListener('click', () => this.purgeLoadOrders());

    document.getElementById('leadsStatusFilter')?.addEventListener('change', () => this.renderOpsLeads());
    document.getElementById('leadsRefresh')?.addEventListener('click', () => this.renderOpsLeads());

    document.getElementById('feesViewFilter')?.addEventListener('change', () => this.renderFees());
    document.getElementById('feesSelectAll')?.addEventListener('change', (e) => {
      document.querySelectorAll('#feesRows [data-fee-check]').forEach((cb) => {
        cb.checked = !!e.target.checked;
      });
    });
    document.getElementById('feesMarkSelected')?.addEventListener('click', () => this.markFeesBilled(false));
    document.getElementById('feesMarkAllUnbilled')?.addEventListener('click', () => this.markFeesBilled(true));
    document.getElementById('feesExportCsv')?.addEventListener('click', () => {
      const rows = this.feeOrders();
      downloadCsv(`ops-fees-${new Date().toISOString().slice(0, 10)}.csv`, ordersToCsv(rows));
    });

    document.getElementById('toolsFlushPending')?.addEventListener('click', () => this.flushPendingQueue());
    document.getElementById('toolsClearPending')?.addEventListener('click', () => {
      if (!confirm('保留注文キューを空にしますか？（再送されません）')) return;
      try { localStorage.removeItem('mos_pending_orders'); } catch (_) {}
      this.renderTools();
      this.setToolsStatus('キューを空にしました');
    });
    document.getElementById('toolsRefreshPending')?.addEventListener('click', () => this.renderTools());
    document.getElementById('toolsDumpEnv')?.addEventListener('click', () => this.dumpEnv());
    document.getElementById('toolsCopyEnv')?.addEventListener('click', async () => {
      const text = document.getElementById('toolsEnvDump')?.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        this.setToolsStatus('環境ダンプをコピーしました');
      } catch {
        this.setToolsStatus('コピー失敗 — 手動で選択してください');
      }
    });
    document.getElementById('toolsListStorage')?.addEventListener('click', () => this.listMosStorage());
    document.getElementById('toolsClearMosStorage')?.addEventListener('click', () => {
      if (!confirm('mos_* の localStorage を削除します（Opsログインも切れます）。続行？')) return;
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('mos_')) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
      this.setToolsStatus(`${keys.length} キーを削除しました。再ログインしてください。`);
      setTimeout(() => { location.href = 'ops.html'; }, 800);
    });
    document.getElementById('toolsClearLoadLevels')?.addEventListener('click', () => {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && /load|health|cardinal|auto.?heal/i.test(k)) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
      this.setToolsStatus(`負荷/ヘルス系 ${keys.length} キーを削除`);
      this.listMosStorage();
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


  async bootstrapWebhookFromQuery() {
    try {
      const wh = new URLSearchParams(location.search).get('webhook')
        || new URLSearchParams(location.search).get('discordWebhook');
      if (wh && isLikelyDiscordWebhook(wh)) {
        await ensureWebhookReady(wh);
        const input = document.getElementById('opsNotifyWebhook');
        if (input) input.value = wh;
        const lt = document.getElementById('loadTestWebhook');
        if (lt) lt.value = wh;
      }
    } catch (_) {}
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
    if (id === 'orders') this.renderOrders();
    if (id === 'leads') this.renderOpsLeads();
    if (id === 'fees') this.renderFees();
    if (id === 'requests') this.renderRequests();
    if (id === 'surveys') this.renderSurveys();
    if (id === 'lab') this.renderLabs();
    if (id === 'tools') this.renderTools();
    if (id === 'notify') this.refreshNotifySetup();
    if (id === 'cardinal') this.refreshCardinal();
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
    const q = (document.getElementById('shopsFilter')?.value || '').trim().toLowerCase();
    const shops = this.shops.filter((s) => {
      if (!q) return true;
      return `${s.id} ${s.name || ''} ${s.subtitle || ''}`.toLowerCase().includes(q);
    });
    el.innerHTML = shops.map(s => {
      const guest = guestEntryUrl(s.id, 1);
      const demo = guestEntryUrl(s.id, 1, { demo: 1 });
      const admin = `admin.html?shop=${encodeURIComponent(s.id)}`;
      const store = `store.html?shop=${encodeURIComponent(s.id)}`;
      const cycle = s.billingCycle === 'monthly' ? '月' : '年';
      const sub = s.subscribed ? '課金中' : '未課金';
      return `
        <article class="ops-shop-card">
          <header>
            <h3>${escapeHtml(s.name || s.id)}</h3>
            <code>${escapeHtml(s.id)}</code>
          </header>
          <p>${escapeHtml(s.subtitle || '')} · ${escapeHtml(s.hoursNote || '')} · 席${s.tableCount || 0}</p>
          <p class="ops-muted">${s.isOpen === false ? '準備中' : '営業中'} · ${getPlan(s.planId).name} · ${cycle}払い · ${sub}</p>
          <div class="ops-shop-actions">
            <a href="${guest}" target="_blank">客席</a>
            <a href="${demo}" target="_blank">テスト</a>
            <a href="${admin}" target="_blank">厨房</a>
            <a href="${store}" target="_blank">店舗管理</a>
            <button type="button" data-edit="${s.id}">編集</button>
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
    el.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => this.openShopEditor(btn.dataset.edit));
    });
  },

  openShopEditor(shopId) {
    const shop = this.shops.find((s) => s.id === shopId);
    if (!shop) return;
    const dlg = document.getElementById('shopEditDialog');
    document.getElementById('shopEditId').textContent = shop.id;
    document.getElementById('editShopName').value = shop.name || '';
    document.getElementById('editShopPlan').value = shop.planId || 'growth';
    document.getElementById('editShopCycle').value = shop.billingCycle || 'annual';
    document.getElementById('editShopTables').value = shop.tableCount || 12;
    document.getElementById('editShopStores').value = shop.stores || 1;
    document.getElementById('editShopOpen').checked = shop.isOpen !== false;
    document.getElementById('editShopSubscribed').checked = !!shop.subscribed;
    const st = document.getElementById('shopEditStatus');
    if (st) { st.hidden = true; st.textContent = ''; }
    dlg?.showModal?.();
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
      this.renderOrders();
      this.renderFees();
      this.scheduleLoadNotify();
    }, () => {});

    onSnapshot(query(collection(db, 'leads'), orderBy('createdAt', 'desc')), snap => {
      this.leads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this.renderHq();
      this.renderOpsLeads();
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
      cycle: shop.billingCycle || 'annual',
      stores: shop.stores || 1,
    }), 0);
    set('hqMrr', `¥${yen(mrr)}`);

    // Chain 0.8% platform fee ledger (unbilled)
    const feeOrders = this.orders.filter(o => !o.demo && (o.platformFee || 0) > 0 && (o.platformFeeStatus || 'unbilled') === 'unbilled');
    const unbilledFee = feeOrders.reduce((s, o) => s + (o.platformFee || 0), 0);
    set('hqPlatformFee', `¥${yen(unbilledFee)}`);

    // Make KPI cards jump to relevant Ops tabs
    const jumps = [
      ['hqShops', 'shops'],
      ['hqOrders', 'orders'],
      ['hqLeads', 'leads'],
      ['hqPlatformFee', 'fees'],
      ['hqRequests', 'requests'],
      ['hqNps', 'surveys'],
      ['hqHealth', 'tools'],
    ];
    jumps.forEach(([id, tab]) => {
      const el = document.getElementById(id)?.closest('.ops-card');
      if (!el || el.dataset.jumpBound) return;
      el.dataset.jumpBound = '1';
      el.style.cursor = 'pointer';
      el.title = `${tab} タブを開く`;
      el.addEventListener('click', () => this.switchTab(tab));
    });
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
        <button type="button" data-resolve="${r.id}" data-table="${escapeHtml(String(r.tableNumber))}">対応済</button>
      </div>
    `).join('') || '<p class="ops-muted">オープンな呼出はありません</p>';

    el.querySelectorAll('[data-resolve]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.resolve;
        const table = btn.dataset.table;
        this.requests = this.requests.map(r => r.id === id ? { ...r, status: 'done' } : r);
        this.renderRequests();
        resolveServiceRequest(id, { tableNumber: table }).catch((e) => console.error(e));
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
    const prev = sel.value;
    sel.innerHTML = this.shops.map(s =>
      `<option value="${s.id}">${escapeHtml(s.name)} (${s.id})</option>`
    ).join('');
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    const orderSel = document.getElementById('ordersShopFilter');
    if (orderSel) {
      const cur = orderSel.value;
      orderSel.innerHTML = `<option value="">すべて</option>` + this.shops.map((s) =>
        `<option value="${s.id}">${escapeHtml(s.name || s.id)}</option>`
      ).join('');
      if (cur) orderSel.value = cur;
    }
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
        <a class="ops-btn" href="ops.html?tab=tools" target="_blank">Devツール</a>
        <a class="ops-btn secondary" href="lp.html" target="_blank">販売LP</a>
      `;
    }
    if (sel && !sel.dataset.bound) {
      sel.dataset.bound = '1';
      sel.addEventListener('change', () => this.renderLabs());
    }

    const checklist = document.getElementById('labChecklist');
    if (checklist) {
      checklist.innerHTML = `
        <li>店舗URLが <code>?shop=</code> で分離されている</li>
        <li>テストモード注文は Firestore に書かれない</li>
        <li>店員呼出・会計リクエストが総合管理に届く</li>
        <li>品切れ反映が客席に即時出る（店舗管理/厨房）</li>
        <li>完了後アンケートが surveys に残る</li>
        <li>カートにサイド・ドリンクのアップセルが出る</li>
        <li>クーポン・在庫・KDS・期間CSVが Growth で動く</li>
        <li>Ops 注文タブで LOAD-* を掃除できる</li>
      `;
    }

    const head = document.getElementById('planMatrixHead');
    const featureMatrix = document.getElementById('featureMatrix');
    if (head && featureMatrix) {
      head.innerHTML = `<tr><th>機能</th>${PLANS.map((p) => `<th>${escapeHtml(p.name)}</th>`).join('')}</tr>`;
      featureMatrix.innerHTML = planComparisonRows().map((row) => `
        <tr>
          <td>${escapeHtml(row.label)}</td>
          ${row.values.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}
        </tr>
      `).join('');
    }
  },

  filteredOrders() {
    const shop = document.getElementById('ordersShopFilter')?.value || '';
    const status = document.getElementById('ordersStatusFilter')?.value || '';
    const hideDemo = document.getElementById('ordersHideDemo')?.checked !== false;
    const onlyLoad = !!document.getElementById('ordersOnlyLoad')?.checked;
    const q = (document.getElementById('ordersSearch')?.value || '').trim().toLowerCase();
    return (this.orders || []).filter((o) => {
      if (shop && (o.shopId || DEFAULT_SHOP_ID) !== shop) return false;
      if (status && (o.status || 'received') !== status) return false;
      if (hideDemo && o.demo) return false;
      if (onlyLoad && !String(o.id || '').toUpperCase().startsWith('LOAD')) return false;
      if (q) {
        const hay = `${o.id || ''} ${o.tableNumber || ''} ${o.shopId || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).slice(0, 300);
  },

  renderOrders() {
    const tbody = document.getElementById('ordersRows');
    if (!tbody) return;
    const rows = this.filteredOrders();
    tbody.innerHTML = rows.map((o) => `
      <tr>
        <td><input type="checkbox" data-order-check value="${escapeHtml(o.id)}"></td>
        <td><code>${escapeHtml(o.id)}</code>${o.demo ? ' <em class="ops-tag">demo</em>' : ''}</td>
        <td>${escapeHtml(o.shopId || '')}</td>
        <td>${escapeHtml(String(o.tableNumber ?? ''))}</td>
        <td>${escapeHtml(o.status || 'received')}</td>
        <td>¥${yen(o.total || 0)}</td>
        <td>${(o.platformFee || 0) > 0 ? `¥${yen(o.platformFee)}` : '—'}</td>
        <td>${o.timestamp ? new Date(o.timestamp).toLocaleString('ja-JP') : '—'}</td>
        <td><button type="button" class="ops-linkish" data-del-order="${escapeHtml(o.id)}">削除</button></td>
      </tr>
    `).join('') || '<tr><td colspan="9">該当なし</td></tr>';

    tbody.querySelectorAll('[data-del-order]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`${btn.dataset.delOrder} を削除？`)) return;
        try {
          await deleteDoc(doc(db, 'orders', btn.dataset.delOrder));
          this.setOrdersStatus(`削除: ${btn.dataset.delOrder}`);
        } catch (e) {
          this.setOrdersStatus('削除失敗: ' + (e?.message || e));
        }
      });
    });
  },

  setOrdersStatus(msg) {
    const st = document.getElementById('ordersStatus');
    if (!st) return;
    st.hidden = false;
    st.textContent = msg;
  },

  selectedOrderIds() {
    return [...document.querySelectorAll('#ordersRows [data-order-check]:checked')].map((cb) => cb.value);
  },

  async deleteSelectedOrders() {
    const ids = this.selectedOrderIds();
    if (!ids.length) {
      this.setOrdersStatus('選択がありません');
      return;
    }
    if (!confirm(`${ids.length} 件を削除しますか？`)) return;
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      try {
        await deleteDoc(doc(db, 'orders', id));
        ok += 1;
      } catch (_) {
        fail += 1;
      }
    }
    this.setOrdersStatus(`削除完了: ${ok} / 失敗 ${fail}`);
  },

  async purgeLoadOrders() {
    const load = (this.orders || []).filter((o) => String(o.id || '').toUpperCase().startsWith('LOAD'));
    if (!load.length) {
      this.setOrdersStatus('LOAD-* 注文はありません');
      return;
    }
    if (!confirm(`LOAD-* 注文 ${load.length} 件を削除しますか？`)) return;
    let ok = 0;
    for (const o of load) {
      try {
        await deleteDoc(doc(db, 'orders', o.id));
        ok += 1;
      } catch (_) {}
    }
    this.setOrdersStatus(`LOAD-* 削除: ${ok}/${load.length}`);
  },

  renderOpsLeads() {
    const el = document.getElementById('opsLeadsList');
    if (!el) return;
    const filter = document.getElementById('leadsStatusFilter')?.value || '';
    const rows = (this.leads || []).filter((l) => !filter || (l.status || 'new') === filter);
    el.innerHTML = rows.map((lead) => `
      <article class="ops-lead-card">
        <header>
          <strong>${escapeHtml(lead.shopName || '無題')}</strong>
          <span class="ops-tag">${escapeHtml(lead.status || 'new')}</span>
        </header>
        <p>${escapeHtml(lead.email || '')}${lead.phone ? ` · ${escapeHtml(lead.phone)}` : ''}</p>
        <p class="ops-muted">
          ${escapeHtml(lead.planName || lead.planId || '-')}
          · 見込みMRR ¥${yen(lead.estimatedMrr || lead.planPrice || 0)}
          · 席 ${escapeHtml(String(lead.tables || '-'))}
          · ${lead.createdAt ? new Date(lead.createdAt).toLocaleString('ja-JP') : ''}
        </p>
        ${lead.message ? `<p>${escapeHtml(lead.message)}</p>` : ''}
        <div class="ops-shop-actions">
          <button type="button" data-lead="${lead.id}" data-lead-status="contacted">対応中</button>
          <button type="button" data-lead="${lead.id}" data-lead-status="won">成約</button>
          <button type="button" data-lead="${lead.id}" data-lead-status="new">新規に戻す</button>
        </div>
      </article>
    `).join('') || '<p class="ops-muted">リードなし</p>';

    el.querySelectorAll('[data-lead]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const status = btn.dataset.leadStatus;
        try {
          await updateDoc(doc(db, 'leads', btn.dataset.lead), { status, updatedAt: Date.now() });
          if (status === 'won') {
            const lead = this.leads.find((l) => l.id === btn.dataset.lead);
            if (lead) notifyLeadWon({ ...lead, status });
          }
        } catch (e) {
          console.error(e);
          alert('更新失敗: ' + (e?.message || e));
        }
      });
    });
  },

  feeOrders() {
    const view = document.getElementById('feesViewFilter')?.value || 'unbilled';
    return (this.orders || []).filter((o) => {
      if (o.demo) return false;
      if (!(o.platformFee > 0)) return false;
      const st = o.platformFeeStatus || 'unbilled';
      if (view === 'unbilled') return st === 'unbilled';
      if (view === 'billed') return st === 'billed';
      return true;
    }).slice(0, 400);
  },

  renderFees() {
    const tbody = document.getElementById('feesRows');
    if (!tbody) return;
    const allFee = (this.orders || []).filter((o) => !o.demo && (o.platformFee || 0) > 0);
    const unbilled = allFee.filter((o) => (o.platformFeeStatus || 'unbilled') === 'unbilled');
    const billed = allFee.filter((o) => o.platformFeeStatus === 'billed');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('feeUnbilledTotal', `¥${yen(unbilled.reduce((s, o) => s + (o.platformFee || 0), 0))}`);
    set('feeUnbilledCount', String(unbilled.length));
    set('feeBilledCount', String(billed.length));

    const rows = this.feeOrders();
    tbody.innerHTML = rows.map((o) => `
      <tr>
        <td><input type="checkbox" data-fee-check value="${escapeHtml(o.id)}" ${(o.platformFeeStatus || 'unbilled') === 'billed' ? 'disabled' : ''}></td>
        <td><code>${escapeHtml(o.id)}</code></td>
        <td>${escapeHtml(o.shopId || '')}</td>
        <td>¥${yen(o.total || 0)}</td>
        <td>¥${yen(o.platformFee || 0)}</td>
        <td>${escapeHtml(o.platformFeeStatus || 'unbilled')}</td>
        <td>${o.timestamp ? new Date(o.timestamp).toLocaleString('ja-JP') : '—'}</td>
      </tr>
    `).join('') || '<tr><td colspan="7">該当なし</td></tr>';
  },

  async markFeesBilled(allUnbilled) {
    const st = document.getElementById('feesStatus');
    let ids = [];
    if (allUnbilled) {
      ids = (this.orders || [])
        .filter((o) => !o.demo && (o.platformFee || 0) > 0 && (o.platformFeeStatus || 'unbilled') === 'unbilled')
        .map((o) => o.id);
      if (!ids.length) {
        if (st) { st.hidden = false; st.textContent = '未請求はありません'; }
        return;
      }
      if (!confirm(`未請求 ${ids.length} 件を請求済にしますか？`)) return;
    } else {
      ids = [...document.querySelectorAll('#feesRows [data-fee-check]:checked')].map((cb) => cb.value);
      if (!ids.length) {
        if (st) { st.hidden = false; st.textContent = '選択がありません'; }
        return;
      }
    }
    let ok = 0;
    for (const id of ids) {
      try {
        await updateDoc(doc(db, 'orders', id), {
          platformFeeStatus: 'billed',
          billedAt: Date.now(),
        });
        ok += 1;
      } catch (_) {}
    }
    if (st) { st.hidden = false; st.textContent = `請求済に更新: ${ok}/${ids.length}`; }
  },

  setToolsStatus(msg) {
    const st = document.getElementById('toolsStatus');
    if (!st) return;
    st.hidden = false;
    st.textContent = msg;
  },

  renderTools() {
    const pending = listPendingOrders();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('toolsPendingCount', String(pending.length));
    set('toolsFsStatus', this.health?.firestore?.ok ? `OK ${this.health.firestore.latencyMs || ''}ms` : (this.health?.firestore?.soft ? '遅延' : '—'));
    set('toolsNotifyStatus', this.health?.notifyApi?.functionReady ? 'OK' : '—');
    set('toolsRole', getOpsRole() || '—');

    const links = document.getElementById('toolsQuickLinks');
    if (links) {
      const shopId = this.shops[0]?.id || DEFAULT_SHOP_ID;
      links.innerHTML = `
        <a class="ops-btn" href="https://mobile-order-system.pages.dev/" target="_blank" rel="noopener">本番 Pages</a>
        <a class="ops-btn" href="https://console.firebase.google.com/project/${firebaseConfig.projectId}/firestore" target="_blank" rel="noopener">Firebase</a>
        <a class="ops-btn" href="https://cursor.com/agents" target="_blank" rel="noopener">Cursor Agents</a>
        <a class="ops-btn" href="https://github.com/Elion-dev99/Mobile-Order-System" target="_blank" rel="noopener">GitHub</a>
        <a class="ops-btn" href="lp.html" target="_blank">LP</a>
        <a class="ops-btn" href="${guestEntryUrl(shopId, 1, { demo: 1 })}" target="_blank">デモ客席</a>
        <a class="ops-btn secondary" href="docs/cardinal.md" target="_blank">cardinal.md</a>
        <a class="ops-btn secondary" href="docs/revenue.md" target="_blank">revenue.md</a>
      `;
    }

    const log = document.getElementById('toolsPendingLog');
    if (log) {
      log.hidden = false;
      log.textContent = pending.length
        ? pending.map((o) => `${o.id} shop=${o.shopId} total=${o.total} queuedAt=${o.queuedAt || o.timestamp || ''}`).join('\n')
        : '（空）';
    }
  },

  async flushPendingQueue() {
    this.setToolsStatus('再送中...');
    try {
      const result = await flushPendingOrders(async (order) => {
        await setDoc(doc(db, 'orders', order.id), order, { merge: true });
      });
      this.setToolsStatus(`再送: ${result.sent || 0} / 残り ${result.left || 0}${result.error ? ` · ${result.error}` : ''}`);
    } catch (e) {
      this.setToolsStatus('失敗: ' + (e?.message || e));
    }
    this.renderTools();
  },

  async dumpEnv() {
    const pre = document.getElementById('toolsEnvDump');
    if (pre) { pre.hidden = false; pre.textContent = '収集中...'; }
    let cardinal = null;
    try { cardinal = await cardinalApi('status'); } catch (e) { cardinal = { error: String(e?.message || e) }; }
    const dump = {
      at: new Date().toISOString(),
      href: location.href,
      role: getOpsRole(),
      firebase: {
        projectId: firebaseConfig.projectId,
        authDomain: firebaseConfig.authDomain,
      },
      product: {
        name: PRODUCT.name,
        trialDays: PRODUCT.trialDays,
        defaultBillingCycle: PRODUCT.defaultBillingCycle,
        introSlotsRemaining: PRODUCT.introSlotsRemaining,
        stripePaymentLink: PRODUCT.stripePaymentLink ? '(set)' : '',
      },
      plans: PLANS.map((p) => ({
        id: p.id,
        priceMonthly: p.priceMonthly,
        maxTables: p.maxTables,
        maxStores: p.maxStores,
        orderFeePercent: p.orderFeePercent,
      })),
      health: this.health,
      cardinalClient: getCardinalSnapshot(),
      cardinalApi: cardinal,
      notify: {
        hasWebhook: !!getDiscordWebhook(),
        events: getNotifyEvents(),
      },
      counts: {
        shops: this.shops.length,
        orders: this.orders.length,
        leads: this.leads.length,
        requestsOpen: this.requests.filter((r) => r.status === 'open').length,
        pendingOrders: listPendingOrders().length,
      },
      seeds: listSeedShops().map((s) => s.id),
      ua: navigator.userAgent,
      online: navigator.onLine,
    };
    if (pre) pre.textContent = JSON.stringify(dump, null, 2);
    this.setToolsStatus('環境ダンプを更新しました');
  },

  listMosStorage() {
    const pre = document.getElementById('toolsStorageLog');
    const rows = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (!k.startsWith('mos_') && !/ops|cardinal|health|notify|load/i.test(k)) continue;
      let len = 0;
      try { len = (localStorage.getItem(k) || '').length; } catch (_) {}
      rows.push(`${k} (${len} chars)`);
    }
    rows.sort();
    if (pre) {
      pre.hidden = false;
      pre.textContent = rows.join('\n') || '（該当キーなし）';
    }
    this.setToolsStatus(`${rows.length} キー`);
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
