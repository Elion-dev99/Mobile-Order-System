/**
 * Ops console passwords (client-side gate for internal tools).
 * Roles:
 *  - cursor: agent / engineering access
 *  - owner: 店舗オーナー本人
 *
 * いま有効なパスワード（コピペ推奨）:
 *   Cursor → cursor2026
 *   Owner  → owner2026
 *
 * 旧パスワードも当面受け付けます。
 */
const OPS_SESSION = 'mos_ops_role';

/** @type {Record<'cursor'|'owner', string[]>} */
const PLAIN_PASSWORDS = {
  cursor: ['cursor2026', 'cursor-ops-3dc6'],
  owner: ['owner2026', 'yukiyo-ops-2026'],
};

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

let liveHashes = null;

async function getLiveHashes() {
  if (liveHashes) return liveHashes;
  liveHashes = { cursor: new Set(), owner: new Set() };
  for (const role of /** @type {const} */ (['cursor', 'owner'])) {
    for (const pw of PLAIN_PASSWORDS[role]) {
      liveHashes[role].add(await sha256(pw));
    }
  }
  return liveHashes;
}

function normalizePassword(password) {
  return String(password || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width
    .replace(/\u3000/g, ' ')
    .trim();
}

export async function verifyOpsPassword(password) {
  const raw = normalizePassword(password);
  if (!raw) return { ok: false, role: null };

  // Fast path: plain compare (also helps when crypto.subtle is blocked)
  for (const role of /** @type {const} */ (['cursor', 'owner'])) {
    if (PLAIN_PASSWORDS[role].includes(raw)) return { ok: true, role };
  }

  try {
    const hashes = await getLiveHashes();
    const h = await sha256(raw);
    if (hashes.cursor.has(h)) return { ok: true, role: 'cursor' };
    if (hashes.owner.has(h)) return { ok: true, role: 'owner' };

    const custom = JSON.parse(localStorage.getItem('mos_ops_custom_hashes') || '{}');
    if (custom.cursor && h === custom.cursor) return { ok: true, role: 'cursor' };
    if (custom.owner && h === custom.owner) return { ok: true, role: 'owner' };
  } catch (e) {
    console.warn('verifyOpsPassword hash path failed', e);
  }

  return { ok: false, role: null };
}

export function getOpsRole() {
  try {
    return sessionStorage.getItem(OPS_SESSION) || '';
  } catch {
    return '';
  }
}

export function isOpsAuthed() {
  const role = getOpsRole();
  return role === 'cursor' || role === 'owner';
}

export function setOpsRole(role) {
  try {
    if (role) sessionStorage.setItem(OPS_SESSION, role);
    else sessionStorage.removeItem(OPS_SESSION);
  } catch (_) {}
}

export function clearOpsAuth() {
  setOpsRole('');
}

export async function setCustomOpsPassword(role, newPassword) {
  if (role !== 'cursor' && role !== 'owner') throw new Error('invalid role');
  const raw = normalizePassword(newPassword);
  if (raw.length < 4) throw new Error('4文字以上にしてください');
  const h = await sha256(raw);
  const custom = JSON.parse(localStorage.getItem('mos_ops_custom_hashes') || '{}');
  custom[role] = h;
  localStorage.setItem('mos_ops_custom_hashes', JSON.stringify(custom));
}

export const OPS_PASSWORD_HINTS = {
  cursor: 'Cursor用: cursor2026',
  owner: 'Owner用: owner2026',
};
