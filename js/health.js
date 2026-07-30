/**
 * Backend health probes (Firestore + notify API) and downtime playbook helpers.
 */

import { db } from './firebase.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { probeNotifyApi, notifyDiscord, loadNotifySettings, isEventEnabled } from './notify.js';

const STATE_KEY = 'mos_health_state';
const PENDING_ORDERS_KEY = 'mos_pending_orders';

export const HEALTH = {
  ok: { id: 'ok', label: '正常', emoji: '🟢' },
  degraded: { id: 'degraded', label: '一部障害', emoji: '🟡' },
  down: { id: 'down', label: '障害', emoji: '🔴' },
  offline: { id: 'offline', label: 'オフライン', emoji: '⚫' },
};

function withTimeout(promise, ms, label = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

export async function probeFirestore(timeoutMs = 4000) {
  const started = Date.now();
  try {
    await withTimeout(getDoc(doc(db, 'ops', 'settings')), timeoutMs, 'firestore_timeout');
    return { ok: true, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: String(e?.message || e) };
  }
}

export async function checkSystemHealth() {
  const online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
  if (!online) {
    return {
      status: 'offline',
      label: HEALTH.offline.label,
      emoji: HEALTH.offline.emoji,
      online: false,
      firestore: { ok: false, error: 'browser_offline' },
      notifyApi: { ok: false, functionReady: false },
      checkedAt: Date.now(),
    };
  }

  const [firestore, notifyApi] = await Promise.all([
    probeFirestore(),
    probeNotifyApi(),
  ]);

  let status = 'ok';
  if (!firestore.ok && !notifyApi.functionReady) status = 'down';
  else if (!firestore.ok || !notifyApi.functionReady) status = 'degraded';

  const meta = HEALTH[status] || HEALTH.ok;
  return {
    status,
    label: meta.label,
    emoji: meta.emoji,
    online: true,
    firestore,
    notifyApi,
    checkedAt: Date.now(),
  };
}

export function getLastHealthState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
  } catch {
    return null;
  }
}

function setLastHealthState(state) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      status: state.status,
      checkedAt: state.checkedAt,
    }));
  } catch (_) {}
}

export function playbookFor(status) {
  if (status === 'offline') {
    return [
      '端末またはWi-Fi/モバイル回線を確認する',
      '機内モードOFF・別ネットワークで再試行',
      '復旧後、保留注文があれば自動再送を待つ',
    ];
  }
  if (status === 'down') {
    return [
      'Firestore（注文DB）と通知APIの両方が応答していません',
      'Cloudflare Pages / Firebase Console の障害情報を確認',
      '客席はデモモードで業務継続可（本番注文は保留キューへ）',
      '復旧後に Ops で保留注文・負荷状況を確認',
    ];
  }
  if (status === 'degraded') {
    return [
      '一部サービスのみ障害です（DBまたは通知）',
      '注文が失敗する場合は保留キューに入ります',
      'Discord通知だけ落ちている場合、注文自体は継続可能',
      'Firebase / Cloudflare のステータスを確認',
    ];
  }
  return [
    '各サービスは正常です',
    '異常時は Discord に障害通知が飛びます（通知APIが生きている場合）',
  ];
}

/**
 * Run health check; Discord-notify on status transition.
 */
export async function runHealthCheckAndNotify({ forceNotify = false } = {}) {
  await loadNotifySettings().catch(() => {});
  const health = await checkSystemHealth();
  const prev = getLastHealthState();
  const changed = !prev || prev.status !== health.status;

  if (forceNotify) {
    await notifyDiscord({
      title: `システム状態: ${health.label}`,
      emoji: health.emoji,
      event: 'system_health',
      force: true,
      fields: {
        状態: `${health.emoji} ${health.label}`,
        Firestore: health.firestore?.ok ? `OK (${health.firestore.latencyMs}ms)` : `NG ${health.firestore?.error || ''}`,
        通知API: health.notifyApi?.functionReady ? 'OK' : 'NG',
        回線: health.online ? 'オンライン' : 'オフライン',
        対処: (playbookFor(health.status)[0] || ''),
      },
    }).catch(() => {});
  } else if (changed && health.status !== 'ok') {
    if (isEventEnabled('system_health')) {
      await notifyDiscord({
        title: `システム障害: ${health.label}`,
        emoji: health.emoji,
        event: 'system_health',
        fields: {
          状態: `${health.emoji} ${health.label}`,
          Firestore: health.firestore?.ok ? `OK (${health.firestore.latencyMs}ms)` : `NG ${health.firestore?.error || ''}`,
          通知API: health.notifyApi?.functionReady ? 'OK' : 'NG',
          回線: health.online ? 'オンライン' : 'オフライン',
          対処: (playbookFor(health.status)[0] || ''),
        },
      }).catch(() => {});
    }
  } else if (changed && prev && prev.status !== 'ok' && health.status === 'ok') {
    await notifyDiscord({
      title: 'システム復旧',
      emoji: '🟢',
      event: 'system_health',
      fields: {
        状態: '🟢 正常に戻りました',
        Firestore: health.firestore?.ok ? `OK (${health.firestore.latencyMs}ms)` : 'NG',
        通知API: health.notifyApi?.functionReady ? 'OK' : 'NG',
      },
    }).catch(() => {});
  }

  setLastHealthState(health);
  return { health, changed, prev };
}

/* ——— pending order queue (Firestore down) ——— */

export function listPendingOrders() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_ORDERS_KEY) || '[]');
  } catch {
    return [];
  }
}

export function enqueuePendingOrder(order) {
  const list = listPendingOrders();
  list.push({ ...order, queuedAt: Date.now() });
  try {
    localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(list.slice(-30)));
  } catch (_) {}
  return list.length;
}

export async function flushPendingOrders(setDocFn) {
  const list = listPendingOrders();
  if (!list.length) return { sent: 0, left: 0 };
  const remain = [];
  let sent = 0;
  for (const order of list) {
    try {
      await setDocFn(order);
      sent += 1;
    } catch (_) {
      remain.push(order);
    }
  }
  try {
    localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(remain));
  } catch (_) {}
  return { sent, left: remain.length };
}
