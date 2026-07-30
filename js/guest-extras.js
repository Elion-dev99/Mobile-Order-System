/**
 * Industry guest extras: favorites, party size, diet filters,
 * age gate, brand accent, ready chime, quick-service helpers.
 */

import { getShop, getShopId } from './shop.js';
import { guestEntryUrl } from './tenant.js';

const FAV_KEY = () => `mos_favs_${getShopId()}`;
const PARTY_KEY = () => `mos_party_${getShopId()}_${sessionTable()}`;
const AGE_KEY = () => `mos_age_ok_${getShopId()}`;

function sessionTable() {
  try {
    return new URLSearchParams(location.search).get('table') || '1';
  } catch {
    return '1';
  }
}

export const DIET_FILTERS = [
  { id: 'popular', ja: '人気', en: 'Popular' },
  { id: 'sale', ja: 'セール', en: 'Sale' },
  { id: 'fav', ja: 'お気に入り', en: 'Favorites' },
  { id: 'veg', ja: 'ベジ', en: 'Veg' },
  { id: 'spicy', ja: '辛口', en: 'Spicy' },
  { id: 'kids', ja: 'キッズ', en: 'Kids' },
];

export function loadFavorites() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_KEY()) || '[]'));
  } catch {
    return new Set();
  }
}

export function toggleFavorite(itemId) {
  const set = loadFavorites();
  const id = String(itemId);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  try {
    localStorage.setItem(FAV_KEY(), JSON.stringify([...set]));
  } catch (_) {}
  return set;
}

export function isFavorite(itemId, favs = loadFavorites()) {
  return favs.has(String(itemId));
}

export function getPartySize() {
  try {
    const n = Number(localStorage.getItem(PARTY_KEY()));
    return Number.isFinite(n) && n > 0 ? Math.min(20, Math.floor(n)) : 0;
  } catch {
    return 0;
  }
}

export function setPartySize(n) {
  const v = Math.max(1, Math.min(20, Number(n) || 1));
  try {
    localStorage.setItem(PARTY_KEY(), String(v));
  } catch (_) {}
  return v;
}

export function isAgeVerified() {
  try {
    return localStorage.getItem(AGE_KEY()) === '1';
  } catch {
    return false;
  }
}

export function setAgeVerified(ok = true) {
  try {
    localStorage.setItem(AGE_KEY(), ok ? '1' : '0');
  } catch (_) {}
}

export function itemHasTag(item, tag) {
  if (!item) return false;
  if (tag === 'alcohol') return !!(item.alcohol || (item.tags || []).includes('alcohol'));
  return Array.isArray(item.tags) && item.tags.includes(tag);
}

export function confirmAlcoholAge(locale = 'ja') {
  if (isAgeVerified()) return true;
  const msg = locale === 'en'
    ? 'This item contains alcohol. Are you 20 or older?'
    : 'アルコールを含む商品です。20歳以上ですか？';
  const ok = window.confirm(msg);
  if (ok) setAgeVerified(true);
  return ok;
}

/** Apply shop accent / brand tokens to :root */
export function applyBrandTheme(shop = getShop()) {
  const root = document.documentElement;
  const accent = shop.accentColor || shop.themeAccent || '';
  if (accent && /^#[0-9A-Fa-f]{6}$/.test(accent)) {
    root.style.setProperty('--g-accent', accent);
    root.style.setProperty('--blue', accent);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', accent);
  }
  if (shop.name) {
    document.querySelectorAll('.guest-brand, .nav-large-title').forEach((el) => {
      if (el.classList.contains('guest-brand') || el.classList.contains('nav-large-title')) {
        // leave demo suffix to caller
      }
    });
  }
}

export function playReadyChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(523.25, ctx.currentTime);
    o.frequency.setValueAtTime(659.25, ctx.currentTime + 0.12);
    o.frequency.setValueAtTime(783.99, ctx.currentTime + 0.24);
    g.gain.value = 0.07;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => {
      try { o.stop(); ctx.close(); } catch (_) {}
    }, 420);
  } catch (_) {}
}

export function mountQuickFilters({ locale = 'ja', active = new Set(), onChange } = {}) {
  let el = document.getElementById('guestQuickFilters');
  if (!el) {
    el = document.createElement('div');
    el.id = 'guestQuickFilters';
    el.className = 'guest-quick-filters';
    const host = document.querySelector('.guest-search') || document.querySelector('.guest-header');
    host?.after(el);
  }
  el.innerHTML = DIET_FILTERS.map((f) => `
    <button type="button" class="quick-filter-chip ${active.has(f.id) ? 'active' : ''}" data-qf="${f.id}">
      ${locale === 'en' ? f.en : f.ja}
    </button>
  `).join('');
  el.querySelectorAll('[data-qf]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.qf;
      const next = new Set(active);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange?.(next);
    });
  });
  return el;
}

