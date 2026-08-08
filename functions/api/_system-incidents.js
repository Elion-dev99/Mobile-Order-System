/**
 * System incident ledger (Cache API) + Discord alerts with dedupe.
 */

const CACHE_URL = 'https://mobile-order-system.pages.dev/__system_incidents_v1';
const DEDUPE_MS = 10 * 60 * 1000;
const MAX_EVENTS = 120;
const MAX_DISCORD_PER_HOUR = 40;

function resolveCache(cachesObj) {
  try {
    if (typeof caches !== 'undefined' && caches?.default) return caches.default;
  } catch (_) {}
  try {
    if (cachesObj?.default) return cachesObj.default;
  } catch (_) {}
  return null;
}

export function defaultIncidentQueue() {
  return { events: [], discordHour: { windowStart: 0, count: 0 }, updatedAt: 0 };
}

export async function readIncidentQueue(cachesObj) {
  try {
    const cache = resolveCache(cachesObj);
    if (!cache) return defaultIncidentQueue();
    const hit = await cache.match(CACHE_URL);
    if (!hit) return defaultIncidentQueue();
    const data = await hit.json();
    return {
      events: Array.isArray(data.events) ? data.events : [],
      discordHour: data.discordHour || { windowStart: 0, count: 0 },
      updatedAt: Number(data.updatedAt) || 0,
    };
  } catch {
    return defaultIncidentQueue();
  }
}

export async function writeIncidentQueue(cachesObj, queue) {
  const next = {
    events: (queue.events || []).slice(0, MAX_EVENTS),
    discordHour: queue.discordHour || { windowStart: 0, count: 0 },
    updatedAt: Date.now(),
  };
  const cache = resolveCache(cachesObj);
  if (!cache) return { ...next, persisted: false };
  const res = new Response(JSON.stringify(next), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=604800',
    },
  });
  await cache.put(CACHE_URL, res);
  return { ...next, persisted: true };
}

function incidentKey(row) {
  const f = String(row.feature || 'unknown').slice(0, 64);
  const c = String(row.cause || '').slice(0, 120).toLowerCase();
  return `${f}::${c}`;
}

function isDiscordWebhook(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'https:'
      && (u.hostname === 'discord.com' || u.hostname === 'discordapp.com')
      && /\/api\/webhooks\/\d+\/[\w-]+/.test(u.pathname);
  } catch {
    return false;
  }
}

async function postDiscordAlert(env, row) {
  const webhook = env?.DISCORD_WEBHOOK_URL || '';
  if (!isDiscordWebhook(webhook)) return { ok: false, skipped: true, reason: 'no_webhook' };
  const color = row.severity === 'critical' ? 0xed4245 : row.severity === 'warning' ? 0xfaa61a : 0x5865f2;
  const endpoint = webhook.includes('?') ? `${webhook}&wait=true` : `${webhook}?wait=true`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'QuickOrder システム監視',
      embeds: [{
        title: `⚠️ ${row.feature || 'system'}`,
        description: String(row.cause || '—').slice(0, 1800),
        color,
        fields: [
          { name: '種別', value: String(row.kind || '—'), inline: true },
          { name: '発生元', value: String(row.source || '—'), inline: true },
          { name: '店舗', value: String(row.shopId || '—'), inline: true },
          { name: '回数', value: String(row.count || 1), inline: true },
        ],
        footer: { text: String(row.url || '').slice(0, 200) },
        timestamp: new Date(row.lastAt || Date.now()).toISOString(),
      }],
    }),
  });
  return { ok: res.ok, status: res.status };
}

function bumpDiscordHour(queue) {
  const now = Date.now();
  const hour = queue.discordHour || { windowStart: 0, count: 0 };
  if (now - hour.windowStart > 3600000) {
    queue.discordHour = { windowStart: now, count: 0 };
  }
  return queue.discordHour;
}

/**
 * Record incident; notify Discord on first sighting or every 30 min repeat.
 */
export async function recordSystemIncident(cachesObj, env, input = {}) {
  const now = Date.now();
  const row = {
    id: input.id || `sys_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    feature: String(input.feature || 'unknown').slice(0, 80),
    cause: String(input.cause || input.message || 'unknown').slice(0, 500),
    kind: String(input.kind || 'error').slice(0, 40),
    source: String(input.source || 'client').slice(0, 40),
    shopId: String(input.shopId || '').slice(0, 64),
    url: String(input.url || '').slice(0, 300),
    severity: input.severity === 'critical' ? 'critical' : (input.severity === 'warning' ? 'warning' : 'info'),
    meta: input.meta && typeof input.meta === 'object' ? input.meta : undefined,
    firstAt: now,
    lastAt: now,
    count: 1,
    status: 'open',
  };

  const q = await readIncidentQueue(cachesObj);
  const key = incidentKey(row);
  const existingIdx = q.events.findIndex((e) => e.dedupeKey === key && e.status === 'open');
  let notify = true;
  if (existingIdx >= 0) {
    const prev = q.events[existingIdx];
    row.id = prev.id;
    row.firstAt = prev.firstAt || now;
    row.count = (Number(prev.count) || 1) + 1;
    row.lastAt = now;
    row.dedupeKey = key;
    q.events[existingIdx] = { ...prev, ...row };
    const since = now - (prev.discordAt || 0);
    notify = since > 30 * 60 * 1000;
  } else {
    row.dedupeKey = key;
    q.events.unshift(row);
  }

  let discord = { ok: false, skipped: true };
  if (notify) {
    const dh = bumpDiscordHour(q);
    if (dh.count < MAX_DISCORD_PER_HOUR) {
      discord = await postDiscordAlert(env, row).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (discord.ok) {
        dh.count += 1;
        if (existingIdx >= 0) q.events[existingIdx].discordAt = now;
        else if (q.events[0]) q.events[0].discordAt = now;
      }
    } else {
      discord = { ok: false, skipped: true, reason: 'rate_limit' };
    }
  }

  const saved = await writeIncidentQueue(cachesObj, q);
  return { row: existingIdx >= 0 ? q.events[existingIdx] : q.events[0], discord, persisted: saved.persisted !== false };
}

export async function listSystemIncidents(cachesObj, { limit = 20, status = 'open' } = {}) {
  const q = await readIncidentQueue(cachesObj);
  let events = q.events;
  if (status) events = events.filter((e) => e.status === status);
  return { events: events.slice(0, limit), total: q.events.length, updatedAt: q.updatedAt };
}

export async function dismissSystemIncident(cachesObj, id) {
  const q = await readIncidentQueue(cachesObj);
  const events = q.events.map((e) => (e.id === id ? { ...e, status: 'dismissed', dismissedAt: Date.now() } : e));
  await writeIncidentQueue(cachesObj, { ...q, events });
  return { ok: true, id };
}

export async function recordProbeFailures(cachesObj, env, probes, source = 'cardinal_tick') {
  const out = [];
  for (const [path, p] of Object.entries(probes || {})) {
    if (p?.ok) continue;
    const cause = p?.error || (p?.status ? `HTTP ${p.status}` : 'probe failed');
    const r = await recordSystemIncident(cachesObj, env, {
      feature: `probe:${path}`,
      cause,
      kind: 'probe_fail',
      source,
      severity: path === '/' || path === '/ops.html' ? 'critical' : 'warning',
    });
    out.push(r);
  }
  return out;
}
