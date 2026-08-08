/**
 * Client + Ops system incident intake (Discord alert via ledger).
 */

import { requireOpsSecret, corsHeaders, getOpsSecret } from './_ops-auth.js';
import {
  recordSystemIncident,
  listSystemIncidents,
  dismissSystemIncident,
} from './_system-incidents.js';
import { dispatchCursorAgent } from './_incident-dispatch.js';

function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(request),
    },
  });
}

function sanitizeReport(body = {}) {
  return {
    feature: String(body.feature || 'unknown').slice(0, 80),
    cause: String(body.cause || body.message || 'unknown').slice(0, 500),
    kind: String(body.kind || 'client_error').slice(0, 40),
    source: String(body.source || 'client').slice(0, 40),
    shopId: String(body.shopId || '').slice(0, 64),
    url: String(body.url || '').slice(0, 300),
    severity: body.severity === 'critical' ? 'critical' : (body.severity === 'warning' ? 'warning' : 'info'),
    meta: body.meta && typeof body.meta === 'object' ? body.meta : undefined,
  };
}

export async function onRequestPost(context) {
  const { request, env, caches } = context;
  const j = (data, status = 200) => json(data, status, request);
  let body;
  try {
    body = await request.json();
  } catch {
    return j({ ok: false, error: 'invalid_json' }, 400);
  }

  const action = String(body.action || 'report');

  if (action === 'list' || action === 'dismiss' || action === 'dispatch_fix') {
    const gate = requireOpsSecret(request, env, body, j);
    if (!gate.ok) return gate.response;
  }

  if (action === 'list') {
    const status = body.status ? String(body.status) : 'open';
    const limit = Math.min(50, Number(body.limit) || 20);
    const data = await listSystemIncidents(caches, { limit, status });
    return j({ ok: true, action: 'list', ...data });
  }

  if (action === 'dismiss') {
    const id = String(body.id || '').trim();
    if (!id) return j({ ok: false, error: 'missing_id' }, 400);
    const r = await dismissSystemIncident(caches, id);
    return j({ ok: true, action: 'dismiss', ...r });
  }

  if (action === 'dispatch_fix') {
    const id = String(body.id || '').trim();
    const data = await listSystemIncidents(caches, { limit: 80, status: '' });
    const row = data.events.find((e) => e.id === id);
    if (!row) return j({ ok: false, error: 'incident_not_found' }, 404);
    const incident = {
      feature: row.feature,
      cause: row.cause,
      summary: `${row.feature}: ${row.cause}`,
      message: row.cause,
      incidentId: row.id,
      kind: row.kind,
      source: 'ops_system_report',
      severity: row.severity,
      cardinalRole: 'executor',
      url: row.url,
      shopId: row.shopId,
      meta: row.meta,
    };
    const cursor = await dispatchCursorAgent(env, incident);
    return j({
      ok: true,
      action: 'dispatch_fix',
      incidentId: id,
      cursor,
      launched: !!(cursor.agent?.ok || cursor.automation?.ok),
    });
  }

  const report = sanitizeReport(body);
  if (!report.cause || report.cause === 'unknown') {
    return j({ ok: false, error: 'missing_cause' }, 400);
  }

  const recorded = await recordSystemIncident(caches, env, report);
  return j({
    ok: true,
    action: 'report',
    id: recorded.row?.id,
    discord: recorded.discord,
    persisted: recorded.persisted,
  });
}

export async function onRequestGet(context) {
  const { env, request, caches } = context;
  const j = (data, status = 200) => json(data, status, request);
  const gate = requireOpsSecret(request, env, {}, j);
  if (gate.ok) {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'open';
    const limit = Math.min(50, Number(url.searchParams.get('limit') || 20));
    const data = await listSystemIncidents(caches, { limit, status });
    return j({ ok: true, service: 'quickorder-system-report', ...data });
  }
  return j({
    ok: true,
    service: 'quickorder-system-report',
    opsSecretConfigured: !!getOpsSecret(env),
    hint: 'POST { feature, cause, kind, shopId?, url? } — Discord へ機能+原因を通知。Ops は GET/POST action=list|dismiss|dispatch_fix',
  });
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(context.request),
  });
}
