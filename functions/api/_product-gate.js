/**
 * Product / marketing feature gate — dual Cardinal approval before implementation.
 * Stored in Cache API (same pattern as maintenance ledger).
 */

const CACHE_URL = 'https://mobile-order-system.pages.dev/__cardinal_product_gate_v1';
const MAX_PROPOSALS = 24;

function resolveCache(cachesObj) {
  try {
    if (typeof caches !== 'undefined' && caches?.default) return caches.default;
  } catch (_) {}
  try {
    if (cachesObj?.default) return cachesObj.default;
  } catch (_) {}
  return null;
}

export function defaultProductGate() {
  return {
    proposals: [],
    lastCycleAt: 0,
    updatedAt: 0,
  };
}

function normalizeVerdict(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'approve' || s === 'approved' || s === 'ok') return 'approve';
  if (s === 'reject' || s === 'rejected' || s === 'no') return 'reject';
  return null;
}

export function normalizeProposal(raw = {}) {
  const id = String(raw.id || '').slice(0, 40) || `prop_${Date.now().toString(36)}`;
  const g = normalizeVerdict(raw.guardianVerdict);
  const e = normalizeVerdict(raw.executorVerdict);
  let status = String(raw.status || 'proposed');
  if (status === 'proposed' && g === 'reject') status = 'rejected';
  if (status === 'proposed' && e === 'reject') status = 'rejected';
  if (g === 'approve' && e === 'approve' && status !== 'implemented') status = 'approved';
  return {
    id,
    createdAt: Number(raw.createdAt) || Date.now(),
    title: String(raw.title || '無題').slice(0, 160),
    summary: String(raw.summary || '').slice(0, 2000),
    marketSignal: String(raw.marketSignal || '').slice(0, 1200),
    marketingAngle: String(raw.marketingAngle || '').slice(0, 1200),
    acceptance: Array.isArray(raw.acceptance)
      ? raw.acceptance.map((a) => String(a).slice(0, 240)).slice(0, 12)
      : [],
    guardianVerdict: g,
    executorVerdict: e,
    guardianNotes: String(raw.guardianNotes || '').slice(0, 2000),
    executorNotes: String(raw.executorNotes || '').slice(0, 2000),
    status,
    implementedAt: Number(raw.implementedAt) || 0,
    branch: String(raw.branch || '').slice(0, 80),
    scoutSource: String(raw.scoutSource || 'cursor').slice(0, 40),
    implementationReport: normalizeImplementationReport(raw.implementationReport || raw.report),
  };
}

function normalizeImplementationReport(raw) {
  if (!raw || typeof raw !== 'object') {
    if (typeof raw === 'string' && raw.trim()) {
      return { summary: raw.trim().slice(0, 12000), reportedAt: Date.now() };
    }
    return null;
  }
  const files = Array.isArray(raw.filesChanged || raw.files)
    ? (raw.filesChanged || raw.files).map((f) => String(f).slice(0, 200)).slice(0, 40)
    : [];
  return {
    summary: String(raw.summary || raw.implementationSummary || '').slice(0, 12000),
    changes: String(raw.changes || raw.changeLog || '').slice(0, 12000),
    prUrl: String(raw.prUrl || raw.pr || '').slice(0, 500),
    filesChanged: files,
    testsRun: String(raw.testsRun || raw.tests || '').slice(0, 4000),
    verification: String(raw.verification || raw.acceptanceNotes || '').slice(0, 4000),
    rawMarkdown: String(raw.rawMarkdown || raw.markdown || raw.report || '').slice(0, 16000),
    reportedAt: Number(raw.reportedAt) || Date.now(),
  };
}

