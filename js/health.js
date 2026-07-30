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

export async function probeFirestore(timeoutMs = 5000) {
  const started = Date.now();
  const refs = [
    doc(db, 'shops', 'default'),
    doc(db, 'ops', 'settings'),
    doc(db, 'shop', 'settings'),
  ];

  const attempt = async () => {
    const results = await Promise.all(refs.map(async (ref) => {
      try {
        await withTimeout(getDoc(ref), timeoutMs, 'firestore_timeout');
        return { ok: true };
      } catch (e) {
        const msg = String(e?.message || e);
        // Service answered but rules denied — still counts as reachable
        if (/permission|insufficient|PERMISSION/i.test(msg)) {
          return { ok: true, note: 'permission_soft_ok' };
        }
        return { ok: false, error: msg };
      }
    }));
    const good = results.find(r => r.ok);
    if (good) return { ok: true, latencyMs: Date.now() - started, note: good.note };
    throw new Error(results.find(r => r.error)?.error || 'firestore_unreachable');
  };

  try {
    return await attempt();
  } catch (e) {
    try {
      await new Promise(r => setTimeout(r, 350));
      return await attempt();
    } catch (e2) {
      const err = String(e2?.message || e2);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: err,
        soft: /timeout/i.test(err),
      };
    }
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
  // Soft timeout alone → degraded with clearer label, not full outage panic
  if (!firestore.ok && !notifyApi.functionReady) status = 'down';
  else if (!firestore.ok || !notifyApi.functionReady) status = 'degraded';

  const meta = HEALTH[status] || HEALTH.ok;
  let label = meta.label;
  if (status === 'degraded' && firestore.soft && notifyApi.functionReady) {
    label = '応答遅延';
  }

  return {
    status,
    label,
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
      '注文DB（Firestore）と通知APIの両方が応答していません',
      'Cloudflare Pages / Firebase Console の障害情報を確認',
      '客席はデモモードで業務継続可（本番注文は保留キューへ）',
      '復旧後に Ops で保留注文・負荷状況を確認',
    ];
  }
  if (status === 'degraded') {
    return [
      'このバナーは定期ヘルスチェック結果です（業務停止とは限りません）',
      'Firestore=障害 / 通知API=OK → 注文DBへの疎通が遅い、または一時的に失敗',
      'モバイル回線の遅延でも出ることがあります。「再チェック」を押してください',
      '注文が失敗する場合は端末の保留キューに入り、復旧後に自動再送されます',
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
  try {
    const { isMaintenanceMode } = await import('./maintenance.js');
    if (isMaintenanceMode()) {
      const list = listPendingOrders();
      return { sent: 0, left: list.length, maintenance: true };
    }
  } catch (_) {}
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
