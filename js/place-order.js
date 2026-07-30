/**
 * Shared guest order placement (menu SPA + cart.html).
 */

import { db } from './firebase.js';
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getShopId, getShop } from './shop.js';
import { cartStorageKey, isDemoMode, withDemo } from './demo.js';
import { enqueuePendingOrder } from './health.js';
import { notifyOrderPlaced } from './notify-orders.js';

export async function placeGuestOrder({ cart, tableNumber, partySize = 0, onProgress } = {}) {
  if (!cart?.length) return { ok: false, error: 'empty' };

  const orderId = (isDemoMode() ? 'DEMO-' : 'ORD-') + Math.random().toString(36).substring(2, 8).toUpperCase();
  const subtotal = cart.reduce((s, e) => s + e.price * e.qty, 0);
  const tax = Math.floor(subtotal * 0.1);
  const order = {
    id: orderId,
    shopId: getShopId(),
    tableNumber,
    partySize: Number(partySize) > 0 ? Number(partySize) : undefined,
    items: cart,
    subtotal,
    tax,
    total: subtotal + tax,
    timestamp: Date.now(),
    status: 'received',
    demo: isDemoMode(),
  };

  const statusUrl = withDemo(`status.html?order=${orderId}&table=${encodeURIComponent(tableNumber)}`);
  const pingDiscord = () => notifyOrderPlaced({
    shopId: getShopId(),
    shopName: getShop()?.name,
    order,
  }).catch(() => {});

  try {
    onProgress?.('sending');
    if (isDemoMode()) {
      sessionStorage.setItem('mos_demo_order_' + orderId, JSON.stringify(order));
      localStorage.removeItem(cartStorageKey());
      pingDiscord();
      return { ok: true, orderId, order, statusUrl };
    }
    await setDoc(doc(db, 'orders', orderId), order);
    localStorage.removeItem(cartStorageKey());
    pingDiscord();
    return { ok: true, orderId, order, statusUrl };
  } catch (e) {
    console.error(e);
    const n = enqueuePendingOrder(order);
    localStorage.removeItem(cartStorageKey());
    try {
      sessionStorage.setItem('mos_demo_order_' + orderId, JSON.stringify({ ...order, queued: true }));
    } catch (_) {}
    pingDiscord();
    return {
      ok: true,
      queued: true,
      pending: n,
      orderId,
      order,
      statusUrl: withDemo(`status.html?order=${orderId}&table=${encodeURIComponent(tableNumber)}&queued=1`),
      error: String(e?.message || e),
    };
  }
}
