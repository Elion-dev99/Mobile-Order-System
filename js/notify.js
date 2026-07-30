/**
 * Slack / Ops notification settings + event dispatch.
 * Settings: localStorage + Firestore ops/settings (shared across devices when rules allow).
 */

import { db } from './firebase.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const STORAGE_KEY = 'mos_slack_webhook';
const ENABLED_KEY = 'mos_slack_notify_enabled';
const EVENTS_KEY = 'mos_slack_events';
const CHANNEL_KEY = 'mos_slack_channel';
const SETUP_DONE_KEY = 'mos_slack_setup_done';
const API_PATH = '/api/notify';
const OPS_DOC = 'ops/settings';

export const NOTIFY_EVENTS = [
  { id: 'shop_created', label: '店舗の追加', defaultOn: true },
  { id: 'shop_deleted', label: '店舗の削除', defaultOn: true },
  { id: 'item_added', label: '商品の追加', defaultOn: true },
  { id: 'item_removed', label: '商品の削除', defaultOn: true },
  { id: 'lead_new', label: '新規契約のお問い合わせ（LP）', defaultOn: true },
  { id: 'lead_won', label: 'リード成約', defaultOn: true },
  { id: 'contract_activated', label: '課金・契約の有効化', defaultOn: true },
  { id: 'plan_changed', label: 'プラン変更', defaultOn: true },
];

const defaultEvents = () =>
  Object.fromEntries(NOTIFY_EVENTS.map(e => [e.id, e.defaultOn]));

let settingsCache = null;
let loadPromise = null;

function isLikelySlackWebhook(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com' && u.pathname.includes('/services/');
  } catch {
    return false;
  }
}

function readLocalSettings() {
  let webhook = '';
  let enabled = true;
  let channel = '';
  let setupDone = false;
  let events = defaultEvents();
  try {
    webhook = (localStorage.getItem(STORAGE_KEY) || '').trim();
    const en = localStorage.getItem(ENABLED_KEY);
    enabled = en == null ? true : en === '1';
    channel = (localStorage.getItem(CHANNEL_KEY) || '').trim();
    setupDone = localStorage.getItem(SETUP_DONE_KEY) === '1';
    const raw = localStorage.getItem(EVENTS_KEY);
    if (raw) events = { ...events, ...JSON.parse(raw) };
  } catch (_) {}
  return { webhook, enabled, channel, setupDone, events, updatedAt: null, source: 'local' };
}

function writeLocalSettings( partial ) {
  const cur = readLocalSettings();
  const next = { ...cur, ...partial, events: { ...cur.events, ...(partial.events || {}) } };
  try {
    if (next.webhook) localStorage.setItem(STORAGE_KEY, next.webhook);
    else localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(ENABLED_KEY, next.enabled ? '1' : '0');
    localStorage.setItem(CHANNEL_KEY, next.channel || '');
    localStorage.setItem(EVENTS_KEY, JSON.stringify(next.events || defaultEvents()));
    localStorage.setItem(SETUP_DONE_KEY, next.setupDone ? '1' : '0');
  } catch (_) {}
  settingsCache = { ...next, source: 'local' };
  return settingsCache;
}

export function getSlackWebhook() {
  return (settingsCache?.webhook || readLocalSettings().webhook || '').trim();
}

export function setSlackWebhook(url) {
  writeLocalSettings({ webhook: String(url || '').trim() });
  return getSlackWebhook();
}

export function isSlackNotifyEnabled() {
  if (settingsCache) return !!settingsCache.enabled;
  return readLocalSettings().enabled;
}

export function setSlackNotifyEnabled(on) {
  writeLocalSettings({ enabled: !!on });
}

export function getNotifyEvents() {
  return { ...defaultEvents(), ...(settingsCache?.events || readLocalSettings().events || {}) };
}

export function isEventEnabled(eventId) {
  const events = getNotifyEvents();
  return events[eventId] !== false;
}

