/**
 * Guest smart curation + table pulse helpers (client-side, no remote AI).
 * Uses time-of-day, party size, cart complementarity, popularity, favorites.
 */

import { getMenu, isItemSoldOut, isSaleActive } from './shop.js';
import { itemHasTag } from './guest-extras.js';

export function hourBucket(date = new Date()) {
  const h = date.getHours();
  if (h < 11) return 'morning';
  if (h < 15) return 'lunch';
  if (h < 17) return 'tea';
  if (h < 21) return 'dinner';
  return 'late';
}

export function curatorTitle(locale = 'ja', bucket = hourBucket()) {
  const map = {
    ja: {
      morning: '朝のスタートに',
      lunch: 'いまのランチおすすめ',
      tea: '小腹にぴったりの一皿',
      dinner: '今夜のおすすめ',
      late: '夜の締めにおすすめ',
    },
    en: {
      morning: 'Morning picks',
      lunch: 'Lunch favorites now',
      tea: 'Light bites for now',
      dinner: 'Tonight’s picks',
      late: 'Late-night picks',
    },
  };
  const lang = locale === 'en' ? 'en' : 'ja';
  return map[lang][bucket] || map.ja.dinner;
}

function scoreItem(item, ctx) {
  let s = 0;
  if (item.popular) s += 8;
  if (isSaleActive(item)) s += 6;
  if (ctx.favorites?.has?.(String(item.id))) s += 5;
  if (ctx.inCart?.has?.(item.id)) s -= 20;

  const bucket = ctx.bucket || hourBucket();
  if (bucket === 'lunch' && (item.category === 'rice' || item.category === 'noodle')) s += 4;
  if (bucket === 'dinner' && (item.category === 'side' || item.popular)) s += 3;
  if (bucket === 'late' && (item.category === 'drink' || item.category === 'dessert')) s += 4;
  if (bucket === 'tea' && (item.category === 'dessert' || item.category === 'side')) s += 4;
  if (bucket === 'morning' && item.category === 'drink') s += 3;

  const party = Number(ctx.partySize) || 0;
  if (party >= 4 && (item.category === 'side' || itemHasTag(item, 'set'))) s += 3;
  if (party === 1 && item.category !== 'side') s += 1;

  // Complement cart: if cart has mains, boost sides/drinks; vice versa
  if (ctx.hasMain && (item.category === 'side' || item.category === 'drink')) s += 5;
  if (ctx.hasDrinkOnly && (item.category === 'rice' || item.category === 'noodle')) s += 4;
  if (ctx.hasNoDessert && item.category === 'dessert' && (ctx.cartCount || 0) >= 2) s += 3;

  if (itemHasTag(item, 'kids') && party >= 3) s += 2;
  if (itemHasTag(item, 'spicy') && bucket === 'dinner') s += 1;

  return s;
}

/**
 * Curate a short rail of items for the discovery strip.
 */
export function curateTonightPicks({
  cart = [],
  favorites = new Set(),
  partySize = 0,
  limit = 6,
  now = new Date(),
} = {}) {
  const menu = getMenu();
  const items = menu.items || [];
  const inCart = new Set(cart.map((c) => c.itemId));
  const cats = new Set(
    cart.map((c) => items.find((i) => i.id === c.itemId)?.category).filter(Boolean),
  );
  const bucket = hourBucket(now);
  const ctx = {
    bucket,
    favorites,
    inCart,
    partySize,
    cartCount: cart.reduce((n, c) => n + (c.qty || 1), 0),
    hasMain: [...cats].some((c) => c === 'rice' || c === 'noodle'),
    hasDrinkOnly: cats.size === 1 && cats.has('drink'),
    hasNoDessert: !cats.has('dessert'),
  };

  return items
    .filter((i) => !isItemSoldOut(i.id))
    .map((item) => ({ item, score: scoreItem(item, ctx) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.item.price - b.item.price)
    .slice(0, limit)
    .map((r) => r.item);
}

export function tablePulseCopy({
  waitMin = 0,
  partySize = 0,
  channel = 'dine_in',
  locale = 'ja',
} = {}) {
  const en = locale === 'en';
  const channelLabel = {
    dine_in: en ? 'Dine-in' : '店内',
    takeout: en ? 'Takeout' : 'テイクアウト',
    delivery: en ? 'Delivery' : 'デリバリー',
  }[channel] || channel;

  const wait = waitMin > 0
    ? (en ? `~${waitMin} min wait` : `待ち目安 約${waitMin}分`)
    : (en ? 'Kitchen ready' : '厨房余裕あり');

  const party = partySize > 0
    ? (en ? `${partySize} guests` : `${partySize}名`)
    : '';

  return { wait, party, channelLabel };
}

/** Fly emoji/element toward the cart bar (visual only). */
export function flyToCart(fromEl) {
  const bar = document.getElementById('cartBar');
  if (!fromEl || !bar || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const from = fromEl.getBoundingClientRect();
  const to = bar.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = 'fly-to-cart';
  ghost.textContent = fromEl.textContent?.trim()?.slice(0, 2) || '＋';
  ghost.style.left = `${from.left + from.width / 2}px`;
  ghost.style.top = `${from.top + from.height / 2}px`;
  document.body.appendChild(ghost);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  requestAnimationFrame(() => {
    ghost.style.transform = `translate(${dx}px, ${dy}px) scale(0.35)`;
    ghost.style.opacity = '0';
  });
  setTimeout(() => ghost.remove(), 520);
  bar.classList.add('cart-bar-pulse');
  setTimeout(() => bar.classList.remove('cart-bar-pulse'), 480);
}
