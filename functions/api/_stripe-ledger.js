/**
 * Stripe webhook queue (Cache API) — prep stage; Ops applies subscribed in Firestore.
 */

const CACHE_URL = 'https://mobile-order-system.pages.dev/__stripe_activation_queue_v1';

function resolveCache(cachesObj) {
  try {
    if (typeof caches !== 'undefined' && caches?.default) return caches.default;
  } catch (_) {}
  try {
    if (cachesObj?.default) return cachesObj.default;
  } catch (_) {}
  return null;
}

export function defaultStripeQueue() {
  return { events: [], updatedAt: 0 };
}

export async function readStripeQueue(cachesObj) {
  try {
    const cache = resolveCache(cachesObj);
    if (!cache) return defaultStripeQueue();
    const hit = await cache.match(CACHE_URL);
    if (!hit) return defaultStripeQueue();
    const data = await hit.json();
    return {
      events: Array.isArray(data.events) ? data.events : [],
      updatedAt: Number(data.updatedAt) || 0,
    };
  } catch {
    return defaultStripeQueue();
  }
}

export async function writeStripeQueue(cachesObj, queue) {
  const next = {
    events: (queue.events || []).slice(0, 80),
    updatedAt: Date.now(),
  };
  const cache = resolveCache(cachesObj);
  if (!cache) return { ...next, persisted: false, persistError: 'no_cache_api' };
  const res = new Response(JSON.stringify(next), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=604800',
    },
  });
  await cache.put(CACHE_URL, res);
  return { ...next, persisted: true };
}

export async function appendStripeEvent(cachesObj, row) {
  const q = await readStripeQueue(cachesObj);
  const id = row.id || `evt_${Date.now().toString(36)}`;
  const events = [
    {
      id,
      at: Date.now(),
      status: 'pending',
      ...row,
    },
    ...q.events.filter((e) => e.id !== id),
  ];
  return writeStripeQueue(cachesObj, { events });
}

export async function updateStripeEvent(cachesObj, id, patch) {
  const q = await readStripeQueue(cachesObj);
  const events = q.events.map((e) => (e.id === id ? { ...e, ...patch, updatedAt: Date.now() } : e));
  return writeStripeQueue(cachesObj, { events });
}
