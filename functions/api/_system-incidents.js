/**
 * System incident ledger (Cache API) + Discord alerts with dedupe.
 */

import { dispatchCursorAgent } from './_incident-dispatch.js';
import { readAgentLedger, recordLaunch, recentlyLaunched } from './_agent-ledger.js';
import { readCardinalPrefs, allowCursorDispatch } from './_cardinal-prefs-store.js';
import { mirrorSystemIncidentToAws } from './_aws-bridge.js';

const CACHE_URL = 'https://mobile-order-system.pages.dev/__system_incidents_v1';
const DEDUPE_MS = 10 * 60 * 1000;
const MAX_EVENTS = 120;
const MAX_DISCORD_PER_HOUR = 40;
const SYSTEM_INCIDENT_COOLDOWN_MS = 45 * 60 * 1000;
const AUTO_DISPATCH_SKIP_KINDS = new Set(['notify_test', 'debug_request', 'test']);

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

async function maybeAutoDispatchExecutor(cachesObj, env, row, { firstSighting }) {
  if (!firstSighting || row.severity !== 'critical') return null;
  if (AUTO_DISPATCH_SKIP_KINDS.has(row.kind)) return null;
  if (!env?.CURSOR_API_KEY && !env?.CURSOR_AUTOMATION_WEBHOOK_URL) {
    return { skipped: true, reason: 'no_cursor' };
  }
  const prefs = await readCardinalPrefs(cachesObj);
  const gate = allowCursorDispatch(prefs, 'system_incident');
  if (!gate.ok) return { skipped: true, reason: gate.reason };
  const ledger = await readAgentLedger(cachesObj);
  if (recentlyLaunched(ledger, 'system_incident', SYSTEM_INCIDENT_COOLDOWN_MS)) {
    return { skipped: true, reason: 'cooldown' };
  }
  const incident = {
    feature: row.feature,
    cause: row.cause,
    summary: `${row.feature}: ${row.cause}`,
    message: row.cause,
    incidentId: row.id,
    kind: row.kind,
    source: 'system_watchdog_auto',
    severity: 'critical',
    cardinalRole: 'executor',
    url: row.url,
    shopId: row.shopId,
  };
  const cursor = await dispatchCursorAgent(env, incident);
  const launched = !!(cursor.agent?.ok || cursor.automation?.ok);
  if (launched) {
    await recordLaunch(cachesObj, {
      kind: 'system_incident',
      role: 'executor',
      title: incident.summary,
      launched: true,
      agentOk: true,
    });
  }
  return { launched, cursor };
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
  const firstSighting = existingIdx < 0;
  let autoDispatch = null;
<<<<<<< HEAD
  let awsMirror = null;
=======
>>>>>>> origin/main
  if (firstSighting && notify) {
    try {
      autoDispatch = await maybeAutoDispatchExecutor(cachesObj, env, existingIdx >= 0 ? q.events[existingIdx] : q.events[0], { firstSighting });
    } catch (e) {
      autoDispatch = { ok: false, error: String(e?.message || e) };
    }
<<<<<<< HEAD
    try {
      awsMirror = await mirrorSystemIncidentToAws(env, existingIdx >= 0 ? q.events[existingIdx] : q.events[0]);
    } catch (e) {
      awsMirror = { ok: false, error: String(e?.message || e) };
    }
=======
>>>>>>> origin/main
  }
  return {
    row: existingIdx >= 0 ? q.events[existingIdx] : q.events[0],
    discord,
    autoDispatch,
<<<<<<< HEAD
    awsMirror,
=======
>>>>>>> origin/main
    persisted: saved.persisted !== false,
  };
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
