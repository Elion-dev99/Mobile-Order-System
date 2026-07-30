/**
 * Order / staff / load-test Discord notifications.
 */

import { notifyDiscord } from './notify.js';

const STATUS_LABEL = {
  received: '受付',
  cooking: '調理中',
  finishing: '仕上げ',
  done: '完了',
};

export function notifyOrderPlaced({ shopId, shopName, order, force = false } = {}) {
  const items = (order?.items || [])
    .map((i) => `${i.emoji || ''} ${i.name}×${i.qty || 1}`)
    .join(', ')
    .slice(0, 400);
  return notifyDiscord({
    title: '新規注文',
    emoji: '🧾',
    event: 'order_new',
    force,
    fields: {
      店舗: shopName || shopId || '',
      店舗ID: shopId || order?.shopId || '',
      注文ID: order?.id || '',
      席: String(order?.tableNumber ?? ''),
      人数: order?.partySize || '—',
      合計: `¥${Number(order?.total || 0).toLocaleString()}`,
      明細: items || '—',
      負荷テスト: order?.loadTest ? 'YES' : 'NO',
    },
  });
}

export function notifyOrderStatus({
  shopId, shopName, orderId, tableNumber, status, total, force = false,
} = {}) {
  const label = STATUS_LABEL[status] || status;
  return notifyDiscord({
    title: `注文ステータス: ${label}`,
    emoji: status === 'done' ? '✅' : status === 'finishing' ? '✨' : '🔥',
    event: 'order_status',
    force,
    fields: {
      店舗: shopName || shopId || '',
      店舗ID: shopId || '',
      注文ID: orderId || '',
      席: String(tableNumber ?? ''),
      ステータス: label,
      合計: total != null ? `¥${Number(total).toLocaleString()}` : '—',
    },
  });
}

export function notifyStaffCall({
  shopId, shopName, tableNumber, note = '', requestId = '', force = false,
} = {}) {
  return notifyDiscord({
    title: '店員呼出',
    emoji: '🙋',
    event: 'staff_call',
    force,
    fields: {
      店舗: shopName || shopId || '',
      店舗ID: shopId || '',
      席番号: String(tableNumber ?? ''),
      内容: note || '店員を呼ぶ',
      リクエストID: requestId || '—',
    },
  });
}

export function notifyLoadTestProgress(fields = {}) {
  return notifyDiscord({
    title: '負荷テスト',
    emoji: '🧪',
    event: 'load_test',
    force: true,
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v])
    ),
  });
}
