/**
 * AWS bridge API — optional hybrid ops (EventBridge / SQS / SNS).
 * GET: public capability flags. POST: privileged bridge actions (OPS_API_SECRET).
 */

import { requireOpsSecret, corsHeaders, getOpsSecret } from './_ops-auth.js';
import {
  isAwsConfigured,
  awsTargets,
  awsStsPing,
  awsEventBridgePut,
  awsSqsSend,
  awsSnsPublish,
  mirrorSystemIncidentToAws,
} from './_aws-bridge.js';

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
  const { env, request } = context;
  const targets = awsTargets(env);
  return json({
    ok: true,
    service: 'quickorder-aws-bridge',
    configured: {
      credentials: isAwsConfigured(env),
      region: targets.region,
      eventBus: !!targets.eventBus,
      sqs: !!targets.sqsQueueUrl,
      sns: !!targets.snsTopicArn,
      incidentMirror: targets.incidentMirror,
    },
    hint: 'POST with X-Ops-Secret: ping | event | sqs | sns | mirror_incident',
    docs: 'docs/aws-integration.md',
  }, 200, request);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const j = (data, status = 200) => json(data, status, request);
  let body;
  try {
    body = await request.json();
  } catch {
    return j({ ok: false, error: 'invalid_json' }, 400);
  }

  const gate = requireOpsSecret(request, env, body, j);
  if (!gate.ok) return gate.response;

  const action = String(body.action || 'ping');

  if (action === 'ping') {
    const sts = await awsStsPing(env);
    return j({ ok: true, action: 'ping', sts, targets: awsTargets(env) });
  }

  if (action === 'event') {
    const r = await awsEventBridgePut(
      env,
      body.detailType || body.type || 'QuickOrderManual',
      body.detail || body.payload || {},
      body.source || 'quickorder.ops',
    );
    return j({ ok: r.ok, action: 'event', ...r });
  }

  if (action === 'sqs') {
    const r = await awsSqsSend(env, body.message || JSON.stringify(body.payload || {}));
    return j({ ok: r.ok, action: 'sqs', ...r });
  }

  if (action === 'sns') {
    const r = await awsSnsPublish(env, body.subject, body.message || JSON.stringify(body.payload || {}));
    return j({ ok: r.ok, action: 'sns', ...r });
  }

  if (action === 'mirror_incident') {
    const r = await mirrorSystemIncidentToAws(env, body.incident || body);
    return j({ ok: r.ok, action: 'mirror_incident', ...r });
  }

  return j({ ok: false, error: 'unknown_action', action }, 400);
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(context.request),
  });
}
