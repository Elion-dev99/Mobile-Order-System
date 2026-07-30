/**
 * Cloudflare Pages Function — incident intake + auto-dispatch Cursor Cloud Agent.
 *
 * Env (Cloudflare Pages secrets):
 * - DISCORD_WEBHOOK_URL (optional; also accepts body.webhook)
 * - CURSOR_API_KEY — Cloud Agents API key (Dashboard → API Keys)
 * - CURSOR_REPO — default https://github.com/Elion-dev99/Mobile-Order-System
 * - CURSOR_AUTOMATION_WEBHOOK_URL — optional Automations webhook URL
 * - CURSOR_AUTOMATION_API_KEY — Basic auth username for automation webhook
 */

const DEFAULT_REPO = 'https://github.com/Elion-dev99/Mobile-Order-System';

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
    return u.protocol === 'https:'
      && (u.hostname === 'discord.com' || u.hostname === 'discordapp.com')
      && /\/api\/webhooks\/\d+\/[\w-]+/.test(u.pathname);
  } catch {
    return false;
  }
}

function buildAgentPrompt(incident = {}) {
  const lines = [
    'QuickOrder（Mobile-Order-System）で本番障害が発生しました。自動対処してください。',
    '',
    '## 方針',
    '1. まず原因を特定（Firestore / Cloudflare Pages Function / フロント / 回線）',
    '2. コードや設定で直せるなら修正し、PRを作成',
    '3. 外部障害（Firebase/Cloudflare本体ダウン）なら、ユーザー向けフォールバックと監視を強化する変更を提案',
    '4. 客席注文の保留キュー（mos_pending_orders）や health/load 監視を壊さない',
    '',
    '## インシデント詳細',
    '```json',
    JSON.stringify(incident, null, 2).slice(0, 6000),
    '```',
    '',
    'リポジトリ: Elion-dev99/Mobile-Order-System / ベースブランチ main',
  ];
  return lines.join('\n');
}

async function postDiscord(env, body, incident) {
  const webhook = (env && env.DISCORD_WEBHOOK_URL) || body.webhook || '';
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

async function dispatchCursorAgent(env, incident) {
  const apiKey = env?.CURSOR_API_KEY || '';
  const repo = env?.CURSOR_REPO || DEFAULT_REPO;
  const results = { agent: null, automation: null };

  // Prefer Automations webhook if configured
  const autoUrl = env?.CURSOR_AUTOMATION_WEBHOOK_URL || '';
  const autoKey = env?.CURSOR_AUTOMATION_API_KEY || '';
  if (autoUrl && autoKey) {
    try {
      const res = await fetch(autoUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Basic ' + btoa(`${autoKey}:`),
        },
        body: JSON.stringify({
          text: buildAgentPrompt(incident),
          incident,
          source: 'quickorder-autoheal',
        }),
      });
      const raw = await res.text();
      results.automation = { ok: res.ok, status: res.status, raw: raw.slice(0, 300) };
    } catch (e) {
      results.automation = { ok: false, error: String(e?.message || e) };
    }
  }

  if (apiKey) {
    try {
      const res = await fetch('https://api.cursor.com/v0/agents', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Basic ' + btoa(`${apiKey}:`),
        },
        body: JSON.stringify({
          prompt: { text: buildAgentPrompt(incident) },
          source: { repository: repo, ref: 'main' },
          target: { autoCreatePr: true, branchName: 'cursor/autoheal-incident-3dc6' },
        }),
      });
      const data = await res.json().catch(() => ({}));
      results.agent = { ok: res.ok, status: res.status, data };
    } catch (e) {
      results.agent = { ok: false, error: String(e?.message || e) };
    }
  }

  return results;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const incident = {
    ...body,
    receivedAt: Date.now(),
    severity: body.severity || (body.status === 'down' ? 'critical' : 'warning'),
  };

  const cursor = await dispatchCursorAgent(env, incident);
  incident.cursorDispatched = !!(cursor.agent?.ok || cursor.automation?.ok);

  const discord = await postDiscord(env, body, incident).catch(e => ({ ok: false, error: String(e?.message || e) }));

  return json({
    ok: true,
    discord,
    cursor,
    hint: (!env?.CURSOR_API_KEY && !env?.CURSOR_AUTOMATION_WEBHOOK_URL)
      ? 'Cloudflare に CURSOR_API_KEY（または Automations Webhook）を設定すると、障害時に Cloud Agent が自動起動します。'
      : undefined,
  });
}

export async function onRequestGet() {
  return json({
    ok: true,
    service: 'quickorder-incident',
    hint: 'POST { status, summary, firestoreOk, notifyApiOk, webhook? } で障害を受け付け、Cursor自動対処を起動します',
  });
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
