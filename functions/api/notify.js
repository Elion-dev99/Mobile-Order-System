/**
 * Cloudflare Pages Function — Slack Incoming Webhook proxy.
 * Secrets: SLACK_WEBHOOK_URL (preferred)
 * Or pass webhook in JSON body (must be hooks.slack.com) when Ops configures it.
 */

const SLACK_HOST = 'hooks.slack.com';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function isSlackWebhook(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'https:' && u.hostname === SLACK_HOST && u.pathname.startsWith('/services/');
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
    (env && env.SLACK_WEBHOOK_URL) ||
    body.webhook ||
    '';

  if (!isSlackWebhook(webhook)) {
    return json({
      ok: false,
      error: 'webhook_missing',
      hint: 'Ops の「通知」タブで Incoming Webhook URL を保存するか、Cloudflare の SLACK_WEBHOOK_URL を設定してください。',
      hasEnvWebhook: !!(env && env.SLACK_WEBHOOK_URL),
    }, 400);
  }

  const text = String(body.text || '').slice(0, 3500);
  if (!text) return json({ ok: false, error: 'empty_text' }, 400);

  const payload = { text };
  if (Array.isArray(body.blocks) && body.blocks.length) {
    payload.blocks = body.blocks.slice(0, 40);
  }
  if (body.username) payload.username = String(body.username).slice(0, 80);
  if (body.icon_emoji) payload.icon_emoji = String(body.icon_emoji).slice(0, 40);

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    if (!res.ok) {
      return json({ ok: false, error: 'slack_error', status: res.status, raw: raw.slice(0, 200) }, 502);
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
    service: 'quickorder-slack-notify',
    hasEnvWebhook: !!(env && env.SLACK_WEBHOOK_URL),
    hint: 'POST { text, webhook? } で Slack に送信します',
  });
}
