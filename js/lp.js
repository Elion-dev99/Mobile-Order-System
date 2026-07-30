import { PLANS, PRODUCT, ADDONS, getPlan, yen, planPrice, planComparisonRows, estimateMrr } from './plans.js';
import { submitLead } from './leads.js';

let billingCycle = 'monthly';
let selectedPlanId = 'growth';

function renderPlans() {
  const grid = document.getElementById('planGrid');
  grid.innerHTML = PLANS.map(plan => {
    const price = planPrice(plan, billingCycle);
    const setup = yen(plan.priceSetup);
    return `
      <article class="lp-plan ${plan.recommended ? 'is-rec' : ''}" data-plan="${plan.id}">
        ${plan.badge ? `<div class="lp-plan-badge">${plan.badge}</div>` : ''}
        <div class="lp-plan-name">${plan.name}</div>
        <p class="lp-plan-tag">${plan.tagline}</p>
        <div class="lp-plan-price">
          <span>¥</span><strong>${yen(price.perMonthEffective)}</strong><em>/月</em>
        </div>
        <div class="lp-plan-sub">
          ${billingCycle === 'annual' ? `年額 ¥${yen(price.chargeNow)}（一括）` : '税別・月額課金'}
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
    });
  });

  document.getElementById('planFootnote').textContent =
    `${PRODUCT.competitorNote} 追加店舗は ¥${yen(PRODUCT.extraStoreMonthly)}/月（Growth以上・Chainは店舗無制限）。`;
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

function recommendPlan(tables) {
  if (tables <= 15) return getPlan('lite');
  if (tables <= 50) return getPlan('growth');
  if (tables <= 100) return getPlan('business');
  return getPlan('chain');
}

function updateRoi() {
  const tables = Number(document.getElementById('roiTables').value);
  const turns = Number(document.getElementById('roiTurns').value);
  const ticket = Number(document.getElementById('roiTicket').value);
  const attach = Number(document.getElementById('roiAttach').value) / 100;

  document.getElementById('roiTablesOut').textContent = String(tables);
  document.getElementById('roiTurnsOut').textContent = String(turns);
  document.getElementById('roiTicketOut').textContent = yen(ticket);
  document.getElementById('roiAttachOut').textContent = String(Math.round(attach * 100));

  const dailyCovers = tables * turns;
  const monthlyGmv = Math.round(dailyCovers * ticket * attach * 30);
  const plan = recommendPlan(tables);
  const cost = estimateMrr({ planId: plan.id, stores: 1, cycle: billingCycle });
  const rate = monthlyGmv > 0 ? ((cost / monthlyGmv) * 100).toFixed(2) : '—';

  document.getElementById('roiGmv').textContent = `¥${yen(monthlyGmv)}`;
  document.getElementById('roiPlan').textContent = plan.name;
  document.getElementById('roiCost').textContent = `¥${yen(cost)}`;
  document.getElementById('roiRate').textContent = rate === '—' ? '—' : `${rate}%`;
}

document.querySelectorAll('.lp-cycle').forEach(btn => {
  btn.addEventListener('click', () => {
    billingCycle = btn.dataset.cycle;
    document.querySelectorAll('.lp-cycle').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('leadCycle').value = billingCycle;
    renderPlans();
    updateRoi();
  });
});

['roiTables', 'roiTurns', 'roiTicket', 'roiAttach'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateRoi);
});

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
  const cycle = String(fd.get('billingCycle') || 'monthly');
  const stores = Number(fd.get('stores') || 1);
  const plan = getPlan(planId);
  const mrr = estimateMrr({ planId, stores, cycle });

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
  };

  try {
    await submitLead(payload);
    status.textContent = `送信しました。${plan.name}（見込み月額 ¥${yen(mrr)}）で折り返します。`;
    form.reset();
    fillLeadPlanSelect();
  } catch (err) {
    console.error(err);
    status.classList.add('error');
    status.textContent = '送信に失敗しました。Firestoreルールまたはネットワークを確認してください。';
  } finally {
    submitBtn.disabled = false;
  }
});

renderPlans();
renderCompare();
renderAddons();
fillLeadPlanSelect();
updateRoi();