export function getNotifySettings() {
  return settingsCache || readLocalSettings();
}

export async function loadNotifySettings() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const local = readLocalSettings();
    settingsCache = local;
    try {
      const snap = await getDoc(doc(db, 'ops', 'settings'));
      if (snap.exists()) {
        const data = snap.data() || {};
        const remote = {
          webhook: String(data.slackWebhook || '').trim(),
          enabled: data.slackEnabled !== false,
          channel: String(data.slackChannel || '').trim(),
          setupDone: !!data.slackSetupDone,
          events: { ...defaultEvents(), ...(data.slackEvents || {}) },
          updatedAt: data.updatedAt || null,
          source: 'firestore',
        };
        // Prefer newer remote; if remote has webhook, use it
        if (remote.webhook || (remote.updatedAt && (!local.webhook || (remote.updatedAt > (local.updatedAt || 0))))) {
          settingsCache = {
            webhook: remote.webhook || local.webhook,
            enabled: remote.enabled,
            channel: remote.channel || local.channel,
            setupDone: remote.setupDone || local.setupDone,
            events: remote.events,
            updatedAt: remote.updatedAt,
            source: 'firestore',
          };
          writeLocalSettings(settingsCache);
        }
      }
    } catch (e) {
      console.warn('loadNotifySettings firestore failed', e);
    }
    return settingsCache;
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

export async function saveNotifySettings(partial = {}) {
  const cur = getNotifySettings();
  const next = {
    webhook: partial.webhook != null ? String(partial.webhook).trim() : cur.webhook,
    enabled: partial.enabled != null ? !!partial.enabled : cur.enabled,
    channel: partial.channel != null ? String(partial.channel).trim() : cur.channel,
    setupDone: partial.setupDone != null ? !!partial.setupDone : cur.setupDone,
    events: { ...defaultEvents(), ...cur.events, ...(partial.events || {}) },
    updatedAt: Date.now(),
  };

  if (next.webhook && !isLikelySlackWebhook(next.webhook)) {
    throw new Error('hooks.slack.com の Incoming Webhook URL を入力してください');
  }

  writeLocalSettings(next);

  try {
    await setDoc(doc(db, 'ops', 'settings'), {
      slackWebhook: next.webhook,
      slackEnabled: next.enabled,
      slackChannel: next.channel,
      slackSetupDone: next.setupDone,
      slackEvents: next.events,
      updatedAt: next.updatedAt,
    }, { merge: true });
    settingsCache = { ...next, source: 'firestore' };
  } catch (e) {
    console.warn('saveNotifySettings firestore failed; kept local', e);
    settingsCache = { ...next, source: 'local' };
  }
  return settingsCache;
}

export async function probeNotifyApi() {
  try {
    const res = await fetch(API_PATH, { method: 'GET', cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      status: res.status,
      hasEnvWebhook: !!data.hasEnvWebhook,
      functionReady: res.ok || res.status === 400 || res.status === 405,
      data,
    };
  } catch (e) {
    return { ok: false, functionReady: false, error: String(e?.message || e) };
  }
}

export async function getSetupStatus() {
  const settings = await loadNotifySettings();
  const api = await probeNotifyApi();
  const hasWebhook = isLikelySlackWebhook(settings.webhook) || !!api.hasEnvWebhook;
  return {
    settings,
    api,
    hasWebhook,
    ready: !!(settings.enabled && hasWebhook && api.functionReady),
    needsSetup: !settings.setupDone || !hasWebhook,
  };
}

function formatLines(fields = {}) {
  return Object.entries(fields)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `• *${k}:* ${v}`)
    .join('\n');
}

/**
 * @param {object} opts
 * @param {string} [opts.event]
 * @param {string} opts.title
 * @param {string} [opts.emoji]
 * @param {Record<string, string|number>} [opts.fields]
 * @param {string} [opts.footer]
 */
