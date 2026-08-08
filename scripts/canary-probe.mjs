#!/usr/bin/env node
/**
 * Production canary probe — exits 1 if guest/ops display or APIs look broken.
 * Used after deploy to decide immediate rollback to pre-merge SHA.
 *
 * Usage:
 *   node scripts/canary-probe.mjs
 *   BASE_URL=https://mobile-order-system.pages.dev node scripts/canary-probe.mjs
 */

const BASE = String(process.env.BASE_URL || 'https://mobile-order-system.pages.dev').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.CANARY_TIMEOUT_MS || 20000);

const PATHS = [
  { path: '/', type: 'html', mustInclude: ['script', 'QuickOrder'] },
  { path: '/ops.html', type: 'html', mustInclude: ['Cardinal', 'ops.js'] },
  { path: '/store.html', type: 'html', mustInclude: ['store.js'] },
  { path: '/status.html', type: 'html', mustInclude: ['status'] },
  { path: '/css/style.css', type: 'css', minBytes: 500 },
  { path: '/css/guest.css', type: 'css', minBytes: 200 },
  { path: '/js/app.js', type: 'js', minBytes: 500 },
  { path: '/js/ops.js', type: 'js', minBytes: 500 },
  { path: '/js/store.js', type: 'js', minBytes: 500 },
  { path: '/api/cardinal', type: 'json' },
  { path: '/api/maintenance', type: 'json' },
  { path: '/api/notify', type: 'json' },
  { path: '/api/stripe', type: 'json', mustJsonOk: true },
  { path: '/api/system-report', type: 'json', mustJsonOk: true },
  { path: '/api/aws', type: 'json', mustJsonOk: true },
];

const ERROR_SNIPPETS = [
  'Internal Server Error',
  'Error 1101',
  'Error 502',
  'Error 503',
  'Worker threw exception',
  'This page is not working',
  'Cannot GET',
  '404 Not Found',
  'ReferenceError',
  'SyntaxError',
  'Failed to load module',
];

async function fetchText(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      redirect: 'follow',
      headers: { 'user-agent': 'QuickOrder-Canary/1.0', accept: '*/*' },
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok || res.status < 500, status: res.status, text, bytes: text.length };
  } finally {
    clearTimeout(t);
  }
}

function findBadSnippet(text) {
  const lower = text.slice(0, 8000);
  for (const s of ERROR_SNIPPETS) {
    if (lower.includes(s)) return s;
  }
  return null;
}

async function main() {
  const failures = [];
  const results = [];

  for (const item of PATHS) {
    let r;
    try {
      r = await fetchText(item.path);
    } catch (e) {
      failures.push(`${item.path}: network ${e?.message || e}`);
      results.push({ path: item.path, ok: false, error: String(e?.message || e) });
      continue;
    }

    const row = { path: item.path, status: r.status, bytes: r.bytes, ok: true };
    if (!r.ok) {
      row.ok = false;
      failures.push(`${item.path}: HTTP ${r.status}`);
    }

    const bad = findBadSnippet(r.text);
    if (bad) {
      row.ok = false;
      failures.push(`${item.path}: error snippet "${bad}"`);
    }

    if (item.type === 'html' && Array.isArray(item.mustInclude)) {
      for (const needle of item.mustInclude) {
        if (!r.text.includes(needle)) {
          row.ok = false;
          failures.push(`${item.path}: missing "${needle}" (display/markup regression?)`);
        }
      }
    }

    if ((item.type === 'css' || item.type === 'js') && item.minBytes) {
      if (r.bytes < item.minBytes) {
        row.ok = false;
        failures.push(`${item.path}: too small (${r.bytes}b < ${item.minBytes}b)`);
      }
    }

    if (item.type === 'json') {
      try {
        const j = JSON.parse(r.text);
        if (j && j.ok === false && item.path === '/api/cardinal') {
          // status endpoint should be ok:true
          row.ok = false;
          failures.push(`${item.path}: json ok=false`);
        }
        if (item.mustJsonOk && j?.ok !== true) {
          row.ok = false;
          failures.push(`${item.path}: expected ok:true`);
        }
        row.jsonOk = j?.ok !== false;
      } catch {
        row.ok = false;
        failures.push(`${item.path}: invalid JSON`);
      }
    }

    results.push(row);
  }

  const report = {
    ok: failures.length === 0,
    base: BASE,
    at: new Date().toISOString(),
    failures,
    results,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error('CANARY_FAILED', failures.join(' | '));
    process.exit(1);
  }
  console.error('CANARY_OK');
}

main().catch((e) => {
  console.error('CANARY_CRASH', e);
  process.exit(1);
});
