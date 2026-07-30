import { db } from './firebase.js';
import { MENU_DATA as DEFAULT_MENU } from './data.js';
import { DEFAULT_SHOP } from './config.js';
import { resolveShopId, seedShopMeta, listSeedShops, DEFAULT_SHOP_ID, scopedKey } from './tenant.js';
import {
  doc, getDoc, setDoc, collection, getDocs, deleteDoc
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

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
  try {
    const localRaw = localStorage.getItem(scopedKey('mos_shop_settings'));
    if (localRaw) {
      const local = JSON.parse(localRaw);
      if (local?.id === shopId || !local?.id) {
        shopCache = mergeShop(local, shopId);
      }
    }
  } catch (_) {}
  try {
    const snap = await getDoc(settingsRef(shopId));
    if (snap.exists()) {
      shopCache = mergeShop(snap.data() || {}, shopId);
      return shopCache;
    }
    // Migrate legacy default shop once
    if (shopId === DEFAULT_SHOP_ID) {
      const legacy = await getDoc(legacySettingsRef());
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
  return shopCache;
}

export async function saveShop(partial, shopId = getShopId()) {
  shopCache = mergeShop({ ...shopCache, ...partial }, shopId);
  try {
    await setDoc(settingsRef(shopId), shopCache, { merge: true });
  } catch (e) {
    console.warn('saveShop firestore failed, local fallback', e);
    try {
      localStorage.setItem(scopedKey('mos_shop_settings'), JSON.stringify(shopCache));
      const local = JSON.parse(localStorage.getItem('mos_local_shops') || '[]');
      const idx = local.findIndex(s => s.id === shopId);
      if (idx >= 0) local[idx] = shopCache;
      else local.push(shopCache);
      localStorage.setItem('mos_local_shops', JSON.stringify(local));
      if (shopId === DEFAULT_SHOP_ID) {
        try { await setDoc(legacySettingsRef(), shopCache, { merge: true }); } catch (_) {}
      }
    } catch (_) {}
  }
  return shopCache;
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
        try { await saveMenu(menuCache, shopId); } catch (_) {}
        return menuCache;
      }
    }
  } catch (e) {
    console.warn('menu load failed', e);
  }
  menuCache = cloneMenu();
  return menuCache;
}

export async function saveMenu(menu, shopId = getShopId()) {
  menuCache = menu;
  await setDoc(menuRef(shopId), {
    categories: menu.categories,
    allergens: menu.allergens,
    items: menu.items,
    updatedAt: Date.now(),
    shopId,
  });
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
  return !!map[itemId];
}

export async function setItemSoldOut(itemId, soldOut) {
  const map = { ...(shopCache.soldOut || {}) };
  if (soldOut) map[itemId] = true;
  else delete map[itemId];
  return saveShop({ soldOut: map });
}

export function isSubscribed() {
  if (shopCache.subscribed) return true;
  try {
    return localStorage.getItem(scopedKey('mos_subscribed')) === '1'
      || localStorage.getItem('mos_subscribed') === '1';
  } catch {
    return false;
  }
}

export async function markSubscribed() {
  try { localStorage.setItem(scopedKey('mos_subscribed'), '1'); } catch (_) {}
  return saveShop({ subscribed: true, subscribedAt: Date.now() });
}

export async function listShops() {
  const map = new Map();
  listSeedShops().forEach(s => map.set(s.id, { ...s }));
  try {
    const local = JSON.parse(localStorage.getItem('mos_local_shops') || '[]');
    local.forEach(s => map.set(s.id, mergeShop(s, s.id)));
  } catch (_) {}
  try {
    const snap = await getDocs(collection(db, 'shops'));
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
  let current = {};
  try {
    current = await loadShop(id);
  } catch (_) {}
  const next = mergeShop({ ...current, ...partial, id, slug: id }, id);
  try {
    await setDoc(settingsRef(id), { ...next, updatedAt: Date.now() }, { merge: true });
    await ensureMenuSeeded(id);
  } catch (e) {
    console.warn('upsertShop firestore failed, saving locally', e);
    try {
      const local = JSON.parse(localStorage.getItem('mos_local_shops') || '[]');
      const idx = local.findIndex(s => s.id === id);
      if (idx >= 0) local[idx] = next;
      else local.push(next);
      localStorage.setItem('mos_local_shops', JSON.stringify(local));
    } catch (_) {}
  }
  return next;
}

export async function deleteShop(shopId) {
  if (!shopId || shopId === DEFAULT_SHOP_ID) throw new Error('default shop cannot be deleted');
  await deleteDoc(settingsRef(shopId));
  try { await deleteDoc(menuRef(shopId)); } catch (_) {}
}

export async function ensureSeedShops() {
  for (const seed of listSeedShops()) {
    try {
      const snap = await getDoc(settingsRef(seed.id));
      if (!snap.exists()) {
        await setDoc(settingsRef(seed.id), mergeShop(seed, seed.id));
        await ensureMenuSeeded(seed.id);
      }
    } catch (e) {
      console.warn('seed shop failed', seed.id, e);
    }
  }
}
