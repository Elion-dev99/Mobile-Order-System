/**
 * Cloudflare Pages Function — incident intake + auto-dispatch Cursor Cloud Agent.
 *
 * Env (Cloudflare Pages secrets):
 * - DISCORD_WEBHOOK_URL (optional; server secret only — client body.webhook
 *   is intentionally ignored here to avoid forwarding arbitrary webhooks)
 * - CURSOR_API_KEY — Cloud Agents API key (Dashboard → API Keys)
 * - CURSOR_REPO — default https://github.com/Elion-dev99/Mobile-Order-System
 * - CURSOR_AUTOMATION_WEBHOOK_URL — optional Automations webhook URL
 * - CURSOR_AUTOMATION_API_KEY — Basic auth username for automation webhook
 */

import { requireOpsSecret, corsHeaders, getOpsSecret } from './_ops-auth.js';

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

async function postDiscord(env, body, incident) {
  const webhook = (env && env.DISCORD_WEBHOOK_URL) || '';
  if (!isDiscordWebhook(webhook)) return { ok: false, skipped: true, reason: 'no_discord' };

  const status = incident.status || incident.severity || 'unknown';
  const payload = {
    username: 'QuickOrder AutoHeal',
    embeds: [{
      title: `🛠 自動対処を起動: ${status}`,
      color: 0xed4245,
      fields: [
        { name: '要約', value: String(incident.summary || incident.message || '障害検知').slice(0, 1000), inline: false },
        { name: 'Firestore', value: incident.firestoreOk === false ? 'NG' : (incident.firestoreOk ? 'OK' : '—'), inline: true },
        { name: '通知API', value: incident.notifyApiOk === false ? 'NG' : (incident.notifyApiOk ? 'OK' : '—'), inline: true },
        { name: 'Cursor', value: incident.cursorDispatched ? '起動依頼済' : '未起動/設定なし', inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'QuickOrder AutoHeal' },
    }],
  };

  const endpoint = webhook.includes('?') ? `${webhook}&wait=true` : `${webhook}?wait=true`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status };
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

  const incident = {
    ...body,
    receivedAt: Date.now(),
    severity: body.severity || (body.status === 'down' ? 'critical' : 'warning'),
  };

  const cursor = await dispatchCursorAgent(env, incident);
  incident.cursorDispatched = !!(cursor.agent?.ok || cursor.automation?.ok);

  const discord = await postDiscord(env, body, incident).catch(e => ({ ok: false, error: String(e?.message || e) }));

  return j({
    ok: true,
    discord,
    cursor,
    hint: (!env?.CURSOR_API_KEY && !env?.CURSOR_AUTOMATION_WEBHOOK_URL)
      ? 'Cloudflare に CURSOR_API_KEY（または Automations Webhook）を設定すると、障害時に Cloud Agent が自動起動します。'
      : undefined,
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  return json({
    ok: true,
    service: 'quickorder-incident',
    opsSecretConfigured: !!getOpsSecret(env),
    hint: 'POST requires X-Ops-Secret. Body: { status, summary, firestoreOk, notifyApiOk }',
  }, 200, request);
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(context.request),
  });
}
