/**
 * Cloudflare Pages Function — platform maintenance kill switch (edge copy).
 *
 * GET  — public read (effective = flag OR schedule window)
 * POST — Ops secret required; set/clear maintenance, save schedule, drill
 */

import { requireOpsSecret, corsHeaders, getOpsSecret } from './_ops-auth.js';
import {
  readMaintenanceState,
  writeMaintenanceState,
  effectiveMaintenance,
  applyScheduleToState,
  defaultMaintenanceState,
  DEFAULT_MESSAGE,
} from './_maintenance-store.js';
import { normalizeSchedule } from './_maint-schedule.js';

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
  const stored = await readMaintenanceState(caches);
  const eff = effectiveMaintenance(stored);
  return json({
    ok: true,
    ...eff,
    maintenance: eff.effective || eff.maintenance,
    storedMaintenance: stored.maintenance,
    storedSource: stored.source,
    defaultMessage: DEFAULT_MESSAGE,
  }, 200, request);
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

  const action = String(body.action || 'set');

  // Save schedule only
  if (
    action === 'schedule'
    || (action === 'set' && body.schedule != null && body.maintenance == null && body.enabled == null && !body.clear)
  ) {
    const prev = await readMaintenanceState(caches);
    const schedule = normalizeSchedule(body.schedule || {});
    const state = await writeMaintenanceState(caches, {
      schedule,
      // keep current flag fields
      maintenance: prev.maintenance,
      message: prev.message,
      source: prev.source,
      auto: prev.auto,
      updatedBy: String(body.updatedBy || 'ops-schedule').slice(0, 120),
    });
    const applied = await applyScheduleToState(caches, { outageMaintain: false });
    return j({
      ok: true,
      action: 'schedule',
      ...effectiveMaintenance(applied.state),
      scheduleApplied: applied,
      opsSecretConfigured: !!getOpsSecret(env),
    });
  }

  // Drill: force cardinal auto ON, then optional auto-off
  if (action === 'drill_outage') {
    const before = await readMaintenanceState(caches);
    const on = await writeMaintenanceState(caches, {
      maintenance: true,
      message: DEFAULT_MESSAGE,
      updatedBy: 'cardinal:drill',
      source: 'cardinal',
      auto: true,
      schedule: before.schedule,
    });
    let off = null;
    if (body.autoClear !== false) {
      // leave ON so Ops can see guest banner; clear only if requested
    }
    if (body.autoClear === true) {
      off = await writeMaintenanceState(caches, {
        maintenance: false,
        updatedBy: 'cardinal:drill-clear',
        source: 'cardinal',
        auto: true,
        schedule: before.schedule,
      });
    }
    return j({
      ok: true,
      action: 'drill_outage',
      before: effectiveMaintenance(before),
      afterOn: effectiveMaintenance(on),
      afterClear: off ? effectiveMaintenance(off) : null,
      checks: {
        edgeWrite: !!on.maintenance,
        sourceCardinal: on.source === 'cardinal',
        autoFlag: !!on.auto,
      },
      hint: off
        ? '投入→即解除まで完了。ゲストバナーは短時間だけ出た可能性があります。'
        : '自動メンテを ON にしました。HQ/客席でバナーを確認し、「解除」または drill_clear で戻してください。',
    });
  }

  if (action === 'drill_clear') {
    const prev = await readMaintenanceState(caches);
    if (prev.maintenance && prev.source === 'manual' && !prev.auto) {
      return j({ ok: true, skipped: true, reason: 'manual_lock', ...effectiveMaintenance(prev) });
    }
    const state = await writeMaintenanceState(caches, {
      maintenance: false,
      updatedBy: 'cardinal:drill-clear',
      source: 'cardinal',
      auto: true,
      schedule: prev.schedule,
    });
    return j({ ok: true, action: 'drill_clear', ...effectiveMaintenance(state) });
  }

  if (action === 'apply_schedule') {
    const applied = await applyScheduleToState(caches, {
      outageMaintain: !!body.outageMaintain,
    });
    return j({ ok: true, action: 'apply_schedule', ...applied, effective: effectiveMaintenance(applied.state) });
  }

  const enabled = body.maintenance === true || body.enabled === true
    || body.maintenance === 'true' || body.enabled === 'true';
  const clear = body.maintenance === false || body.enabled === false
    || body.clear === true;

  if (!enabled && !clear && body.maintenance == null && body.enabled == null) {
    const state = await readMaintenanceState(caches);
    return j({ ok: true, ...effectiveMaintenance(state) });
  }

  const prev = await readMaintenanceState(caches);
  if (clear && !enabled) {
    const fromCardinal = String(body.source || body.updatedBy || '').includes('cardinal')
      || body.auto === true
      || body.source === 'schedule';
    if (fromCardinal && prev.maintenance && prev.source === 'manual' && !prev.auto) {
      return j({
        ok: true,
        skipped: true,
        reason: 'manual_lock',
        ...effectiveMaintenance(prev),
      });
    }
  }

  let source = 'manual';
  if (body.source === 'cardinal' || body.auto === true) source = 'cardinal';
  else if (body.source === 'schedule') source = 'schedule';

  const next = await writeMaintenanceState(caches, {
    maintenance: enabled && !clear,
    message: body.message != null ? body.message : prev.message,
    updatedBy: String(body.updatedBy || body.source || 'ops').slice(0, 120),
    source,
    auto: body.auto === true || source === 'cardinal' || source === 'schedule',
    schedule: body.schedule != null ? normalizeSchedule(body.schedule) : prev.schedule,
  });

  return j({ ok: true, ...effectiveMaintenance(next), opsSecretConfigured: !!getOpsSecret(env) });
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(context.request),
  });
}

export { defaultMaintenanceState };