export function normalizeProductGate(raw = {}) {
  const base = defaultProductGate();
  const proposals = Array.isArray(raw.proposals)
    ? raw.proposals.map(normalizeProposal).slice(0, MAX_PROPOSALS)
    : [];
  return {
    proposals,
    lastCycleAt: Number(raw.lastCycleAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

export async function readProductGate(cachesObj) {
  try {
    const cache = resolveCache(cachesObj);
    if (!cache) return defaultProductGate();
    const hit = await cache.match(CACHE_URL);
    if (!hit) return defaultProductGate();
    return normalizeProductGate(await hit.json());
  } catch {
    return defaultProductGate();
  }
}

export async function writeProductGate(cachesObj, next) {
  const normalized = normalizeProductGate({
    ...next,
    updatedAt: Date.now(),
  });
  try {
    const cache = resolveCache(cachesObj);
    if (!cache) return { ...normalized, persisted: false };
    await cache.put(
      CACHE_URL,
      new Response(JSON.stringify(normalized), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'max-age=2592000',
        },
      }),
    );
    return { ...normalized, persisted: true };
  } catch (e) {
    return { ...normalized, persisted: false, persistError: String(e?.message || e) };
  }
}

export function activeProposal(gate = defaultProductGate()) {
  const open = (gate.proposals || []).filter(
    (p) => !['rejected', 'implemented'].includes(p.status),
  );
  if (!open.length) return null;
  return open.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
}

/**
 * Next automated step in the product pipeline.
 * @returns {{ step: 'idle'|'scout'|'guardian_review'|'executor_review'|'implement', proposal: object|null, reason?: string }}
 */
export function planProductCycle(gate = defaultProductGate(), { forceScout = false } = {}) {
  const proposal = activeProposal(gate);
  if (!proposal) {
    const last = (gate.proposals || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const stale = !last || last.status === 'implemented' || last.status === 'rejected';
    const oldEnough = !last || Date.now() - (last.createdAt || 0) > weekMs;
    if (forceScout || (stale && oldEnough)) {
      return { step: 'scout', proposal: null, reason: forceScout ? 'force' : 'no_active_proposal' };
    }
    return { step: 'idle', proposal: null, reason: 'cooldown_or_waiting' };
  }

  if (proposal.status === 'approved' || (proposal.guardianVerdict === 'approve' && proposal.executorVerdict === 'approve')) {
    return { step: 'implement', proposal };
  }
  if (proposal.guardianVerdict === 'reject' || proposal.executorVerdict === 'reject') {
    return { step: 'idle', proposal, reason: 'rejected' };
  }
  if (!proposal.guardianVerdict) {
    return { step: 'guardian_review', proposal };
  }
  if (proposal.guardianVerdict === 'approve' && !proposal.executorVerdict) {
    return { step: 'executor_review', proposal };
  }
  return { step: 'idle', proposal, reason: 'unknown_state' };
}

export async function addProposal(cachesObj, input = {}) {
  const gate = await readProductGate(cachesObj);
  const row = normalizeProposal({
    ...input,
    id: input.id || `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: Date.now(),
    status: 'proposed',
  });
  const proposals = [row, ...(gate.proposals || [])].slice(0, MAX_PROPOSALS);
  const saved = await writeProductGate(cachesObj, { ...gate, proposals, lastCycleAt: Date.now() });
  return { gate: saved, proposal: row };
}

export async function applyProductReview(cachesObj, { proposalId, role, verdict, notes = '' } = {}) {
  const gate = await readProductGate(cachesObj);
  const id = String(proposalId || '');
  const v = normalizeVerdict(verdict);
  if (!id || !v) return { ok: false, error: 'invalid_review' };
  const isGuardian = role === 'guardian';
  const isExecutor = role === 'executor';
  if (!isGuardian && !isExecutor) return { ok: false, error: 'invalid_role' };

  let found = null;
  const proposals = (gate.proposals || []).map((p) => {
    if (p.id !== id) return p;
    found = p;
    const next = { ...p };
    if (isGuardian) {
      next.guardianVerdict = v;
      next.guardianNotes = String(notes || '').slice(0, 2000);
    } else {
      next.executorVerdict = v;
      next.executorNotes = String(notes || '').slice(0, 2000);
    }
    return normalizeProposal(next);
  });
  if (!found) return { ok: false, error: 'proposal_not_found' };
  const saved = await writeProductGate(cachesObj, { ...gate, proposals, lastCycleAt: Date.now() });
  const updated = proposals.find((p) => p.id === id);
  return { ok: true, gate: saved, proposal: updated };
}

export async function markProposalImplemented(cachesObj, { proposalId, branch = '', report = null } = {}) {
  const gate = await readProductGate(cachesObj);
  const id = String(proposalId || '');
  let found = null;
  const proposals = (gate.proposals || []).map((p) => {
    if (p.id !== id) return p;
    found = p;
    const implReport = report != null && report !== undefined
      ? normalizeImplementationReport(report)
      : null;
    return normalizeProposal({
      ...p,
      status: 'implemented',
      implementedAt: Date.now(),
      branch: branch || p.branch,
      implementationReport: implReport || p.implementationReport,
    });
  });
  if (!found) return { ok: false, error: 'proposal_not_found' };
  const saved = await writeProductGate(cachesObj, { ...gate, proposals, lastCycleAt: Date.now() });
  return { ok: true, gate: saved, proposal: proposals.find((p) => p.id === id) };
}

export function summarizeProductGate(gate = defaultProductGate()) {
  const active = activeProposal(gate);
  const plan = planProductCycle(gate);
  return {
    count: (gate.proposals || []).length,
    active: active
      ? {
          id: active.id,
          title: active.title,
          status: active.status,
          guardianVerdict: active.guardianVerdict,
          executorVerdict: active.executorVerdict,
        }
      : null,
    nextStep: plan.step,
    lastCycleAt: gate.lastCycleAt || 0,
    recent: (gate.proposals || []).slice(0, 5).map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      guardianVerdict: p.guardianVerdict,
      executorVerdict: p.executorVerdict,
      createdAt: p.createdAt,
    })),
  };
}
