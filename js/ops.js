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
import { resolveServiceRequest, estimateWaitMinutes } from './guest-features.js';

const OpsPage = {
  shops: [],
  orders: [],
  leads: [],
  surveys: [],
  requests: [],
  unsubReq: null,

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
    window.scrollTo(0, 0);
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
      btn.addEventListener('click', () => {
        const input = document.getElementById('opsPassword');
        if (input) {
          input.value = btn.dataset.fill;
          input.focus();
        }
      });
    });

    const form = document.getElementById('opsLoginForm');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = form.querySelector('button[type="submit"]');
      const pw = document.getElementById('opsPassword').value;
      const err = document.getElementById('opsLoginError');
      err.hidden = true;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '入室中...';
      }
      let res;
      try {
        res = await verifyOpsPassword(pw);
      } catch (ex) {
        console.error(ex);
        err.hidden = false;
        err.textContent = '認証処理でエラーが出ました。再読み込みしてください';
        if (btn) { btn.disabled = false; btn.textContent = '入室'; }
        return;
      }
      if (!res.ok) {
        err.hidden = false;
        err.textContent = 'パスワードが違います（Cursor: cursor2026 / Owner: owner2026）';
        if (btn) { btn.disabled = false; btn.textContent = '入室'; }
        return;
      }
      setOpsRole(res.role);
      // リロードせずその場で画面切替（iOSで session が消えて戻る問題を回避）
      try {
        await this.enterApp();
      } catch (ex) {
        console.error(ex);
        err.hidden = false;
        err.textContent = '画面の切替に失敗しました。もう一度お試しください';
        if (btn) { btn.disabled = false; btn.textContent = '入室'; }
      }
    });
  },

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
    document.getElementById('opsLogout')?.addEventListener('click', () => {
      clearOpsAuth();
      location.reload();
    });
    document.querySelectorAll('[data-ops-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.opsTab));
    });
    document.getElementById('createShopForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('newShopId').value.trim().toLowerCase();
      const name = document.getElementById('newShopName').value.trim();
      const status = document.getElementById('createShopStatus');
      status.hidden = false;
      try {
        await upsertShop(id, {
          name: name || id,
          subtitle: document.getElementById('newShopSubtitle').value.trim(),
          tableCount: Number(document.getElementById('newShopTables').value) || 10,
          planId: document.getElementById('newShopPlan').value || 'growth',
        });
        status.textContent = `店舗 ${id} を作成しました`;
        e.target.reset();
        await this.refreshShops();
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

  subscribeGlobal() {
    onSnapshot(query(collection(db, 'orders'), orderBy('timestamp', 'desc')), snap => {
      this.orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this.renderHq();
      this.renderLabs();
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
    const rows = document.getElementById('hqShopRows');
    if (rows) {
      rows.innerHTML = Object.entries(byShop).map(([id, v]) => {
        const shop = this.shops.find(s => s.id === id);
        return `<tr><td>${escapeHtml(shop?.name || id)}</td><td>${v.orders}</td><td>¥${yen(v.gmv)}</td><td>${estimateWaitMinutes(this.orders.filter(o => (o.shopId || DEFAULT_SHOP_ID) === id && (o.status || '') !== 'done'))}分</td></tr>`;
      }).join('') || '<tr><td colspan="4">本日の注文なし</td></tr>';
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