export function mountPartySizePrompt({ locale = 'ja', required = false, onDone } = {}) {
  if (getPartySize() > 0) {
    onDone?.(getPartySize());
    return;
  }
  if (!required && sessionStorage.getItem('mos_party_skipped') === '1') {
    onDone?.(0);
    return;
  }
  let el = document.getElementById('partySizeModal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'partySizeModal';
    el.className = 'party-size-overlay';
    document.body.appendChild(el);
  }
  const title = locale === 'en' ? 'How many guests?' : 'ご利用人数は？';
  const hint = locale === 'en'
    ? 'Helps us pace kitchen prep and split the bill.'
    : '厨房の準備と割り勘の目安に使います。';
  const skip = locale === 'en' ? 'Skip' : 'スキップ';
  const go = locale === 'en' ? 'Continue' : 'はじめる';
  el.hidden = false;
  el.innerHTML = `
    <div class="party-size-card" role="dialog" aria-modal="true">
      <h2>${title}</h2>
      <p>${hint}</p>
      <div class="party-size-row">
        <button type="button" data-party-delta="-1">−</button>
        <strong id="partySizeValue">2</strong>
        <button type="button" data-party-delta="1">＋</button>
      </div>
      <div class="party-size-actions">
        ${required ? '' : `<button type="button" class="party-skip" data-party-skip>${skip}</button>`}
        <button type="button" class="party-go" data-party-go>${go}</button>
      </div>
    </div>`;
  let n = 2;
  const val = el.querySelector('#partySizeValue');
  el.querySelectorAll('[data-party-delta]').forEach((btn) => {
    btn.addEventListener('click', () => {
      n = Math.max(1, Math.min(20, n + Number(btn.dataset.partyDelta)));
      if (val) val.textContent = String(n);
    });
  });
  el.querySelector('[data-party-skip]')?.addEventListener('click', () => {
    try { sessionStorage.setItem('mos_party_skipped', '1'); } catch (_) {}
    el.hidden = true;
    onDone?.(0);
  });
  el.querySelector('[data-party-go]')?.addEventListener('click', () => {
    setPartySize(n);
    el.hidden = true;
    onDone?.(n);
  });
}

export function mountShareTableLink({ tableNumber, locale = 'ja', onToast } = {}) {
  if (document.getElementById('shareTableBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'shareTableBtn';
  btn.type = 'button';
  btn.className = 'nav-action share-table-btn';
  btn.textContent = locale === 'en' ? 'Share' : '席URL';
  const host = document.querySelector('.guest-header-actions') || document.querySelector('.guest-header');
  host?.prepend(btn);
  btn.addEventListener('click', async () => {
    const url = guestEntryUrl(getShopId(), tableNumber);
    const absolute = new URL(url, location.origin).href;
    try {
      if (navigator.share) {
        await navigator.share({
          title: getShop().name || 'QuickOrder',
          text: locale === 'en' ? `Table ${tableNumber} menu` : `テーブル${tableNumber}のメニュー`,
          url: absolute,
        });
      } else {
        await navigator.clipboard.writeText(absolute);
        onToast?.(locale === 'en' ? 'Table link copied' : '席のURLをコピーしました');
      }
    } catch (_) {
      try {
        await navigator.clipboard.writeText(absolute);
        onToast?.(locale === 'en' ? 'Table link copied' : '席のURLをコピーしました');
      } catch (e) {
        onToast?.(absolute);
      }
    }
  });
}

export function tagBadgesHtml(item, locale = 'ja') {
  const tags = [];
  if (item.popular) tags.push(locale === 'en' ? 'Popular' : '人気');
  if (itemHasTag(item, 'veg')) tags.push(locale === 'en' ? 'Veg' : 'ベジ');
  if (itemHasTag(item, 'spicy')) tags.push(locale === 'en' ? 'Spicy' : '辛口');
  if (itemHasTag(item, 'kids')) tags.push(locale === 'en' ? 'Kids' : 'キッズ');
  if (itemHasTag(item, 'alcohol')) tags.push(locale === 'en' ? 'Alcohol' : 'Alc');
  if (item.calories) tags.push(`${item.calories}kcal`);
  if (!tags.length) return '';
  return `<div class="menu-tag-row">${tags.map((t) => `<span class="menu-tag">${t}</span>`).join('')}</div>`;
}

export function suggestSetCombos(cart = [], menuItems = [], limit = 2) {
  const cats = new Set(cart.map((c) => {
    const m = menuItems.find((i) => i.id === c.itemId);
    return m?.category;
  }).filter(Boolean));
  const inCart = new Set(cart.map((c) => c.itemId));
  const need = [];
  if (!cats.has('drink')) need.push('drink');
  if (!cats.has('side') && !cats.has('dessert')) need.push('side');
  const out = [];
  for (const cat of need) {
    const hit = menuItems.find((i) => i.category === cat && i.popular && !inCart.has(i.id));
    if (hit) out.push(hit);
  }
  return out.slice(0, limit);
}

export function ordersToCsv(orders = []) {
  const header = [
    'orderId', 'shopId', 'table', 'status', 'timestamp', 'iso',
    'subtotal', 'discount', 'coupon', 'serviceCharge', 'tip', 'tax', 'total',
    'platformFee', 'items',
  ];
  const lines = [header.join(',')];
  for (const o of orders) {
    const items = (o.items || [])
      .map((i) => `${i.name || ''}x${i.qty || 1}`)
      .join('; ')
      .replace(/"/g, '""');
    const iso = o.timestamp ? new Date(o.timestamp).toISOString() : '';
    lines.push([
      csv(o.id),
      csv(o.shopId),
      csv(o.tableNumber),
      csv(o.status || 'received'),
      csv(o.timestamp),
      csv(iso),
      csv(o.subtotal),
      csv(o.discount || 0),
      csv(o.couponCode || ''),
      csv(o.serviceCharge || 0),
      csv(o.tip || 0),
      csv(o.tax),
      csv(o.total),
      csv(o.platformFee || 0),
      `"${items}"`,
    ].join(','));
  }
  return lines.join('\n');
}

/** Filter orders by local-date range (inclusive). from/to as 'YYYY-MM-DD' or Date. */
export function filterOrdersByDateRange(orders = [], from, to) {
  const start = from ? new Date(from) : null;
  if (start) start.setHours(0, 0, 0, 0);
  const end = to ? new Date(to) : null;
  if (end) end.setHours(23, 59, 59, 999);
  return orders.filter((o) => {
    const t = Number(o.timestamp) || 0;
    if (start && t < start.getTime()) return false;
    if (end && t > end.getTime()) return false;
    return true;
  });
}

function csv(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function downloadCsv(filename, text) {
  const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
