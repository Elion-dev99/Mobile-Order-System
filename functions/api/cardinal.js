/**
 * Cloudflare Pages Function — Cardinal dual-agent bus.
 *
 * Actions (POST JSON { action, ... }):
 *   heartbeat — record role heartbeat (echo + Discord optional)
 *   dispatch  — launch Guardian or Executor via Cursor Automations / Cloud Agents API
 *   status    — configuration / readiness
 *
 * Env (Cloudflare Pages secrets):
 * - DISCORD_WEBHOOK_URL
 * - CURSOR_API_KEY
 * - CURSOR_REPO (default GitHub URL)
 * - CURSOR_GUARDIAN_WEBHOOK_URL + CURSOR_GUARDIAN_API_KEY  (Automations webhook)
 * - CURSOR_EXECUTOR_WEBHOOK_URL + CURSOR_EXECUTOR_API_KEY
 * - CURSOR_AUTOMATION_WEBHOOK_URL + CURSOR_AUTOMATION_API_KEY (legacy shared)
 */

import { requireOpsSecret, corsHeaders, getOpsSecret } from './_ops-auth.js';
import {
  readMaintenanceState,
  writeMaintenanceState,
  DEFAULT_MESSAGE as MAINT_DEFAULT_MESSAGE,
} from './_maintenance-store.js';

const DEFAULT_REPO = 'https://github.com/Elion-dev99/Mobile-Order-System';
const FIRESTORE_PROBE =
  'https://firestore.googleapis.com/v1/projects/mobile-order-system-c7c70/databases/(default)/documents/shops/default';

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

function rolePrompt(role, task = {}, meta = {}) {
  const isGuardian = role === 'guardian';
  const title = task.title || (isGuardian ? 'Guardian タスク' : 'Executor タスク');
  const lines = [
    isGuardian
      ? 'あなたは QuickOrder Cardinal の Guardian（監視体）です。'
      : 'あなたは QuickOrder Cardinal の Executor（実行体）です。',
    '',
    '## 役割分担（必ず守る）',
    isGuardian
      ? [
          '- 監視・レビュー・タスク起票・再ディスパッチ判断が主務',
          '- 大きな機能実装はしない（最小のドキュメント/ラベル/Issue文面まで）',
          '- Executor の PR をレビューし、問題があれば具体的な修正指示を残す',
          '- Executor が無応答なら再起動方針を書き、必要なら escalate',
          '- 自動マージはしない（draft PR / 人間ゲートを尊重）',
        ].join('\n')
      : [
          '- 障害修正・機能実装・テスト・draft PR 作成が主務',
          '- Guardian の指示/Issue を受け入れ、スコープ外に広げない',
          '- 客席の保留キュー・health・Cardinal 監視を壊さない',
          '- 完了したら PR に受け入れ条件のチェックを書く',
          '- Guardian が無応答なら一時的に監視も兼ね、Discord向け状況報告を残す',
        ].join('\n'),
    '',
    '## タスク',
    `タイトル: ${title}`,
    `種別: ${task.kind || 'ops'}`,
    `重要度: ${task.severity || 'warning'}`,
    '',
    String(task.message || task.summary || '').slice(0, 4000),
    '',
    '## 受け入れ条件',
    ...(Array.isArray(task.acceptance) && task.acceptance.length
      ? task.acceptance.map((a, i) => `${i + 1}. ${a}`)
      : ['状況を報告する', '変更があれば draft PR を作る', '破壊的変更を避ける']),
    '',
    '## メタ',
    '```json',
    JSON.stringify({ role, task, meta }, null, 2).slice(0, 5000),
    '```',
    '',
    'リポジトリ: Elion-dev99/Mobile-Order-System / ベースブランチ main',
    'プロトコル: docs/cardinal.md と .cursor/rules/cardinal-*.mdc を参照',
  ];
  return lines.join('\n');
}

