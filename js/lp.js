import {
  PLANS, PRODUCT, ADDONS, getPlan, yen, planPrice, planComparisonRows,
  estimateMrr, annualSavings, paymentCta, estimateSetup,
} from './plans.js';
import { submitLead } from './leads.js';
import {
  loadMaintenance, subscribeMaintenance, mountMaintenanceBanner, isMaintenanceMode, maintenanceMessage,
} from './maintenance.js';

let billingCycle = PRODUCT.defaultBillingCycle || 'annual';
let selectedPlanId = 'growth';

function renderScarcity() {
  const el = document.getElementById('lpScarcity');
  if (!el) return;
  const n = Number(PRODUCT.introSlotsRemaining || 0);
  if (n <= 0) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = `${PRODUCT.introSlotsLabel} 残り ${n} 店 · 14日トライアル付き`;
}

function updateHeroCta() {
  const growth = getPlan('growth');
  const ap = planPrice(growth, 'annual');
  const btn = document.getElementById('heroAnnualCta');
  if (btn) {
    btn.textContent = `Growth年払い 実質¥${yen(ap.perMonthEffective)}/月で相談`;
    btn.addEventListener('click', () => {
      selectedPlanId = 'growth';
      billingCycle = 'annual';
      document.querySelectorAll('.lp-cycle').forEach(b => b.classList.toggle('active', b.dataset.cycle === 'annual'));
      const sel = document.getElementById('leadPlan');
      const cycle = document.getElementById('leadCycle');
      if (sel) sel.value = 'growth';
      if (cycle) cycle.value = 'annual';
      updateQuotePreview();
      renderPlans();
    }, { once: false });
  }
}

function renderPayCta() {
  const a = document.getElementById('lpPayCta');
  if (!a) return;
  const pay = paymentCta();
  if (pay.mode === 'stripe') {
    a.hidden = false;
    a.href = pay.href;
    a.textContent = pay.label;
    a.target = '_blank';
    a.rel = 'noopener';
  } else {
    a.hidden = true;
  }
}

function updateQuotePreview() {
  const el = document.getElementById('leadQuotePreview');
  if (!el) return;
  const plan = getPlan(selectedPlanId || document.getElementById('leadPlan')?.value || 'growth');
  const cycle = document.getElementById('leadCycle')?.value || billingCycle;
  const stores = Number(document.getElementById('leadForm')?.stores?.value || 1);
  const mrr = estimateMrr({ planId: plan.id, stores, cycle });
  const setup = estimateSetup(plan.id);
  const ap = planPrice(plan, cycle);
  if (cycle === 'annual') {
    el.textContent = `見積プレビュー: ${plan.name} 年額 ¥${yen(ap.chargeNow)}（実質 ¥${yen(ap.perMonthEffective)}/月・¥${yen(annualSavings(plan))}お得）+ 初期 ¥${yen(setup)} ≒ 初回 ¥${yen(ap.chargeNow + setup)}`;
  } else {
    el.textContent = `見積プレビュー: ${plan.name} 月額 ¥${yen(mrr)} + 初期 ¥${yen(setup)} · 年払いなら実質 ¥${yen(planPrice(plan, 'annual').perMonthEffective)}/月`;
  }
}

function renderPlans() {
  const grid = document.getElementById('planGrid');
  grid.innerHTML = PLANS.map(plan => {
    const price = planPrice(plan, billingCycle);
    const setup = yen(plan.priceSetup);
    const save = annualSavings(plan);
    return `
      <article class="lp-plan ${plan.recommended ? 'is-rec' : ''}" data-plan="${plan.id}">
        ${plan.badge ? `<div class="lp-plan-badge">${plan.badge}</div>` : ''}
        <div class="lp-plan-name">${plan.name}</div>
        <p class="lp-plan-tag">${plan.tagline}</p>
        <div class="lp-plan-price">
          <span>¥</span><strong>${yen(price.perMonthEffective)}</strong><em>/月</em>
        </div>
        <div class="lp-plan-sub">
          ${billingCycle === 'annual'
            ? `年額 ¥${yen(price.chargeNow)}（一括）· ¥${yen(save)}お得`
            : '税別・月額課金'}
          · 初期 ¥${setup}
        </div>
        <ul>${plan.highlights.map(h => `<li>${h}</li>`).join('')}</ul>
        <a href="#contact" class="lp-btn-primary lp-btn-block plan-pick" data-plan="${plan.id}">${plan.cta}</a>
      </article>`;
  }).join('');

  grid.querySelectorAll('.plan-pick').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedPlanId = btn.dataset.plan;
      const sel = document.getElementById('leadPlan');
      if (sel) sel.value = selectedPlanId;
      updateQuotePreview();
    });
  });

  document.getElementById('planFootnote').textContent =
    `${PRODUCT.competitorNote} 追加店舗は ¥${yen(PRODUCT.extraStoreMonthly)}/月（Growth以上・Chainは店舗無制限）。${PRODUCT.trialDays}日トライアルあり。`;
}

function renderCompare() {
  const table = document.getElementById('compareTable');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  thead.innerHTML = `<tr><th>機能</th>${PLANS.map(p => `<th>${p.name}</th>`).join('')}</tr>`;
  tbody.innerHTML = planComparisonRows().map(row =>
    `<tr><td>${row.label}</td>${row.values.map(v => `<td>${v}</td>`).join('')}</tr>`
  ).join('');
}

function renderAddons() {
  document.getElementById('addonGrid').innerHTML = ADDONS.map(a => `
    <div class="lp-addon">
      <h3>${a.name}</h3>
      <p>¥${yen(a.price)}</p>
      <span>/${a.unit}</span>
    </div>
  `).join('');
}

