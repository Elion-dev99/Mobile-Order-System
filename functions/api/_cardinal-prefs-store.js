/**
 * Cardinal capability prefs (Cache API) — shared by GitHub cron, Ops, and dispatch gates.
 */

const CACHE_URL = 'https://mobile-order-system.pages.dev/__cardinal_prefs_v2';
const CACHE_URL_LEGACY = 'https://mobile-order-system.pages.dev/__cardinal_prefs_v1';

function resolveCache(cachesObj) {
  try {
    if (typeof caches !== 'undefined' && caches?.default) return caches.default;
  } catch (_) {}
  try {
    if (cachesObj?.default) return cachesObj.default;
  } catch (_) {}
  return null;
}

/** Keep in sync with js/cardinal-features.js CARDINAL_CAPABILITIES ids. */
export const CARDINAL_CAPABILITY_DEFS = [
  { id: 'masterCursorDispatch', defaultOn: false },
  { id: 'masterServerCron', defaultOn: false },
  { id: 'opsClientCardinal', defaultOn: false },
  { id: 'autoMaintenance', defaultOn: false },
  { id: 'dispatchOnOutage', defaultOn: false },
  { id: 'watchdog', defaultOn: false },
  { id: 'anomalyScan', defaultOn: false },
  { id: 'dailyDigest', defaultOn: false },
  { id: 'quietHours', defaultOn: false },
  { id: 'timeline', defaultOn: false },
  { id: 'proactiveSteward', defaultOn: false },
  { id: 'ciDispatch', defaultOn: false },
  { id: 'prGuardian', defaultOn: false },
  { id: 'productGate', defaultOn: false },
  { id: 'marketScout', defaultOn: false },
  { id: 'dualFeatureReview', defaultOn: false },
  { id: 'tickHealthyDiscord', defaultOn: false },
];

export function defaultCardinalPrefs() {
  return {
    capabilities: Object.fromEntries(CARDINAL_CAPABILITY_DEFS.map((c) => [c.id, c.defaultOn])),
    quietStart: '23:00',
    quietEnd: '08:00',
    timezone: 'Asia/Tokyo',
    anomalyZeroOrderHours: 3,
    anomalyPendingWarn: 5,
    digestHourJst: 9,
    updatedAt: 0,
    updatedBy: '',
  };
}

export function normalizeCardinalPrefs(raw = {}) {
  const base = defaultCardinalPrefs();
  const caps = { ...base.capabilities, ...(raw.capabilities || {}) };
  for (const def of CARDINAL_CAPABILITY_DEFS) {
    if (caps[def.id] === 'false' || caps[def.id] === 0) caps[def.id] = false;
    else if (caps[def.id] === 'true' || caps[def.id] === 1) caps[def.id] = true;
    else if (typeof caps[def.id] !== 'boolean') caps[def.id] = def.defaultOn;
  }
  return {
    ...base,
    ...raw,
    capabilities: caps,
    quietStart: String(raw.quietStart || base.quietStart).slice(0, 8),
    quietEnd: String(raw.quietEnd || base.quietEnd).slice(0, 8),
    timezone: String(raw.timezone || base.timezone).slice(0, 64),
    anomalyZeroOrderHours: Math.min(48, Math.max(1, Number(raw.anomalyZeroOrderHours) || base.anomalyZeroOrderHours)),
    anomalyPendingWarn: Math.min(50, Math.max(1, Number(raw.anomalyPendingWarn) || base.anomalyPendingWarn)),
    digestHourJst: Math.min(23, Math.max(0, Number(raw.digestHourJst) ?? base.digestHourJst)),
    updatedAt: Number(raw.updatedAt) || 0,
    updatedBy: String(raw.updatedBy || '').slice(0, 120),
  };
}

export function isServerCapabilityOn(prefs, id) {
  const p = normalizeCardinalPrefs(prefs);
  return p.capabilities[id] !== false;
}

