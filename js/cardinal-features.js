/**
 * Cardinal capability registry, timeline, quiet hours, diagnose, digest, anomalies.
 */

import { checkSystemHealth, listPendingOrders, getLastHealthState, playbookFor } from './health.js';
import { getMaintenance, isMaintenanceMode, getScheduleEval, describeSchedule } from './maintenance.js';
import { getAutoHealState } from './auto-heal.js';
import { notifyDiscord, loadNotifySettings, probeNotifyApi } from './notify.js';
import { getOpsApiSecret } from './ops-secret.js';

const PREFS_KEY = 'mos_cardinal_prefs';
const TIMELINE_KEY = 'mos_cardinal_timeline';
const DIGEST_AT_KEY = 'mos_cardinal_last_digest_at';
const ANOMALY_AT_KEY = 'mos_cardinal_last_anomaly_at';

/** Toggleable Cardinal capabilities (Ops UI). */
export const CARDINAL_CAPABILITIES = [
  {
    id: 'autoMaintenance',
    label: '障害時自動メンテ',
    description: 'Firestore/サイト障害でメンテナンスを自動 ON',
    defaultOn: true,
  },
  {
    id: 'dispatchOnOutage',
    label: '障害時 Executor 起動',
    description: '連続障害で Cursor Executor を起動',
    defaultOn: true,
  },
  {
    id: 'watchdog',
    label: '相互ウォッチドッグ',
    description: 'Guardian/Executor 無応答時に相手を起こす',
    defaultOn: true,
  },
  {
    id: 'anomalyScan',
    label: '店舗異常スキャン',
    description: '営業中なのに注文ゼロ・保留キュー過多を検知',
    defaultOn: true,
  },
  {
    id: 'dailyDigest',
    label: '日次ダイジェスト',
    description: '1日1回 Discord に健全性サマリを送信',
    defaultOn: true,
  },
  {
    id: 'quietHours',
    label: '静穏時間',
    description: '深夜は warning 以下の Discord/起動を抑制（down は除く）',
    defaultOn: true,
  },
  {
    id: 'timeline',
    label: 'アクション履歴',
    description: 'Cardinal の判断を Ops に残す',
    defaultOn: true,
  },
];

export function defaultCardinalPrefs() {
  return {
    capabilities: Object.fromEntries(CARDINAL_CAPABILITIES.map((c) => [c.id, c.defaultOn])),
    quietStart: '23:00',
    quietEnd: '08:00',
    timezone: 'Asia/Tokyo',
    anomalyZeroOrderHours: 3,
    anomalyPendingWarn: 5,
    digestHourJst: 9,
    updatedAt: 0,
  };
}

export function loadCardinalPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') || {};
    const base = defaultCardinalPrefs();
    return {
      ...base,
      ...raw,
      capabilities: { ...base.capabilities, ...(raw.capabilities || {}) },
    };
  } catch {
    return defaultCardinalPrefs();
  }
}

export function saveCardinalPrefs(partial = {}) {
  const cur = loadCardinalPrefs();
  const next = {
    ...cur,
    ...partial,
    capabilities: { ...cur.capabilities, ...(partial.capabilities || {}) },
    updatedAt: Date.now(),
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}

export function isCapabilityOn(id, prefs = loadCardinalPrefs()) {
  return prefs.capabilities?.[id] !== false;
}

function hmToMin(hm) {
  const [h, m] = String(hm || '0:0').split(':').map(Number);
  return (h * 60) + (m || 0);
}

export function isQuietHours(prefs = loadCardinalPrefs(), now = new Date()) {
  if (!isCapabilityOn('quietHours', prefs)) return false;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: prefs.timezone || 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    const mins = (Number(parts.hour) || 0) * 60 + (Number(parts.minute) || 0);
    const start = hmToMin(prefs.quietStart || '23:00');
    const end = hmToMin(prefs.quietEnd || '08:00');
    if (start === end) return false;
    if (start < end) return mins >= start && mins < end;
    return mins >= start || mins < end;
  } catch {
    return false;
  }
}

export function pushCardinalTimeline(entry) {
  if (!isCapabilityOn('timeline')) return;
  const row = {
    id: 'ev_' + Math.random().toString(36).slice(2, 8),
    at: Date.now(),
    ...entry,
  };
  let list = [];
  try { list = JSON.parse(localStorage.getItem(TIMELINE_KEY) || '[]') || []; } catch (_) {}
  list.unshift(row);
  try { localStorage.setItem(TIMELINE_KEY, JSON.stringify(list.slice(0, 80))); } catch (_) {}
  return row;
}

