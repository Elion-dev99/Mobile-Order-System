/**
 * Ops / agent load test: mass shops, orders, status advances, bill/staff,
 * and Discord notifications for every event class.
 */

import { upsertShop } from './shop.js';
import { db } from './firebase.js';
import {
  doc, setDoc, updateDoc, collection, addDoc
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import {
  notifyDiscord,
  notifyBillRequested,
  notifyLeadSubmitted,
  notifyLeadWon,
  notifyContractActivated,
  notifyPlanChanged,
  notifyMenuItemsAdded,
  testAllDiscordEvents,
  saveNotifySettings,
  loadNotifySettings,
  isLikelyDiscordWebhook,
  getDiscordWebhook,
} from './notify.js';
import {
  notifyOrderPlaced,
  notifyOrderStatus,
  notifyStaffCall,
  notifyLoadTestProgress,
} from './notify-orders.js';
import { notifySystemLoadNow } from './load-monitor.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLE_ITEMS = [
  { itemId: 'item_001', name: '特製チキンカレー', emoji: '🍛', price: 980, qty: 1 },
  { itemId: 'item_004', name: '濃厚醤油ラーメン', emoji: '🍜', price: 850, qty: 2 },
  { itemId: 'item_008', name: 'フライドポテト', emoji: '🍟', price: 380, qty: 1 },
  { itemId: 'item_016', name: '生ビール（中）', emoji: '🍺', price: 590, qty: 1 },
];

function makeOrder({ shopId, tableNumber, status = 'received', index = 0 }) {
  const picks = SAMPLE_ITEMS.slice(0, 1 + (index % SAMPLE_ITEMS.length));
  const items = picks.map((p, i) => ({
    ...p,
    id: `${Date.now()}-${index}-${i}`,
    qty: p.qty || 1,
    customizations: {},
    toggles: {},
    note: index % 5 === 0 ? '負荷テスト' : '',
  }));
  const subtotal = items.reduce((s, e) => s + e.price * e.qty, 0);
  const tax = Math.floor(subtotal * 0.1);
  const id = `LOAD-${shopId.slice(0, 8)}-${Date.now().toString(36)}-${index}`.toUpperCase();
  return {
    id,
    shopId,
    tableNumber: String(tableNumber),
    partySize: 2 + (index % 4),
    items,
    subtotal,
    tax,
    total: subtotal + tax,
    timestamp: Date.now() - index * 1000,
    status,
    loadTest: true,
  };
}

async function writeOrder(order) {
  try {
    await setDoc(doc(db, 'orders', order.id), order);
    return { ok: true, order };
  } catch (e) {
    // local fallback
    try {
      const key = 'mos_load_orders';
      const all = JSON.parse(localStorage.getItem(key) || '[]');
      all.unshift(order);
      localStorage.setItem(key, JSON.stringify(all.slice(0, 500)));
    } catch (_) {}
    return { ok: false, order, error: String(e?.message || e), local: true };
  }
}

