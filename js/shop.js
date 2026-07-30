import { db } from './firebase.js';
import { MENU_DATA as DEFAULT_MENU } from './data.js';
import { DEFAULT_SHOP } from './config.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const SETTINGS_REF = () => doc(db, 'shop', 'settings');
const MENU_REF = () => doc(db, 'shop', 'menu');

let shopCache = { ...DEFAULT_SHOP };
let menuCache = null;

function cloneMenu() {
  return JSON.parse(JSON.stringify(DEFAULT_MENU));
}

export function getShop() {
  return shopCache;
}

export function getMenu() {
  return menuCache || cloneMenu();
}

export async function loadShop() {
  try {
    const snap = await getDoc(SETTINGS_REF());
    if (snap.exists()) {
      shopCache = { ...DEFAULT_SHOP, ...snap.data() };
    }
  } catch (e) {
    console.warn('shop settings load failed', e);
  }
  return shopCache;
}

export async function saveShop(partial) {
  shopCache = { ...shopCache, ...partial };
  await setDoc(SETTINGS_REF(), shopCache, { merge: true });
  return shopCache;
}

export async function loadMenu() {
  try {
    const snap = await getDoc(MENU_REF());
    if (snap.exists() && Array.isArray(snap.data()?.items) && snap.data().items.length) {
      const data = snap.data();
      menuCache = {
        categories: data.categories?.length ? data.categories : DEFAULT_MENU.categories,
        allergens: data.allergens?.length ? data.allergens : DEFAULT_MENU.allergens,
        items: data.items,
      };
      return menuCache;
    }
  } catch (e) {
    console.warn('menu load failed', e);
  }
  menuCache = cloneMenu();
  return menuCache;
}

export async function saveMenu(menu) {
  menuCache = menu;
  await setDoc(MENU_REF(), {
    categories: menu.categories,
    allergens: menu.allergens,
    items: menu.items,
    updatedAt: Date.now(),
  });
  return menuCache;
}

export async function ensureMenuSeeded() {
  const menu = await loadMenu();
  try {
    const snap = await getDoc(MENU_REF());
    if (!snap.exists()) await saveMenu(menu);
  } catch (e) { /* offline / rules */ }
  return menu;
}

export function isSubscribed() {
  if (shopCache.subscribed) return true;
  try {
    return localStorage.getItem('mos_subscribed') === '1';
  } catch {
    return false;
  }
}

export async function markSubscribed() {
  try { localStorage.setItem('mos_subscribed', '1'); } catch (_) {}
  return saveShop({ subscribed: true, subscribedAt: Date.now() });
}