export function listCardinalTimeline(limit = 40) {
  try {
    const list = JSON.parse(localStorage.getItem(TIMELINE_KEY) || '[]') || [];
    return list.slice(0, limit);
  } catch {
    return [];
  }
}

export function clearCardinalTimeline() {
  try { localStorage.removeItem(TIMELINE_KEY); } catch (_) {}
}

/** Full self-diagnosis for Ops / Discord. */
export async function runCardinalDiagnose({ shops = [], orders = [] } = {}) {
  await loadNotifySettings().catch(() => {});
  const health = await checkSystemHealth();
  const notify = await probeNotifyApi();
  const maint = getMaintenance();
  const sched = getScheduleEval();
  const heal = getAutoHealState();
  const prefs = loadCardinalPrefs();
  const pending = listPendingOrders().length;
  const secret = !!getOpsApiSecret();
  const checks = [
    {
      id: 'firestore',
      ok: !!health.firestore?.ok,
      label: 'Firestore',
      detail: health.firestore?.ok
        ? `OK ${health.firestore.latencyMs || ''}ms`
        : (health.firestore?.error || 'NG'),
    },
    {
      id: 'notifyApi',
      ok: !!notify.functionReady,
      label: '通知API',
      detail: notify.functionReady ? 'OK' : (notify.error || 'NG'),
    },
    {
      id: 'opsSecret',
      ok: secret,
      label: 'Ops鍵',
      detail: secret ? 'ブラウザに保存済' : '未設定（鍵タブへ）',
    },
    {
      id: 'maintenance',
      ok: !isMaintenanceMode(),
      label: 'メンテ',
      detail: isMaintenanceMode()
        ? `ON (${maint.source || 'schedule'})`
        : 'OFF',
    },
    {
      id: 'schedule',
      ok: true,
      label: 'スケジュール',
      detail: `${describeSchedule(maint.schedule)} · ${sched.active ? '窓内' : '窓外'}`,
    },
    {
      id: 'pending',
      ok: pending < (prefs.anomalyPendingWarn || 5),
      label: '保留注文',
      detail: `${pending}件`,
    },
    {
      id: 'autoHeal',
      ok: (heal.consecutiveFails || 0) < 2,
      label: 'AutoHeal連続失敗',
      detail: String(heal.consecutiveFails || 0),
    },
  ];

  const anomalies = scanBusinessAnomalies({ shops, orders, prefs });
  const score = checks.filter((c) => c.ok).length;
  const report = {
    ok: checks.every((c) => c.ok) && !anomalies.find((a) => a.severity === 'critical'),
    score: `${score}/${checks.length}`,
    health,
    checks,
    anomalies,
    playbook: playbookFor(health.status),
    prefs,
    at: Date.now(),
  };
  pushCardinalTimeline({
    type: 'diagnose',
    severity: report.ok ? 'info' : 'warning',
    summary: `自己診断 ${report.score} · health=${health.status}`,
  });
  return report;
}

/** Business anomalies from live Ops order/shop lists. */
export function scanBusinessAnomalies({ shops = [], orders = [], prefs = loadCardinalPrefs() } = {}) {
  const findings = [];
  const pending = listPendingOrders().length;
  const warnPending = Number(prefs.anomalyPendingWarn) || 5;
  if (pending >= warnPending) {
    findings.push({
      id: 'pending_spike',
      severity: pending >= warnPending * 2 ? 'critical' : 'warning',
      title: '保留注文が多い',
      detail: `端末キュー ${pending}件（閾値 ${warnPending}）`,
    });
  }

  const zeroHours = Number(prefs.anomalyZeroOrderHours) || 3;
  const since = Date.now() - zeroHours * 3600_000;
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);

  for (const shop of shops || []) {
    if (shop.isOpen === false) continue;
    if (shop.loadTest || String(shop.id || '').startsWith('load-')) continue;
    const shopOrders = (orders || []).filter((o) => (o.shopId || 'default') === shop.id && !o.demo);
    const recent = shopOrders.filter((o) => (o.timestamp || 0) >= since);
    const today = shopOrders.filter((o) => (o.timestamp || 0) >= startToday.getTime());
    // Only flag if shop has history or is subscribed/trial — avoid brand-new empty shops noise
    if (shopOrders.length >= 3 && recent.length === 0) {
      findings.push({
        id: `zero_${shop.id}`,
        severity: 'warning',
        title: '注文が止まっている店舗',
        detail: `${shop.name || shop.id}: 直近${zeroHours}時間 0件（本日累計 ${today.length}）`,
        shopId: shop.id,
      });
    }
  }

  if (isMaintenanceMode()) {
    const m = getMaintenance();
    findings.push({
      id: 'maintenance_on',
      severity: m.source === 'cardinal' ? 'critical' : 'info',
      title: 'メンテナンス中',
      detail: `${m.source || 'flag'} · ${m.message || ''}`.slice(0, 160),
    });
  }

  return findings;
}

