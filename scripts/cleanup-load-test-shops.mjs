/**
 * Delete load-test shops / orders from production (or local) Ops / Firestore.
 *
 * Usage:
 *   node scripts/cleanup-load-test-shops.mjs
 * Optional:
 *   BASE_URL=https://mobile-order-system.pages.dev OPS_PASSWORD=cursor2026
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE_URL || 'https://mobile-order-system.pages.dev';
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
const password = process.env.OPS_PASSWORD || 'cursor2026';

console.log(JSON.stringify({ BASE, chrome }, null, 2));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
page.setDefaultTimeout(180000);
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) console.log('BROWSER', m.type(), m.text());
});

await page.goto(`${BASE}/ops.html`, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForSelector('input[type=password]', { timeout: 15000 });
await page.type('input[type=password]', password);
await Promise.all([
  page.click('button[type=submit]'),
  page.waitForSelector('#opsApp:not([hidden]), [data-ops-tab="shops"], [data-ops-tab="lab"]', { timeout: 20000 }).catch(() => null),
]);
await new Promise((r) => setTimeout(r, 1500));

const result = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shopMod = await import('/js/shop.js');
  const { db } = await import('/js/firebase.js');
  const { collection, getDocs, deleteDoc, doc, query, where } =
    await import('https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js');

  const isLoadTestShop = (shop) => {
    if (!shop) return false;
    const id = String(shop.id || '');
    if (!id || id === 'default') return false;
    if (shop.loadTest === true) return true;
    return id.startsWith('load-');
  };

  const out = {
    found: 0,
    shopsDeleted: 0,
    shopsFailed: 0,
    ordersDeleted: 0,
    requestsDeleted: 0,
    shopIds: [],
    remainingOrders: 0,
    shopsPermissionError: false,
    errors: [],
  };

  // 1) Always wipe load-test orders (this collection is readable/writable)
  try {
    const snap = await getDocs(collection(db, 'orders'));
    for (const d of snap.docs) {
      const data = d.data() || {};
      const isLoad = data.loadTest === true
        || String(d.id).startsWith('LOAD-')
        || String(data.shopId || '').startsWith('load-');
      if (!isLoad) continue;
      try {
        await deleteDoc(d.ref);
        out.ordersDeleted++;
      } catch (e) {
        out.errors.push(`orders/${d.id}: ${e?.message || e}`);
      }
    }
  } catch (e) {
    out.errors.push(`orders scan: ${e?.message || e}`);
  }

  // 2) Try shops list + delete
  let shops = [];
  try {
    shops = await shopMod.listShops();
  } catch (e) {
    out.errors.push(`listShops: ${e?.message || e}`);
  }
  let targets = shops.filter(isLoadTestShop);

  // Discover shop ids from any remaining load orders / known local
  const discovered = new Set(targets.map((s) => s.id));
  try {
    const snap = await getDocs(collection(db, 'orders'));
    for (const d of snap.docs) {
      const sid = d.data()?.shopId;
      if (sid && String(sid).startsWith('load-')) discovered.add(sid);
    }
  } catch (_) {}

  for (const id of discovered) {
    if (!targets.find((t) => t.id === id)) targets.push({ id, loadTest: true, name: id });
  }
  out.found = targets.length;

  // serviceRequests by loadTest flag
  try {
    const snap = await getDocs(query(collection(db, 'serviceRequests'), where('loadTest', '==', true)));
    for (const d of snap.docs) {
      try {
        await deleteDoc(d.ref);
        out.requestsDeleted++;
      } catch (e) {
        out.errors.push(`serviceRequests/${d.id}: ${e?.message || e}`);
      }
    }
  } catch (e) {
    const msg = String(e?.message || e);
    if (/permission/i.test(msg)) out.shopsPermissionError = true;
    out.errors.push(`serviceRequests: ${msg}`);
  }

  for (let i = 0; i < targets.length; i++) {
    const s = targets[i];
    try {
      await shopMod.deleteShop(s.id);
      out.shopsDeleted++;
      out.shopIds.push(s.id);
    } catch (e) {
      // Direct delete attempt
      try {
        await deleteDoc(doc(db, 'shops', s.id));
        out.shopsDeleted++;
        out.shopIds.push(s.id);
      } catch (e2) {
        out.shopsFailed++;
        const msg = String(e2?.message || e?.message || e2);
        if (/permission/i.test(msg)) out.shopsPermissionError = true;
        out.errors.push(`shop ${s.id}: ${msg}`);
      }
    }
    await sleep(80);
  }

  try {
    const after = await getDocs(collection(db, 'orders'));
    out.remainingOrders = after.docs.filter((d) => {
      const data = d.data() || {};
      return data.loadTest === true || String(d.id).startsWith('LOAD-') || String(data.shopId || '').startsWith('load-');
    }).length;
  } catch (_) {}

  out.remaining = [];
  try {
    out.remaining = (await shopMod.listShops()).filter(isLoadTestShop).map((s) => s.id);
  } catch (_) {}

  return out;
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
const ok = result.remainingOrders === 0 && (!result.remaining || result.remaining.length === 0 || result.shopsPermissionError);
process.exit(ok ? 0 : 1);