async function postDiscord(env, body, embed) {
  // Never trust client-supplied webhook on Cardinal (use CF secret only)
  const webhook = (env && env.DISCORD_WEBHOOK_URL) || '';
  if (!isDiscordWebhook(webhook)) return { ok: false, skipped: true, reason: 'no_discord' };
  const endpoint = webhook.includes('?') ? `${webhook}&wait=true` : `${webhook}?wait=true`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'QuickOrder Cardinal',
      embeds: [embed],
    }),
  });
  return { ok: res.ok, status: res.status };
}

async function postAutomation(url, key, text, payload) {
  if (!url || !key) return { ok: false, skipped: true, reason: 'no_automation' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic ' + btoa(`${key}:`),
      },
      body: JSON.stringify({ text, ...payload }),
    });
    const raw = await res.text();
    return { ok: res.ok, status: res.status, raw: raw.slice(0, 400) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function postCloudAgent(env, role, promptText) {
  const apiKey = env?.CURSOR_API_KEY || '';
  if (!apiKey) return { ok: false, skipped: true, reason: 'no_api_key' };
  const repo = env?.CURSOR_REPO || DEFAULT_REPO;
  const branch = role === 'guardian'
    ? 'cursor/cardinal-guardian-a58c'
    : 'cursor/cardinal-executor-a58c';
  try {
    const res = await fetch('https://api.cursor.com/v0/agents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic ' + btoa(`${apiKey}:`),
      },
      body: JSON.stringify({
        prompt: { text: promptText },
        source: { repository: repo, ref: 'main' },
        target: {
          autoCreatePr: role === 'executor',
          branchName: branch,
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function pickAutomation(env, role) {
  if (role === 'guardian') {
    return {
      url: env?.CURSOR_GUARDIAN_WEBHOOK_URL || env?.CURSOR_AUTOMATION_WEBHOOK_URL || '',
      key: env?.CURSOR_GUARDIAN_API_KEY || env?.CURSOR_AUTOMATION_API_KEY || '',
    };
  }
  return {
    url: env?.CURSOR_EXECUTOR_WEBHOOK_URL || env?.CURSOR_AUTOMATION_WEBHOOK_URL || '',
    key: env?.CURSOR_EXECUTOR_API_KEY || env?.CURSOR_AUTOMATION_API_KEY || '',
  };
}

async function dispatchRole(env, role, task, body) {
  const prompt = rolePrompt(role, task, { source: body.source, url: body.url });
  const auto = pickAutomation(env, role);
  const automation = await postAutomation(auto.url, auto.key, prompt, {
    role,
    task,
    source: 'quickorder-cardinal',
  });
  const agent = await postCloudAgent(env, role, prompt);
  const launched = !!(automation.ok || agent.ok);

  await postDiscord(env, body, {
    title: launched
      ? `Cardinal ${role} を起動`
      : `Cardinal ${role} 起動できず（設定不足）`,
    color: launched ? (role === 'guardian' ? 0x5865f2 : 0x57f287) : 0xed4245,
    fields: [
      { name: '役割', value: role, inline: true },
      { name: '種別', value: String(task.kind || 'ops'), inline: true },
      { name: '重要度', value: String(task.severity || 'warning'), inline: true },
      { name: '要約', value: String(task.summary || task.title || '—').slice(0, 800), inline: false },
      {
        name: 'Cursor',
        value: launched
          ? (automation.ok ? 'Automation OK' : 'Cloud Agent OK')
          : '未設定（CURSOR_* secrets）',
        inline: false,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'QuickOrder Cardinal' },
  }).catch(() => {});

  return { automation, agent, launched, role };
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

  const action = String(body.action || 'status');

  // Public: status only. Privileged actions require OPS_API_SECRET.
  if (action !== 'status') {
    const gate = requireOpsSecret(request, env, body, j);
    if (!gate.ok) return gate.response;
  }

  if (action === 'heartbeat') {
    const role = body.role === 'executor' ? 'executor' : 'guardian';
    // Optional quiet Discord for alerts only
    if (body.status && body.status !== 'ok' && body.status !== 'drill') {
      await postDiscord(env, body, {
        title: `Cardinal heartbeat: ${role} = ${body.status}`,
        color: 0xfaa61a,
        fields: [
          { name: 'detail', value: String(body.detail || '—').slice(0, 1000), inline: false },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'QuickOrder Cardinal' },
      }).catch(() => {});
    }
    return j({
      ok: true,
      action: 'heartbeat',
      role,
      receivedAt: Date.now(),
      status: body.status || 'ok',
    });
  }

  if (action === 'dispatch') {
    const role = body.role === 'guardian' ? 'guardian' : 'executor';
    const task = body.task || {};
    const result = await dispatchRole(env, role, task, body);
    return j({
      ok: true,
      action: 'dispatch',
      ...result,
      hint: (!env?.CURSOR_API_KEY
        && !env?.CURSOR_GUARDIAN_WEBHOOK_URL
        && !env?.CURSOR_EXECUTOR_WEBHOOK_URL
        && !env?.CURSOR_AUTOMATION_WEBHOOK_URL)
        ? 'Cloudflare に CURSOR_GUARDIAN_* / CURSOR_EXECUTOR_*（または CURSOR_API_KEY）を設定すると双方向起動できます。docs/cardinal.md を参照。'
        : undefined,
    });
  }

  // Hourly/ cron tick: probe site + Firestore, auto maintenance, wake agents
  if (action === 'tick') {
    const base = String(body.baseUrl || 'https://mobile-order-system.pages.dev').replace(/\/$/, '');
    const force = !!body.force;
    const probes = {};
    for (const path of ['/', '/api/cardinal', '/api/notify', '/api/maintenance', '/ops.html']) {
      const started = Date.now();
      try {
        const res = await fetch(`${base}${path}`, {
          method: 'GET',
          redirect: 'follow',
          headers: { 'user-agent': 'QuickOrder-Cardinal-Tick/1.0' },
        });
        probes[path] = { ok: res.ok || res.status < 500, status: res.status, ms: Date.now() - started };
      } catch (e) {
        probes[path] = { ok: false, error: String(e?.message || e), ms: Date.now() - started };
      }
    }
    // Firestore public REST — detects order-DB outage even when Pages is fine
    {
      const started = Date.now();
      try {
        const res = await fetch(FIRESTORE_PROBE, {
          method: 'GET',
          headers: { 'user-agent': 'QuickOrder-Cardinal-Tick/1.0' },
        });
        // 2xx/404 = API reachable; 5xx/network = down
        probes.firestore = {
          ok: res.status > 0 && res.status < 500,
          status: res.status,
          ms: Date.now() - started,
        };
      } catch (e) {
        probes.firestore = { ok: false, error: String(e?.message || e), ms: Date.now() - started };
      }
    }

    const siteDown = ['/', '/ops.html'].some((p) => !probes[p]?.ok);
    const apiDown = !probes['/api/notify']?.ok || !probes['/api/cardinal']?.ok;
    const firestoreDown = !probes.firestore?.ok;
    // Auto-maintenance: order path broken (Firestore) or site/API hard down
    const shouldMaintain = firestoreDown || siteDown || apiDown;
    const unhealthy = shouldMaintain || Object.values(probes).some((p) => !p.ok);

    let maintenance = null;
    try {
      const prev = await readMaintenanceState(context.caches);
      if (shouldMaintain) {
        maintenance = await writeMaintenanceState(context.caches, {
          maintenance: true,
          message: MAINT_DEFAULT_MESSAGE,
          updatedBy: 'cardinal-tick',
          source: 'cardinal',
          auto: true,
        });
        if (!prev.maintenance) {
          await postDiscord(env, body, {
            title: 'Cardinal: 自動メンテナンス開始',
            color: 0xed4245,
            fields: [
              { name: '理由', value: firestoreDown ? 'Firestore障害' : (siteDown ? 'サイト障害' : 'API障害'), inline: true },
              { name: '案内', value: MAINT_DEFAULT_MESSAGE, inline: false },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'QuickOrder Cardinal' },
          }).catch(() => {});
        }
      } else if (prev.maintenance && (prev.auto || prev.source === 'cardinal')) {
        maintenance = await writeMaintenanceState(context.caches, {
          maintenance: false,
          updatedBy: 'cardinal-tick',
          source: 'cardinal',
          auto: true,
        });
        await postDiscord(env, body, {
          title: 'Cardinal: 自動メンテナンス解除',
          color: 0x57f287,
          fields: [
            { name: '状態', value: 'プローブ正常のため解除', inline: true },
          ],
          timestamp: new Date().toISOString(),
          footer: { text: 'QuickOrder Cardinal' },
        }).catch(() => {});
      } else {
        maintenance = prev;
      }
    } catch (e) {
      maintenance = { ok: false, error: String(e?.message || e) };
    }

    let dispatch = null;
    if (unhealthy || force) {
      const role = unhealthy ? 'executor' : 'guardian';
      dispatch = await dispatchRole(env, role, {
        kind: unhealthy ? 'incident' : 'watchdog',
        severity: unhealthy ? 'critical' : 'info',
        title: unhealthy ? 'Cardinal tick: 本番プローブ失敗' : 'Cardinal tick: 定期監視',
        summary: unhealthy
          ? '定期監視で本番エンドポイント異常を検知。Executor として調査・修正してください。'
          : '定期監視（強制）。Guardian として短く健全性を報告してください。',
        message: [
          unhealthy
            ? 'あなたは Cardinal Executor です。プローブ結果を見て原因調査し、直せるなら draft PR を作成。自動メンテナンスが ON の場合は復旧後に解除されるか確認。'
            : 'あなたは Cardinal Guardian です。プローブ結果を確認し短く報告。大きなコード変更は不要。',
          '',
          '```json',
          JSON.stringify({ base, probes, maintenance }, null, 2).slice(0, 4000),
          '```',
        ].join('\n'),
        acceptance: unhealthy
          ? ['原因特定', 'draft PR または外部障害の説明', '客席フォールバックを壊さない', '自動メンテ状態を確認']
          : ['健全性の短報', 'コード変更なしで可'],
      }, body);
    } else {
      await postDiscord(env, body, {
        title: 'Cardinal tick: 正常',
        color: 0x57f287,
        fields: Object.entries(probes).map(([path, p]) => ({
          name: path,
          value: p.ok ? `OK ${p.status || ''} (${p.ms}ms)` : `NG ${p.error || p.status}`,
          inline: true,
        })),
        timestamp: new Date().toISOString(),
        footer: { text: 'QuickOrder Cardinal' },
      }).catch(() => {});
    }

    return j({
      ok: true,
      action: 'tick',
      unhealthy,
      shouldMaintain,
      probes,
      maintenance,
      dispatched: !!dispatch?.launched,
      dispatch,
    });
  }

  return j({
    ok: true,
    action: 'status',
    service: 'quickorder-cardinal',
    configured: {
      discord: !!(env?.DISCORD_WEBHOOK_URL),
      apiKey: !!(env?.CURSOR_API_KEY),
      opsSecret: !!getOpsSecret(env),
      guardianWebhook: !!(env?.CURSOR_GUARDIAN_WEBHOOK_URL || env?.CURSOR_AUTOMATION_WEBHOOK_URL),
      executorWebhook: !!(env?.CURSOR_EXECUTOR_WEBHOOK_URL || env?.CURSOR_AUTOMATION_WEBHOOK_URL),
    },
  });
}

export async function onRequestGet(context) {
  return json({
    ok: true,
    service: 'quickorder-cardinal',
    roles: ['guardian', 'executor'],
    hint: 'Privileged POST requires X-Ops-Secret. Public: GET or POST { action: "status" }.',
  }, 200, context.request);
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(context.request),
  });
}