function fillLeadPlanSelect() {
  const sel = document.getElementById('leadPlan');
  sel.innerHTML = PLANS.map(p =>
    `<option value="${p.id}" ${p.id === 'growth' ? 'selected' : ''}>${p.name}（¥${yen(p.priceMonthly)}/月）</option>`
  ).join('');
}

function recommendPlan(tables, stores) {
  if (stores >= 4) return getPlan('chain');
  if (tables <= 15 && stores === 1) return getPlan('lite');
  if (tables <= 50 && stores === 1) return getPlan('growth');
  if (stores <= 3) return getPlan('business');
  return getPlan('chain');
}

function updateRoi() {
  const tables = Number(document.getElementById('roiTables').value);
  const seats = Number(document.getElementById('roiSeats').value);
  const turns = Number(document.getElementById('roiTurns').value);
  const days = Number(document.getElementById('roiDays').value);
  const ticket = Number(document.getElementById('roiTicket').value);
  const attach = Number(document.getElementById('roiAttach').value) / 100;
  const stores = Number(document.getElementById('roiStores').value);

  document.getElementById('roiTablesOut').textContent = String(tables);
  document.getElementById('roiSeatsOut').textContent = String(seats);
  document.getElementById('roiTurnsOut').textContent = String(turns);
  document.getElementById('roiDaysOut').textContent = String(days);
  document.getElementById('roiTicketOut').textContent = yen(ticket);
  document.getElementById('roiAttachOut').textContent = String(Math.round(attach * 100));
  document.getElementById('roiStoresOut').textContent = String(stores);

  const dailyCovers = tables * seats * turns;
  const monthlyGmv = Math.round(dailyCovers * ticket * attach * days * stores);
  const plan = recommendPlan(tables, stores);
  const cost = estimateMrr({ planId: plan.id, stores, cycle: billingCycle });
  const rate = monthlyGmv > 0 ? ((cost / monthlyGmv) * 100).toFixed(2) : '—';

  document.getElementById('roiGmv').textContent = `¥${yen(monthlyGmv)}`;
  document.getElementById('roiPlan').textContent = plan.name;
  document.getElementById('roiCost').textContent = `¥${yen(cost)}`;
  document.getElementById('roiRate').textContent = rate === '—' ? '—' : `${rate}%`;
  document.getElementById('roiAnnual').textContent = `¥${yen(cost * 12)}`;
}

document.querySelectorAll('.lp-cycle').forEach(btn => {
  btn.addEventListener('click', () => {
    billingCycle = btn.dataset.cycle;
    document.querySelectorAll('.lp-cycle').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('leadCycle').value = billingCycle;
    renderPlans();
    updateRoi();
    updateQuotePreview();
  });
});

['roiTables', 'roiSeats', 'roiTurns', 'roiDays', 'roiTicket', 'roiAttach', 'roiStores'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateRoi);
});

document.getElementById('leadPlan')?.addEventListener('change', (e) => {
  selectedPlanId = e.target.value;
  updateQuotePreview();
});
document.getElementById('leadCycle')?.addEventListener('change', updateQuotePreview);
document.querySelector('#leadForm [name=stores]')?.addEventListener('input', updateQuotePreview);

const form = document.getElementById('leadForm');
const status = document.getElementById('leadStatus');
const submitBtn = document.getElementById('leadSubmit');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  status.hidden = false;
  status.classList.remove('error');
  status.textContent = '送信中...';
  submitBtn.disabled = true;

  const fd = new FormData(form);
  const planId = String(fd.get('planId') || 'growth');
  const cycle = String(fd.get('billingCycle') || 'annual');
  const stores = Number(fd.get('stores') || 1);
  const plan = getPlan(planId);
  const mrr = estimateMrr({ planId, stores, cycle });
  const ap = planPrice(plan, cycle);

  const payload = {
    shopName: String(fd.get('shopName') || '').trim(),
    email: String(fd.get('email') || '').trim(),
    phone: String(fd.get('phone') || '').trim(),
    tables: String(fd.get('tables') || ''),
    stores,
    planId,
    planName: plan.name,
    billingCycle: cycle,
    message: String(fd.get('message') || '').trim(),
    planPrice: plan.priceMonthly,
    estimatedMrr: mrr,
    setupFee: plan.priceSetup,
    chargeNow: cycle === 'annual' ? ap.chargeNow + plan.priceSetup : plan.priceMonthly + plan.priceSetup,
    annualSavings: cycle === 'annual' ? annualSavings(plan) : 0,
    source: 'lp_revenue_max',
  };

  try {
    if (isMaintenanceMode()) throw new Error(maintenanceMessage());
    await submitLead(payload);
    status.textContent = cycle === 'annual'
      ? `送信しました。${plan.name}年払い（初回目安 ¥${yen(payload.chargeNow)}）で折り返します。`
      : `送信しました。${plan.name}（見込み月額 ¥${yen(mrr)}）で折り返します。`;
    form.reset();
    fillLeadPlanSelect();
    document.getElementById('leadCycle').value = PRODUCT.defaultBillingCycle || 'annual';
    updateQuotePreview();
  } catch (err) {
    console.error(err);
    status.classList.add('error');
    status.textContent = isMaintenanceMode()
      ? maintenanceMessage()
      : '送信に失敗しました。Firestoreルールまたはネットワークを確認してください。';
  } finally {
    submitBtn.disabled = false;
  }
});

renderScarcity();
updateHeroCta();
renderPayCta();
renderPlans();
renderCompare();
renderAddons();
fillLeadPlanSelect();
document.getElementById('leadCycle').value = billingCycle;
updateRoi();
updateQuotePreview();
loadMaintenance().catch(() => {}).then(() => {
  subscribeMaintenance();
  mountMaintenanceBanner({ compact: true });
});
