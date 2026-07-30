/**
 * Cloudflare Pages Function — platform maintenance kill switch (edge copy).
 *
 * GET  — public read (guests poll when Firestore is slow/down)
 * POST — Ops secret required; set/clear maintenance
 *
 * Cardinal tick writes here so maintenance works even if Firestore is down.
 */

import { requireOpsSecret, corsHeaders, getOpsSecret } from './_ops-auth.js';
import {
  readMaintenanceState,
  writeMaintenanceState,
  defaultMaintenanceState,
  DEFAULT_MESSAGE,
} from './_maintenance-store.js';

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

export async function onRequestGet(context) {
  const { request, caches } = context;
  const state = await readMaintenanceState(caches);
  return json({ ok: true, ...state, defaultMessage: DEFAULT_MESSAGE }, 200, request);
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

  const gate = requireOpsSecret(request, env, body, j);
  if (!gate.ok) return gate.response;

  const enabled = body.maintenance === true || body.enabled === true
    || body.maintenance === 'true' || body.enabled === 'true';
  const clear = body.maintenance === false || body.enabled === false
    || body.clear === true;

  if (!enabled && !clear && body.maintenance == null && body.enabled == null) {
    const state = await readMaintenanceState(caches);
    return j({ ok: true, ...state });
  }

  const prev = await readMaintenanceState(caches);
  // Cardinal must not clear a human Ops lock
  if (clear && !enabled) {
    const fromCardinal = String(body.source || body.updatedBy || '').includes('cardinal')
      || body.auto === true;
    if (fromCardinal && prev.maintenance && prev.source === 'manual' && !prev.auto) {
      return j({
        ok: true,
        skipped: true,
        reason: 'manual_lock',
        ...prev,
      });
    }
  }

  const next = await writeMaintenanceState(caches, {
    maintenance: enabled && !clear,
    message: body.message != null ? body.message : prev.message,
    updatedBy: String(body.updatedBy || body.source || 'ops').slice(0, 120),
    source: body.source === 'cardinal' || body.auto === true ? 'cardinal' : 'manual',
    auto: body.auto === true || body.source === 'cardinal',
  });

  return j({ ok: true, ...next, opsSecretConfigured: !!getOpsSecret(env) });
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(context.request),
  });
}

export { defaultMaintenanceState };
