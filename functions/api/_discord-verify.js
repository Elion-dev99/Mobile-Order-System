/**
 * Discord interaction request signature (Ed25519).
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding#security-and-authorization
 */

function hexToUint8Array(hex) {
  const h = String(hex || '').trim();
  if (!h || h.length % 2 !== 0) return new Uint8Array(0);
  return new Uint8Array(h.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
}

export async function verifyDiscordInteraction(request, rawBody, publicKeyHex) {
  const signature = request.headers.get('X-Signature-Ed25519')
    || request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp')
    || request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp || !publicKeyHex) return false;

  const ts = new TextEncoder().encode(String(timestamp));
  const body = new TextEncoder().encode(String(rawBody || ''));
  const message = new Uint8Array(ts.length + body.length);
  message.set(ts, 0);
  message.set(body, ts.length);

  const sig = hexToUint8Array(signature);
  const keyBytes = hexToUint8Array(publicKeyHex);
  if (sig.length < 64 || keyBytes.length < 32) return false;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'Ed25519', namedCurve: 'Ed25519' },
      false,
      ['verify'],
    );
    return crypto.subtle.verify('Ed25519', key, sig, message);
  } catch {
    return false;
  }
}

export function parseAllowedDiscordUsers(env) {
  const raw = String(env?.DISCORD_OPS_USER_IDS || env?.DISCORD_ALLOWED_USER_IDS || '').trim();
  if (!raw) return [];
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

export function discordInteractionUserId(interaction = {}) {
  return interaction.member?.user?.id
    || interaction.user?.id
    || interaction.member?.user?.id
    || '';
}

export function isAllowedDiscordOperator(interaction, env) {
  const allow = parseAllowedDiscordUsers(env);
  if (!allow.length) return false;
  const uid = discordInteractionUserId(interaction);
  return !!uid && allow.includes(uid);
}

/** Discord API response envelope */
export function discordReply(content, { ephemeral = false, embeds = null } = {}) {
  const data = { content: String(content || '').slice(0, 2000) };
  if (embeds?.length) data.embeds = embeds.slice(0, 10);
  if (ephemeral) data.flags = 64;
  return new Response(JSON.stringify({ type: 4, data }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function discordPong() {
  return new Response(JSON.stringify({ type: 1 }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