export function capabilityForKind(kind) {
  const k = String(kind || 'ops');
  if (k.startsWith('product_')) {
    if (k === 'product_scout') return 'marketScout';
    if (k === 'product_review') return 'dualFeatureReview';
    if (k === 'product_implement') return 'productGate';
    return 'productGate';
  }
  const map = {
    incident: 'dispatchOnOutage',
    followup: 'dispatchOnOutage',
    watchdog: 'watchdog',
    steward: 'proactiveSteward',
    ci: 'ciDispatch',
    pr_review: 'prGuardian',
  };
  return map[k] || null;
}

/** Gate Cursor Automations / Cloud Agents launches. */
export function allowCursorDispatch(prefs, kind, { force = false } = {}) {
  const p = normalizeCardinalPrefs(prefs);
  if (!isServerCapabilityOn(p, 'masterCursorDispatch')) {
    return { ok: false, reason: 'master_cursor_dispatch_off' };
  }
  if (force) {
    return { ok: true };
  }
  const cap = capabilityForKind(kind);
  if (cap && !isServerCapabilityOn(p, cap)) {
    return { ok: false, reason: `capability_off:${cap}` };
  }
  return { ok: true };
}

export function allCapabilitiesOff() {
  return Object.fromEntries(CARDINAL_CAPABILITY_DEFS.map((c) => [c.id, false]));
}

/** GitHub scheduled cron (cardinal-cron.yml) — not manual Ops buttons. */
export function allowGithubCron(prefs, source) {
  const src = String(source || '');
  if (!src.includes('github-cron')) return { ok: true };
  const p = normalizeCardinalPrefs(prefs);
  if (!isServerCapabilityOn(p, 'masterServerCron')) {
    return { ok: false, reason: 'master_server_cron_off' };
  }
  return { ok: true };
}

export async function readCardinalPrefs(cachesObj) {
  try {
    const cache = resolveCache(cachesObj);
    if (!cache) return defaultCardinalPrefs();
    const hit = await cache.match(CACHE_URL);
    if (hit) {
      const data = await hit.json();
      if (!data.shutdownEpoch) {
        const shutdown = {
          ...normalizeCardinalPrefs(data),
          capabilities: allCapabilitiesOff(),
          shutdownEpoch: 1,
          updatedAt: Date.now(),
          updatedBy: 'forced-shutdown-2026-08',
        };
        const res = new Response(JSON.stringify(shutdown), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=604800',
          },
        });
        await cache.put(CACHE_URL, res);
        return normalizeCardinalPrefs(shutdown);
      }
      return normalizeCardinalPrefs(data);
    }
    // v2 未作成: 全機能 OFF で初期化（v1 の ON 状態は引き継がない）
    const shutdown = {
      ...defaultCardinalPrefs(),
      capabilities: allCapabilitiesOff(),
      updatedAt: Date.now(),
      updatedBy: 'init-v2-shutdown',
    };
    const res = new Response(JSON.stringify(shutdown), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=604800',
      },
    });
    await cache.put(CACHE_URL, res);
    try { await cache.delete(CACHE_URL_LEGACY); } catch (_) {}
    return normalizeCardinalPrefs(shutdown);
  } catch {
    return defaultCardinalPrefs();
  }
}

export async function writeCardinalPrefs(cachesObj, partial, updatedBy = 'ops') {
  const prev = await readCardinalPrefs(cachesObj);
  const next = normalizeCardinalPrefs({
    ...prev,
    ...partial,
    capabilities: {
      ...prev.capabilities,
      ...(partial.capabilities || {}),
    },
    updatedAt: Date.now(),
    updatedBy: String(updatedBy || partial.updatedBy || 'ops').slice(0, 120),
  });
  const cache = resolveCache(cachesObj);
  if (!cache) {
    return { ...next, persisted: false, persistError: 'no_cache_api' };
  }
  const res = new Response(JSON.stringify(next), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=604800',
    },
  });
  await cache.put(CACHE_URL, res);
  return { ...next, persisted: true };
}
