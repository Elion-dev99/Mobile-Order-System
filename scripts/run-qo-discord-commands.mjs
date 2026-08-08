#!/usr/bin/env node
/**
 * Run /qo Discord command handlers + post results to Discord (notify API).
 * 保存済み GitHub Secrets をそのまま使う:
 *   OPS_API_SECRET（Cardinal cron と同じ）
 *   任意 DISCORD_APPLICATION_ID + DISCORD_BOT_TOKEN（登録用）
 *
 * Usage:
 *   node scripts/run-qo-discord-commands.mjs
 *   OPS_API_SECRET=... node scripts/run-qo-discord-commands.mjs
 */

import { executeDiscordQoCommand } from '../functions/api/_discord-ops.js';

const BASE = String(process.env.BASE_URL || 'https://mobile-order-system.pages.dev').replace(/\/$/, '');
const OPS = String(
  process.env.OPS_API_SECRET || process.env.CARDINAL_API_SECRET || '',
).trim();

function mkInteraction(group, sub, options = []) {
  return {
    data: {
      name: 'qo',
      options: [{
        type: 2,
        name: group,
        options: [{
          type: 1,
          name: sub,
          options: options.map((o) => ({ type: 3, name: o.name, value: o.value })),
        }],
      }],
    },
    member: { user: { id: 'cloud-agent-test', username: 'CloudAgent' } },
  };
}

async function notifyDiscord(fields) {
  const res = await fetch(`${BASE}/api/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'QuickOrder Ops',
      embeds: [{
        title: 'Discord 運用コマンド（テスト実行）',
        color: 0x5865f2,
        fields,
        timestamp: new Date().toISOString(),
      }],
    }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json.ok, status: res.status, json };
}

async function opsFetch(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json', 'x-ops-secret': OPS };
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

async function registerCommands() {
  const appId = process.env.DISCORD_APPLICATION_ID || process.env.DISCORD_APP_ID;
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID || '';
  if (!appId || !token) {
    return { skipped: true, reason: 'no DISCORD_APPLICATION_ID / DISCORD_BOT_TOKEN' };
  }
  const { execSync } = await import('node:child_process');
  try {
    const out = execSync('node scripts/register-discord-commands.mjs', {
      encoding: 'utf8',
      env: { ...process.env, DISCORD_APPLICATION_ID: appId, DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guildId },
    });
    return { ok: true, out: out.slice(0, 500) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), out: e.stdout?.slice(0, 300) };
  }
}

async function runHandler(label, interaction) {
  const result = await executeDiscordQoCommand(interaction, null, {
    PUBLIC_BASE_URL: BASE,
  });
  const content = String(result.content || '—');
  const n = await notifyDiscord([
    { name: 'コマンド', value: label, inline: true },
    { name: '経路', value: 'executeDiscordQoCommand', inline: true },
    { name: '結果', value: content.slice(0, 1000), inline: false },
  ]);
  return { content, notify: n };
}

const COMMANDS = [
  { label: '/qo debug status', interaction: mkInteraction('debug', 'status') },
  { label: '/qo maint status', interaction: mkInteraction('maint', 'status') },
  {
    label: '/qo debug request',
    interaction: mkInteraction('debug', 'request', [
      { name: 'feature', value: 'discord-cmd-test' },
      { name: 'cause', value: 'slash コマンドテスト（Agent 起動は CURSOR_API_KEY 依存）' },
    ]),
  },
];

async function main() {
  const report = { base: BASE, steps: [] };

  const reg = await registerCommands();
  report.steps.push({ step: 'register_commands', ...reg });
  if (!reg.skipped) {
    await notifyDiscord([
      { name: 'コマンド', value: 'register-discord-commands.mjs', inline: true },
      { name: '結果', value: reg.ok ? 'OK' : String(reg.error || reg.out || 'fail').slice(0, 900), inline: false },
    ]);
  }

  for (const cmd of COMMANDS) {
    const r = await runHandler(cmd.label, cmd.interaction);
    report.steps.push({ step: cmd.label, ok: r.notify.ok, preview: r.content.split('\n').slice(0, 3).join(' | ') });
  }

  if (OPS) {
    const list = await opsFetch('/api/system-report');
    const openPreview = list.json?.events?.slice(0, 5).map((e) =>
      `• ${e.id} ${e.feature}: ${String(e.cause).slice(0, 60)}`,
    ).join('\n') || '（なし）';
    report.steps.push({ step: 'GET /api/system-report (ops)', status: list.status, open: list.json?.events?.length });
    await notifyDiscord([
      { name: 'コマンド', value: '/qo debug status（本番 ledger）', inline: true },
      { name: '結果', value: `open ${list.json?.events?.length ?? '?'} / total ${list.json?.total ?? '?'}\n${openPreview}`.slice(0, 1000), inline: false },
    ]);

    if (process.env.DISMISS_INCIDENT_ID) {
      const dismissId = process.env.DISMISS_INCIDENT_ID;
      const dismiss = await opsFetch('/api/system-report', {
        method: 'POST',
        body: { action: 'dismiss', id: dismissId },
      });
      report.steps.push({ step: 'POST dismiss', id: dismissId, status: dismiss.status, json: dismiss.json });
      await notifyDiscord([
        { name: 'コマンド', value: `/qo debug dismiss (${dismissId})`, inline: true },
        { name: '結果', value: JSON.stringify(dismiss.json).slice(0, 900), inline: false },
      ]);
    }
  } else {
    report.steps.push({
      step: 'ops_api',
      skipped: true,
      hint: 'OPS_API_SECRET を渡すと本番 ledger の list/dismiss も実行します',
    });
  }

  console.log(JSON.stringify(report, null, 2));
  const failed = report.steps.some((s) => s.ok === false && !s.skipped);
  if (failed) {
    console.error('QO_COMMAND_TEST_PARTIAL_FAIL');
    process.exit(1);
  }
  console.error('QO_COMMAND_TEST_OK');
}

main().catch((e) => {
  console.error('QO_COMMAND_TEST_CRASH', e);
  process.exit(1);
});
