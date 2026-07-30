/**
 * Delete load-test shops from production (or local) Ops / Firestore.
 * Works against currently deployed code (uses listShops + deleteShop).
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
page.setDefaultTimeout(120000);
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
  const { collection, getDocs, deleteDoc, query, where } =
    await import('https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js');

  const isLoadTestShop = (shop) => {
    if (!shop) return false;
    const id = String(shop.id || '');
    if (!id || id === 'default') return false;
    if (shop.loadTest === true) return true;
    return id.startsWith('load-');
  };

  const shops = await shopMod.listShops();
  const targets = shops.filter(isLoadTestShop);
  const shopIds = targets.map((s) => s.id);
  const out = {
    found: shopIds.length,
    shopsDeleted: 0,
    shopsFailed: 0,
    ordersDeleted: 0,
    requestsDeleted: 0,
    shopIds: [],
    errors: [],
  };

  async function wipeByShopId(colName) {
    let n = 0;
    for (const shopId of shopIds) {
      try {
        const snap = await getDocs(query(collection(db, colName), where('shopId', '==', shopId)));
        for (const d of snap.docs) {
          try {
            await deleteDoc(d.ref);
            n++;
          } catch (e) {
            out.errors.push(`${colName}/${d.id}: ${e?.message || e}`);
          }
        }
      } catch (e) {
        out.errors.push(`${colName}@${shopId}: ${e?.message || e}`);
      }
    }
    return n;
  }

  async function wipeLoadTestFlag(colName) {
    let n = 0;
    try {
      const snap = await getDocs(query(collection(db, colName), where('loadTest', '==', true)));
      for (const d of snap.docs) {
        try {
          await deleteDoc(d.ref);
          n++;
        } catch (e) {
          out.errors.push(`${colName}/${d.id}: ${e?.message || e}`);
        }
      }
    } catch (e) {
      out.errors.push(`${colName} loadTest query: ${e?.message || e}`);
    }
    return n;
  }

  if (shopIds.length) {
    out.ordersDeleted += await wipeLoadTestFlag('orders');
    out.ordersDeleted += await wipeByShopId('orders');
    out.requestsDeleted += await wipeLoadTestFlag('serviceRequests');
    out.requestsDeleted += await wipeByShopId('serviceRequests');
  }

  for (let i = 0; i < targets.length; i++) {
    const s = targets[i];
    try {
      await shopMod.deleteShop(s.id);
      out.shopsDeleted++;
      out.shopIds.push(s.id);
    } catch (e) {
      out.shopsFailed++;
      out.errors.push(`shop ${s.id}: ${e?.message || e}`);
    }
    await sleep(100);
  }

  // Verify remaining
  const after = (await shopMod.listShops()).filter(isLoadTestShop).map((s) => s.id);
  out.remaining = after;
  return out;
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
process.exit(result.remaining?.length ? 1 : 0);
