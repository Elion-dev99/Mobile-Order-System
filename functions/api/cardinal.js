/**
 * Cloudflare Pages Function — Cardinal dual-agent bus.
 *
 * Actions (POST JSON { action, ... }):
 *   heartbeat — record role heartbeat (echo + Discord optional)
 *   dispatch  — launch Guardian or Executor via Cursor Automations / Cloud Agents API
 *   status    — configuration / readiness
 *   diagnose  — edge + Firestore probes
 *   digest    — Discord digest
 *   tick      — cron probe → auto maintenance → dispatch
 *   steward   — proactive daily/weekly Cursor maintenance (90% autonomy)
 *   followup  — re-dispatch Executor if outage persists after prior launch
 *   product_* — market scout → dual review → implement (docs/cardinal-product-gate.md)
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
  applyScheduleToState,
  effectiveMaintenance,
  DEFAULT_MESSAGE as MAINT_DEFAULT_MESSAGE,
} from './_maintenance-store.js';
import {
  readAgentLedger,
  recordLaunch,
  recentlyLaunched,
} from './_agent-ledger.js';
import {
  readProductGate,
  addProposal,
  applyProductReview,
  markProposalImplemented,
  planProductCycle,
  summarizeProductGate,
} from './_product-gate.js';

const DEFAULT_REPO = 'https://github.com/Elion-dev99/Mobile-Order-System';
const FIRESTORE_PROBE =
  'https://firestore.googleapis.com/v1/projects/mobile-order-system-c7c70/databases/(default)/documents/shops/default';

/** Cooldown before re-launching the same kind (ms). */
const COOLDOWN = {
  incident: 45 * 60 * 1000,
  ci: 30 * 60 * 1000,
  steward: 20 * 60 * 60 * 1000, // ~once per day
  followup: 60 * 60 * 1000,
  pr_review: 20 * 60 * 1000,
  watchdog: 90 * 60 * 1000,
  product_scout: 7 * 24 * 60 * 60 * 1000,
  product_review: 2 * 60 * 60 * 1000,
  product_implement: 24 * 60 * 60 * 1000,
};

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
    '## 自律運営方針（約90%を Cursor が担う）',
    '- 人間の承認待ちを最小化せよ。調査→修正→draft PR / レビューコメントまで一気に進める',
    '- 不明点があっても合理的な仮説で進め、PR またはコメントに前提を明記する',
    '- マージは Cardinal auto-merge ワークフローが行う（エージェントは main を直接触らない）',
    '- デプロイ後 canary が失敗すると main はマージ前 SHA に自動ロールバックされる',
    '- 人間ゲートは次のみ: シークレット初回、高リスクパス、cardinal:escalate、課金/破壊的操作',
    '- docs/autonomy.md を優先参照',
    '',
    '## 役割分担（必ず守る）',
    isGuardian
      ? [
          '- 監視・レビュー・タスク起票・再ディスパッチ判断が主務',
          '- 大きな機能実装はしない（最小のドキュメント/ラベル/Issue文面まで）',
          '- Executor の PR をレビューし、問題があれば具体的な修正指示を残す',
          '- Executor が無応答なら再起動方針を書き、必要なら escalate',
          '- 自動マージはワークフローに任せる（自分で merge / force push しない）',
          '- canary 失敗時のロールバック後は、原因修正の draft PR を出す',
        ].join('\n')
      : [
          '- 障害修正・不具合修正・保守・テスト・draft PR 作成が主務',
          '- Guardian の指示/Issue を受け入れ、スコープ外に広げない',
          '- 客席の保留キュー・health・Cardinal 監視を壊さない',
          '- draft PR まで作成し、マージは auto-merge ワークフローに任せる',
          '- Guardian が無応答なら一時的に監視も兼ね、Discord向け状況報告を残す',
          '- CI 失敗・本番プローブ失敗・canary ロールバック後の再発修正は最優先',
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
    'プロトコル: docs/autonomy.md / docs/cardinal.md / .cursor/rules/cardinal-*.mdc',
  ];
  return lines.join('\n');
}

