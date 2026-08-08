import { db } from './firebase.js';
import { MENU_DATA as DEFAULT_MENU } from './data.js';
import { DEFAULT_SHOP, PRODUCT } from './config.js';
import { resolveShopId, seedShopMeta, listSeedShops, DEFAULT_SHOP_ID, scopedKey } from './tenant.js';
import {
  doc, getDoc, setDoc, collection, getDocs, deleteDoc
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { notifyShopCreated, notifyShopDeleted, notifyContractActivated } from './notify.js';
import { getAccessState, canUseFeature } from './plans.js';
import { isMaintenanceMode, maintenanceMessage } from './maintenance.js';

let shopCache = { ...DEFAULT_SHOP, id: DEFAULT_SHOP_ID };
let menuCache = null;
let shopIdCache = null;

function cloneMenu() {
  return JSON.parse(JSON.stringify(DEFAULT_MENU));
}

function settingsRef(shopId = resolveShopId()) {
  return doc(db, 'shops', shopId);
}

function menuRef(shopId = resolveShopId()) {
  return doc(db, 'shopMenus', shopId);
}

/** Legacy single-tenant docs (pre multi-shop) */
function legacySettingsRef() {
  return doc(db, 'shop', 'settings');
}

function legacyMenuRef() {
  return doc(db, 'shop', 'menu');
}

export function getShopId() {
  return shopIdCache || resolveShopId();
}

export function getShop() {
  return shopCache;
}

export function getMenu() {
  return menuCache || cloneMenu();
}

function mergeShop(data = {}, shopId = resolveShopId()) {
  const seed = seedShopMeta(shopId) || {};
  const merged = {
    ...DEFAULT_SHOP,
    ...seed,
    ...data,
    id: shopId,
    slug: data.slug || seed.slug || shopId,
  };
  Object.keys(DEFAULT_SHOP).forEach((key) => {
    if (merged[key] === '' || merged[key] == null) {
      merged[key] = seed[key] ?? DEFAULT_SHOP[key];
    }
  });
  if (!merged.soldOut || typeof merged.soldOut !== 'object') merged.soldOut = {};
  if (!Array.isArray(merged.serviceRequests)) merged.serviceRequests = [];
  return merged;
}

export async function loadShop(shopId = resolveShopId()) {
  shopIdCache = shopId;

  // Local created shops / cached settings first (works without Firestore shops rules)
  try {
    const keyed = localStorage.getItem(`mos_shop_settings_${shopId}`);
    if (keyed) shopCache = mergeShop(JSON.parse(keyed), shopId);
    else {
      const local = readLocalShops().find(s => s.id === shopId);
      if (local) shopCache = mergeShop(local, shopId);
      else {
        const legacyKey = localStorage.getItem(scopedKey('mos_shop_settings'));
        if (legacyKey) {
          const parsed = JSON.parse(legacyKey);
          if (parsed?.id === shopId || (!parsed?.id && shopId === DEFAULT_SHOP_ID)) {
            shopCache = mergeShop(parsed, shopId);
          }
        }
      }
    }
  } catch (_) {}

  try {
    const snap = await withTimeout(getDoc(settingsRef(shopId)), 2500, 'loadShop timeout');
    if (snap.exists()) {
      shopCache = mergeShop(snap.data() || {}, shopId);
      return shopCache;
    }
    if (shopId === DEFAULT_SHOP_ID) {
      const legacy = await withTimeout(getDoc(legacySettingsRef()), 2500, 'legacy load timeout');
      if (legacy.exists()) {
        shopCache = mergeShop(legacy.data() || {}, shopId);
        try { await setDoc(settingsRef(shopId), shopCache, { merge: true }); } catch (_) {}
        return shopCache;
      }
    }
    shopCache = mergeShop(shopCache?.id === shopId ? shopCache : {}, shopId);
    try { await setDoc(settingsRef(shopId), { ...shopCache, createdAt: Date.now() }, { merge: true }); } catch (_) {}
  } catch (e) {
    console.warn('shop settings load failed', e);
    shopCache = mergeShop(shopCache?.id === shopId ? shopCache : {}, shopId);
  }
  // Fire-and-forget trial stamp (don't block UI)
  ensureTrialStarted().catch(() => {});
  return shopCache;
}

function persistShopLocal(shopId) {
  try {
    localStorage.setItem(scopedKey('mos_shop_settings'), JSON.stringify(shopCache));
    const local = JSON.parse(localStorage.getItem('mos_local_shops') || '[]');
    const idx = local.findIndex(s => s.id === shopId);
    if (idx >= 0) local[idx] = shopCache;
    else local.push(shopCache);
    localStorage.setItem('mos_local_shops', JSON.stringify(local));
  } catch (_) {}
}

function isPermissionDenied(e) {
  const code = e?.code || '';
  return code === 'permission-denied' || /permission[- ]?denied/i.test(String(e?.message || e || ''));
}

export async function saveShop(partial, shopId = getShopId()) {
  shopCache = mergeShop({ ...shopCache, ...partial }, shopId);
  try {
    // Staff Auth required by rules for full document writes
    await setDoc(settingsRef(shopId), shopCache, { merge: true });
  } catch (e) {
    console.warn('saveShop firestore failed, local fallback', e);
    persistShopLocal(shopId);
    if (shopId === DEFAULT_SHOP_ID) {
      try { await setDoc(legacySettingsRef(), shopCache, { merge: true }); } catch (_) {}
    }
    // Surface Auth/rules failures so Admin/Store/Ops can prompt login
    if (isPermissionDenied(e)) throw e;
  }
  return shopCache;
}

/**
 * Write only selected fields (guest-safe under Firestore rules for stock/coupons).
 * Prefer this for checkout-side mutations so affectedKeys stay narrow.
 */
export async function patchShopFields(partial, shopId = getShopId()) {
  const updatedAt = Date.now();
  const payload = { ...partial, updatedAt };
  shopCache = mergeShop({ ...shopCache, ...payload }, shopId);
  try {
    await setDoc(settingsRef(shopId), payload, { merge: true });
  } catch (e) {
    console.warn('patchShopFields firestore failed, local fallback', e);
    persistShopLocal(shopId);
    if (isPermissionDenied(e)) throw e;
  }
  return shopCache;
}

function localMenuKey(shopId) {
  return `mos_local_menu_${shopId}`;
}

function readLocalMenu(shopId) {
  try {
    const raw = localStorage.getItem(localMenuKey(shopId));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.items) || !data.items.length) return null;
    return {
      categories: data.categories?.length ? data.categories : DEFAULT_MENU.categories,
      allergens: data.allergens?.length ? data.allergens : DEFAULT_MENU.allergens,
      items: data.items,
    };
  } catch (_) {
    return null;
  }
}

