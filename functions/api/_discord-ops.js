/**
 * Discord slash command handlers → maintenance / probes.
 */

import {
  readMaintenanceState,
  writeMaintenanceState,
  effectiveMaintenance,
  DEFAULT_MESSAGE,
} from './_maintenance-store.js';
import {
  listSystemIncidents,
  dismissSystemIncident,
  recordSystemIncident,
} from './_system-incidents.js';
import { dispatchCursorAgent } from './_incident-dispatch.js';

const PROBE_PATHS = ['/', '/api/cardinal', '/api/maintenance', '/api/notify', '/ops.html'];

async function runEdgeProbes(base) {
  const probes = {};
  for (const path of PROBE_PATHS) {
    const started = Date.now();
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'user-agent': 'QuickOrder-Discord-Ops/1.0' },
      });
      probes[path] = { ok: res.ok || res.status < 500, status: res.status, ms: Date.now() - started };
    } catch (e) {
      probes[path] = { ok: false, error: String(e?.message || e), ms: Date.now() - started };
    }
  }
  return probes;
}

function optionValue(sub, name) {
  return sub?.options?.find((o) => o.name === name)?.value;
}

function parseQoCommand(interaction) {
  const root = interaction?.data?.name;
  if (root !== 'qo') return null;
  const group = interaction.data.options?.[0];
  if (!group || group.type !== 2) return null;
  const sub = group.options?.[0];
  if (!sub || sub.type !== 1) return null;
  const options = {};
  for (const o of sub.options || []) {
    options[o.name] = o.value;
  }
  return {
    group: group.name,
    sub: sub.name,
    message: options.message,
    options,
  };
}

async function setMaintenance(caches, { on, userId, message }) {
  const prev = await readMaintenanceState(caches);
  const next = await writeMaintenanceState(caches, {
    maintenance: !!on,
    message: on ? (message || prev.message || DEFAULT_MESSAGE) : prev.message,
    updatedBy: `discord:${userId || 'ops'}`,
    source: 'manual',
    auto: false,
    schedule: prev.schedule,
  });
  const eff = effectiveMaintenance(next);
  return { prev, next, eff, persisted: next.persisted, persistError: next.persistError ?? null };
}

