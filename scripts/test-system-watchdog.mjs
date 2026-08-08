#!/usr/bin/env node
/**
 * Smoke test for system-report + watchdog client module load.
 * Usage: BASE_URL=http://127.0.0.1:5000 node scripts/test-system-watchdog.mjs
 */

const BASE = String(process.env.BASE_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

const failures = [];

async function main() {
  const g = await get('/api/system-report');
  if (g.json?.service !== 'quickorder-system-report' || g.json?.ok !== true) {
    failures.push('GET system-report service hint');
  }

  const r1 = await post('/api/system-report', {
    feature: 'test-script',
    cause: `watchdog script ${Date.now()}`,
    kind: 'test',
  });
  if (!r1.json?.ok || !r1.json?.id) failures.push('POST report');

  const r2 = await post('/api/system-report', {
    feature: 'test-script',
    cause: r1.json?.id ? 'dedupe-check-placeholder' : 'x',
    kind: 'test',
  });

  const jsRes = await fetch(`${BASE}/js/system-watchdog.js`);
  const jsText = await jsRes.text();
  if (jsRes.status !== 200 || !jsText.includes('startSystemWatchdog')) {
    failures.push('system-watchdog.js asset');
  }

  const listGate = await post('/api/system-report', { action: 'list' });
  if (listGate.json?.ok !== false) failures.push('list should require ops secret');

  const report = {
    ok: failures.length === 0,
    base: BASE,
    failures,
    sampleReport: r1.json,
    listGate: listGate.json?.error,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) {
    console.error('WATCHDOG_TEST_FAILED', failures.join(' | '));
    process.exit(1);
  }
  console.error('WATCHDOG_TEST_OK');
}

main().catch((e) => {
  console.error('WATCHDOG_TEST_CRASH', e);
  process.exit(1);
});
