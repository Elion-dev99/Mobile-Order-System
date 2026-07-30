/**
 * Ops / admin event → Slack notifications (via Cloudflare Pages /api/notify).
 * Webhook URL is stored in Ops (localStorage + optional Firestore) or CF secret.
 */

const STORAGE_KEY = 'mos_slack_webhook';
const ENABLED_KEY = 'mos_slack_notify_enabled';
const API_PATH = '/api/notify';

export function getSlackWebhook() {
  try {
    return (localStorage.getItem(STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function setSlackWebhook(url) {
  const v = String(url || '').trim();
  try {
    if (v) localStorage.setItem(STORAGE_KEY, v);
    else localStorage.removeItem(STORAGE_KEY);
  } catch (_) {}
  return v;
}

export function isSlackNotifyEnabled() {
  try {
    const raw = localStorage.getItem(ENABLED_KEY);
    if (raw == null) return true; // default on once webhook exists / CF secret
    return raw === '1';
  } catch {
    return true;
  }
}

export function setSlackNotifyEnabled(on) {
  try {
    localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  } catch (_) {}
}

function isLikelySlackWebhook(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

function formatLines(fields = {}) {
  return Object.entries(fields)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `• *${k}:* ${v}`)
    .join('\n');
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.emoji]
 * @param {Record<string, string|number>} [opts.fields]
 * @param {string} [opts.footer]
 */
export async function notifySlack(opts = {}) {
  if (!isSlackNotifyEnabled()) return { ok: false, skipped: true, reason: 'disabled' };

  const title = String(opts.title || 'お知らせ').trim();
  const emoji = opts.emoji || ':bell:';
  const fields = opts.fields || {};
  const footer = opts.footer || 'QuickOrder Ops';
  const detail = formatLines(fields);
  const text = `${emoji} *${title}*\n${detail}${detail ? '\n' : ''}_${footer}_`.slice(0, 3500);

  const webhook = getSlackWebhook();
  const body = {
    text,
    username: 'QuickOrder',
    icon_emoji: ':fork_and_knife:',
  };
  if (webhook && isLikelySlackWebhook(webhook)) body.webhook = webhook;

  try {
    const res = await fetch(API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      console.warn('slack notify failed', res.status, data);
      return { ok: false, status: res.status, data };
    }
    return { ok: true, data };
  } catch (e) {
    console.warn('slack notify error', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Fire-and-forget wrapper */
export function notifySlackEvent(title, fields = {}, emoji = ':bell:') {
  return notifySlack({ title, fields, emoji }).catch(() => ({ ok: false }));
}

export async function testSlackNotify() {
  return notifySlack({
    title: 'Slack通知テスト',
    emoji: ':white_check_mark:',
    fields: {
      結果: '接続OK',
      時刻: new Date().toLocaleString('ja-JP'),
    },
  });
}

/* ——— typed ops events ——— */

export function notifyShopCreated(shop) {
  return notifySlackEvent('店舗を追加しました', {
    店舗名: shop?.name || shop?.id,
    店舗ID: shop?.id,
    プラン: shop?.planId,
    席数: shop?.tableCount,
  }, ':department_store:');
}

export function notifyShopDeleted(shopId, shopName) {
  return notifySlackEvent('店舗を削除しました', {
    店舗名: shopName || shopId,
    店舗ID: shopId,
  }, ':wastebasket:');
}

export function notifyMenuItemsAdded(shopId, shopName, items = []) {
  if (!items.length) return Promise.resolve({ ok: true, skipped: true });
  return notifySlackEvent('商品を追加しました', {
    店舗: shopName || shopId,
    店舗ID: shopId,
    件数: items.length,
    商品: items.map(i => `${i.emoji || ''} ${i.name}（¥${i.price}）`).join(', ').slice(0, 500),
  }, ':plus:');
}

export function notifyMenuItemsRemoved(shopId, shopName, items = []) {
  if (!items.length) return Promise.resolve({ ok: true, skipped: true });
  return notifySlackEvent('商品を削除しました', {
    店舗: shopName || shopId,
    店舗ID: shopId,
    件数: items.length,
    商品: items.map(i => `${i.emoji || ''} ${i.name}`).join(', ').slice(0, 500),
  }, ':x:');
}

export function notifyContractActivated(shop) {
  return notifySlackEvent('新規契約を有効化しました', {
    店舗: shop?.name || shop?.id,
    店舗ID: shop?.id || '',
    プラン: shop?.planId,
    課金: shop?.billingCycle || 'monthly',
  }, ':handshake:');
}

export function notifyLeadSubmitted(lead) {
  return notifySlackEvent('新規契約のお問い合わせ', {
    店舗名: lead?.shopName,
    メール: lead?.email,
    電話: lead?.phone,
    プラン: lead?.planName || lead?.planId,
    見込みMRR: lead?.estimatedMrr != null ? `¥${lead.estimatedMrr}` : '',
    席数: lead?.tables,
    メッセージ: (lead?.message || '').slice(0, 200),
  }, ':memo:');
}

export function notifyLeadWon(lead) {
  return notifySlackEvent('成約（リード）', {
    店舗名: lead?.shopName,
    プラン: lead?.planName || lead?.planId,
    見込みMRR: lead?.estimatedMrr != null ? `¥${lead.estimatedMrr}` : '',
    メール: lead?.email,
  }, ':tada:');
}

export function notifyPlanChanged(shop, prevPlanId, nextPlanId) {
  if (!prevPlanId || prevPlanId === nextPlanId) return Promise.resolve({ ok: true, skipped: true });
  return notifySlackEvent('契約プラン変更', {
    店舗: shop?.name || shop?.id,
    店舗ID: shop?.id,
    変更前: prevPlanId,
    変更後: nextPlanId,
  }, ':arrows_counterclockwise:');
}
