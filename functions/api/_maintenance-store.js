/**
 * Durable-enough maintenance flag for Pages Functions via Cache API.
 * Survives Firestore outages so Cardinal can still flip the kill switch.
 */

const CACHE_URL = 'https://mobile-order-system.pages.dev/__platform_maintenance_v1';
const DEFAULT_MESSAGE = 'システム障害を検知したため一時停止中です。ご注文はレジにてお願いいたします。';

export function defaultMaintenanceState() {
  return {
    maintenance: false,
    message: DEFAULT_MESSAGE,
    updatedAt: 0,
    updatedBy: '',
    source: 'manual', // manual | cardinal
    auto: false,
  };
}

export function normalizeMaintenance(raw = {}) {
  const base = defaultMaintenanceState();
  const message = String(raw.message || base.message).trim().slice(0, 200) || base.message;
  const source = raw.source === 'cardinal' ? 'cardinal' : 'manual';
  return {
    maintenance: raw.maintenance === true || raw.maintenance === 'true' || raw.maintenance === 1,
    message,
    updatedAt: Number(raw.updatedAt) || 0,
    updatedBy: String(raw.updatedBy || '').slice(0, 120),
    source,
    auto: raw.auto === true || source === 'cardinal',
  };
}

export async function readMaintenanceState(cachesObj) {
  try {
    const cache = cachesObj?.default;
    if (!cache) return defaultMaintenanceState();
    const hit = await cache.match(CACHE_URL);
    if (!hit) return defaultMaintenanceState();
    const data = await hit.json();
    return normalizeMaintenance(data);
  } catch {
    return defaultMaintenanceState();
  }
}

export async function writeMaintenanceState(cachesObj, partial) {
  const prev = await readMaintenanceState(cachesObj);
  const next = normalizeMaintenance({
    ...prev,
    ...partial,
    updatedAt: Date.now(),
  });
  const cache = cachesObj?.default;
  if (cache) {
    const res = new Response(JSON.stringify(next), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=604800',
      },
    });
    await cache.put(CACHE_URL, res);
  }
  return next;
}

export { DEFAULT_MESSAGE, CACHE_URL };
