/**
 * Shared auth for privileged Ops / Cardinal / Incident endpoints.
 * Set Cloudflare secret: OPS_API_SECRET
 * Clients send: header X-Ops-Secret or Authorization: Bearer <secret>
 */

export function getOpsSecret(env) {
  return String(env?.OPS_API_SECRET || env?.CARDINAL_API_SECRET || '').trim();
}

export function extractOpsSecret(request, body = {}) {
  const header = request.headers.get('x-ops-secret')
    || request.headers.get('X-Ops-Secret')
    || '';
  if (header) return String(header).trim();
  const auth = request.headers.get('authorization') || request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  if (body && body.opsSecret) return String(body.opsSecret).trim();
  return '';
}

/** Constant-time-ish compare for equal-length strings */
export function secretsMatch(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * @returns {{ ok: true } | { ok: false, response: Response }}
 */
export function requireOpsSecret(request, env, body = {}, jsonFn) {
  const expected = getOpsSecret(env);
  if (!expected) {
    return {
      ok: false,
      response: jsonFn({
        ok: false,
        error: 'ops_secret_not_configured',
        hint: 'Cloudflare に OPS_API_SECRET を設定し、Ops「鍵」タブと同じ値をブラウザに保存してください。',
      }, 503),
    };
  }
  const provided = extractOpsSecret(request, body);
  if (!secretsMatch(provided, expected)) {
    return {
      ok: false,
      response: jsonFn({
        ok: false,
        error: 'unauthorized',
        hint: 'X-Ops-Secret ヘッダー（または Bearer）が必要です。',
      }, 401),
    };
  }
  return { ok: true };
}

/** Same-origin browser calls don't need ACAO; avoid `*` on privileged APIs. */
export function corsHeaders(request = null, extra = {}) {
  const origin = request?.headers?.get?.('Origin') || '';
  const allowed = /^https:\/\/([a-z0-9-]+\.)?mobile-order-system\.pages\.dev$/i.test(origin)
    || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  const headers = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-ops-secret, authorization',
    'access-control-max-age': '86400',
    ...extra,
  };
  if (allowed) headers['access-control-allow-origin'] = origin;
  return headers;
}
