#!/usr/bin/env node
/**
 * Register global /qo slash commands with Discord.
 *
 * Env:
 *   DISCORD_APPLICATION_ID
 *   DISCORD_BOT_TOKEN
 * Optional:
 *   DISCORD_GUILD_ID — guild commands (instant) vs global (~1h)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commands = JSON.parse(fs.readFileSync(path.join(__dirname, 'discord-qo-commands.json'), 'utf8'));

const appId = process.env.DISCORD_APPLICATION_ID || process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID || '';

if (!appId || !token) {
  console.error('Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN');
  process.exit(1);
}

const base = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

const res = await fetch(base, {
  method: 'PUT',
  headers: {
    'content-type': 'application/json',
    authorization: `Bot ${token}`,
  },
  body: JSON.stringify(commands),
});

const text = await res.text();
if (!res.ok) {
  console.error('Register failed', res.status, text);
  process.exit(1);
}

console.log('OK — registered commands:', text.slice(0, 800));
console.log('Interactions Endpoint URL: https://mobile-order-system.pages.dev/api/discord');
