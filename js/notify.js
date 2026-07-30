/**
 * Discord / Ops notification settings + event dispatch.
 * Settings: localStorage + Firestore ops/settings.
 */

import { db } from './firebase.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const STORAGE_KEY = 'mos_discord_webhook';
const ENABLED_KEY = 'mos_discord_notify_enabled';
const EVENTS_KEY = 'mos_discord_events';
const CHANNEL_KEY = 'mos_discord_channel';
const SETUP_DONE_KEY = 'mos_discord_setup_done';
const API_PATH = '/api/notify';

/** Legacy Slack keys — migrate once if Discord empty */
const LEGACY = {
  webhook: 'mos_slack_webhook',
  enabled: 'mos_slack_notify_enabled',
  events: 'mos_slack_events',
  channel: 'mos_slack_channel',
  setupDone: 'mos_slack_setup_done',
};

export const NOTIFY_EVENTS = [
  { id: 'order_revenue', label: '注文売上（GMV）', defaultOn: true },
  { id: 'shop_created', label: '店舗の追加', defaultOn: true },
  { id: 'shop_deleted', label: '店舗の削除', defaultOn: true },
  { id: 'item_added', label: '商品の追加', defaultOn: true },
  { id: 'item_removed', label: '商品の削除', defaultOn: true },
  { id: 'lead_new', label: '新規契約のお問い合わせ（LP）', defaultOn: true },
  { id: 'lead_won', label: 'リード成約', defaultOn: true },
  { id: 'contract_activated', label: '課金・契約の有効化（MRR）', defaultOn: true },
  { id: 'plan_changed', label: 'プラン変更', defaultOn: true },
];

const EVENT_COLORS = {
  order_revenue: 0xfee75c,
  shop_created: 0x3dcf9a,
  shop_deleted: 0xff6b6b,
  item_added: 0x57f287,
  item_removed: 0xed4245,
  lead_new: 0x5865f2,
  lead_won: 0xfee75c,
  contract_activated: 0x57f287,
  plan_changed: 0xeb459e,
  test: 0x3dcf9a,
  default: 0x3dcf9a,
};

const defaultEvents = () =>
  Object.fromEntries(NOTIFY_EVENTS.map(e => [e.id, e.defaultOn]));

let settingsCache = null;
let loadPromise = null;

export function isLikelyDiscordWebhook(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'https:') return false;
    if (u.hostname !== 'discord.com' && u.hostname !== 'discordapp.com') return false;
    return /\/api\/webhooks\/\d+\/[\w-]+/.test(u.pathname);
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
    webhook = (localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY.webhook) || '').trim();
    // Drop legacy Slack URLs — Discord only
    if (webhook && !isLikelyDiscordWebhook(webhook)) webhook = '';
    const en = localStorage.getItem(ENABLED_KEY) ?? localStorage.getItem(LEGACY.enabled);
    enabled = en == null ? true : en === '1';
    channel = (localStorage.getItem(CHANNEL_KEY) || localStorage.getItem(LEGACY.channel) || '').trim();
    setupDone = localStorage.getItem(SETUP_DONE_KEY) === '1'
      || localStorage.getItem(LEGACY.setupDone) === '1';
    const raw = localStorage.getItem(EVENTS_KEY) || localStorage.getItem(LEGACY.events);
    if (raw) events = { ...events, ...JSON.parse(raw) };
  } catch (_) {}
  return { webhook, enabled, channel, setupDone, events, updatedAt: null, source: 'local' };
}