export async function maybeNotifyAnomalies(findings, { force = false } = {}) {
  if (!findings?.length) return { skipped: true, reason: 'none' };
  if (!isCapabilityOn('anomalyScan')) return { skipped: true, reason: 'disabled' };
  const prefs = loadCardinalPrefs();
  const critical = findings.some((f) => f.severity === 'critical');
  if (!force && isQuietHours(prefs) && !critical) {
    return { skipped: true, reason: 'quiet_hours' };
  }
  const last = Number(localStorage.getItem(ANOMALY_AT_KEY) || 0);
  if (!force && Date.now() - last < 60 * 60 * 1000) {
    return { skipped: true, reason: 'cooldown' };
  }
  const top = findings.slice(0, 6);
  await notifyDiscord({
    title: `Cardinal 異常スキャン（${findings.length}件）`,
    emoji: critical ? '🚨' : '👀',
    event: 'system_health',
    force: true,
    fields: Object.fromEntries(top.map((f, i) => [`${i + 1}.${f.title}`, f.detail])),
  });
  try { localStorage.setItem(ANOMALY_AT_KEY, String(Date.now())); } catch (_) {}
  pushCardinalTimeline({
    type: 'anomaly',
    severity: critical ? 'critical' : 'warning',
    summary: `異常 ${findings.length}件を通知`,
  });
  return { ok: true, count: findings.length };
}

export async function buildDailyDigest({ shops = [], orders = [] } = {}) {
  const health = getLastHealthState() || await checkSystemHealth();
  const pending = listPendingOrders().length;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = (orders || []).filter((o) => !o.demo && (o.timestamp || 0) >= start.getTime());
  const gmv = today.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const maint = isMaintenanceMode();
  const anomalies = scanBusinessAnomalies({ shops, orders });
  return {
    at: Date.now(),
    health: health.status || 'unknown',
    shops: (shops || []).length,
    ordersToday: today.length,
    gmvToday: gmv,
    pending,
    maintenance: maint,
    anomalies: anomalies.length,
    topAnomalies: anomalies.slice(0, 3),
  };
}

export async function maybeSendDailyDigest(ctx = {}, { force = false } = {}) {
  if (!isCapabilityOn('dailyDigest') && !force) return { skipped: true, reason: 'disabled' };
  const prefs = loadCardinalPrefs();
  const hour = Number(prefs.digestHourJst);
  let hourNow = new Date().getHours();
  try {
    hourNow = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: prefs.timezone || 'Asia/Tokyo',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date()).find((p) => p.type === 'hour')?.value) || hourNow;
  } catch (_) {}

  const last = Number(localStorage.getItem(DIGEST_AT_KEY) || 0);
  const dayKey = new Date().toLocaleDateString('en-CA', { timeZone: prefs.timezone || 'Asia/Tokyo' });
  let lastDay = '';
  try {
    lastDay = new Date(last).toLocaleDateString('en-CA', { timeZone: prefs.timezone || 'Asia/Tokyo' });
  } catch (_) {}

  if (!force) {
    if (hourNow !== hour) return { skipped: true, reason: 'wrong_hour', hourNow, hour };
    if (lastDay === dayKey) return { skipped: true, reason: 'already_sent' };
  }

  const digest = await buildDailyDigest(ctx);
  await notifyDiscord({
    title: 'Cardinal 日次ダイジェスト',
    emoji: '📊',
    event: 'system_health',
    force: true,
    fields: {
      ヘルス: digest.health,
      店舗数: String(digest.shops),
      本日注文: String(digest.ordersToday),
      本日GMV: `¥${Number(digest.gmvToday || 0).toLocaleString('ja-JP')}`,
      保留: String(digest.pending),
      メンテ: digest.maintenance ? 'ON' : 'OFF',
      異常: String(digest.anomalies),
    },
  });
  try { localStorage.setItem(DIGEST_AT_KEY, String(Date.now())); } catch (_) {}
  pushCardinalTimeline({
    type: 'digest',
    severity: 'info',
    summary: `日次ダイジェスト送信 · orders=${digest.ordersToday}`,
  });
  return { ok: true, digest };
}

/** Should Cardinal suppress non-critical Discord/dispatch? */
export function shouldSuppressNoise(severity = 'warning', prefs = loadCardinalPrefs()) {
  if (severity === 'critical' || severity === 'down') return false;
  return isQuietHours(prefs);
}
