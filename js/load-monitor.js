/**
 * Kitchen / ops system load assessment + Discord alerts on level change.
 */

import { estimateWaitMinutes } from './guest-features.js';
import { notifyDiscord, isEventEnabled, loadNotifySettings } from './notify.js';

export const LOAD_LEVELS = {
  normal: { id: 'normal', label: '平常', emoji: '🟢' },
  busy: { id: 'busy', label: 'やや混雑', emoji: '🟡' },
  crowded: { id: 'crowded', label: '混雑', emoji: '🟠' },
  critical: { id: 'critical', label: '高負荷', emoji: '🔴' },
};

const LEVEL_ORDER = ['normal', 'busy', 'crowded', 'critical'];

function storageKey(shopId) {
  return `mos_load_level_${shopId || 'default'}`;
}

function cooldownKey(shopId) {
  return `mos_load_notify_at_${shopId || 'default'}`;
}

/**
 * @param {{ orders?: object[], requests?: object[] }} input
 */
export function assessSystemLoad({ orders = [], requests = [] } = {}) {
  const openOrders = (orders || []).filter(o => {
    if (o?.demo) return false;
    const s = o.status || 'received';
    return s !== 'done';
  });
  const openReq = (requests || []).filter(r => r?.status === 'open' && !r?.demo);
  const waitMin = estimateWaitMinutes(openOrders);
  const pending = openOrders.length;
  const cooking = openOrders.filter(o => (o.status || '') === 'cooking').length;
  const received = openOrders.filter(o => (o.status || 'received') === 'received').length;
  const now = Date.now();
  const stale = openOrders.filter(o => now - (o.timestamp || 0) >= 15 * 60 * 1000).length;
  const openStaff = openReq.filter(r => r.type === 'staff').length;
  const openBill = openReq.filter(r => r.type === 'bill').length;

  let level = 'normal';
  if (waitMin >= 28 || pending >= 10 || stale >= 3 || openReq.length >= 6) {
    level = 'critical';
  } else if (waitMin >= 18 || pending >= 6 || stale >= 2 || openReq.length >= 4) {
    level = 'crowded';
  } else if (waitMin >= 10 || pending >= 3 || openReq.length >= 2 || stale >= 1) {
    level = 'busy';
  }

  const meta = LOAD_LEVELS[level] || LOAD_LEVELS.normal;
  return {
    level,
    label: meta.label,
    emoji: meta.emoji,
    waitMin,
    pending,
    cooking,
    received,
    stale,
    openRequests: openReq.length,
    openStaff,
    openBill,
  };
}

export function getLastLoadLevel(shopId) {
  try {
    return localStorage.getItem(storageKey(shopId)) || '';
  } catch {
    return '';
  }
}

function setLastLoadLevel(shopId, level) {
  try { localStorage.setItem(storageKey(shopId), level); } catch (_) {}
}

function getLastNotifyAt(shopId) {
  try {
    return Number(localStorage.getItem(cooldownKey(shopId)) || 0) || 0;
  } catch {
    return 0;
  }
}

function setLastNotifyAt(shopId, ts = Date.now()) {
  try { localStorage.setItem(cooldownKey(shopId), String(ts)); } catch (_) {}
}

function isUpgrade(from, to) {
  return LEVEL_ORDER.indexOf(to) > LEVEL_ORDER.indexOf(from || 'normal');
}

function loadFields(shopId, shopName, a, note = '') {
  return {
    内容: note || '厨房・オペレーションの混雑状況です',
    店舗: shopName || shopId || '',
    店舗ID: shopId || '',
    レベル: `${a.emoji} ${a.label}`,
    予想待ち: `${a.waitMin}分`,
    未完了注文: a.pending,
    受付中: a.received,
    調理中: a.cooking,
    '15分超滞留': a.stale,
    未対応呼出: a.openRequests,
    店員呼出: a.openStaff,
    会計リクエスト: a.openBill,
  };
}

async function postLoad(shopId, shopName, assessment, { force = false, note = '' } = {}) {
  const a = assessment;
  return notifyDiscord({
    title: `システム負荷: ${a.label}`,
    emoji: a.emoji,
    event: 'system_load',
    force,
    fields: loadFields(shopId, shopName, a, note),
  });
}

/**
 * Notify Discord when load level changes (debounced).
 */
export async function maybeNotifySystemLoad({
  shopId,
  shopName = '',
  orders = [],
  requests = [],
  force = false,
  cooldownMs = 90_000,
} = {}) {
  await loadNotifySettings().catch(() => {});
  const assessment = assessSystemLoad({ orders, requests });
  const prev = getLastLoadLevel(shopId);

  if (!force) {
    if (!isEventEnabled('system_load')) {
      return { ok: false, skipped: true, reason: 'event_off', assessment };
    }
    if (prev === assessment.level) {
      return { ok: true, skipped: true, reason: 'unchanged', assessment };
    }
    const upgraded = isUpgrade(prev, assessment.level);
    const elapsed = Date.now() - getLastNotifyAt(shopId);
    if (!upgraded && assessment.level !== 'critical' && elapsed < cooldownMs) {
      setLastLoadLevel(shopId, assessment.level);
      return { ok: true, skipped: true, reason: 'cooldown', assessment };
    }
  }

  const note = prev && prev !== assessment.level
    ? `負荷レベルが変化: ${(LOAD_LEVELS[prev] || {}).label || prev} → ${assessment.label}`
    : '厨房・オペレーションの混雑状況です';

  const res = await postLoad(shopId, shopName, assessment, { force, note });
  if (res.ok || force) {
    setLastLoadLevel(shopId, assessment.level);
    setLastNotifyAt(shopId);
  }
  return { ...res, assessment, prevLevel: prev || '—' };
}

/** Manual / test send — always posts */
export async function notifySystemLoadNow({
  shopId,
  shopName = '',
  orders = [],
  requests = [],
} = {}) {
  const assessment = assessSystemLoad({ orders, requests });
  const res = await postLoad(shopId, shopName, assessment, {
    force: true,
    note: '厨房・オペレーションの混雑状況です（手動送信）',
  });
  setLastLoadLevel(shopId, assessment.level);
  setLastNotifyAt(shopId);
  return { ...res, assessment };
}
