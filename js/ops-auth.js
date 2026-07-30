/**
 * Ops console passwords (client-side gate for internal tools).
 * Roles:
 *  - cursor: agent / engineering access
 *  - owner: 店舗オーナー本人
 *
 * Defaults (change after first login in ops settings):
 *   Cursor → cursor-ops-3dc6
 *   Owner  → yukiyo-ops-2026
 */
const OPS_SESSION = 'mos_ops_role';

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

let liveHashes = null;

async function getLiveHashes() {
  if (liveHashes) return liveHashes;
  liveHashes = {
    cursor: await sha256('cursor-ops-3dc6'),
    owner: await sha256('yukiyo-ops-2026'),
  };
  return liveHashes;
}

export async function verifyOpsPassword(password) {
  const hashes = await getLiveHashes();
  const h = await sha256(String(password || ''));
  if (h === hashes.cursor) return { ok: true, role: 'cursor' };
  if (h === hashes.owner) return { ok: true, role: 'owner' };

  try {
    const custom = JSON.parse(localStorage.getItem('mos_ops_custom_hashes') || '{}');
    if (custom.cursor && h === custom.cursor) return { ok: true, role: 'cursor' };
    if (custom.owner && h === custom.owner) return { ok: true, role: 'owner' };
  } catch (_) {}

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
  const h = await sha256(String(newPassword || ''));
  const custom = JSON.parse(localStorage.getItem('mos_ops_custom_hashes') || '{}');
  custom[role] = h;
  localStorage.setItem('mos_ops_custom_hashes', JSON.stringify(custom));
}

export const OPS_PASSWORD_HINTS = {
  cursor: 'Cursor用（開発）',
  owner: 'オーナー用（本人）',
};