function writeLocalMenu(menu, shopId) {
  try {
    localStorage.setItem(localMenuKey(shopId), JSON.stringify({
      categories: menu.categories,
      allergens: menu.allergens,
      items: menu.items,
      updatedAt: Date.now(),
      shopId,
    }));
  } catch (_) {}
}

export async function loadMenu(shopId = resolveShopId()) {
  try {
    const snap = await getDoc(menuRef(shopId));
    if (snap.exists() && Array.isArray(snap.data()?.items) && snap.data().items.length) {
      const data = snap.data();
      menuCache = {
        categories: data.categories?.length ? data.categories : DEFAULT_MENU.categories,
        allergens: data.allergens?.length ? data.allergens : DEFAULT_MENU.allergens,
        items: data.items,
      };
      writeLocalMenu(menuCache, shopId);
      return menuCache;
    }
    if (shopId === DEFAULT_SHOP_ID) {
      const legacy = await getDoc(legacyMenuRef());
      if (legacy.exists() && Array.isArray(legacy.data()?.items) && legacy.data().items.length) {
        const data = legacy.data();
        menuCache = {
          categories: data.categories?.length ? data.categories : DEFAULT_MENU.categories,
          allergens: data.allergens?.length ? data.allergens : DEFAULT_MENU.allergens,
          items: data.items,
        };
        writeLocalMenu(menuCache, shopId);
        try { await saveMenu(menuCache, shopId); } catch (_) {}
        return menuCache;
      }
    }
  } catch (e) {
    console.warn('menu load failed', e);
  }
  const local = readLocalMenu(shopId);
  if (local) {
    menuCache = local;
    return menuCache;
  }
  menuCache = cloneMenu();
  return menuCache;
}