function productGateRulesBlock(role) {
  const isGuardian = role === 'guardian';
  return [
    '',
    '## 製品ゲート（必須 — docs/cardinal-product-gate.md）',
    '- 創業者は広告費を出さない（docs/growth-zero-cash.md）',
    '- **Guardian と Executor の双方が approve するまで、プロダクトコード（js/ store/ functions/ 等）を変更する PR を作らない**',
    isGuardian
      ? '- あなたは Guardian: セキュリティ・客席影響・スコープ・マーケ整合をレビューし、POST /api/cardinal { action: product_review, role: guardian, proposalId, verdict, notes } を実行（Ops secret 付き）'
      : '- あなたは Executor: 実装可能性・canary リスク・工数をレビューし、同 API で role: executor を報告',
    '- reject なら理由を notes に明記',
    '- approve 後のみ product_implement タスクで実装 PR を作成',
  ].join('\n');
}

function productTaskPrompt(role, step, proposal = null) {
  const isGuardian = role === 'guardian';
  const propJson = proposal
    ? JSON.stringify(proposal, null, 2).slice(0, 3500)
    : '(新規提案なし — 市場調査から開始)';
  if (step === 'scout') {
    return {
      kind: 'product_scout',
      severity: 'info',
      title: 'Cardinal product: 市場調査・機能提案',
      summary: 'ゼロ現金成長に沿った機能/マーケ案を1件提案し、ゲートに登録する',
      message: [
        'Executor として製品パイプラインのスカウトフェーズです。',
        '1. docs/growth-zero-cash.md / docs/product-backlog.md / LP・Store 導線を読む',
        '2. 広告費ゼロで効く改善を **1件だけ** 選び、根拠（市場シグナル）を書く',
        '3. docs/product-backlog.md に追記（マーケ文案のみ — 実装コードはまだ触らない）',
        '4. Cloudflare Pages の POST /api/cardinal に action: product_propose を送る（x-ops-secret は GitHub/Cloudflare secret と同じ OPS_API_SECRET）',
        '   例: { "action":"product_propose", "title":"...", "summary":"...", "marketSignal":"...", "marketingAngle":"...", "acceptance":["..."] }',
        '5. 実装 PR は **作らない**（Guardian+Executor レビュー待ち）',
        '',
        '現在の提案:',
        '```json',
        propJson,
        '```',
      ].join('\n'),
      acceptance: [
        'product-backlog.md 更新',
        'product_propose API 成功',
        'プロダクトコード変更なし',
      ],
    };
  }
  if (step === 'guardian_review') {
    return {
      kind: 'product_review',
      severity: 'warning',
      title: `Cardinal product: Guardian レビュー — ${proposal?.title || ''}`,
      summary: '提案のリスク・マーケ整合を判定し product_review を POST',
      message: [
        'Guardian として製品提案をレビューしてください。',
        productGateRulesBlock('guardian'),
        '',
        '判定後、必ず API を呼ぶ:',
        '{ "action":"product_review", "role":"guardian", "proposalId":"...", "verdict":"approve|reject", "notes":"..." }',
        '',
        '```json',
        propJson,
        '```',
      ].join('\n'),
      acceptance: ['approve または reject', 'product_review API 実行', '大規模コード変更なし'],
    };
  }
  if (step === 'executor_review') {
    return {
      kind: 'product_review',
      severity: 'warning',
      title: `Cardinal product: Executor レビュー — ${proposal?.title || ''}`,
      summary: '実装可能性・スコープを判定し product_review を POST',
      message: [
        'Executor として製品提案をレビューしてください（実装はまだしない）。',
        productGateRulesBlock('executor'),
        '',
        'Guardian が approve 済みの場合のみ implement フェーズへ進める。',
        '{ "action":"product_review", "role":"executor", "proposalId":"...", "verdict":"approve|reject", "notes":"..." }',
        '',
        '```json',
        propJson,
        '```',
      ].join('\n'),
      acceptance: ['approve または reject', 'product_review API 実行', '実装 PR なし'],
    };
  }
  if (step === 'implement') {
    return {
      kind: 'product_implement',
      severity: 'info',
      title: `Cardinal product: 実装 — ${proposal?.title || ''}`,
      summary: '双方 approve 済み — 最小スコープで draft PR',
      message: [
        'Executor として **双方 approve 済み** の提案を実装してください。',
        '- 受け入れ条件を満たす最小 diff',
        '- draft PR（cursor/*-a58c）',
        '- マージは auto-merge に任せる',
        '- 完了後 action: product_implemented { proposalId, branch } を POST',
        '',
        '```json',
        propJson,
        '```',
      ].join('\n'),
      acceptance: ['draft PR', 'canary を壊さない', 'product_implemented 報告'],
    };
  }
  return null;
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

function agentBranchName(role, task = {}) {
  const kind = String(task.kind || 'ops').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'ops';
  const stamp = Date.now().toString(36).slice(-6);
  if (role === 'guardian') return `cursor/cardinal-guardian-${kind}-${stamp}-a58c`;
  return `cursor/cardinal-executor-${kind}-${stamp}-a58c`;
}

async function postCloudAgent(env, role, promptText, task = {}) {
  const apiKey = env?.CURSOR_API_KEY || '';
  if (!apiKey) return { ok: false, skipped: true, reason: 'no_api_key' };
  const repo = env?.CURSOR_REPO || DEFAULT_REPO;
  const branch = agentBranchName(role, task);
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
    return { ok: res.ok, status: res.status, data, branch };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), branch };
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

