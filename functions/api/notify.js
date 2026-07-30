/**
 * Cloudflare Pages Function — Discord Incoming Webhook proxy.
 *
 * Secrets:
 * - DISCORD_WEBHOOK_URL (preferred for guest/system notifies)
 * - OPS_API_SECRET (required to pass a client webhook or override)
 */

import { extractOpsSecret, getOpsSecret, secretsMatch, corsHeaders } from './_ops-auth.js';

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
    if (u.protocol !== 'https:') return false;
    if (u.hostname !== 'discord.com' && u.hostname !== 'discordapp.com') return false;
    return /^\/api\/webhooks\/\d+\/[\w-]+/.test(u.pathname);
  } catch {
    return false;
  }
}

function resolveWebhook(request, env, body) {
  const envWh = (env && env.DISCORD_WEBHOOK_URL) || '';
  const bodyWh = body.webhook || '';
  const expected = getOpsSecret(env);
  const provided = extractOpsSecret(request, body);
  const authed = !!(expected && secretsMatch(provided, expected));

  // Prefer server secret; client webhook only when Ops-authenticated
  if (isDiscordWebhook(envWh)) {
    if (bodyWh && isDiscordWebhook(bodyWh) && authed) return bodyWh;
    return envWh;
  }
  if (bodyWh && isDiscordWebhook(bodyWh)) {
    if (authed) return bodyWh;
    return null; // client webhook without ops secret → reject
  }
  return null;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400, request);
  }

  const webhook = resolveWebhook(request, env, body);

  if (!isDiscordWebhook(webhook)) {
    return json({
      ok: false,
      error: 'webhook_missing',
      hint: 'Cloudflare の DISCORD_WEBHOOK_URL を設定するか、Ops 鍵タブの OPS_API_SECRET 付きで Webhook を送ってください。',
      hasEnvWebhook: !!(env && env.DISCORD_WEBHOOK_URL),
      opsSecretConfigured: !!getOpsSecret(env),
    }, 400, request);
  }

  const content = String(body.content || body.text || '').slice(0, 1900);
  const embeds = Array.isArray(body.embeds) ? body.embeds.slice(0, 10) : [];
  if (!content && !embeds.length) {
    return json({ ok: false, error: 'empty_payload' }, 400, request);
  }

  const payload = {};
  if (content) payload.content = content;
  if (embeds.length) payload.embeds = embeds;
  if (body.username) payload.username = String(body.username).slice(0, 80);
  // Do not forward arbitrary avatar_url (SSRF / abuse vector)

  const endpoint = webhook.includes('?') ? `${webhook}&wait=true` : `${webhook}?wait=true`;

  async function sendOnce() {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    return { res, raw };
  }

  try {
    let { res, raw } = await sendOnce();
    if (res.status === 429) {
      let retry = 1.2;
      try {
        const j = JSON.parse(raw);
        if (j.retry_after) retry = Number(j.retry_after) + 0.2;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, Math.min(5000, retry * 1000)));
      ({ res, raw } = await sendOnce());
    }
    if (!res.ok) {
      return json({ ok: false, error: 'discord_error', status: res.status, raw: raw.slice(0, 300) }, 502, request);
    }
    return json({ ok: true }, 200, request);
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 502, request);
  }
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(context.request),
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  return json({
    ok: true,
    service: 'quickorder-discord-notify',
    hasEnvWebhook: !!(env && env.DISCORD_WEBHOOK_URL),
    opsSecretConfigured: !!getOpsSecret(env),
    hint: 'POST embeds/content. Client webhook には X-Ops-Secret が必要です。',
  }, 200, request);
}
