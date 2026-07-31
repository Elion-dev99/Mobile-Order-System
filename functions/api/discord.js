/**
 * Discord Interactions — slash commands for ops (maintenance / stop / recover).
 *
 * Secrets (Cloudflare Pages):
 * - DISCORD_PUBLIC_KEY       — Application → General → Public Key
 * - DISCORD_OPS_USER_IDS     — comma-separated Discord user snowflakes allowed to run commands
 * - DISCORD_WEBHOOK_URL      — optional audit embeds (same as Cardinal)
 *
 * Register commands once: node scripts/register-discord-commands.mjs
 * Interactions URL: https://mobile-order-system.pages.dev/api/discord
 */

import {
  verifyDiscordInteraction,
  isAllowedDiscordOperator,
  discordPong,
  discordReply,
  parseAllowedDiscordUsers,
} from './_discord-verify.js';
import { executeDiscordQoCommand } from './_discord-ops.js';

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

async function auditDiscordOps(env, interaction, resultText) {
  const webhook = env?.DISCORD_WEBHOOK_URL || '';
  if (!isDiscordWebhook(webhook)) return;
  const user = interaction.member?.user || interaction.user || {};
  const endpoint = webhook.includes('?') ? `${webhook}&wait=true` : `${webhook}?wait=true`;
  await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'QuickOrder Discord Ops',
      embeds: [{
        title: 'Discord 運用コマンド',
        color: 0x5865f2,
        fields: [
          { name: 'ユーザー', value: `${user.username || '?'} (${user.id || '?'})`, inline: true },
          { name: 'コマンド', value: `\`${interaction.data?.name || '?'}\``, inline: true },
          { name: '結果', value: String(resultText || '—').slice(0, 1000), inline: false },
        ],
        timestamp: new Date().toISOString(),
      }],
    }),
  }).catch(() => {});
}

export async function onRequestGet(context) {
  const { env } = context;
  return new Response(JSON.stringify({
    ok: true,
    service: 'quickorder-discord-interactions',
    configured: {
      publicKey: !!env?.DISCORD_PUBLIC_KEY,
      allowedUsers: parseAllowedDiscordUsers(env).length,
      webhookAudit: isDiscordWebhook(env?.DISCORD_WEBHOOK_URL || ''),
    },
    commands: ['/qo maint start|stop|status', '/qo server stop|recover'],
    interactionsUrl: 'https://mobile-order-system.pages.dev/api/discord',
    docs: 'docs/discord-ops-commands.md',
    register: 'node scripts/register-discord-commands.mjs',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { request, env, caches } = context;
  const publicKey = String(env?.DISCORD_PUBLIC_KEY || '').trim();
  if (!publicKey) {
    return new Response(JSON.stringify({ error: 'discord_not_configured' }), { status: 503 });
  }

  const bodyText = await request.text();
  const valid = await verifyDiscordInteraction(request, bodyText, publicKey);
  if (!valid) {
    return new Response('invalid request signature', { status: 401 });
  }

  let interaction;
  try {
    interaction = JSON.parse(bodyText);
  } catch {
    return new Response('bad json', { status: 400 });
  }

  if (interaction.type === 1) {
    return discordPong();
  }

  if (interaction.type !== 2) {
    return discordReply('未対応の interaction タイプです', { ephemeral: true });
  }

  if (!isAllowedDiscordOperator(interaction, env)) {
    return discordReply(
      '権限がありません。Cloudflare の `DISCORD_OPS_USER_IDS` にあなたの Discord ユーザー ID を追加してください。',
      { ephemeral: true },
    );
  }

  try {
    const result = await executeDiscordQoCommand(interaction, caches, env);
    await auditDiscordOps(env, interaction, result.content);
    return discordReply(result.content, { ephemeral: false });
  } catch (e) {
    const msg = `コマンド失敗: ${String(e?.message || e).slice(0, 500)}`;
    await auditDiscordOps(env, interaction, msg);
    return discordReply(msg, { ephemeral: true });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}