export async function executeDiscordQoCommand(interaction, caches, env) {
  const parsed = parseQoCommand(interaction);
  if (!parsed) {
    return { content: '不明なコマンドです。`/qo` のサブコマンドを使ってください。' };
  }

  const userId = interaction.member?.user?.id || interaction.user?.id || 'unknown';
  const { group, sub, message, options = {} } = parsed;

  if (group === 'maint') {
    if (sub === 'start') {
      const r = await setMaintenance(caches, { on: true, userId, message });
      const eff = r.eff;
      return {
        content: [
          '**メンテナンス開始**（客席・新規注文を停止）',
          `実効: ${eff.effective || eff.maintenance ? 'ON' : 'OFF'}`,
          `案内: ${(eff.message || DEFAULT_MESSAGE).slice(0, 200)}`,
          r.persisted === false ? '⚠️ Cache 書き込み失敗 — Ops で確認してください' : '✅ edge に反映済み',
          `操作者: <@${userId}>`,
        ].join('\n'),
      };
    }
    if (sub === 'stop' || sub === 'off') {
      const r = await setMaintenance(caches, { on: false, userId, message: null });
      const eff = r.eff;
      return {
        content: [
          '**メンテナンス解除**',
          `実効: ${eff.effective || eff.maintenance ? 'ON' : 'OFF'}`,
          r.persisted === false ? '⚠️ Cache 書き込み失敗' : '✅ 復旧（edge OFF）',
          `操作者: <@${userId}>`,
        ].join('\n'),
      };
    }
    if (sub === 'status') {
      const stored = await readMaintenanceState(caches);
      const eff = effectiveMaintenance(stored);
      const probes = await runEdgeProbes(String(env?.PUBLIC_BASE_URL || 'https://mobile-order-system.pages.dev').replace(/\/$/, ''));
      const failed = Object.entries(probes).filter(([, p]) => !p.ok).map(([k]) => k);
      return {
        content: [
          '**QuickOrder 状態**',
          `メンテ（実効）: ${eff.effective || eff.maintenance ? 'ON' : 'OFF'} (${eff.source || stored.source || '?'})`,
          `メッセージ: ${(eff.message || '—').slice(0, 160)}`,
          `更新: ${stored.updatedBy || '—'}`,
          `プローブ: ${failed.length ? `NG ${failed.join(', ')}` : 'すべて OK'}`,
        ].join('\n'),
      };
    }
  }

  if (group === 'debug') {
    const incidentId = options.incident_id || options.id;
    const feature = options.feature || 'manual';
    const cause = options.cause || options.detail || 'Discord debug request';

    if (sub === 'status') {
      const data = await listSystemIncidents(caches, { limit: 15, status: 'open' });
      const lines = data.events.length
        ? data.events.map((e) => `• \`${e.id}\` **${e.feature}** — ${String(e.cause).slice(0, 80)} (×${e.count || 1})`)
        : ['オープンなインシデントはありません。'];
      return {
        content: ['**システムインシデント（open）**', ...lines, `合計 ledger: ${data.total}`].join('\n'),
      };
    }

    if (sub === 'dismiss') {
      if (!incidentId) return { content: 'incident_id を指定してください。' };
      await dismissSystemIncident(caches, incidentId);
      return { content: `インシデント \`${incidentId}\` を dismissed にしました。` };
    }

    if (sub === 'fix') {
      if (!incidentId) return { content: 'incident_id を指定してください。`/qo debug status` で ID を確認。' };
      const data = await listSystemIncidents(caches, { limit: 80, status: '' });
      const row = data.events.find((e) => e.id === incidentId);
      if (!row) return { content: `ID \`${incidentId}\` が見つかりません。` };
      const incident = {
        feature: row.feature,
        cause: row.cause,
        summary: `${row.feature}: ${row.cause}`,
        message: row.cause,
        incidentId: row.id,
        kind: row.kind,
        source: 'discord_debug_fix',
        severity: row.severity,
        cardinalRole: 'executor',
        url: row.url,
        shopId: row.shopId,
        requestedBy: userId,
      };
      const cursor = await dispatchCursorAgent(env, incident);
      const launched = !!(cursor.agent?.ok || cursor.automation?.ok);
      return {
        content: [
          '**デバッグ修正依頼 → Cursor Agent**',
          `対象: \`${incidentId}\` — ${row.feature}`,
          launched ? '✅ Agent 起動依頼済み（draft PR 予定）' : '⚠️ CURSOR_API_KEY / Automations 未設定または起動失敗',
          `操作者: <@${userId}>`,
        ].join('\n'),
      };
    }

    if (sub === 'request') {
      const recorded = await recordSystemIncident(caches, env, {
        feature,
        cause,
        kind: 'debug_request',
        source: 'discord',
        severity: 'warning',
      });
      const incident = {
        feature,
        cause,
        summary: `${feature}: ${cause}`,
        message: cause,
        source: 'discord_debug_request',
        severity: 'warning',
        cardinalRole: 'executor',
        requestedBy: userId,
        incidentId: recorded.row?.id,
      };
      const cursor = await dispatchCursorAgent(env, incident);
      const launched = !!(cursor.agent?.ok || cursor.automation?.ok);
      return {
        content: [
          '**デバッグ依頼**',
          `機能: ${feature}`,
          `原因/依頼: ${cause.slice(0, 300)}`,
          recorded.discord?.ok ? '✅ Discord 通知済' : '（Discord 通知スキップ/失敗）',
          launched ? '✅ Cursor Agent 起動依頼済' : '⚠️ Agent 未起動 — Cloudflare に CURSOR_API_KEY を設定',
          `操作者: <@${userId}>`,
        ].join('\n'),
      };
    }

    return { content: `未対応 debug サブコマンド: ${sub}` };
  }

  if (group === 'server') {
    if (sub === 'stop') {
      const r = await setMaintenance(caches, {
        on: true,
        userId,
        message: message || '運用のため一時停止中です。復旧までお待ちください。',
      });
      return {
        content: [
          '**サーバー停止**（緊急メンテ ON — 客席停止）',
          `実効: ${r.eff.effective || r.eff.maintenance ? 'ON' : 'OFF'}`,
          `操作者: <@${userId}>`,
          '復旧は `/qo server recover` または `/qo maint stop`',
        ].join('\n'),
      };
    }
    if (sub === 'recover') {
      const r = await setMaintenance(caches, { on: false, userId, message: null });
      return {
        content: [
          '**サーバー復旧**（メンテ OFF）',
          `実効: ${r.eff.effective || r.eff.maintenance ? 'ON' : 'OFF'}`,
          r.persisted === false ? '⚠️ 反映失敗の可能性' : '✅ 通常稼働に戻しました',
          `操作者: <@${userId}>`,
        ].join('\n'),
      };
    }
  }

  return { content: `未対応: ${group} ${sub}` };
}

export const DISCORD_COMMAND_DEFINITIONS = [
  {
    name: 'qo',
    description: 'QuickOrder 運用（メンテ・停止・復旧）',
    options: [
      {
        name: 'maint',
        description: 'メンテナンス',
        type: 2,
        options: [
          {
            name: 'start',
            description: 'メンテナンス開始（客席停止）',
            type: 1,
            options: [
              {
                name: 'message',
                description: '客席に表示する案内文',
                type: 3,
                required: false,
              },
            ],
          },
          {
            name: 'stop',
            description: 'メンテナンス解除',
            type: 1,
          },
          {
            name: 'status',
            description: 'メンテ状態とプローブ',
            type: 1,
          },
        ],
      },
      {
        name: 'server',
        description: 'サーバー緊急停止 / 復旧',
        type: 2,
        options: [
          {
            name: 'stop',
            description: '緊急停止（メンテ ON）',
            type: 1,
            options: [
              {
                name: 'message',
                description: '案内文',
                type: 3,
                required: false,
              },
            ],
          },
          {
            name: 'recover',
            description: '復旧（メンテ OFF）',
            type: 1,
          },
        ],
      },
      {
        name: 'debug',
        description: 'システムエラー監視・デバッグ依頼',
        type: 2,
        options: [
          {
            name: 'status',
            description: 'オープンインシデント一覧',
            type: 1,
          },
          {
            name: 'request',
            description: 'デバッグ依頼（Discord通知 + Cursor Agent）',
            type: 1,
            options: [
              { name: 'feature', description: '機能名（例: billing, guest-order）', type: 3, required: true },
              { name: 'cause', description: '原因または依頼内容', type: 3, required: true },
            ],
          },
          {
            name: 'fix',
            description: '既存インシデントを Agent に修正依頼',
            type: 1,
            options: [
              { name: 'incident_id', description: 'インシデント ID（debug status）', type: 3, required: true },
            ],
          },
          {
            name: 'dismiss',
            description: 'インシデントを解消済みにする',
            type: 1,
            options: [
              { name: 'incident_id', description: 'インシデント ID', type: 3, required: true },
            ],
          },
        ],
      },
    ],
  },
];
