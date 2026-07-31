/**
 * Last Cardinal agent launches (Cache API) — cooldown + follow-up without D1.
 */

const CACHE_URL = 'https://mobile-order-system.pages.dev/__cardinal_agent_ledger_v1';
const MAX_LAUNCHES = 40;

export function defaultLedger() {
  return {
    launches: [],
    lastByKind: {},
    updatedAt: 0,
  };
}

export function normalizeLedger(raw = {}) {
  const base = defaultLedger();
  const launches = Array.isArray(raw.launches) ? raw.launches.slice(0, MAX_LAUNCHES) : [];
  return {
    launches,
    lastByKind: raw.lastByKind && typeof raw.lastByKind === 'object' ? raw.lastByKind : {},
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

export async function readAgentLedger(cachesObj) {
  try {
    const cache = cachesObj?.default;
    if (!cache) return defaultLedger();
    const hit = await cache.match(CACHE_URL);
    if (!hit) return defaultLedger();
    return normalizeLedger(await hit.json());
  } catch {
    return defaultLedger();
  }
}

export async function writeAgentLedger(cachesObj, next) {
  const normalized = normalizeLedger({
    ...next,
    updatedAt: Date.now(),
  });
  try {
    const cache = cachesObj?.default;
    if (!cache) return normalized;
    await cache.put(
      CACHE_URL,
      new Response(JSON.stringify(normalized), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'max-age=2592000',
        },
      }),
    );
  } catch (_) {}
  return normalized;
}

/**
 * Record a launch. kind examples: incident | ci | steward | watchdog | pr_review | followup
 */
export async function recordLaunch(cachesObj, entry = {}) {
  const prev = await readAgentLedger(cachesObj);
  const kind = String(entry.kind || 'ops').slice(0, 40);
  const row = {
    at: Date.now(),
    role: entry.role === 'guardian' ? 'guardian' : 'executor',
    kind,
    title: String(entry.title || '').slice(0, 160),
    launched: entry.launched !== false,
    agentOk: !!entry.agentOk,
    branch: String(entry.branch || '').slice(0, 80),
  };
  const launches = [row, ...prev.launches].slice(0, MAX_LAUNCHES);
  const lastByKind = { ...prev.lastByKind, [kind]: row.at };
  if (row.role === 'executor') lastByKind.executor = row.at;
  if (row.role === 'guardian') lastByKind.guardian = row.at;
  return writeAgentLedger(cachesObj, { launches, lastByKind });
}

/** True if we launched this kind within cooldownMs. */
export function recentlyLaunched(ledger, kind, cooldownMs) {
  const at = Number(ledger?.lastByKind?.[kind] || 0);
  if (!at) return false;
  return Date.now() - at < cooldownMs;
}
