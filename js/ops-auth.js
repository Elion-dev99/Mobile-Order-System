/**
 * Ops console gate (client-side). Passwords are stored as SHA-256 only.
 * This is NOT a substitute for Cloudflare Access / Firebase Auth —
 * privileged APIs additionally require OPS_API_SECRET.
 *
 * Default passwords (do not display in UI):
 *   Cursor → cursor2026
 *   Owner  → owner2026
 */
const OPS_SESSION = 'mos_ops_role';

/** Precomputed SHA-256 hex digests (plaintext never shipped to the page). */
const PASSWORD_HASHES = {
  cursor: new Set([
    '0cf082924d364a8822a8b7e12992b3ef4077f597df842a368ada462c7f598821', // cursor2026
    'c9580f7705cacb64e988ca0593eb797adf5936162b02a073a4db21813621c70d', // cursor-ops-3dc6
  ]),
  owner: new Set([
    'e37838828f7335c08e5249022d9537a4d8c1f350be1b84af32f8296647bd28b9', // owner2026
    '35770dc5d9bf43bc85c7767fa25e6daa8ddd9b32d5e6cb5ffe407cc91323f4cf', // yukiyo-ops-2026
  ]),
};

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizePassword(password) {
  return String(password || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u3000/g, ' ')
    .trim();
}

export async function verifyOpsPassword(password) {
  const raw = normalizePassword(password);
  if (!raw) return { ok: false, role: null };

  try {
    const h = await sha256(raw);
    if (PASSWORD_HASHES.cursor.has(h)) return { ok: true, role: 'cursor' };
    if (PASSWORD_HASHES.owner.has(h)) return { ok: true, role: 'owner' };

    const custom = JSON.parse(localStorage.getItem('mos_ops_custom_hashes') || '{}');
    if (custom.cursor && h === custom.cursor) return { ok: true, role: 'cursor' };
    if (custom.owner && h === custom.owner) return { ok: true, role: 'owner' };
  } catch (e) {
    console.warn('verifyOpsPassword failed', e);
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
    // Drop legacy persistent role (was bypassable via localStorage)
    localStorage.removeItem('mos_ops_role_local');
  } catch (_) {}
}

export function clearOpsAuth() {
  setOpsRole('');
}

export async function setCustomOpsPassword(role, newPassword) {
  if (role !== 'cursor' && role !== 'owner') throw new Error('invalid role');
  const raw = normalizePassword(newPassword);
  if (raw.length < 8) throw new Error('8文字以上にしてください');
  const h = await sha256(raw);
  const custom = JSON.parse(localStorage.getItem('mos_ops_custom_hashes') || '{}');
  custom[role] = h;
  localStorage.setItem('mos_ops_custom_hashes', JSON.stringify(custom));
}

export const OPS_PASSWORD_HINTS = {
  cursor: 'Cursor用パスワード',
  owner: 'Owner用パスワード',
};
