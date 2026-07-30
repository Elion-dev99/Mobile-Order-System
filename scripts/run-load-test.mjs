/**
 * Headless load test against production Ops.
 * Usage:
 *   DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/...' node scripts/run-load-test.mjs
 * Optional:
 *   SHOP_COUNT=25 ORDERS_PER_SHOP=10 BASE_URL=https://mobile-order-system.pages.dev
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const BASE = process.env.BASE_URL || 'https://mobile-order-system.pages.dev';
const SHOP_COUNT = Number(process.env.SHOP_COUNT || 25);
const ORDERS = Number(process.env.ORDERS_PER_SHOP || 10);
const AUTO_CLEANUP = process.env.AUTO_CLEANUP !== '0';
let webhook = (process.env.DISCORD_WEBHOOK_URL || '').trim();
if (!webhook) {
  for (const p of ['.discord-webhook', '/workspace/.discord-webhook', '/tmp/discord-webhook.txt']) {
    try {
      if (fs.existsSync(p)) {
        webhook = fs.readFileSync(p, 'utf8').trim();
        if (webhook) break;
      }
    } catch (_) {}
  }
}

const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
console.log(JSON.stringify({ BASE, SHOP_COUNT, ORDERS, AUTO_CLEANUP, hasWebhook: !!webhook }, null, 2));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
page.setDefaultTimeout(120000);
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) console.log('BROWSER', m.type(), m.text());
});

await page.goto(`${BASE}/ops.html`, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForSelector('input[type=password]', { timeout: 15000 });
await page.type('input[type=password]', process.env.OPS_PASSWORD || 'cursor2026');
await Promise.all([
  page.click('button[type=submit]'),
  page.waitForSelector('#opsApp:not([hidden]), [data-ops-tab="lab"]', { timeout: 20000 }).catch(() => null),
]);
await new Promise((r) => setTimeout(r, 1500));

// Go to notify tab, save webhook if provided
await page.evaluate((wh) => {
  document.querySelector('[data-ops-tab="notify"]')?.click();
}, webhook);
await new Promise((r) => setTimeout(r, 600));
if (webhook) {
  await page.evaluate((wh) => {
    const input = document.getElementById('opsNotifyWebhook');
    if (input) input.value = wh;
    const en = document.getElementById('opsNotifyEnabled');
    if (en) en.checked = true;
  }, webhook);
  await page.click('#opsNotifyForm button[type=submit]').catch(() => null);
  await new Promise((r) => setTimeout(r, 800));
  // Direct localStorage + settings save via module
  await page.evaluate(async (wh) => {
    localStorage.setItem('mos_discord_webhook', wh);
    localStorage.setItem('mos_discord_notify_enabled', '1');
    try {
      const mod = await import('/js/notify.js');
      await mod.saveNotifySettings({ webhook: wh, enabled: true, setupDone: true });
    } catch (_) {}
  }, webhook);
}

// Lab tab + run load test
await page.click('[data-ops-tab="lab"]');
await new Promise((r) => setTimeout(r, 500));
await page.evaluate((shopCount, orders, wh, autoCleanup) => {
  const a = document.getElementById('loadTestShops');
  const b = document.getElementById('loadTestOrders');
  const c = document.getElementById('loadTestWebhook');
  const d = document.getElementById('loadTestAutoCleanup');
  if (a) a.value = String(shopCount);
  if (b) b.value = String(orders);
  if (c && wh) c.value = wh;
  if (d) d.checked = !!autoCleanup;
}, SHOP_COUNT, ORDERS, webhook, AUTO_CLEANUP);

const runBtn = await page.$('#opsLoadTestRun');
if (!runBtn) {
  console.error('Load test UI not found — is latest deploy live?');
  await browser.close();
  process.exit(2);
}

await runBtn.click();
console.log('Load test started...');

// Poll until status contains 完了 or 失敗 / timeout 15min
const started = Date.now();
let last = '';
while (Date.now() - started < 15 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 3000));
  const info = await page.evaluate(() => ({
    status: document.getElementById('opsLoadTestStatus')?.textContent || '',
    log: document.getElementById('opsLoadTestLog')?.textContent || '',
    disabled: document.getElementById('opsLoadTestRun')?.disabled,
  }));
  if (info.status && info.status !== last) {
    console.log('STATUS', info.status);
    last = info.status;
  }
  if (!info.disabled && /完了|中断|失敗|エラー/.test(info.status)) {
    console.log('--- LOG TAIL ---');
    console.log(info.log.split('\n').slice(-40).join('\n'));
    console.log('FINAL', info.status);
    await browser.close();
    process.exit(/完了/.test(info.status) ? 0 : 1);
  }
}
console.error('Timeout waiting for load test');
await browser.close();
process.exit(1);