async function setOrderStatus(orderId, status) {
  try {
    await updateDoc(doc(db, 'orders', orderId), { status });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function writeServiceRequest(payload) {
  try {
    const ref = await addDoc(collection(db, 'serviceRequests'), payload);
    return { ok: true, id: ref.id, ...payload };
  } catch (e) {
    const id = 'LOCAL-LOAD-' + Math.random().toString(36).slice(2, 8);
    try {
      const all = JSON.parse(localStorage.getItem('mos_local_requests') || '[]');
      all.unshift({ ...payload, id });
      localStorage.setItem('mos_local_requests', JSON.stringify(all.slice(0, 200)));
    } catch (_) {}
    return { ok: false, id, ...payload, local: true, error: String(e?.message || e) };
  }
}

/**
 * @param {object} opts
 * @param {number} [opts.shopCount=20]
 * @param {number} [opts.ordersPerShop=8]
 * @param {string} [opts.webhook]
 * @param {(msg: string, meta?: object) => void} [opts.onProgress]
 * @param {boolean} [opts.cleanup=false] — delete load-test shops from local list only
 */
export async function runFullLoadTest(opts = {}) {
  const shopCount = Math.max(1, Math.min(Number(opts.shopCount) || 20, 80));
  const ordersPerShop = Math.max(1, Math.min(Number(opts.ordersPerShop) || 8, 40));
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const started = Date.now();
  const stats = {
    shopsCreated: 0,
    shopsFailed: 0,
    ordersCreated: 0,
    ordersFsOk: 0,
    ordersLocal: 0,
    statusAdvanced: 0,
    bills: 0,
    staff: 0,
    discordOk: 0,
    discordFail: 0,
    discordSkipped: 0,
    errors: [],
  };

  await loadNotifySettings().catch(() => {});
  if (opts.webhook && isLikelyDiscordWebhook(opts.webhook)) {
    await saveNotifySettings({
      webhook: opts.webhook,
      enabled: true,
      setupDone: true,
      events: Object.fromEntries([
        'system_load', 'system_health', 'lead_new', 'lead_won', 'contract_activated',
        'plan_changed', 'shop_created', 'shop_deleted', 'item_added', 'item_removed',
        'bill_request', 'order_new', 'order_status', 'staff_call', 'load_test',
      ].map((id) => [id, true])),
    }).catch(() => {});
  }

  const webhook = getDiscordWebhook() || opts.webhook || '';
  const canDiscord = isLikelyDiscordWebhook(webhook);

  const trackDiscord = async (promise) => {
    try {
      const res = await promise;
      if (res?.ok) stats.discordOk++;
      else if (res?.skipped) stats.discordSkipped++;
      else {
        stats.discordFail++;
        if (res?.data?.error || res?.error) stats.errors.push(String(res.data?.error || res.error));
      }
      return res;
    } catch (e) {
      stats.discordFail++;
      stats.errors.push(String(e?.message || e));
      return { ok: false, error: String(e?.message || e) };
    }
  };

  onProgress('負荷テスト開始', { shopCount, ordersPerShop, canDiscord });
  await trackDiscord(notifyLoadTestProgress({
    phase: 'start',
    shopCount,
    ordersPerShop,
    note: canDiscord ? 'Discord通知ONで実行' : 'Webhook未設定 — 注文負荷のみ実行',
  }));

  // ——— 1) Mass create shops ———
  const shops = [];
  const stamp = Date.now().toString(36);
  for (let i = 0; i < shopCount; i++) {
    const id = `load-${stamp}-${String(i + 1).padStart(2, '0')}`;
    const name = `負荷テスト店 ${i + 1}`;
    onProgress(`店舗作成 ${i + 1}/${shopCount}`, { id });
    try {
      // notifyShopCreated fires inside upsertShop → Discord per shop
      const shop = await upsertShop(id, {
        name,
        subtitle: 'Load Test',
        tableCount: 20 + (i % 10),
        planId: ['lite', 'growth', 'business', 'chain'][i % 4],
        isOpen: true,
        accentColor: '#0D5C4D',
        loadTest: true,
        createdAt: Date.now(),
      });
      shops.push(shop);
      stats.shopsCreated++;
      stats.discordOk++; // expected notify from upsert (best-effort count)
    } catch (e) {
      stats.shopsFailed++;
      stats.errors.push(`shop ${id}: ${e?.message || e}`);
    }
    await sleep(canDiscord ? 450 : 50);

  await trackDiscord(notifyLoadTestProgress({
    phase: 'shops_done',
    created: stats.shopsCreated,
    failed: stats.shopsFailed,
  }));

  // ——— 2) Sample SaaS / menu / lead events ———
  onProgress('SaaS・メニュー・リード通知サンプル');
  const sampleShop = shops[0] || { id: 'default', name: 'default', planId: 'growth' };
  await trackDiscord(notifyMenuItemsAdded(sampleShop.id, sampleShop.name, [
    { emoji: '🧪', name: '負荷テストメニュー', price: 100 },
  ]));
  await sleep(400);
  await trackDiscord(notifyLeadSubmitted({
    shopName: '負荷テスト見込み店',
    email: 'load@example.com',
    phone: '090-0000-0000',
    planId: 'growth',
    tables: 30,
    stores: 1,
    message: '負荷テストからの問い合わせ',
  }));
  await sleep(400);
  await trackDiscord(notifyLeadWon({
    shopName: '負荷テスト成約店',
    email: 'won@example.com',
    planId: 'business',
    stores: 2,
  }));
  await sleep(400);
  await trackDiscord(notifyContractActivated({ ...sampleShop, stores: 1, billingCycle: 'monthly' }));
  await sleep(400);
  await trackDiscord(notifyPlanChanged({ ...sampleShop, stores: 1 }, 'lite', 'growth'));

  // ——— 3) Mass orders ———
  const allOrders = [];
  let orderIndex = 0;
  for (let s = 0; s < shops.length; s++) {
    const shop = shops[s];
    for (let o = 0; o < ordersPerShop; o++) {
      const table = 1 + ((o + s) % 12);
      const order = makeOrder({ shopId: shop.id, tableNumber: table, index: orderIndex++ });
      onProgress(`注文 ${stats.ordersCreated + 1}/${shopCount * ordersPerShop}`, { orderId: order.id });
      const wr = await writeOrder(order);
      allOrders.push(order);
      stats.ordersCreated++;
      if (wr.ok) stats.ordersFsOk++;
      else stats.ordersLocal++;

      // Discord sample: first order per shop + every 10th overall
      if (o === 0 || orderIndex % 10 === 0) {
        await trackDiscord(notifyOrderPlaced({
          shopId: shop.id,
          shopName: shop.name,
          order,
          force: true,
        }));
        await sleep(300);
      }
    }
  }

  await trackDiscord(notifyLoadTestProgress({
    phase: 'orders_done',
    total: stats.ordersCreated,
    firestoreOk: stats.ordersFsOk,
    localFallback: stats.ordersLocal,
  }));

  // ——— 4) Advance statuses: cooking → finishing → done ———
  onProgress('ステータス進行（調理→仕上げ→完了）');
  for (let i = 0; i < allOrders.length; i++) {
    const order = allOrders[i];
    const path = i % 3;
    // path 0: leave received, 1: cooking, 2: done pipeline
    if (path === 0) continue;
    const next = path === 1 ? 'cooking' : 'cooking';
    await setOrderStatus(order.id, next);
    order.status = next;
    stats.statusAdvanced++;
    if (path === 2) {
      await setOrderStatus(order.id, 'finishing');
      order.status = 'finishing';
      stats.statusAdvanced++;
      await setOrderStatus(order.id, 'done');
      order.status = 'done';
      stats.statusAdvanced++;
    }
    if (i % 12 === 0) {
      await trackDiscord(notifyOrderStatus({
        shopId: order.shopId,
        shopName: shops.find((x) => x.id === order.shopId)?.name,
        orderId: order.id,
        tableNumber: order.tableNumber,
        status: order.status,
        total: order.total,
        force: true,
      }));
      await sleep(280);
    }
    if (i % 20 === 0) onProgress(`ステータス ${i + 1}/${allOrders.length}`);
  }

  // ——— 5) Staff calls + bill requests ———
  onProgress('店員呼出・会計リクエスト');
  for (let s = 0; s < Math.min(shops.length, 15); s++) {
    const shop = shops[s];
    const table = String(1 + (s % 8));
    const staff = await writeServiceRequest({
      shopId: shop.id,
      tableNumber: table,
      type: 'staff',
      note: s % 3 === 0 ? 'お水ください' : s % 3 === 1 ? 'おしぼりください' : '店員呼出',
      status: 'open',
      timestamp: Date.now(),
      loadTest: true,
    });
    stats.staff++;
    await trackDiscord(notifyStaffCall({
      shopId: shop.id,
      shopName: shop.name,
      tableNumber: table,
      note: staff.note,
      requestId: staff.id,
      force: true,
    }));
    await sleep(280);

    const bill = await writeServiceRequest({
      shopId: shop.id,
      tableNumber: table,
      type: 'bill',
      note: '',
      status: 'open',
      timestamp: Date.now(),
      orderingLocked: true,
      loadTest: true,
    });
    stats.bills++;
    await trackDiscord(notifyBillRequested({
      shopId: shop.id,
      shopName: shop.name,
      tableNumber: table,
      requestId: bill.id,
    }));
    await sleep(280);
  }

  // ——— 6) System load snapshot ———
  onProgress('混雑負荷スナップショット');
  const openish = allOrders.filter((o) => o.status !== 'done');
  await trackDiscord(notifySystemLoadNow({
    shopId: shops[0]?.id || 'default',
    shopName: shops[0]?.name || 'load',
    orders: openish,
    requests: [],
  }));

  // ——— 7) All-event catalog test ———
  onProgress('全イベントカタログ送信');
  if (canDiscord) {
    const catalog = await testAllDiscordEvents({
      onProgress: ({ index, total, title }) => onProgress(`カタログ ${index}/${total} ${title}`),
    });
    stats.discordOk += catalog.sent || 0;
    stats.discordFail += catalog.failed || 0;
  }

  const elapsedMs = Date.now() - started;
  const summary = {
    ...stats,
    shopCount: shops.length,
    ordersPerShop,
    elapsedMs,
    elapsedSec: Math.round(elapsedMs / 1000),
    canDiscord,
    shopIds: shops.map((s) => s.id),
  };

  onProgress('完了', summary);
  await trackDiscord(notifyLoadTestProgress({
    phase: 'complete',
    ...summary,
    shopIds: summary.shopIds.slice(0, 20).join(', '),
  }));

  return summary;
}

export async function ensureWebhookReady(webhook) {
  await loadNotifySettings().catch(() => {});
  if (webhook && isLikelyDiscordWebhook(webhook)) {
    await saveNotifySettings({ webhook, enabled: true, setupDone: true });
  }
  const w = getDiscordWebhook();
  return { ok: isLikelyDiscordWebhook(w), webhook: w };
}
