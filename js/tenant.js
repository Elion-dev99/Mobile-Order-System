/** Multi-tenant shop resolution and URL helpers */

const SHOP_SESSION = 'mos_shop_id';
export const DEFAULT_SHOP_ID = 'default';

const SEED_SHOPS = {
  default: {
    id: 'default',
    slug: 'default',
    name: 'QuickOrder 本店',
    subtitle: 'モバイルオーダー',
    tableCount: 12,
    planId: 'growth',
    locale: 'ja',
    isOpen: true,
    hoursNote: '11:00–22:00',
    address: '東京都（デモ）',
    theme: 'teal',
  },
  'hanako-sushi': {
    id: 'hanako-sushi',
    slug: 'hanako-sushi',
    name: 'はなこ寿司',
    subtitle: '江戸前・カウンター',
    tableCount: 8,
    planId: 'business',
    locale: 'ja',
    isOpen: true,
    hoursNote: '17:00–23:00',
    address: '渋谷区道玄坂',
    theme: 'navy',
  },
  'ichi-ramen': {
    id: 'ichi-ramen',
    slug: 'ichi-ramen',
    name: '壱ラーメン',
    subtitle: 'つけ麺と醤油',
    tableCount: 16,
    planId: 'lite',
    locale: 'ja',
    isOpen: true,
    hoursNote: '11:00–21:00',
    address: '新宿区歌舞伎町',
    theme: 'ember',
  },
};

let resolvedShopId = null;

export function seedShopMeta(id) {
  return SEED_SHOPS[id] ? { ...SEED_SHOPS[id] } : null;
}

export function listSeedShops() {
  return Object.values(SEED_SHOPS).map(s => ({ ...s }));
}

export function resolveShopId() {
  if (resolvedShopId) return resolvedShopId;
  const q = new URLSearchParams(location.search);
  const fromQuery = (q.get('shop') || q.get('store') || '').trim().toLowerCase();
  const pathMatch = location.pathname.match(/\/s\/([^/]+)/i);
  const fromPath = pathMatch ? decodeURIComponent(pathMatch[1]).toLowerCase() : '';
  let id = fromQuery || fromPath;
  if (!id) {
    try { id = sessionStorage.getItem(SHOP_SESSION) || ''; } catch (_) {}
  }
  if (!id) id = DEFAULT_SHOP_ID;
  id = id.replace(/[^a-z0-9_-]/g, '').slice(0, 48) || DEFAULT_SHOP_ID;
  resolvedShopId = id;
  try { sessionStorage.setItem(SHOP_SESSION, id); } catch (_) {}
  return resolvedShopId;
}

export function setShopId(id) {
  resolvedShopId = String(id || DEFAULT_SHOP_ID)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 48) || DEFAULT_SHOP_ID;
  try { sessionStorage.setItem(SHOP_SESSION, resolvedShopId); } catch (_) {}
  return resolvedShopId;
}

export function withShop(url) {
  const u = new URL(url, location.href);
  u.searchParams.set('shop', resolveShopId());
  return `${u.pathname}${u.search}${u.hash}`;
}

export function guestEntryUrl(shopId, table = 1, extra = {}) {
  const u = new URL('index.html', location.href);
  u.searchParams.set('shop', shopId || DEFAULT_SHOP_ID);
  u.searchParams.set('table', String(table));
  Object.entries(extra).forEach(([k, v]) => {
    if (v == null || v === '') u.searchParams.delete(k);
    else u.searchParams.set(k, String(v));
  });
  return `${u.pathname}${u.search}${u.hash}`;
}

export function prettyShopPath(shopId, page = '') {
  const base = `/s/${encodeURIComponent(shopId || DEFAULT_SHOP_ID)}/`;
  if (!page || page === 'index' || page === 'menu') return base;
  return `${base}${page.replace(/^\//, '')}`;
}

export function scopedKey(base) {
  return `${base}_${resolveShopId()}`;
}
