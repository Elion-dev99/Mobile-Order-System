/**
 * Cardinal dual-agent system (SAO-inspired):
 *   Guardian  — monitor health, review PRs, dispatch Executor, watchdog Executor
 *   Executor  — implement/fix, open PRs, watchdog Guardian
 *
 * Coordination bus: /api/cardinal + Discord + local heartbeats.
 * Cursor Automations (dashboard) are the long-running "bodies"; this module
 * is the in-app nervous system that detects, escalates, and reports.
 */

import {
  checkSystemHealth,
  listPendingOrders,
  getLastHealthState,
} from './health.js';
import {
  getDiscordWebhook,
  isLikelyDiscordWebhook,
  notifyDiscord,
  loadNotifySettings,
} from './notify.js';
import {
  escalateToCursor,
  runAutoHealCycle,
  getAutoHealState,
  startAutoHeal,
} from './auto-heal.js';
import { opsAuthHeaders } from './ops-secret.js';
import {
  loadCardinalPrefs,
  isCapabilityOn,
  shouldSuppressNoise,
  pushCardinalTimeline,
  listCardinalTimeline,
  runCardinalDiagnose,
  scanBusinessAnomalies,
  maybeNotifyAnomalies,
  maybeSendDailyDigest,
  CARDINAL_CAPABILITIES,
} from './cardinal-features.js';

const STATE_KEY = 'mos_cardinal_state';
const CARDINAL_PATH = '/api/cardinal';

export {
  loadCardinalPrefs,
  saveCardinalPrefs,
  CARDINAL_CAPABILITIES,
  listCardinalTimeline,
  clearCardinalTimeline,
  pushCardinalTimeline,
  runCardinalDiagnose,
  scanBusinessAnomalies,
  maybeNotifyAnomalies,
  buildDailyDigest,
  maybeSendDailyDigest,
  isQuietHours,
  isCapabilityOn,
} from './cardinal-features.js';

export const ROLES = {
  guardian: {
    id: 'guardian',
    name: 'Guardian',
    label: '監視体',
    duty: 'ヘルス監視・PRレビュー・Executor監視・タスク起票',
  },
  executor: {
    id: 'executor',
    name: 'Executor',
    label: '実行体',
    duty: '障害修正・機能実装・PR作成・Guardian監視',
  },
};

const DEFAULT_STATE = () => ({
  enabled: true,
  guardian: { lastHeartbeatAt: 0, status: 'unknown', detail: '', lastDispatchAt: 0 },
  executor: { lastHeartbeatAt: 0, status: 'unknown', detail: '', lastDispatchAt: 0 },
  lastCycleAt: 0,
  lastIncidentAt: 0,
  cycles: 0,
  dispatches: 0,
  updatedAt: 0,
});

let started = false;
let timer = null;

export function loadCardinalState() {
  try {
    return { ...DEFAULT_STATE(), ...(JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {}) };
  } catch {
    return DEFAULT_STATE();
  }
}