async function dispatchRole(env, role, task, body, cachesObj = null) {
  const kind = String(task.kind || 'ops');
  const cooldownMs = COOLDOWN[kind] || COOLDOWN.watchdog;
  if (!task.force && cachesObj) {
    const ledger = await readAgentLedger(cachesObj);
    if (recentlyLaunched(ledger, kind, cooldownMs)) {
      return {
        automation: { ok: false, skipped: true, reason: 'cooldown' },
        agent: { ok: false, skipped: true, reason: 'cooldown' },
        launched: false,
        skipped: true,
        reason: 'cooldown',
        role,
        kind,
        cooldownMs,
      };
    }
  }

  const prompt = rolePrompt(role, task, { source: body.source, url: body.url, autonomy: '90' });
  const auto = pickAutomation(env, role);
  const automation = await postAutomation(auto.url, auto.key, prompt, {
    role,
    task,
    source: 'quickorder-cardinal',
  });
  const agent = await postCloudAgent(env, role, prompt, task);
  const launched = !!(automation.ok || agent.ok);

  if (cachesObj) {
    await recordLaunch(cachesObj, {
      role,
      kind,
      title: task.title || task.summary || kind,
      launched,
      agentOk: !!agent.ok,
      branch: agent.branch || '',
    }).catch(() => {});
  }

  await postDiscord(env, body, {
    title: launched
      ? `Cardinal ${role} を起動`
      : (task.force ? `Cardinal ${role} 起動できず（設定不足）` : `Cardinal ${role}（${kind}）`),
    color: launched ? (role === 'guardian' ? 0x5865f2 : 0x57f287) : 0xed4245,
    fields: [
      { name: '役割', value: role, inline: true },
      { name: '種別', value: kind, inline: true },
      { name: '重要度', value: String(task.severity || 'warning'), inline: true },
      { name: '要約', value: String(task.summary || task.title || '—').slice(0, 800), inline: false },
      {
        name: 'Cursor',
        value: launched
          ? (automation.ok ? 'Automation OK' : 'Cloud Agent OK')
          : '未設定またはクールダウン',
        inline: false,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'QuickOrder Cardinal · autonomy 90%' },
  }).catch(() => {});

  return { automation, agent, launched, role, kind };
}

async function runProbes(base) {
  const probes = {};
  for (const path of ['/', '/api/cardinal', '/api/notify', '/api/maintenance', '/ops.html']) {
    const started = Date.now();
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'user-agent': 'QuickOrder-Cardinal/2.0' },
      });
      probes[path] = { ok: res.ok || res.status < 500, status: res.status, ms: Date.now() - started };
    } catch (e) {
      probes[path] = { ok: false, error: String(e?.message || e), ms: Date.now() - started };
    }
  }
  {
    const started = Date.now();
    try {
      const res = await fetch(FIRESTORE_PROBE, {
        method: 'GET',
        headers: { 'user-agent': 'QuickOrder-Cardinal/2.0' },
      });
      probes.firestore = {
        ok: res.status > 0 && res.status < 500,
        status: res.status,
        ms: Date.now() - started,
      };
    } catch (e) {
      probes.firestore = { ok: false, error: String(e?.message || e), ms: Date.now() - started };
    }
  }
  return probes;
}

