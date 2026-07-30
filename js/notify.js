/**
 * Discord / Ops notification settings + event dispatch.
 * SaaS contract revenue (QuickOrder に入る利益) を含むオペレーション通知。
 */

import { db } from './firebase.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getPlan, estimateMrr, estimateSetup, estimateArr, planPrice, yen } from './plans.js';

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
  { id: 'system_load', label: 'システム負荷・混雑状況', defaultOn: true },
  { id: 'system_health', label: 'サーバー障害・復旧', defaultOn: true },
  { id: 'lead_new', label: '見込み契約利益（問い合わせ）', defaultOn: true },
  { id: 'lead_won', label: '成約利益（リード成約）', defaultOn: true },
  { id: 'contract_activated', label: '契約収益（課金開始・MRR）', defaultOn: true },
  { id: 'plan_changed', label: 'プラン変更によるMRR増減', defaultOn: true },
  { id: 'shop_created', label: '店舗の追加', defaultOn: true },
  { id: 'shop_deleted', label: '店舗の削除', defaultOn: true },
  { id: 'item_added', label: '商品の追加', defaultOn: true },
  { id: 'item_removed', label: '商品の削除', defaultOn: true },
  { id: 'bill_request', label: '客席からの会計リクエスト', defaultOn: true },
];

const EVENT_COLORS = {
  system_load: 0xfaa61a,
  system_health: 0xed4245,
  lead_new: 0x5865f2,
  lead_won: 0xfee75c,
  contract_activated: 0x57f287,
  plan_changed: 0xeb459e,
  shop_created: 0x3dcf9a,
  shop_deleted: 0xff6b6b,
  item_added: 0x57f287,
  item_removed: 0xed4245,
  bill_request: 0xfaa61a,
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
  // Webhook が入っていれば初期設定は完了扱い（黄色いバナーを出さない）
  if (hasWebhook && !settings.setupDone) {
    try {
      await saveNotifySettings({ setupDone: true });
    } catch (_) {}
  }
  const refreshed = getNotifySettings();
  return {
    settings: refreshed,
    api,
    hasWebhook,
    ready: !!(refreshed.enabled !== false && hasWebhook && api.functionReady),
    needsSetup: !hasWebhook,
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
    event: 'system_health',
    title: 'システム障害: 一部障害',
    emoji: '🟡',
    fields: {
      状態: '🟡 一部障害',
      Firestore: 'NG firestore_timeout',
      通知API: 'OK',
      回線: 'オンライン',
      対処: '一部サービスのみ障害です（DBまたは通知）',
      種別: 'テスト通知',
    },
  },
  {
    event: 'system_load',
    title: 'システム負荷: 混雑',
    emoji: '🟠',
    fields: {
      内容: '負荷レベルが変化: やや混雑 → 混雑',
      店舗: 'テスト焼肉',
      レベル: '🟠 混雑',
      予想待ち: '22分',
      未完了注文: 7,
      受付中: 3,
      調理中: 4,
      '15分超滞留': 1,
      未対応呼出: 2,
      種別: 'テスト通知',
    },
  },
  {
    event: 'lead_new',
    title: '見込み契約利益（問い合わせ）',
    emoji: '💰',
    fields: {
      内容: 'QuickOrderに入る見込みの契約収益です',
      店舗名: 'テスト食堂',
      プラン: 'Growth',
      見込みMRR: '¥14,800/月',
      見込みARR: '¥177,600/年',
      初期費用: '¥49,800',
      初回入金目安: '¥64,600',
      種別: 'テスト通知',
    },
  },
  {
    event: 'lead_won',
    title: '成約利益',
    emoji: '🎉',
    fields: {
      内容: 'リードが成約しました（契約パイプライン）',
      店舗名: 'テスト食堂',
      プラン: 'Growth',
      確定見込みMRR: '¥14,800/月',
      確定見込みARR: '¥177,600/年',
      初期費用: '¥49,800',
      種別: 'テスト通知',
    },
  },
  {
    event: 'contract_activated',
    title: '契約収益が発生（課金開始）',
    emoji: '💵',
    fields: {
      内容: 'プラン課金が有効化されました（QuickOrderの売上）',
      店舗: 'テスト食堂',
      プラン: 'Growth',
      月額MRR: '¥14,800',
      年額ARR: '¥177,600',
      初期費用: '¥49,800',
      初回請求目安: '¥64,600',
      種別: 'テスト通知',
    },
  },
  {
    event: 'plan_changed',
    title: 'プラン変更によるMRR増減',
    emoji: '📈',
    fields: {
      内容: '契約プラン変更で入ってくる利益が変わりました',
      店舗: 'テスト食堂',
      変更前: 'Lite（¥6,980）',
      変更後: 'Growth（¥14,800）',
      MRR増減: '+¥7,820/月',
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
    event: 'bill_request',
    title: '会計リクエスト',
    emoji: '🧾',
    fields: {
      店舗: 'テスト焼肉',
      店舗ID: 'test-yakiniku',
      席番号: '5',
      案内: 'お客様はレジへ向かいます。追加注文はロック済みです',
      種別: 'テスト通知',
    },
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
  const planId = lead?.planId || 'growth';
  const plan = getPlan(planId);
  const stores = Number(lead?.stores) || 1;
  const cycle = lead?.billingCycle || 'monthly';
  const mrr = Number(lead?.estimatedMrr) || estimateMrr({ planId, stores, cycle });
  const setup = estimateSetup(planId);
  const first = mrr + setup;
  return notifyDiscordEvent('見込み契約利益（問い合わせ）', {
    内容: 'QuickOrderに入る見込みの契約収益です',
    店舗名: lead?.shopName,
    メール: lead?.email,
    電話: lead?.phone,
    プラン: lead?.planName || plan.name,
    課金: cycle === 'annual' ? '年払い' : '月払い',
    見込みMRR: `¥${yen(mrr)}/月`,
    見込みARR: `¥${yen(estimateArr(mrr))}/年`,
    初期費用: `¥${yen(setup)}`,
    初回入金目安: `¥${yen(first)}`,
    席数: lead?.tables,
    メッセージ: (lead?.message || '').slice(0, 200),
  }, '💰', 'lead_new');
}

export function notifyLeadWon(lead) {
  const planId = lead?.planId || 'growth';
  const plan = getPlan(planId);
  const stores = Number(lead?.stores) || 1;
  const cycle = lead?.billingCycle || 'monthly';
  const mrr = Number(lead?.estimatedMrr) || estimateMrr({ planId, stores, cycle });
  const setup = estimateSetup(planId);
  return notifyDiscordEvent('成約利益', {
    内容: 'リードが成約しました（QuickOrderの契約パイプライン）',
    店舗名: lead?.shopName,
    プラン: lead?.planName || plan.name,
    確定見込みMRR: `¥${yen(mrr)}/月`,
    確定見込みARR: `¥${yen(estimateArr(mrr))}/年`,
    初期費用: `¥${yen(setup)}`,
    初回入金目安: `¥${yen(mrr + setup)}`,
    メール: lead?.email,
  }, '🎉', 'lead_won');
}

export function notifyContractActivated(shop) {
  const planId = shop?.planId || 'growth';
  const plan = getPlan(planId);
  const stores = Number(shop?.stores) || 1;
  const cycle = shop?.billingCycle || 'monthly';
  const mrr = estimateMrr({ planId, stores, cycle });
  const setup = estimateSetup(planId);
  const price = planPrice(plan, cycle);
  return notifyDiscordEvent('契約収益が発生（課金開始）', {
    内容: 'プラン課金が有効化されました — QuickOrderに入る売上です',
    店舗: shop?.name || shop?.id,
    店舗ID: shop?.id || '',
    プラン: plan.name,
    課金: cycle === 'annual' ? '年払い' : '月払い',
    月額MRR: `¥${yen(mrr)}`,
    年額ARR: `¥${yen(estimateArr(mrr))}`,
    初期費用: `¥${yen(setup)}`,
    今回の請求目安: cycle === 'annual'
      ? `¥${yen(price.chargeNow + setup)}（年額+初期）`
      : `¥${yen(mrr + setup)}（初月+初期）`,
  }, '💵', 'contract_activated');
}

export function notifyPlanChanged(shop, prevPlanId, nextPlanId) {
  if (!prevPlanId || prevPlanId === nextPlanId) return Promise.resolve({ ok: true, skipped: true });
  const stores = Number(shop?.stores) || 1;
  const cycle = shop?.billingCycle || 'monthly';
  const prev = getPlan(prevPlanId);
  const next = getPlan(nextPlanId);
  const prevMrr = estimateMrr({ planId: prevPlanId, stores, cycle });
  const nextMrr = estimateMrr({ planId: nextPlanId, stores, cycle });
  const delta = nextMrr - prevMrr;
  const deltaText = `${delta >= 0 ? '+' : ''}¥${yen(delta)}/月`;
  return notifyDiscordEvent('プラン変更によるMRR増減', {
    内容: '契約プラン変更で、QuickOrderに入る月額利益が変わりました',
    店舗: shop?.name || shop?.id,
    店舗ID: shop?.id,
    変更前: `${prev.name}（¥${yen(prevMrr)}/月）`,
    変更後: `${next.name}（¥${yen(nextMrr)}/月）`,
    MRR増減: deltaText,
    ARR影響: `${delta >= 0 ? '+' : ''}¥${yen(estimateArr(delta))}/年`,
  }, delta >= 0 ? '📈' : '📉', 'plan_changed');
}

export function notifyBillRequested({ shopId, shopName, tableNumber, requestId } = {}) {
  return notifyDiscordEvent('会計リクエスト', {
    店舗: shopName || shopId,
    店舗ID: shopId,
    席番号: String(tableNumber ?? ''),
    案内: 'お客様はレジへ向かいます。追加注文はロック済みです',
    リクエストID: requestId || '—',
  }, '🧾', 'bill_request');
}