export async function notifySlack(opts = {}) {
  await loadNotifySettings().catch(() => {});
  if (!isSlackNotifyEnabled()) return { ok: false, skipped: true, reason: 'disabled' };
  if (opts.event && !isEventEnabled(opts.event)) {
    return { ok: false, skipped: true, reason: 'event_off' };
  }

  const title = String(opts.title || 'お知らせ').trim();
  const emoji = opts.emoji || ':bell:';
  const fields = opts.fields || {};
  const channel = getNotifySettings().channel;
  const footer = opts.footer || (channel ? `QuickOrder Ops · #${channel}` : 'QuickOrder Ops');
  const detail = formatLines(fields);
  const text = `${emoji} *${title}*\n${detail}${detail ? '\n' : ''}_${footer}_`.slice(0, 3500);

  const webhook = getSlackWebhook();
  const body = {
    text,
    username: 'QuickOrder',
    icon_emoji: ':fork_and_knife:',
    event: opts.event || '',
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

export function notifySlackEvent(title, fields = {}, emoji = ':bell:', event = '') {
  return notifySlack({ title, fields, emoji, event }).catch(() => ({ ok: false }));
}

export async function testSlackNotify() {
  return notifySlack({
    title: 'Slack通知テスト',
    emoji: ':white_check_mark:',
    fields: {
      結果: '接続OK — QuickOrder のお知らせ設定が完了しています',
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
  }, ':department_store:', 'shop_created');
}

export function notifyShopDeleted(shopId, shopName) {
  return notifySlackEvent('店舗を削除しました', {
    店舗名: shopName || shopId,
    店舗ID: shopId,
  }, ':wastebasket:', 'shop_deleted');
}

export function notifyMenuItemsAdded(shopId, shopName, items = []) {
  if (!items.length) return Promise.resolve({ ok: true, skipped: true });
  return notifySlackEvent('商品を追加しました', {
    店舗: shopName || shopId,
    店舗ID: shopId,
    件数: items.length,
    商品: items.map(i => `${i.emoji || ''} ${i.name}（¥${i.price}）`).join(', ').slice(0, 500),
  }, ':plus:', 'item_added');
}

export function notifyMenuItemsRemoved(shopId, shopName, items = []) {
  if (!items.length) return Promise.resolve({ ok: true, skipped: true });
  return notifySlackEvent('商品を削除しました', {
    店舗: shopName || shopId,
    店舗ID: shopId,
    件数: items.length,
    商品: items.map(i => `${i.emoji || ''} ${i.name}`).join(', ').slice(0, 500),
  }, ':x:', 'item_removed');
}

export function notifyContractActivated(shop) {
  return notifySlackEvent('新規契約を有効化しました', {
    店舗: shop?.name || shop?.id,
    店舗ID: shop?.id || '',
    プラン: shop?.planId,
    課金: shop?.billingCycle || 'monthly',
  }, ':handshake:', 'contract_activated');
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
  }, ':memo:', 'lead_new');
}

export function notifyLeadWon(lead) {
  return notifySlackEvent('成約（リード）', {
    店舗名: lead?.shopName,
    プラン: lead?.planName || lead?.planId,
    見込みMRR: lead?.estimatedMrr != null ? `¥${lead.estimatedMrr}` : '',
    メール: lead?.email,
  }, ':tada:', 'lead_won');
}

export function notifyPlanChanged(shop, prevPlanId, nextPlanId) {
  if (!prevPlanId || prevPlanId === nextPlanId) return Promise.resolve({ ok: true, skipped: true });
  return notifySlackEvent('契約プラン変更', {
    店舗: shop?.name || shop?.id,
    店舗ID: shop?.id,
    変更前: prevPlanId,
    変更後: nextPlanId,
  }, ':arrows_counterclockwise:', 'plan_changed');
}

export { isLikelySlackWebhook, OPS_DOC };