function saveCardinalState(state) {
  const next = { ...state, updatedAt: Date.now() };
  try { localStorage.setItem(STATE_KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}

function staleMs(at, slaMs) {
  if (!at) return Infinity;
  return Date.now() - at;
}

function isStale(at, slaMs) {
  return !at || staleMs(at, slaMs) > slaMs;
}

/**
 * Post to Cardinal API (heartbeat / dispatch / status).
 */
export async function cardinalApi(action, payload = {}) {
  const webhook = getDiscordWebhook();
  const body = {
    action,
    ...payload,
    source: 'quickorder-cardinal',
    url: typeof location !== 'undefined' ? location.href : '',
    at: Date.now(),
  };
  if (webhook && isLikelyDiscordWebhook(webhook)) body.webhook = webhook;

  try {
    const res = await fetch(CARDINAL_PATH, {
      method: 'POST',
      headers: opsAuthHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function recordHeartbeat(role, { status = 'ok', detail = '' } = {}) {
  const id = ROLES[role] ? role : 'guardian';
  const state = loadCardinalState();
  state[id] = {
    ...(state[id] || {}),
    lastHeartbeatAt: Date.now(),
    status,
    detail: String(detail || '').slice(0, 500),
  };
  saveCardinalState(state);
  await cardinalApi('heartbeat', { role: id, status, detail }).catch(() => {});
  return state;
}

/**
 * Dispatch a Cursor Automation / Cloud Agent for a role.
 */
export async function dispatchRole(role, task = {}) {
  const id = ROLES[role] ? role : 'executor';
  const prefs = loadCardinalPrefs();
  if (!task.force && task.kind === 'incident' && !isCapabilityOn('dispatchOnOutage', prefs)) {
    return { ok: false, skipped: true, reason: 'capability_off', role: id };
  }
  if (!task.force && task.kind === 'watchdog' && !isCapabilityOn('watchdog', prefs)) {
    return { ok: false, skipped: true, reason: 'capability_off', role: id };
  }
  if (!task.force && shouldSuppressNoise(task.severity || 'warning', prefs) && task.kind !== 'incident') {
    pushCardinalTimeline({
      type: 'dispatch_suppressed',
      severity: 'info',
      summary: `${id} 起動を静穏時間で抑制 (${task.kind || 'ops'})`,
    });
    return { ok: false, skipped: true, reason: 'quiet_hours', role: id };
  }
  const state = loadCardinalState();
  const cooldownMs = Number(task.cooldownMs) || 20 * 60 * 1000;
  if (Date.now() - (state[id]?.lastDispatchAt || 0) < cooldownMs && !task.force) {
    return { ok: false, skipped: true, reason: 'cooldown', role: id };
  }

  const res = await cardinalApi('dispatch', {
    role: id,
    task: {
      title: task.title || `${ROLES[id].label}タスク`,
      summary: task.summary || task.message || '',
      severity: task.severity || 'warning',
      kind: task.kind || 'ops',
      acceptance: task.acceptance || [],
      ...task,
    },
  });

  // Fallback: legacy incident endpoint (Executor-shaped)
  if (!res.ok && id === 'executor') {
    const fallback = await escalateToCursor({
      status: task.status || 'cardinal',
      severity: task.severity || 'warning',
      summary: task.summary || task.title || 'Cardinal Executor 起動',
      message: task.message || 'Cardinal が Executor を起動しました',
      cardinalRole: 'executor',
      ...task,
    });
    if (fallback.ok) {
      state.executor.lastDispatchAt = Date.now();
      state.dispatches = (state.dispatches || 0) + 1;
      saveCardinalState(state);
      return { ok: true, role: id, via: 'incident', ...fallback };
    }
  }

  if (res.ok) {
    state[id] = { ...(state[id] || {}), lastDispatchAt: Date.now() };
    state.dispatches = (state.dispatches || 0) + 1;
    saveCardinalState(state);
    pushCardinalTimeline({
      type: 'dispatch',
      severity: task.severity || 'warning',
      summary: `${ROLES[id].name} 起動 · ${task.kind || 'ops'} · ${String(task.summary || task.title || '').slice(0, 80)}`,
    });
    await notifyDiscord({
      title: `Cardinal ${ROLES[id].name} 起動`,
      emoji: id === 'guardian' ? '👁' : '🛠',
      event: 'system_health',
      force: true,
      fields: {
        役割: `${ROLES[id].label}（${ROLES[id].name}）`,
        要約: String(task.summary || task.title || '').slice(0, 200) || '—',
        重要度: task.severity || 'warning',
      },
    }).catch(() => {});
  }
  return { ...res, role: id };
}

/**
 * One Cardinal cycle:
 * 1) health + auto-heal
 * 2) local heartbeats for both roles (Ops acts as temporary body)
 * 3) if health bad → Executor
 * 4) if peer heartbeat stale → wake the other role
 */
export async function runCardinalCycle({
  guardianSlaMs = 90 * 60 * 1000,
  executorSlaMs = 90 * 60 * 1000,
  escalateAfterFails = 2,
  shops = [],
  orders = [],
} = {}) {
  await loadNotifySettings().catch(() => {});
  const prefs = loadCardinalPrefs();
  const heal = await runAutoHealCycle({ escalateAfterFails });
  // Capability off → clear Cardinal-owned auto maintenance even if already ON
  if (!isCapabilityOn('autoMaintenance', prefs)) {
    try {
      const { syncAutoMaintenance, getMaintenance } = await import('./maintenance.js');
      const cur = getMaintenance();
      if (cur?.maintenance && cur.source === 'cardinal') {
        await syncAutoMaintenance({ shouldMaintain: false, reason: 'capability_off' });
      }
    } catch (_) {}
  }
  const health = heal.health || await checkSystemHealth();
  const state = loadCardinalState();
  state.cycles = (state.cycles || 0) + 1;
  state.lastCycleAt = Date.now();

  // Ops session soft-beats Guardian only. Soft-beating Executor hid watchdog stale checks.
  const beatDetail = `health=${health.status}; pending=${listPendingOrders().length}; streak=${heal.streak || 0}; via=ops`;
  await recordHeartbeat('guardian', {
    status: health.status === 'ok' ? 'ok' : 'alert',
    detail: beatDetail,
  });
  const refreshed = loadCardinalState();

  const actions = [];

  if (heal.maintenance && !heal.maintenance.skipped) {
    actions.push({ type: 'auto_maintenance', result: heal.maintenance });
    pushCardinalTimeline({
      type: 'auto_maintenance',
      severity: heal.maintenance.enabled ? 'critical' : 'info',
      summary: heal.maintenance.enabled ? '自動メンテ ON' : '自動メンテ解除',
    });
  }

  // Persistent outage → Executor (skip if auto-heal already escalated this cycle)
  if (!heal.escalated?.ok
      && (health.status === 'down' || (health.status === 'degraded' && (heal.streak || 0) >= escalateAfterFails))) {
    const r = await dispatchRole('executor', {
      kind: 'incident',
      severity: health.status === 'down' ? 'critical' : 'warning',
      title: '本番ヘルス異常の自動修正',
      summary: `Cardinal検知: ${health.label}（連続${heal.streak || 0}回）`,
      message: [
        'Guardian 相当の監視が障害を検知。Executor として原因調査・修正PR・フォールバック強化を行ってください。',
        '自動メンテナンスが ON の場合、復旧後に Cardinal が解除します（手動メンテは触らない）。',
      ].join('\n'),
      status: health.status,
      firestoreOk: !!health.firestore?.ok,
      notifyApiOk: !!health.notifyApi?.functionReady,
      acceptance: [
        '原因を特定して報告',
        '直せるなら draft PR',
        '客席の保留キューと health 監視を壊さない',
        '自動メンテナンス状態を確認',
      ],
    });
    actions.push({ type: 'dispatch_executor_health', result: r });
    refreshed.lastIncidentAt = Date.now();
  }

  // Mutual watchdog: Executor silent → wake Guardian to investigate / re-dispatch
  if (isCapabilityOn('watchdog', prefs)
      && isStale(refreshed.executor?.lastHeartbeatAt, executorSlaMs)
      && isStale(refreshed.executor?.lastDispatchAt, executorSlaMs)) {
    // Only when we've previously dispatched or health is bad — avoid cold-start noise
    if ((refreshed.dispatches || 0) > 0 || health.status !== 'ok') {
      const r = await dispatchRole('guardian', {
        kind: 'watchdog',
        severity: 'warning',
        title: 'Executor 無応答の監視',
        summary: 'Executor のハートビートが古く、タスク進捗が不明です',
        message: [
          'あなたは Cardinal Guardian です。',
          '1. cursor.com の Cloud Agents / オープンPR を確認（可能なら）',
          '2. 止まっているなら Executor 向けタスクを起票・再ディスパッチ方針をまとめる',
          '3. 人間へのエスカレーション文面を Discord 向けに簡潔に書く',
          'コード変更は最小限。まず状況整理と再起動判断。',
        ].join('\n'),
        acceptance: ['状況報告', '再ディスパッチ要否の判断', '必要なら Executor 向け issue 文面'],
      });
      actions.push({ type: 'dispatch_guardian_watchdog', result: r });
    }
  }

  // Guardian silent after activity → Executor self-watch (ask Executor to ping ops)
  if (isCapabilityOn('watchdog', prefs)
      && isStale(refreshed.guardian?.lastHeartbeatAt, guardianSlaMs)
      && (refreshed.dispatches || 0) > 0) {
    const r = await dispatchRole('executor', {
      kind: 'watchdog',
      severity: 'warning',
      title: 'Guardian 無応答時の自己監視',
      summary: 'Guardian ハートビートが古いため、Executor が一時的に監視も兼ねる',
      message: [
        'あなたは Cardinal Executor（一時的に監視も担当）です。',
        '1. ヘルス（Firestore / 通知API / Pages）を確認',
        '2. 問題があれば修正PR',
        '3. Guardian 再起動が必要なら Discord にエスカレーション文を書く',
      ].join('\n'),
      force: false,
    });
    actions.push({ type: 'dispatch_executor_watchdog', result: r });
  }

  // Business anomaly scan + daily digest (Ops-fed shop/order lists)
  if (isCapabilityOn('anomalyScan', prefs)) {
    const findings = scanBusinessAnomalies({ shops, orders, prefs });
    if (findings.length) {
      const n = await maybeNotifyAnomalies(findings);
      actions.push({ type: 'anomaly_scan', findings, notify: n });
    }
  }
  if (isCapabilityOn('dailyDigest', prefs)) {
    const dig = await maybeSendDailyDigest({ shops, orders });
    if (!dig.skipped) actions.push({ type: 'daily_digest', result: dig });
  }

  saveCardinalState(refreshed);
  pushCardinalTimeline({
    type: 'cycle',
    severity: health.status === 'ok' ? 'info' : 'warning',
    summary: `cycle#${refreshed.cycles} health=${health.status} actions=${actions.length}`,
  });
  return {
    health,
    heal,
    state: loadCardinalState(),
    autoHeal: getAutoHealState(),
    prefs,
    timeline: listCardinalTimeline(12),
    actions,
  };
}

export function getCardinalSnapshot() {
  const state = loadCardinalState();
  const heal = getAutoHealState();
  const health = getLastHealthState();
  const prefs = loadCardinalPrefs();
  return {
    ...state,
    roles: ROLES,
    autoHeal: heal,
    lastHealth: health,
    running: started,
    prefs,
    capabilities: CARDINAL_CAPABILITIES,
    timeline: listCardinalTimeline(20),
    quiet: shouldSuppressNoise('warning', prefs),
  };
}

export function startCardinal({
  intervalMs = 60_000,
  guardianSlaMs = 90 * 60 * 1000,
  executorSlaMs = 90 * 60 * 1000,
  getContext = null,
} = {}) {
  if (started) return;
  started = true;
  startAutoHeal({ intervalMs: Math.min(intervalMs, 45_000) });

  const tick = () => {
    const ctx = typeof getContext === 'function' ? (getContext() || {}) : {};
    runCardinalCycle({
      guardianSlaMs,
      executorSlaMs,
      shops: ctx.shops || [],
      orders: ctx.orders || [],
    }).catch(() => {});
  };
  tick();
  timer = setInterval(tick, intervalMs);
}

export function stopCardinal() {
  started = false;
  if (timer) clearInterval(timer);
  timer = null;
}

/** Manual dual-agent drill from Ops UI. */
export async function runCardinalDrill() {
  await recordHeartbeat('guardian', { status: 'drill', detail: 'manual drill' });
  await recordHeartbeat('executor', { status: 'drill', detail: 'manual drill' });
  const guardian = await dispatchRole('guardian', {
    force: true,
    kind: 'drill',
    severity: 'info',
    title: 'Cardinal ドリル（Guardian）',
    summary: 'Ops からの相互監視テスト',
    message: 'ドリルです。本番変更は不要。役割・監視手順を確認し、短く報告してください。',
    cooldownMs: 0,
  });
  const executor = await dispatchRole('executor', {
    force: true,
    kind: 'drill',
    severity: 'info',
    title: 'Cardinal ドリル（Executor）',
    summary: 'Ops からの相互監視テスト',
    message: 'ドリルです。本番変更は不要。実装フローを確認し、短く報告してください。',
    cooldownMs: 0,
  });
  return { guardian, executor, state: loadCardinalState() };
}
