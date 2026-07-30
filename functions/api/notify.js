/**
 * Cloudflare Pages Function — Discord Incoming Webhook proxy.
 * Secrets: DISCORD_WEBHOOK_URL (preferred)
 * Or pass webhook in JSON body (discord.com / discordapp.com) from Ops.
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
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

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const webhook =
    (env && env.DISCORD_WEBHOOK_URL) ||
    body.webhook ||
    '';

  if (!isDiscordWebhook(webhook)) {
    return json({
      ok: false,
      error: 'webhook_missing',
      hint: 'Ops の「通知」タブで Discord Webhook URL を保存するか、Cloudflare の DISCORD_WEBHOOK_URL を設定してください。',
      hasEnvWebhook: !!(env && env.DISCORD_WEBHOOK_URL),
    }, 400);
  }

  const content = String(body.content || body.text || '').slice(0, 1900);
  const embeds = Array.isArray(body.embeds) ? body.embeds.slice(0, 10) : [];
  if (!content && !embeds.length) {
    return json({ ok: false, error: 'empty_payload' }, 400);
  }

  const payload = {};
  if (content) payload.content = content;
  if (embeds.length) payload.embeds = embeds;
  if (body.username) payload.username = String(body.username).slice(0, 80);
  if (body.avatar_url) payload.avatar_url = String(body.avatar_url).slice(0, 300);

  const endpoint = webhook.includes('?') ? `${webhook}&wait=true` : `${webhook}?wait=true`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    if (!res.ok) {
      return json({ ok: false, error: 'discord_error', status: res.status, raw: raw.slice(0, 300) }, 502);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 502);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
  });
}

export async function onRequestGet(context) {
  const { env } = context;
  return json({
    ok: true,
    service: 'quickorder-discord-notify',
    hasEnvWebhook: !!(env && env.DISCORD_WEBHOOK_URL),
    hint: 'POST { content|embeds, webhook? } で Discord に送信します',
  });
}