export async function saveMenu(menu, shopId = getShopId()) {
  menuCache = menu;
  writeLocalMenu(menu, shopId);
  try {
    await setDoc(menuRef(shopId), {
      categories: menu.categories,
      allergens: menu.allergens,
      items: menu.items,
      updatedAt: Date.now(),
      shopId,
    });
  } catch (e) {
    console.warn('menu cloud save failed; kept local copy', e);
    if (shopId === DEFAULT_SHOP_ID) {
      try {
        await setDoc(legacyMenuRef(), {
          categories: menu.categories,
          allergens: menu.allergens,
          items: menu.items,
          updatedAt: Date.now(),
        }, { merge: true });
      } catch (_) {}
    }
    if (isPermissionDenied(e)) throw e;
  }
  return menuCache;
}

export async function ensureMenuSeeded(shopId = resolveShopId()) {
  const menu = await loadMenu(shopId);
  try {
    const snap = await getDoc(menuRef(shopId));
    if (!snap.exists()) await saveMenu(menu, shopId);
  } catch (e) { /* offline / rules */ }
  return menu;
}

export function isItemSoldOut(itemId) {
  const map = shopCache.soldOut || {};
  if (map[itemId]) return true;
  // Auto sold-out when inventory tracked and qty <= 0
  const stock = shopCache.stock || {};
  if (Object.prototype.hasOwnProperty.call(stock, itemId)) {
    const n = Number(stock[itemId]);
    if (Number.isFinite(n) && n <= 0) return true;
  }
  return false;
}

export function getItemStock(itemId) {
  const stock = shopCache.stock || {};
  if (!Object.prototype.hasOwnProperty.call(stock, itemId)) return null;
  const n = Number(stock[itemId]);
  return Number.isFinite(n) ? n : null;
}

export async function setItemStock(itemId, qty) {
  const stock = { ...(shopCache.stock || {}) };
  if (qty == null || qty === '' || Number(qty) < 0) {
    delete stock[itemId];
  } else {
    stock[itemId] = Math.floor(Number(qty));
  }
  const soldOut = { ...(shopCache.soldOut || {}) };
  if (stock[itemId] === 0) soldOut[itemId] = true;
  else if (stock[itemId] > 0) delete soldOut[itemId];
  return patchShopFields({ stock, soldOut });
}

/** Decrement stock for ordered items; auto mark sold out at 0. Growth+ inventory. */
export async function consumeStockForCart(cart = []) {
  if (!shopCanUse('inventory')) return shopCache;
  const stock = { ...(shopCache.stock || {}) };
  const soldOut = { ...(shopCache.soldOut || {}) };
  let changed = false;
  for (const line of cart) {
    const id = line.itemId || line.id;
    if (!id || !Object.prototype.hasOwnProperty.call(stock, id)) continue;
    const qty = Math.max(1, Number(line.qty) || 1);
    stock[id] = Math.max(0, Number(stock[id]) - qty);
    if (stock[id] <= 0) soldOut[id] = true;
    changed = true;
  }
  if (!changed) return shopCache;
  return patchShopFields({ stock, soldOut });
}

export async function setItemSoldOut(itemId, soldOut) {
  const map = { ...(shopCache.soldOut || {}) };
  if (soldOut) map[itemId] = true;
  else delete map[itemId];
  return patchShopFields({ soldOut: map });
}

/* ——— time windows / last order / timed sales ——— */

