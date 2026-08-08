/**
 * Client-side system watchdog: JS errors, unhandled rejections, API 5xx, slow/hung fetch.
 * Reports to /api/system-report → Discord (server dedupe).
 */

const REPORT_PATH = '/api/system-report';
const CLIENT_DEDUPE_MS = 90 * 1000;
const FETCH_TIMEOUT_MS = 45 * 1000;

let ctx = { feature: 'app', shopId: '' };
let started = false;
const recentKeys = new Map();

function clientDedupeKey(payload) {
  return `${payload.feature}::${payload.kind}::${String(payload.cause || '').slice(0, 80)}`;
}

function shouldSendClient(key) {
  const now = Date.now();
  const prev = recentKeys.get(key) || 0;
  if (now - prev < CLIENT_DEDUPE_MS) return false;
  recentKeys.set(key, now);
  if (recentKeys.size > 200) {
    for (const [k, t] of recentKeys) {
      if (now - t > CLIENT_DEDUPE_MS * 2) recentKeys.delete(k);
    }
  }
  return true;
}

function sameOriginApi(url) {
  try {
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin) return false;
    return u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

export function reportSystemIncident(payload = {}) {
  const body = {
    feature: payload.feature || ctx.feature,
    cause: String(payload.cause || payload.message || 'unknown').slice(0, 500),
    kind: payload.kind || 'client_error',
    source: payload.source || 'watchdog',
    shopId: payload.shopId || ctx.shopId || '',
    url: payload.url || (typeof location !== 'undefined' ? location.href : ''),
    severity: payload.severity,
    meta: payload.meta,
  };
  const key = clientDedupeKey(body);
  if (!shouldSendClient(key)) return;

  const json = JSON.stringify(body);
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([json], { type: 'application/json' });
      navigator.sendBeacon(REPORT_PATH, blob);
      return;
    }
  } catch (_) {}
  fetch(REPORT_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: json,
    keepalive: true,
  }).catch(() => {});
}

function onWindowError(event) {
  const msg = event?.message || 'Script error';
  const loc = event?.filename ? `${event.filename}:${event.lineno || 0}` : '';
  reportSystemIncident({
    kind: 'js_error',
    cause: loc ? `${msg} (${loc})` : msg,
    severity: 'warning',
    meta: { col: event?.colno },
  });
}

function onUnhandledRejection(event) {
  const reason = event?.reason;
  const cause = reason instanceof Error
    ? `${reason.message}${reason.stack ? `\n${reason.stack.slice(0, 400)}` : ''}`
    : String(reason || 'unhandled rejection');
  reportSystemIncident({
    kind: 'unhandled_rejection',
    cause: cause.slice(0, 500),
    severity: 'warning',
  });
}

function patchFetch() {
  if (typeof window === 'undefined' || window.__mosWatchdogFetch) return;
  window.__mosWatchdogFetch = true;
  const orig = window.fetch.bind(window);
  window.fetch = async function mosWatchdogFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const trackApi = url && sameOriginApi(url);
    const started = Date.now();
    let timer;
    const timeoutPromise = trackApi
      ? new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`fetch timeout ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS);
        })
      : null;

    try {
      const res = timeoutPromise
        ? await Promise.race([orig(input, init), timeoutPromise])
        : await orig(input, init);
      if (trackApi && res.status >= 500) {
        reportSystemIncident({
          kind: 'http_5xx',
          cause: `HTTP ${res.status} ${url}`,
          severity: 'critical',
        });
      }
      return res;
    } catch (e) {
      if (trackApi) {
        const ms = Date.now() - started;
        const errMsg = String(e?.message || e);
        const kind = errMsg.includes('timeout') ? 'fetch_timeout' : 'fetch_fail';
        reportSystemIncident({
          kind,
          cause: `${errMsg} — ${url} (${ms}ms)`,
          severity: kind === 'fetch_timeout' ? 'warning' : 'critical',
        });
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * @param {{ feature?: string, shopId?: string }} options
 */
export function startSystemWatchdog(options = {}) {
  if (started) {
    if (options.feature) ctx.feature = options.feature;
    if (options.shopId) ctx.shopId = options.shopId;
    return;
  }
  started = true;
  ctx.feature = options.feature || ctx.feature;
  ctx.shopId = options.shopId || ctx.shopId;

  if (typeof window === 'undefined') return;

  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  patchFetch();

  let lastActivity = Date.now();
  const bump = () => { lastActivity = Date.now(); };
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => {
    window.addEventListener(ev, bump, { passive: true });
  });

  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const idleMs = Date.now() - lastActivity;
    if (idleMs < 120 * 1000) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    fetch('/api/maintenance', { method: 'GET', signal: ctrl.signal })
      .then((res) => {
        clearTimeout(t);
        if (!res.ok && res.status >= 500) {
          reportSystemIncident({
            kind: 'stall_probe',
            cause: `idle ${Math.round(idleMs / 1000)}s then maintenance HTTP ${res.status}`,
            severity: 'warning',
          });
        }
      })
      .catch((e) => {
        clearTimeout(t);
        reportSystemIncident({
          kind: 'stall_probe',
          cause: `idle ${Math.round(idleMs / 1000)}s — API無反応: ${String(e?.message || e)}`,
          severity: 'warning',
        });
        lastActivity = Date.now();
      });
  }, 60 * 1000);
}
