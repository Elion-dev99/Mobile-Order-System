/**
 * Discord slash command handlers → maintenance / probes.
 */

import {
  readMaintenanceState,
  writeMaintenanceState,
  effectiveMaintenance,
  DEFAULT_MESSAGE,
} from './_maintenance-store.js';

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
  return {
    group: group.name,
    sub: sub.name,
    message: optionValue(sub, 'message'),
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
  const { group, sub, message } = parsed;

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
    ],
  },
];