/** "HH:mm" → minutes from midnight, or null */
export function hmToMinutes(hm) {
  const m = String(hm || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function minutesNow(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

/** Inclusive start, exclusive end. Overnight windows (22:00–02:00) supported. */
export function isNowInWindow(fromHm, untilHm, date = new Date()) {
  const from = hmToMinutes(fromHm);
  const until = hmToMinutes(untilHm);
  if (from == null || until == null) return false;
  const cur = minutesNow(date);
  if (from === until) return true;
  if (from < until) return cur >= from && cur < until;
  return cur >= from || cur < until;
}

export function isPastLastOrder(shop = shopCache, date = new Date()) {
  if (!shop?.lastOrderEnabled) return false;
  const t = hmToMinutes(shop.lastOrderTime);
  if (t == null) return false;
  return minutesNow(date) >= t;
}

export function isSaleActive(item, date = new Date()) {
  if (!item?.saleEnabled) return false;
  const salePrice = Number(item.salePrice);
  if (!Number.isFinite(salePrice) || salePrice < 0) return false;
  if (salePrice >= Number(item.price)) return false;
  const from = item.saleFrom || '00:00';
  const until = item.saleUntil || '23:59';
  return isNowInWindow(from, until, date);
}

/** Base unit price after timed sale (before customization add-ons). */
export function getItemUnitPrice(item, date = new Date()) {
  if (!item) return 0;
  if (isSaleActive(item, date)) return Number(item.salePrice) || 0;
  return Number(item.price) || 0;
}

function lockStorageKey(shopId, tableNumber) {
  return `mos_bill_lock_${shopId || getShopId()}_${String(tableNumber)}`;
}

export function setTableOrderingLocked(tableNumber, locked, meta = {}) {
  const key = lockStorageKey(getShopId(), tableNumber);
  try {
    if (locked) {
      localStorage.setItem(key, JSON.stringify({
        locked: true,
        at: Date.now(),
        ...meta,
      }));
    } else {
      localStorage.removeItem(key);
    }
  } catch (_) {}
}

export function isTableOrderingLocked(tableNumber) {
  try {
    const raw = localStorage.getItem(lockStorageKey(getShopId(), tableNumber));
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return !!parsed?.locked;
  } catch {
    return false;
  }
}

/** Guest cannot place new orders (bill / last order / platform maintenance). */
export function getOrderingBlockReason(tableNumber, shop = shopCache) {
  if (isMaintenanceMode()) {
    return { blocked: true, reason: 'maintenance', label: maintenanceMessage() };
  }
  if (isTableOrderingLocked(tableNumber)) {
    return { blocked: true, reason: 'bill', label: 'お会計リクエスト済み' };
  }
  if (isPastLastOrder(shop)) {
    return {
      blocked: true,
      reason: 'last_order',
      label: `ラストオーダー（${shop.lastOrderTime || ''}）を過ぎています`,
    };
  }
  if (shop?.isOpen === false) {
    return { blocked: true, reason: 'closed', label: 'ただいま準備中です' };
  }
  return { blocked: false, reason: null, label: '' };
}

export function isSubscribed() {
  return !!shopCache.subscribed;
}

/** Start 14-day trial once per shop (local + best-effort Firestore). */
export function trialWindowForNewShop(days = PRODUCT.trialDays) {
  const started = Date.now();
  return {
    trialStartedAt: started,
    trialEndsAt: started + Number(days || PRODUCT.trialDays) * 86400000,
  };
}

/** Start 14-day trial once per shop (local + best-effort Firestore). */
export async function ensureTrialStarted() {
  if (isSubscribed()) return shopCache;
  if (shopCache.trialEndsAt || shopCache.trialStartedAt) return shopCache;
  // Demo / load-test shops skip commercial trial pressure
  if (shopCache.loadTest || String(shopCache.id || '').startsWith('load-')) return shopCache;
  const started = Date.now();
  const ends = started + PRODUCT.trialDays * 86400000;
  try {
    return await saveShop({ trialStartedAt: started, trialEndsAt: ends });
  } catch (_) {
    shopCache = mergeShop({ ...shopCache, trialStartedAt: started, trialEndsAt: ends }, getShopId());
    return shopCache;
  }
}

export function getShopAccess() {
  return getAccessState(shopCache, { subscribed: isSubscribed() });
}

export function shopCanUse(featureKey) {
  return canUseFeature(shopCache, featureKey, { subscribed: isSubscribed() });
}

export async function markSubscribed() {
  const was = isSubscribed();
  const shop = await saveShop({
    subscribed: true,
    subscribedAt: Date.now(),
    trialEndsAt: shopCache.trialEndsAt || Date.now(),
  });
  if (!was) {
    notifyContractActivated({ ...shopCache, ...shop, id: getShopId() });
  }
  return shop;
}

function withTimeout(promise, ms, label = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

function readLocalShops() {
  try {
    return JSON.parse(localStorage.getItem('mos_local_shops') || '[]');
  } catch {
    return [];
  }
}

function writeLocalShop(shop) {
  const local = readLocalShops();
  const idx = local.findIndex(s => s.id === shop.id);
  if (idx >= 0) local[idx] = shop;
  else local.push(shop);
  localStorage.setItem('mos_local_shops', JSON.stringify(local));
  try {
    localStorage.setItem(`mos_shop_settings_${shop.id}`, JSON.stringify(shop));
  } catch (_) {}
}

export async function listShops() {
  const map = new Map();
  listSeedShops().forEach(s => map.set(s.id, { ...s }));
  readLocalShops().forEach(s => map.set(s.id, mergeShop(s, s.id)));
  try {
    const snap = await withTimeout(getDocs(collection(db, 'shops')), 2500, 'listShops timeout');
    snap.docs.forEach(d => {
      const data = d.data() || {};
      map.set(d.id, mergeShop(data, d.id));
    });
  } catch (e) {
    console.warn('listShops firestore failed', e);
  }
  return [...map.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
}

export async function upsertShop(shopId, partial = {}) {
  const id = String(shopId || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 48);
  if (!id) throw new Error('invalid shop id');

  const existingLocal = readLocalShops().find(s => s.id === id) || seedShopMeta(id) || {};
  let existed = !!readLocalShops().find(s => s.id === id) || !!seedShopMeta(id);
  if (!existed) {
    try {
      const snap = await withTimeout(getDoc(settingsRef(id)), 1500, 'upsert exists check');
      existed = snap.exists();
    } catch (_) {}
  }

  const next = mergeShop({ ...existingLocal, ...partial, id, slug: id, updatedAt: Date.now() }, id);

  // Always persist locally first so Ops UI never hangs on Firestore rules
  writeLocalShop(next);
  shopCache = next;
  shopIdCache = id;

  try {
    await withTimeout(
      setDoc(settingsRef(id), next, { merge: true }),
      2500,
      'upsertShop setDoc timeout'
    );
    try {
      await withTimeout(ensureMenuSeeded(id), 2500, 'ensureMenuSeeded timeout');
    } catch (_) {}
  } catch (e) {
    console.warn('upsertShop firestore failed, kept local copy', e);
  }

  if (!existed) notifyShopCreated(next);
  return next;
}

export async function deleteShop(shopId) {
  if (!shopId || shopId === DEFAULT_SHOP_ID) throw new Error('default shop cannot be deleted');
  const prev = readLocalShops().find(s => s.id === shopId);
  try {
    const local = readLocalShops().filter(s => s.id !== shopId);
    localStorage.setItem('mos_local_shops', JSON.stringify(local));
    localStorage.removeItem(`mos_shop_settings_${shopId}`);
  } catch (_) {}
  try {
    await withTimeout(deleteDoc(settingsRef(shopId)), 2500, 'deleteShop timeout');
  } catch (_) {}
  try { await deleteDoc(menuRef(shopId)); } catch (_) {}
  notifyShopDeleted(shopId, prev?.name);
}

export async function ensureSeedShops() {
  for (const seed of listSeedShops()) {
    try {
      const snap = await withTimeout(getDoc(settingsRef(seed.id)), 2000, 'seed get timeout');
      if (!snap.exists()) {
        await withTimeout(setDoc(settingsRef(seed.id), mergeShop(seed, seed.id)), 2000, 'seed set timeout');
        await withTimeout(ensureMenuSeeded(seed.id), 2000, 'seed menu timeout');
      }
    } catch (e) {
      console.warn('seed shop failed', seed.id, e);
      writeLocalShop(mergeShop(seed, seed.id));
    }
  }
}
