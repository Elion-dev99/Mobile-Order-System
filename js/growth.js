/**
 * Zero-cash growth loops: attribution, referral links, watermarks, share kits.
 * No paid ads — product surfaces and organic share do the acquiring.
 */

import { getShop, getShopId } from './shop.js';
import { PRODUCT } from './config.js';

const ATTR_KEY = 'mos_growth_attr';
const REF_CREDIT_KEY = 'mos_referral_credits';

export function readGrowthQuery(search = location.search) {
  const q = new URLSearchParams(search);
  return {
    ref: (q.get('ref') || q.get('referral') || '').trim().slice(0, 48),
    utmSource: (q.get('utm_source') || '').trim().slice(0, 64),
    utmMedium: (q.get('utm_medium') || '').trim().slice(0, 64),
    utmCampaign: (q.get('utm_campaign') || '').trim().slice(0, 64),
  };
}

export function captureGrowthAttribution(search = location.search) {
  const hit = readGrowthQuery(search);
  if (!hit.ref && !hit.utmSource && !hit.utmMedium && !hit.utmCampaign) {
    return loadGrowthAttribution();
  }
  const prev = loadGrowthAttribution();
  // First-touch for ref/UTMs: never wipe a prior referral with a later UTM-only hit
  const next = {
    ref: hit.ref || prev.ref || '',
    utmSource: hit.utmSource || prev.utmSource || '',
    utmMedium: hit.utmMedium || prev.utmMedium || '',
    utmCampaign: hit.utmCampaign || prev.utmCampaign || '',
    landedAt: prev.landedAt || Date.now(),
    lastTouchAt: Date.now(),
    path: location.pathname + location.search,
    firstPath: prev.firstPath || (location.pathname + location.search),
  };
  try { localStorage.setItem(ATTR_KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}

export function loadGrowthAttribution() {
  try {
    return JSON.parse(localStorage.getItem(ATTR_KEY) || 'null') || {};
  } catch {
    return {};
  }
}

/** LP / demo URL with referral + UTM for organic posts */
export function growthLpUrl({
  ref = getShopId(),
  source = 'product',
  medium = 'watermark',
  campaign = 'zero_cash',
  absolute = true,
} = {}) {
  const u = new URL('lp.html', absolute ? location.origin : location.href);
  if (ref) u.searchParams.set('ref', String(ref).slice(0, 48));
  u.searchParams.set('utm_source', source);
  u.searchParams.set('utm_medium', medium);
  u.searchParams.set('utm_campaign', campaign);
  u.hash = 'contact';
  return absolute ? u.href : `${u.pathname}${u.search}${u.hash}`;
}

export function growthDemoUrl({ ref = getShopId() } = {}) {
  const u = new URL('index.html', location.origin);
  u.searchParams.set('shop', 'default');
  u.searchParams.set('table', '1');
  u.searchParams.set('demo', '1');
  if (ref) u.searchParams.set('ref', String(ref).slice(0, 48));
  u.searchParams.set('utm_source', 'demo');
  u.searchParams.set('utm_medium', 'share');
  u.searchParams.set('utm_campaign', 'zero_cash');
  return u.href;
}

/** Soft credit ledger (Ops can honor later). Zero cash outlay. */
export function recordReferralShare(shopId = getShopId()) {
  let map = {};
  try { map = JSON.parse(localStorage.getItem(REF_CREDIT_KEY) || '{}') || {}; } catch (_) {}
  const row = map[shopId] || { shares: 0, creditedDays: 0 };
  row.shares = (row.shares || 0) + 1;
  // Every 3 shares → +7 trial-credit days pending (manual Ops honor)
  if (row.shares % 3 === 0) row.creditedDays = (row.creditedDays || 0) + 7;
  row.updatedAt = Date.now();
  map[shopId] = row;
  try { localStorage.setItem(REF_CREDIT_KEY, JSON.stringify(map)); } catch (_) {}
  return row;
}

export function getReferralCredits(shopId = getShopId()) {
  try {
    const map = JSON.parse(localStorage.getItem(REF_CREDIT_KEY) || '{}') || {};
    return map[shopId] || { shares: 0, creditedDays: 0 };
  } catch {
    return { shares: 0, creditedDays: 0 };
  }
}

export function shareKitText({ shopName = '', locale = 'ja' } = {}) {
  const name = shopName || getShop()?.name || 'QuickOrder';
  const lp = growthLpUrl({ ref: getShopId(), source: 'owner', medium: 'share_kit', campaign: 'referral' });
  const demo = growthDemoUrl({ ref: getShopId() });
  if (locale === 'en') {
    return {
      title: `${name} runs on QuickOrder`,
      body: `We cut waiter trips with QR ordering.\nTry the demo: ${demo}\nFor restaurants: ${lp}`,
      lp,
      demo,
    };
  }
  return {
    title: `${name}はQuickOrderで注文受付中`,
    body: `席のQRで注文→厨房に即着信。人手不足でも回ります。\n無料デモ: ${demo}\n飲食店の方はこちら: ${lp}\n#モバイルオーダー #飲食店DX #QuickOrder`,
    lp,
    demo,
  };
}

/** Subtle product watermark → LP (trial shops / unpaid still show; subscribed can keep brand) */
export function mountGrowthWatermark({ locale = 'ja' } = {}) {
  if (document.getElementById('qoGrowthMark')) return;
  const shop = getShop() || {};
  // Always show for demo; for live shops show unless explicitly hidden
  if (shop.hideGrowthMark === true) return;

  const a = document.createElement('a');
  a.id = 'qoGrowthMark';
  a.className = 'qo-growth-mark';
  a.href = growthLpUrl({
    ref: getShopId(),
    source: 'guest',
    medium: 'watermark',
    campaign: 'product_led',
  });
  a.target = '_blank';
  a.rel = 'noopener';
  a.innerHTML = locale === 'en'
    ? `<span>Powered by</span><strong>QuickOrder</strong>`
    : `<span>注文システム</span><strong>QuickOrder</strong><em>無料で始める</em>`;
  document.body.appendChild(a);
}

export function mountStatusGrowthCta({ locale = 'ja' } = {}) {
  if (document.getElementById('qoStatusGrowth')) return;
  const host = document.querySelector('.status-content') || document.body;
  const box = document.createElement('aside');
  box.id = 'qoStatusGrowth';
  box.className = 'qo-status-growth';
  const kit = shareKitText({ locale });
  box.innerHTML = locale === 'en'
    ? `<p>Restaurant owner? Start a 14-day trial.</p>
       <a class="qo-growth-btn" href="${kit.lp}">Get QuickOrder</a>
       <button type="button" class="qo-growth-share" id="qoStatusShare">Share demo</button>`
    : `<p>お店の方へ — 14日トライアルで同じ仕組みを導入できます</p>
       <a class="qo-growth-btn" href="${kit.lp}">QuickOrderを始める</a>
       <button type="button" class="qo-growth-share" id="qoStatusShare">デモを共有</button>`;
  host.appendChild(box);
  document.getElementById('qoStatusShare')?.addEventListener('click', async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: kit.title, text: kit.body, url: kit.demo });
        recordReferralShare();
      } else {
        await navigator.clipboard.writeText(kit.body);
        recordReferralShare();
        box.querySelector('p').textContent = locale === 'en' ? 'Copied share text' : '投稿文をコピーしました';
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
      try {
        await navigator.clipboard.writeText(kit.body);
        recordReferralShare();
        box.querySelector('p').textContent = locale === 'en' ? 'Copied share text' : '投稿文をコピーしました';
      } catch (__) {}
    }
  });
}

export function leadAttributionFields() {
  const a = loadGrowthAttribution();
  return {
    referralShopId: a.ref || '',
    utmSource: a.utmSource || '',
    utmMedium: a.utmMedium || '',
    utmCampaign: a.utmCampaign || '',
    growthLandedAt: a.landedAt || 0,
    product: PRODUCT.name,
  };
}
