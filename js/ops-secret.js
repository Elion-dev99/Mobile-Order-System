/**
 * Browser-side Ops API secret (session-scoped).
 * Must match Cloudflare env OPS_API_SECRET for privileged calls.
 */

const KEY = 'mos_ops_api_secret';

export function getOpsApiSecret() {
  try {
    return sessionStorage.getItem(KEY)
      || localStorage.getItem(KEY)
      || '';
  } catch {
    return '';
  }
}

export function setOpsApiSecret(secret, { persist = false } = {}) {
  const v = String(secret || '').trim();
  try {
    if (!v) {
      sessionStorage.removeItem(KEY);
      localStorage.removeItem(KEY);
      return;
    }
    sessionStorage.setItem(KEY, v);
    if (persist) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch (_) {}
}

export function clearOpsApiSecret() {
  setOpsApiSecret('');
}

export function opsAuthHeaders(extra = {}) {
  const secret = getOpsApiSecret();
  const headers = { 'content-type': 'application/json', ...extra };
  if (secret) headers['x-ops-secret'] = secret;
  return headers;
}
