/**
 * Store-facing billing status dashboard (shared: store.html + admin billing tab).
 */

import { getShop, getShopId, getShopAccess } from './shop.js';
import {
  getPlan, yen, planPrice, estimateMrr, annualSavings, paymentCta,
  canUseFeature, PRODUCT, PLANS,
} from './plans.js';
import { stripeModeLabel, isStripeConfigured, paymentLinkForPlan } from './stripe-billing.js';
import {
  computeFirstCheckoutEstimate,
  auditBillingState,
  billingDebugEnabled,
  stripeAmountToMajor,
  introCouponId,
  introFirstMonthOff,
  normalizeBillingCycle,
} from './billing-money.js';

const FEATURE_ROWS = [
  { key: 'analytics', label: '売上分析' },
  { key: 'exportCsv', label: '期間CSV出力' },
  { key: 'multiLang', label: '日英メニュー' },
  { key: 'coupons', label: 'クーポン' },
  { key: 'inventory', label: '在庫・自動売切' },
  { key: 'soundAlert', label: '厨房アラート音' },
  { key: 'staffRoles', label: 'スタッフ権限' },
  { key: 'deepAnalytics', label: '深い分析' },
];

function formatDate(ms) {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildBillingSnapshot(shop = getShop(), { billingCycle } = {}) {
  const cycle = normalizeBillingCycle(billingCycle || shop.billingCycle);
  const plan = getPlan(shop.planId);
  const access = getShopAccess();
  const estimate = computeFirstCheckoutEstimate(plan, cycle);
  const price = planPrice(plan, cycle);
  const introOff = introFirstMonthOff(plan.id);
  const couponId = introCouponId(plan.id);

  const features = FEATURE_ROWS.map((row) => {
    const inPlan = !!plan.features[row.key];
    const unlocked = canUseFeature(shop, row.key, { subscribed: access.subscribed });
    return {
      ...row,
      inPlan,
      unlocked,
      state: unlocked ? 'ok' : (inPlan ? 'trial_lock' : 'plan_lock'),
    };
  });

  return {
    shopId: getShopId(),
    plan,
    cycle,
    access,
    subscribedAt: shop.subscribedAt,
    trialStartedAt: shop.trialStartedAt,
    trialEndsAt: shop.trialEndsAt,
    firestoreSubscribed: !!shop.subscribed,
    selfMrr: access.subscribed
      ? estimateMrr({ planId: shop.planId, stores: shop.stores || 1, cycle })
      : 0,
    price,
    setup: estimate.setup,
    chargeEstimate: estimate.total,
    estimateBreakdown: estimate,
    introOff,
    couponId,
    annualSave: annualSavings(plan),
    stripeMode: stripeModeLabel(),
    paymentLinkConfigured: isStripeConfigured(plan.id, cycle),
    features,
  };
}

export async function fetchStripeShopBillingHint(shopId) {
  const sid = String(shopId || getShopId() || '').trim();
  if (!sid) return { ok: false, error: 'missing_shop_id' };
  try {
    const debug = billingDebugEnabled();
    const q = debug ? '&debug=1' : '';
    const res = await fetch(`/api/stripe?shop=${encodeURIComponent(sid)}${q}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.error || `http_${res.status}`, status: res.status };
    }
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function statusBadge(access) {
  if (access.subscribed) return { label: '課金中', level: 'active' };
  if (access.trialActive) return { label: `トライアル（残り${access.daysLeft}日）`, level: 'trial' };
  if (access.trialExpired) return { label: 'トライアル終了', level: 'expired' };
  return { label: '未契約', level: 'pending' };
}

function trialProgress(access) {
  if (!access.trialActive || !access.daysLeft) return null;
  const total = PRODUCT.trialDays || 14;
  const left = access.daysLeft;
  const used = Math.max(0, total - left);
  return Math.min(100, Math.round((used / total) * 100));
}

function renderDebugPanel(snap, hint, checks) {
  if (!billingDebugEnabled()) return '';
  const lines = checks.map((c) =>
    `<li class="shop-bill-debug-item shop-bill-debug--${c.level}"><code>${escapeHtml(c.code)}</code> ${escapeHtml(c.message)}</li>`,
  );
  return `
    <details class="shop-bill-debug" open>
      <summary>課金デバッグ（billing_debug=1）</summary>
      <ul>${lines.join('')}</ul>
      <pre class="shop-bill-debug-pre">${escapeHtml(JSON.stringify({
        snapshot: {
          shopId: snap.shopId,
          cycle: snap.cycle,
          chargeEstimate: snap.chargeEstimate,
          breakdown: snap.estimateBreakdown,
          firestoreSubscribed: snap.firestoreSubscribed,
          accessSubscribed: snap.access.subscribed,
          paymentLink: paymentLinkForPlan(snap.plan.id, snap.cycle) ? '(set)' : '(missing)',
        },
        stripeApi: hint?.ok ? { shop: hint.shop, configured: hint.configured } : hint,
      }, null, 2))}</pre>
    </details>`;
}

/**
 * @param {HTMLElement} root
 * @param {{ billingCycle?: string, onCycleChange?: (c: string) => void, showPlanPicker?: boolean }} opts
 */
export function mountShopBillingDashboard(root, opts = {}) {
  if (!root) return;
  let cycle = normalizeBillingCycle(opts.billingCycle || getShop().billingCycle);

  const render = async () => {
    try {
      const shop = getShop();
      const snap = buildBillingSnapshot(shop, { billingCycle: cycle });
      const badge = statusBadge(snap.access);
      const progress = trialProgress(snap.access);
      const pay = paymentCta({
        shopId: snap.shopId,
        planId: shop.planId,
        email: shop.ownerEmail,
        billingCycle: cycle,
      });
      const hint = await fetchStripeShopBillingHint(snap.shopId);
      const pending = hint?.shop?.pendingPayment;
      const lastPaid = hint?.shop?.lastPayment;
      const lastAmountMajor = lastPaid?.amount != null
        ? (lastPaid.amountMajor ?? stripeAmountToMajor(lastPaid.amount, lastPaid.currency))
        : null;

      const checks = auditBillingState({
        shopId: snap.shopId,
        shopSubscribed: snap.firestoreSubscribed,
        accessSubscribed: snap.access.subscribed,
        cycle: snap.cycle,
        plan: snap.plan,
        chargeEstimate: snap.chargeEstimate,
        paymentLinkConfigured: snap.paymentLinkConfigured,
        stripeHintOk: hint?.ok,
        stripeHintError: hint?.ok ? null : (hint?.error || 'stripe_api_error'),
      });

      root.innerHTML = `
      <div class="shop-bill-head">
        <div>
          <p class="shop-bill-kicker">契約・課金状況</p>
          <h2 class="shop-bill-title">${escapeHtml(snap.plan.name)} <span class="shop-bill-badge shop-bill-badge--${badge.level}">${escapeHtml(badge.label)}</span></h2>
          <p class="shop-bill-sub">店舗ID <code>${escapeHtml(snap.shopId)}</code> · Stripe ${escapeHtml(snap.stripeMode)}モード</p>
        </div>
        <div class="shop-bill-cycle" role="group" aria-label="支払いサイクル（見積）">
          <button type="button" class="shop-bill-cycle-btn ${cycle === 'monthly' ? 'is-active' : ''}" data-bill-cycle="monthly">月払い</button>
          <button type="button" class="shop-bill-cycle-btn ${cycle === 'annual' ? 'is-active' : ''}" data-bill-cycle="annual">年払い</button>
        </div>
      </div>
      ${checks.some((c) => c.level === 'error') ? `<p class="shop-bill-alert">課金設定に問題があります。下のデバッグ情報を Ops に共有してください。</p>` : ''}
      ${progress != null ? `
        <div class="shop-bill-trial">
          <div class="shop-bill-trial-bar"><span style="width:${progress}%"></span></div>
          <p>無料トライアル — 残り <strong>${snap.access.daysLeft}</strong> 日</p>
        </div>` : ''}
      <div class="shop-bill-kpis">
        <div class="shop-bill-kpi">
          <span>月額（見込み）</span>
          <strong>¥${yen(snap.selfMrr || snap.price.perMonthEffective)}</strong>
          <em>${cycle === 'annual' ? '年払い実質/月' : '税別'}</em>
        </div>
        <div class="shop-bill-kpi">
          <span>初回お支払い目安</span>
          <strong>¥${yen(snap.chargeEstimate)}</strong>
          <em>初期 ¥${yen(snap.setup)} + ${cycle === 'annual' ? '年額' : '初月'}</em>
        </div>
        <div class="shop-bill-kpi">
          <span>契約開始</span>
          <strong>${snap.access.subscribed ? formatDate(snap.subscribedAt) : '—'}</strong>
          <em>${snap.access.subscribed ? '課金反映済み' : '未反映'}</em>
        </div>
        <div class="shop-bill-kpi">
          <span>年払いのお得</span>
          <strong>¥${yen(snap.annualSave)}</strong>
          <em>月払い×12 との差</em>
        </div>
      </div>
      ${pending ? `<p class="shop-bill-alert">Stripeで支払いを検知しました（反映待ち）。ページを再読み込みするか、完了画面から戻ってください。</p>` : ''}
      ${lastAmountMajor != null ? `<p class="shop-bill-note">直近のカード決済: ¥${yen(lastAmountMajor)}（${escapeHtml(lastPaid.currency || 'JPY')}）${lastPaid.at ? ` · ${formatDate(lastPaid.at)}` : ''}</p>` : ''}
      ${cycle === 'monthly' && snap.introOff > 0 && snap.couponId ? `
        <p class="shop-bill-promo">月払いの初回は Checkout でプロモコード <code>${escapeHtml(snap.couponId)}</code> を入力すると初月サブスクが ¥${yen(snap.plan.priceMonthly - snap.introOff)} に（¥${yen(snap.introOff)} off）</p>` : ''}
      <div class="shop-bill-actions">
        ${pay.mode === 'stripe'
          ? `<a class="store-save shop-bill-cta" href="${escapeHtml(pay.href)}" target="_blank" rel="noopener">${escapeHtml(pay.label)}</a>`
          : `<a class="store-save shop-bill-cta" href="${escapeHtml(pay.href)}">${escapeHtml(pay.label)}</a>`}
        <button type="button" class="store-mini-btn" data-bill-refresh>状態を再取得</button>
        <a class="store-mini-btn" href="admin.html?shop=${encodeURIComponent(snap.shopId)}&view=billing">厨房の料金タブ</a>
      </div>
      <details class="shop-bill-features">
        <summary>機能の利用状況（この店舗）</summary>
        <ul class="shop-bill-feature-list">
          ${snap.features.map((f) => `
            <li class="shop-bill-feature shop-bill-feature--${f.state}">
              <span>${escapeHtml(f.label)}</span>
              <em>${f.state === 'ok' ? '利用可' : f.state === 'trial_lock' ? 'トライアル/契約が必要' : 'プランアップが必要'}</em>
            </li>`).join('')}
        </ul>
      </details>
      ${opts.showPlanPicker ? `
        <div class="shop-bill-plans">
          <p class="shop-bill-sub">プラン変更は Firebase ログイン後に厨房の料金タブから</p>
          <div class="shop-bill-plan-row">
            ${PLANS.map((p) => `
              <span class="shop-bill-plan-chip ${p.id === snap.plan.id ? 'is-active' : ''}">${escapeHtml(p.name)}</span>`).join('')}
          </div>
        </div>` : ''}
      ${renderDebugPanel(snap, hint, checks)}
    `;

      root.querySelector('[data-bill-refresh]')?.addEventListener('click', () => render());
      root.querySelectorAll('[data-bill-cycle]').forEach((btn) => {
        btn.addEventListener('click', () => {
          cycle = normalizeBillingCycle(btn.dataset.billCycle);
          opts.onCycleChange?.(cycle);
          render();
        });
      });
    } catch (e) {
      console.error('[billing-dashboard]', e);
      root.innerHTML = `<p class="shop-bill-alert">課金ダッシュボードの表示に失敗しました: ${escapeHtml(e?.message || e)}</p>`;
    }
  };

  render();
  return { refresh: render };
}