function writeLocalSettings(partial) {
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

export function getDiscordWebhook() {
  return (settingsCache?.webhook || readLocalSettings().webhook || '').trim();
}

/** @deprecated use getDiscordWebhook */
export function getSlackWebhook() {
  return getDiscordWebhook();
}

export function setDiscordWebhook(url) {
  writeLocalSettings({ webhook: String(url || '').trim() });
  return getDiscordWebhook();
}

export function setSlackWebhook(url) {
  return setDiscordWebhook(url);
}

export function isNotifyEnabled() {
  if (settingsCache) return !!settingsCache.enabled;
  return readLocalSettings().enabled;
}

export function isSlackNotifyEnabled() {
  return isNotifyEnabled();
}

export function setNotifyEnabled(on) {
  writeLocalSettings({ enabled: !!on });
}

export function setSlackNotifyEnabled(on) {
  setNotifyEnabled(on);
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
        let webhook = String(data.discordWebhook || data.slackWebhook || '').trim();
        if (webhook && !isLikelyDiscordWebhook(webhook)) webhook = '';
        const remote = {
          webhook: webhook || local.webhook,
          enabled: data.discordEnabled != null ? data.discordEnabled !== false
            : (data.slackEnabled !== false),
          channel: String(data.discordChannel || data.slackChannel || local.channel || '').trim(),
          setupDone: !!(data.discordSetupDone || data.slackSetupDone || local.setupDone),
          events: { ...defaultEvents(), ...(data.discordEvents || data.slackEvents || {}) },
          updatedAt: data.updatedAt || null,
          source: 'firestore',
        };
        if (remote.webhook || (remote.updatedAt && (!local.webhook || (remote.updatedAt > (local.updatedAt || 0))))) {
          settingsCache = remote;
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

  if (next.webhook && !isLikelyDiscordWebhook(next.webhook)) {
    throw new Error('discord.com の Webhook URL を入力してください');
  }

  writeLocalSettings(next);

  try {
    await setDoc(doc(db, 'ops', 'settings'), {
      discordWebhook: next.webhook,
      discordEnabled: next.enabled,
      discordChannel: next.channel,
      discordSetupDone: next.setupDone,
      discordEvents: next.events,
      // clear stale slack fields so UI doesn't think Slack is configured
      slackWebhook: '',
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
  const hasWebhook = isLikelyDiscordWebhook(settings.webhook) || !!api.hasEnvWebhook;
  return {
    settings,
    api,
    hasWebhook,
    ready: !!(settings.enabled && hasWebhook && api.functionReady),
    needsSetup: !settings.setupDone || !hasWebhook,
  };
}

function fieldsToEmbedFields(fields = {}) {
  return Object.entries(fields)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .slice(0, 25)
    .map(([name, value]) => ({
      name: String(name).slice(0, 256),
      value: String(value).slice(0, 1024),
      inline: String(value).length < 40,
    }));
}

/**
 * @param {object} opts
 * @param {string} [opts.event]
 * @param {string} opts.title
 * @param {string} [opts.emoji]
 * @param {Record<string, string|number>} [opts.fields]
 * @param {string} [opts.footer]
 */
export async function notifyDiscord(opts = {}) {
  await loadNotifySettings().catch(() => {});
  if (!opts.force && !isNotifyEnabled()) return { ok: false, skipped: true, reason: 'disabled' };
  if (!opts.force && opts.event && !isEventEnabled(opts.event)) {
    return { ok: false, skipped: true, reason: 'event_off' };
  }

  const title = String(opts.title || 'お知らせ').trim();
  const emoji = opts.emoji || '🔔';
  const channel = getNotifySettings().channel;
  const footer = opts.footer || (channel ? `QuickOrder Ops · #${channel}` : 'QuickOrder Ops');
  const embedFields = fieldsToEmbedFields(opts.fields || {});
  const color = EVENT_COLORS[opts.event] || EVENT_COLORS.default;

  const embeds = [{
    title: `${emoji} ${title}`.slice(0, 256),
    color,
    fields: embedFields,
    footer: { text: footer.slice(0, 200) },
    timestamp: new Date().toISOString(),
  }];

  const webhook = getDiscordWebhook();
  const body = {
    username: 'QuickOrder',
    embeds,
    event: opts.event || '',
  };
  if (webhook && isLikelyDiscordWebhook(webhook)) body.webhook = webhook;

  try {
    const res = await fetch(API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      console.warn('discord notify failed', res.status, data);
      return { ok: false, status: res.status, data };
    }
    return { ok: true, data };
  } catch (e) {
    console.warn('discord notify error', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Alias kept for older call sites */
export function notifySlack(opts) {
  return notifyDiscord(opts);
}

export function notifyDiscordEvent(title, fields = {}, emoji = '🔔', event = '') {
  return notifyDiscord({ title, fields, emoji, event }).catch(() => ({ ok: false }));
}

export function notifySlackEvent(title, fields = {}, emoji = '🔔', event = '') {
  return notifyDiscordEvent(title, fields, emoji, event);
}

export async function testDiscordNotify() {
  return notifyDiscord({
    title: 'Discord通知テスト',
    emoji: '✅',
    event: 'test',
    force: true,
    fields: {
      結果: '接続OK — QuickOrder のお知らせ設定が完了しています',
      時刻: new Date().toLocaleString('ja-JP'),
    },
  });
}

export async function testSlackNotify() {
  return testDiscordNotify();
}

const ALL_EVENT_SAMPLES = [
  {
    event: 'order_revenue',
    title: '注文売上',
    emoji: '💰',
    fields: {
      店舗: 'テスト焼肉',
      注文ID: 'ORD-TEST01',
      席: 3,
      売上: '¥2,420',
      本日累計: '¥18,700',
      商品: '特選カルビ ×2, ビール ×2',
      種別: 'テスト通知',
    },
  },
  {
    event: 'shop_created',
    title: '店舗を追加しました',
    emoji: '🏪',
    fields: { 店舗名: 'テスト焼肉', 店舗ID: 'test-yakiniku', プラン: 'growth', 席数: 20, 種別: 'テスト通知' },
  },
  {
    event: 'shop_deleted',
    title: '店舗を削除しました',
    emoji: '🗑️',
    fields: { 店舗名: 'テスト焼肉', 店舗ID: 'test-yakiniku', 種別: 'テスト通知' },
  },
  {
    event: 'item_added',
    title: '商品を追加しました',
    emoji: '➕',
    fields: { 店舗: 'テスト焼肉', 店舗ID: 'test-yakiniku', 件数: 2, 商品: '🥩 特選カルビ（¥1280）, 🥬 サンチュ（¥280）', 種別: 'テスト通知' },
  },
  {
    event: 'item_removed',
    title: '商品を削除しました',
    emoji: '❌',
    fields: { 店舗: 'テスト焼肉', 店舗ID: 'test-yakiniku', 件数: 1, 商品: '🧊 限定かき氷', 種別: 'テスト通知' },
  },
  {
    event: 'lead_new',
    title: '新規契約のお問い合わせ',
    emoji: '📝',
    fields: {
      店舗名: 'テスト食堂',
      メール: 'test@example.com',
      電話: '03-0000-0000',
      プラン: 'Growth',
      見込みMRR: '¥9,800',
      席数: 24,
      メッセージ: '導入を検討しています（テスト）',
      種別: 'テスト通知',
    },
  },
  {
    event: 'lead_won',
    title: '成約（リード）',
    emoji: '🎉',
    fields: { 店舗名: 'テスト食堂', プラン: 'Growth', 見込みMRR: '¥9,800', メール: 'test@example.com', 種別: 'テスト通知' },
  },
  {
    event: 'contract_activated',
    title: '新規契約を有効化しました',
    emoji: '🤝',
    fields: { 店舗: 'テスト食堂', 店舗ID: 'test-syokudo', プラン: 'growth', 課金: 'monthly', 種別: 'テスト通知' },
  },
  {
    event: 'plan_changed',
    title: '契約プラン変更',
    emoji: '🔄',
    fields: { 店舗: 'テスト食堂', 店舗ID: 'test-syokudo', 変更前: 'lite', 変更後: 'growth', 種別: 'テスト通知' },
  },
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Fire sample notifications for every configured event (ignores per-event toggles). */
export async function testAllDiscordEvents({ onProgress } = {}) {
  const results = [];
  for (let i = 0; i < ALL_EVENT_SAMPLES.length; i++) {
    const sample = ALL_EVENT_SAMPLES[i];
    if (typeof onProgress === 'function') {
      onProgress({ index: i + 1, total: ALL_EVENT_SAMPLES.length, event: sample.event, title: sample.title });
    }
    const res = await notifyDiscord({
      ...sample,
      force: true,
      footer: 'QuickOrder Ops · 全イベントテスト',
    });
    results.push({ event: sample.event, title: sample.title, ...res });
    if (i < ALL_EVENT_SAMPLES.length - 1) await sleep(900);
  }
  return {
    ok: results.every(r => r.ok || r.skipped),
    sent: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok && !r.skipped).length,
    results,
  };
}

/* ——— typed ops events ——— */

export function notifyShopCreated(shop) {
  return notifyDiscordEvent('店舗を追加しました', {
    店舗名: shop?.name || shop?.id,
    店舗ID: shop?.id,
    プラン: shop?.planId,
    席数: shop?.tableCount,
  }, '🏪', 'shop_created');
}

export function notifyShopDeleted(shopId, shopName) {
  return notifyDiscordEvent('店舗を削除しました', {
    店舗名: shopName || shopId,
    店舗ID: shopId,
  }, '🗑️', 'shop_deleted');
}

export function notifyMenuItemsAdded(shopId, shopName, items = []) {
  if (!items.length) return Promise.resolve({ ok: true, skipped: true });
  return notifyDiscordEvent('商品を追加しました', {
    店舗: shopName || shopId,
    店舗ID: shopId,
    件数: items.length,
    商品: items.map(i => `${i.emoji || ''} ${i.name}（¥${i.price}）`).join(', ').slice(0, 500),
  }, '➕', 'item_added');
}

export function notifyMenuItemsRemoved(shopId, shopName, items = []) {
  if (!items.length) return Promise.resolve({ ok: true, skipped: true });
  return notifyDiscordEvent('商品を削除しました', {
    店舗: shopName || shopId,
    店舗ID: shopId,
    件数: items.length,
    商品: items.map(i => `${i.emoji || ''} ${i.name}`).join(', ').slice(0, 500),
  }, '❌', 'item_removed');
}

export function notifyLeadSubmitted(lead) {
  return notifyDiscordEvent('新規契約のお問い合わせ（見込み収益）', {
    店舗名: lead?.shopName,
    メール: lead?.email,
    電話: lead?.phone,
    プラン: lead?.planName || lead?.planId,
    見込みMRR: lead?.estimatedMrr != null ? `¥${Number(lead.estimatedMrr).toLocaleString('ja-JP')}` : '',
    見込みARR: lead?.estimatedMrr != null ? `¥${Number(lead.estimatedMrr * 12).toLocaleString('ja-JP')}` : '',
    席数: lead?.tables,
    メッセージ: (lead?.message || '').slice(0, 200),
  }, '📝', 'lead_new');
}

export function notifyLeadWon(lead) {
  return notifyDiscordEvent('成約（SaaS収益）', {
    店舗名: lead?.shopName,
    プラン: lead?.planName || lead?.planId,
    見込みMRR: lead?.estimatedMrr != null ? `¥${Number(lead.estimatedMrr).toLocaleString('ja-JP')}` : '',
    見込みARR: lead?.estimatedMrr != null ? `¥${Number(lead.estimatedMrr * 12).toLocaleString('ja-JP')}` : '',
    メール: lead?.email,
  }, '🎉', 'lead_won');
}

export function notifyContractActivated(shop) {
  return notifyDiscordEvent('新規契約を有効化しました（MRR）', {
    店舗: shop?.name || shop?.id,
    店舗ID: shop?.id || '',
    プラン: shop?.planId,
    課金: shop?.billingCycle || 'monthly',
  }, '🤝', 'contract_activated');
}

export function notifyPlanChanged(shop, prevPlanId, nextPlanId) {
  if (!prevPlanId || prevPlanId === nextPlanId) return Promise.resolve({ ok: true, skipped: true });
  return notifyDiscordEvent('契約プラン変更', {
    店舗: shop?.name || shop?.id,
    店舗ID: shop?.id,
    変更前: prevPlanId,
    変更後: nextPlanId,
  }, '🔄', 'plan_changed');
}

function yenText(n) {
  return `¥${Number(n || 0).toLocaleString('ja-JP')}`;
}

function dayKey(shopId) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `mos_day_gmv_${shopId || 'default'}_${y}${m}${day}`;
}

function bumpDayGmv(shopId, amount) {
  const key = dayKey(shopId);
  let total = 0;
  try {
    total = Number(localStorage.getItem(key) || 0) || 0;
  } catch (_) {}
  total += Number(amount) || 0;
  try { localStorage.setItem(key, String(total)); } catch (_) {}
  return total;
}

/** Real (non-demo) order GMV → Discord */
export function notifyOrderRevenue(order, shopName = '') {
  if (!order || order.demo) return Promise.resolve({ ok: true, skipped: true, reason: 'demo' });
  const items = Array.isArray(order.items) ? order.items : [];
  const qty = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
  const itemLine = items
    .map(i => `${i.name || '商品'}×${i.qty || 1}`)
    .join(', ')
    .slice(0, 400);
  const dayGmv = bumpDayGmv(order.shopId, order.total);
  return notifyDiscordEvent('注文売上', {
    店舗: shopName || order.shopId || '',
    店舗ID: order.shopId || '',
    注文ID: order.id,
    席: order.tableNumber,
    売上: yenText(order.total),
    点数: qty,
    本日累計GMV: yenText(dayGmv),
    商品: itemLine,
  }, '💰', 'order_revenue');
}