function probeVerdict(probes, simulateUnhealthy = false) {
  if (simulateUnhealthy) {
    return {
      siteDown: true,
      apiDown: true,
      firestoreDown: true,
      shouldMaintain: true,
      unhealthy: true,
    };
  }
  const siteDown = ['/', '/ops.html'].some((p) => !probes[p]?.ok);
  const apiDown = !probes['/api/notify']?.ok || !probes['/api/cardinal']?.ok;
  const firestoreDown = !probes.firestore?.ok;
  const shouldMaintain = firestoreDown || siteDown || apiDown;
  const unhealthy = shouldMaintain || Object.values(probes).some((p) => !p.ok);
  return { siteDown, apiDown, firestoreDown, shouldMaintain, unhealthy };
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
    const result = await dispatchRole(env, role, task, body, context.caches);
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

  // Server-side diagnose: probe edges + Firestore without launching agents
  if (action === 'diagnose') {
    const base = String(body.baseUrl || 'https://mobile-order-system.pages.dev').replace(/\/$/, '');
    const probes = {};
    for (const path of ['/', '/api/notify', '/api/maintenance', '/api/cardinal', '/ops.html']) {
      const started = Date.now();
      try {
        const res = await fetch(`${base}${path}`, {
          method: 'GET',
          redirect: 'follow',
          headers: { 'user-agent': 'QuickOrder-Cardinal-Diagnose/1.0' },
        });
        probes[path] = { ok: res.ok || res.status < 500, status: res.status, ms: Date.now() - started };
      } catch (e) {
        probes[path] = { ok: false, error: String(e?.message || e), ms: Date.now() - started };
      }
    }
    {
      const started = Date.now();
      try {
        const res = await fetch(FIRESTORE_PROBE, {
          method: 'GET',
          headers: { 'user-agent': 'QuickOrder-Cardinal-Diagnose/1.0' },
        });
        probes.firestore = { ok: res.status > 0 && res.status < 500, status: res.status, ms: Date.now() - started };
      } catch (e) {
        probes.firestore = { ok: false, error: String(e?.message || e), ms: Date.now() - started };
      }
    }
    let maintenance = null;
    try {
      maintenance = await readMaintenanceState(context.caches);
    } catch (e) {
      maintenance = { error: String(e?.message || e) };
    }
    const failed = Object.entries(probes).filter(([, p]) => !p.ok).map(([k]) => k);
    const report = {
      ok: failed.length === 0,
      failed,
      probes,
      maintenance,
      configured: {
        discord: !!(env?.DISCORD_WEBHOOK_URL),
        apiKey: !!(env?.CURSOR_API_KEY),
        opsSecret: !!getOpsSecret(env),
      },
      at: Date.now(),
    };
    if (body.notify !== false) {
      await postDiscord(env, body, {
        title: report.ok ? 'Cardinal 診断: 正常' : `Cardinal 診断: 異常 ${failed.length}件`,
        color: report.ok ? 0x57f287 : 0xed4245,
        fields: [
          ...Object.entries(probes).map(([path, p]) => ({
            name: path,
            value: p.ok ? `OK ${p.status || ''} (${p.ms}ms)` : `NG ${p.error || p.status}`,
            inline: true,
          })),
          {
            name: 'メンテ',
            value: maintenance?.maintenance ? `ON (${maintenance.source || '?'})` : 'OFF',
            inline: true,
          },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'QuickOrder Cardinal' },
      }).catch(() => {});
    }
    return j({ ok: true, action: 'diagnose', ...report });
  }

  // Lightweight digest from server probes (no order DB aggregation)
  if (action === 'digest') {
    const base = String(body.baseUrl || 'https://mobile-order-system.pages.dev').replace(/\/$/, '');
    const started = Date.now();
    let home = { ok: false };
    try {
      const res = await fetch(`${base}/`, { method: 'GET', headers: { 'user-agent': 'QuickOrder-Cardinal-Digest/1.0' } });
      home = { ok: res.ok || res.status < 500, status: res.status, ms: Date.now() - started };
    } catch (e) {
      home = { ok: false, error: String(e?.message || e) };
    }
    let maintenance = null;
    try { maintenance = await readMaintenanceState(context.caches); } catch (_) {}
    await postDiscord(env, body, {
      title: 'Cardinal サーバーダイジェスト',
      color: home.ok ? 0x5865f2 : 0xed4245,
      fields: [
        { name: 'サイト', value: home.ok ? `OK ${home.status} (${home.ms}ms)` : `NG ${home.error || ''}`, inline: true },
        { name: 'メンテ', value: maintenance?.maintenance ? `ON (${maintenance.source || '?'})` : 'OFF', inline: true },
        { name: 'CURSOR_API_KEY', value: env?.CURSOR_API_KEY ? '設定済' : '未設定', inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'QuickOrder Cardinal' },
    }).catch(() => {});
    return j({ ok: true, action: 'digest', home, maintenance });
  }

  // Hourly/ cron tick: probe site + Firestore, auto maintenance, wake agents
  if (action === 'tick') {
    const base = String(body.baseUrl || 'https://mobile-order-system.pages.dev').replace(/\/$/, '');
    const force = !!body.force;
    const simulateUnhealthy = !!body.simulateUnhealthy || !!body.drillOutage;
    let probes = await runProbes(base);
    if (simulateUnhealthy) {
      probes = {
        ...probes,
        '/__simulated': { ok: false, error: 'simulateUnhealthy', ms: 0 },
        firestore: { ok: false, error: 'simulateUnhealthy', status: 0, ms: 0 },
      };
    }
    const { siteDown, apiDown, firestoreDown, shouldMaintain, unhealthy } = probeVerdict(probes, simulateUnhealthy);

    let maintenance = null;
    let scheduleApply = null;
    try {
      const prev = await readMaintenanceState(context.caches);
      if (shouldMaintain) {
        maintenance = await writeMaintenanceState(context.caches, {
          maintenance: true,
          message: MAINT_DEFAULT_MESSAGE,
          updatedBy: simulateUnhealthy ? 'cardinal:drill-tick' : 'cardinal-tick',
          source: 'cardinal',
          auto: true,
          schedule: prev.schedule,
        });
        if (!prev.maintenance || simulateUnhealthy) {
          await postDiscord(env, body, {
            title: simulateUnhealthy
              ? 'Cardinal: 障害メンテドリル（模擬）'
              : 'Cardinal: 自動メンテナンス開始',
            color: 0xed4245,
            fields: [
              {
                name: '理由',
                value: simulateUnhealthy
                  ? 'simulateUnhealthy ドリル'
                  : (firestoreDown ? 'Firestore障害' : (siteDown ? 'サイト障害' : 'API障害')),
                inline: true,
              },
              { name: '案内', value: MAINT_DEFAULT_MESSAGE, inline: false },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'QuickOrder Cardinal' },
          }).catch(() => {});
        }
      } else if (
        prev.maintenance
        && (prev.source === 'cardinal')
        && prev.auto
      ) {
        scheduleApply = await applyScheduleToState(context.caches, { outageMaintain: false });
        if (scheduleApply.scheduleEval?.active) {
          maintenance = scheduleApply.state;
        } else {
          maintenance = await writeMaintenanceState(context.caches, {
            maintenance: false,
            updatedBy: 'cardinal-tick',
            source: 'cardinal',
            auto: true,
            schedule: prev.schedule,
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
        }
      } else {
        scheduleApply = await applyScheduleToState(context.caches, { outageMaintain: false });
        maintenance = scheduleApply.state;
      }
      maintenance = {
        ...effectiveMaintenance(maintenance),
        persisted: maintenance?.persisted,
        persistError: maintenance?.persistError ?? null,
        scheduleApply,
        simulated: simulateUnhealthy,
      };
    } catch (e) {
      maintenance = { ok: false, error: String(e?.message || e) };
    }

    let dispatch = null;
    let followup = null;
    const allowDispatch = !simulateUnhealthy || !!body.dispatchOnDrill;
    if (allowDispatch && (unhealthy || force)) {
      const role = unhealthy ? 'executor' : 'guardian';
      dispatch = await dispatchRole(env, role, {
        kind: unhealthy ? 'incident' : 'watchdog',
        severity: unhealthy ? 'critical' : 'info',
        force,
        title: unhealthy ? 'Cardinal tick: 本番プローブ失敗' : 'Cardinal tick: 定期監視',
        summary: unhealthy
          ? '定期監視で本番エンドポイント異常を検知。Executor として調査・修正してください。'
          : '定期監視（強制）。Guardian として短く健全性を報告してください。',
        message: [
          unhealthy
            ? 'あなたは Cardinal Executor です。プローブ結果を見て原因調査し、直せるなら draft PR を作成。自動メンテナンスが ON の場合は復旧後に解除されるか確認。人間の承認は待たず完走せよ（docs/autonomy.md）。'
            : 'あなたは Cardinal Guardian です。プローブ結果を確認し短く報告。大きなコード変更は不要。',
          '',
          '```json',
          JSON.stringify({ base, probes, maintenance }, null, 2).slice(0, 4000),
          '```',
        ].join('\n'),
        acceptance: unhealthy
          ? ['原因特定', 'draft PR または外部障害の説明', '客席フォールバックを壊さない', '自動メンテ状態を確認']
          : ['健全性の短報', 'コード変更なしで可'],
      }, body, context.caches);

      // Persistent outage: if incident was already launched earlier, try followup after cooldown
      if (unhealthy && dispatch?.skipped && dispatch?.reason === 'cooldown') {
        followup = await dispatchRole(env, 'executor', {
          kind: 'followup',
          severity: 'critical',
          title: 'Cardinal followup: 障害が継続',
          summary: '前回のインシデント起動後もプローブ異常が継続。再調査・再修正してください。',
          message: [
            '前回起動からクールダウン経過後も本番異常が続いています。',
            '重複修正に注意しつつ、未マージの draft があれば続きを、なければ新規 draft PR を。',
            '',
            '```json',
            JSON.stringify({ base, probes, maintenance }, null, 2).slice(0, 3500),
            '```',
          ].join('\n'),
          acceptance: ['継続原因の特定', 'draft PR または外部障害報告', '二重修正を避ける'],
        }, body, context.caches);
      }
    } else if (!simulateUnhealthy) {
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

    const ledger = await readAgentLedger(context.caches).catch(() => null);

    return j({
      ok: true,
      action: 'tick',
      unhealthy,
      shouldMaintain,
      simulateUnhealthy,
      probes,
      maintenance,
      dispatched: !!(dispatch?.launched || followup?.launched),
      dispatch,
      followup,
      ledger: ledger ? { lastByKind: ledger.lastByKind, recent: ledger.launches.slice(0, 5) } : null,
    });
  }

  // Proactive steward: daily Cursor maintenance / bug sweep when healthy
  if (action === 'steward') {
    const base = String(body.baseUrl || 'https://mobile-order-system.pages.dev').replace(/\/$/, '');
    const probes = await runProbes(base);
    const verdict = probeVerdict(probes);
    let maintenance = null;
    try {
      maintenance = effectiveMaintenance(await readMaintenanceState(context.caches));
    } catch (_) {}

    // If unhealthy, prefer incident Executor over steward
    if (verdict.unhealthy) {
      const dispatch = await dispatchRole(env, 'executor', {
        kind: 'incident',
        severity: 'critical',
        force: !!body.force,
        title: 'Cardinal steward: 異常検知 → インシデント化',
        summary: '定期ステュワード中にプローブ異常。Executor に切り替え。',
        message: [
          'ステュワード実行時に本番異常を検知。通常のインシデント対応として修正せよ。',
          '',
          '```json',
          JSON.stringify({ probes, maintenance }, null, 2).slice(0, 4000),
          '```',
        ].join('\n'),
        acceptance: ['原因特定', 'draft PR または外部障害説明'],
      }, body, context.caches);
      return j({
        ok: true,
        action: 'steward',
        mode: 'incident',
        probes,
        maintenance,
        dispatch,
        dispatched: !!dispatch?.launched,
      });
    }

    const mode = body.mode === 'guardian' ? 'guardian' : 'executor';
    const dispatch = await dispatchRole(env, mode, {
      kind: 'steward',
      severity: 'info',
      force: !!body.force,
      title: mode === 'guardian'
        ? 'Cardinal steward: 週次健全性レビュー'
        : 'Cardinal steward: 予防保守・不具合掃討',
      summary: mode === 'guardian'
        ? '健全時の定期レビュー。リスクと次アクションを報告。'
        : '健全時の予防保守。小さな不具合・ドキュメントずれ・監視穴を直して draft PR。',
      message: [
        mode === 'guardian'
          ? [
              '本番プローブは正常です。Guardian として:',
              '1. 直近の draft PR / CI / docs/autonomy.md のギャップを確認',
              '2. 人間ゲート（マージ・escalate）以外で Cursor が回せる改善を列挙',
              '3. 必要なら Executor 向けの具体タスク文を PR コメントまたは docs メモに残す',
              '大きなコード変更はしない',
            ].join('\n')
          : [
              '本番プローブは正常です。Executor として予防保守を実施:',
              '1. docs/hardening.md / docs/autonomy.md / 直近 PR から残リスクを拾う',
              '2. 小さな不具合・キャッシュ bust ずれ・監視穴・デッドコードの安全な修正',
              '3. 客席・注文・Cardinal を壊さない範囲で draft PR',
              '4. 変更が不要なら理由を短く残して終了（クレジット浪費しない）',
              '大規模リファクタや新機能はしない',
            ].join('\n'),
        '',
        '```json',
        JSON.stringify({ probes, maintenance, autonomy: '90' }, null, 2).slice(0, 3000),
        '```',
      ].join('\n'),
      acceptance: mode === 'guardian'
        ? ['健全性レビュー短報', '次アクション列挙', 'コード大変更なし']
        : ['予防修正または「変更不要」の理由', 'draft PR（変更時）', '破壊的変更なし'],
    }, body, context.caches);

    return j({
      ok: true,
      action: 'steward',
      mode,
      probes,
      maintenance,
      dispatch,
      dispatched: !!dispatch?.launched,
    });
  }

  if (action === 'followup') {
    const base = String(body.baseUrl || 'https://mobile-order-system.pages.dev').replace(/\/$/, '');
    const probes = await runProbes(base);
    const verdict = probeVerdict(probes);
    const ledger = await readAgentLedger(context.caches);
    if (!verdict.unhealthy && !body.force) {
      return j({
        ok: true,
        action: 'followup',
        skipped: true,
        reason: 'healthy',
        probes,
        ledger: { lastByKind: ledger.lastByKind },
      });
    }
    const dispatch = await dispatchRole(env, 'executor', {
      kind: 'followup',
      severity: verdict.unhealthy ? 'critical' : 'warning',
      force: !!body.force,
      title: 'Cardinal followup: 再調査',
      summary: '障害継続または手動フォローアップ。',
      message: [
        'フォローアップ要求です。前回エージェントの続きを取り、draft PR を完成させてください。',
        '',
        '```json',
        JSON.stringify({ probes, ledger: ledger.lastByKind }, null, 2).slice(0, 3500),
        '```',
      ].join('\n'),
      acceptance: ['継続原因の特定', 'draft PR または escalate 理由'],
    }, body, context.caches);
    return j({
      ok: true,
      action: 'followup',
      probes,
      dispatch,
      dispatched: !!dispatch?.launched,
      ledger: { lastByKind: ledger.lastByKind, recent: ledger.launches.slice(0, 5) },
    });
  }

  if (action === 'product_status') {
    const gate = await readProductGate(context.caches);
    return j({
      ok: true,
      action: 'product_status',
      ...summarizeProductGate(gate),
      policy: 'docs/cardinal-product-gate.md',
    });
  }

  if (action === 'product_propose') {
    const result = await addProposal(context.caches, {
      title: body.title,
      summary: body.summary,
      marketSignal: body.marketSignal,
      marketingAngle: body.marketingAngle,
      acceptance: body.acceptance,
      scoutSource: body.source || body.scoutSource || 'api',
    });
    await postDiscord(env, body, {
      title: `製品提案: ${result.proposal.title}`,
      color: 0x5865f2,
      fields: [
        { name: 'ID', value: result.proposal.id, inline: true },
        { name: '次', value: 'Guardian レビュー待ち', inline: true },
        { name: '要約', value: result.proposal.summary.slice(0, 900) || '—', inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'QuickOrder Cardinal · product gate' },
    }).catch(() => {});
    return j({
      ok: true,
      action: 'product_propose',
      proposal: result.proposal,
      summary: summarizeProductGate(result.gate),
    });
  }

  if (action === 'product_review') {
    const review = await applyProductReview(context.caches, {
      proposalId: body.proposalId || body.id,
      role: body.role,
      verdict: body.verdict,
      notes: body.notes || body.message,
    });
    if (!review.ok) return j({ ok: false, action: 'product_review', ...review }, 400);
    const p = review.proposal;
    await postDiscord(env, body, {
      title: `製品レビュー (${body.role}): ${p.title} → ${body.role === 'guardian' ? p.guardianVerdict : p.executorVerdict}`,
      color: (body.verdict === 'reject' || String(body.verdict).includes('reject')) ? 0xed4245 : 0x57f287,
      fields: [
        { name: '提案', value: p.id, inline: true },
        { name: 'status', value: p.status, inline: true },
        { name: 'notes', value: String(body.notes || '—').slice(0, 800), inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'QuickOrder Cardinal · product gate' },
    }).catch(() => {});
    return j({
      ok: true,
      action: 'product_review',
      proposal: p,
      summary: summarizeProductGate(review.gate),
    });
  }

  if (action === 'product_implemented') {
    const done = await markProposalImplemented(context.caches, {
      proposalId: body.proposalId || body.id,
      branch: body.branch,
    });
    if (!done.ok) return j({ ok: false, action: 'product_implemented', ...done }, 400);
    return j({
      ok: true,
      action: 'product_implemented',
      proposal: done.proposal,
      summary: summarizeProductGate(done.gate),
    });
  }

  if (action === 'product_cycle') {
    const force = !!body.force;
    const forceScout = !!body.forceScout;
    const gate = await readProductGate(context.caches);
    const plan = planProductCycle(gate, { forceScout: forceScout || force });
    if (plan.step === 'idle') {
      return j({
        ok: true,
        action: 'product_cycle',
        step: 'idle',
        reason: plan.reason,
        summary: summarizeProductGate(gate),
        dispatched: false,
      });
    }

    let role = 'executor';
    if (plan.step === 'guardian_review') role = 'guardian';
    const task = productTaskPrompt(role, plan.step, plan.proposal);
    if (!task) {
      return j({ ok: false, action: 'product_cycle', error: 'no_task', step: plan.step }, 500);
    }
    if (force) task.force = true;
    const dispatch = await dispatchRole(env, role, task, body, context.caches);
    const saved = await readProductGate(context.caches);
    return j({
      ok: true,
      action: 'product_cycle',
      step: plan.step,
      proposal: plan.proposal ? { id: plan.proposal.id, title: plan.proposal.title, status: plan.proposal.status } : null,
      dispatch,
      dispatched: !!dispatch?.launched,
      summary: summarizeProductGate(saved),
    });
  }

  {
    const ledger = await readAgentLedger(context.caches).catch(() => defaultLedgerSafe());
    const productGate = await readProductGate(context.caches).catch(() => null);
    return j({
      ok: true,
      action: 'status',
      service: 'quickorder-cardinal',
      autonomy: {
        targetPct: 90,
        policy: 'docs/autonomy.md',
        cursorOwns: [
          'probe',
          'auto_maintenance',
          'incident_dispatch',
          'ci_dispatch',
          'pr_guardian',
          'steward',
          'followup',
          'draft_pr',
          'auto_merge',
          'canary',
          'rollback',
          'product_gate',
        ],
        humanOwns: [
          'secrets_bootstrap',
          'high_risk_paths',
          'cardinal_escalate',
          'billing_destructive',
        ],
      },
      configured: {
        discord: !!(env?.DISCORD_WEBHOOK_URL),
        apiKey: !!(env?.CURSOR_API_KEY),
        opsSecret: !!getOpsSecret(env),
        guardianWebhook: !!(env?.CURSOR_GUARDIAN_WEBHOOK_URL || env?.CURSOR_AUTOMATION_WEBHOOK_URL),
        executorWebhook: !!(env?.CURSOR_EXECUTOR_WEBHOOK_URL || env?.CURSOR_AUTOMATION_WEBHOOK_URL),
      },
      ledger: ledger ? { lastByKind: ledger.lastByKind, recent: (ledger.launches || []).slice(0, 8) } : null,
      productGate: productGate ? summarizeProductGate(productGate) : null,
    });
  }
}

function defaultLedgerSafe() {
  return { launches: [], lastByKind: {}, updatedAt: 0 };
}

export async function onRequestGet(context) {
  return json({
    ok: true,
    service: 'quickorder-cardinal',
    roles: ['guardian', 'executor'],
    actions: ['status', 'heartbeat', 'dispatch', 'diagnose', 'digest', 'tick', 'steward', 'followup', 'product_status', 'product_propose', 'product_review', 'product_cycle', 'product_implemented'],
    autonomy: { targetPct: 90, policy: 'docs/autonomy.md' },
    hint: 'Privileged POST requires X-Ops-Secret. Public: GET or POST { action: "status" }. See docs/autonomy.md.',
  }, 200, context.request);
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(context.request),
  });
}
