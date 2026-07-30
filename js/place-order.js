/**
 * Shared guest order placement (menu SPA + cart.html).
 */

import { db } from './firebase.js';
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getShopId, getShop, consumeStockForCart, shopCanUse } from './shop.js';
import { cartStorageKey, isDemoMode, withDemo } from './demo.js';
import { enqueuePendingOrder } from './health.js';
import { notifyOrderPlaced } from './notify-orders.js';
import { platformFeeForOrder, getPlan } from './plans.js';
import {
  getAppliedCoupon, discountForCoupon, validateCoupon, markCouponUsed, setAppliedCoupon,
} from './coupons.js';

export function computeOrderTotals(cart, shop = getShop(), opts = {}) {
  const subtotal = (cart || []).reduce((s, e) => s + e.price * e.qty, 0);
  let discount = 0;
  let coupon = opts.coupon || getAppliedCoupon(getShopId());
  if (coupon) {
    const v = validateCoupon(coupon.code, subtotal, shop);
    if (v.ok) {
      coupon = v.coupon;
      discount = discountForCoupon(coupon, subtotal);
    } else {
      coupon = null;
    }
  }
  const afterDiscount = Math.max(0, subtotal - discount);
  const servicePct = shopCanUse('serviceCharge') ? Math.max(0, Number(shop?.serviceChargePercent) || 0) : 0;
  const serviceCharge = Math.floor(afterDiscount * (servicePct / 100));
  const tipPercent = shopCanUse('tip') && shop?.tipEnabled ? Math.max(0, Number(opts.tipPercent) || 0) : 0;
  const tip = Math.floor(afterDiscount * (tipPercent / 100));
  const taxable = afterDiscount + serviceCharge + tip;
  const tax = Math.floor(taxable * 0.1);
  const total = taxable + tax;
  return {
    subtotal, discount, coupon, serviceCharge, servicePct, tip, tipPercent, tax, total, afterDiscount,
  };
}

export async function placeGuestOrder({
  cart, tableNumber, partySize = 0, onProgress, tipPercent = 0,
} = {}) {
  if (!cart?.length) return { ok: false, error: 'empty' };

  const orderId = (isDemoMode() ? 'DEMO-' : 'ORD-') + Math.random().toString(36).substring(2, 8).toUpperCase();
  const shop = getShop();
  const plan = getPlan(shop?.planId);
  const totals = computeOrderTotals(cart, shop, { tipPercent });
  const platformFee = platformFeeForOrder(shop, totals.total);
  const order = {
    id: orderId,
    shopId: getShopId(),
    tableNumber,
    partySize: Number(partySize) > 0 ? Number(partySize) : undefined,
    items: cart,
    subtotal: totals.subtotal,
    discount: totals.discount,
    couponCode: totals.coupon?.code || null,
    serviceCharge: totals.serviceCharge,
    serviceChargePercent: totals.servicePct,
    tip: totals.tip,
    tipPercent: totals.tipPercent,
    tax: totals.tax,
    total: totals.total,
    platformFee,
    platformFeePercent: plan.orderFeePercent || 0,
    platformFeeStatus: platformFee > 0 ? 'unbilled' : 'none',
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
      setAppliedCoupon(getShopId(), null);
      pingDiscord();
      return { ok: true, orderId, order, statusUrl };
    }
    await setDoc(doc(db, 'orders', orderId), order);
    if (totals.coupon?.code) await markCouponUsed(totals.coupon.code).catch(() => {});
    await consumeStockForCart(cart).catch(() => {});
    localStorage.removeItem(cartStorageKey());
    setAppliedCoupon(getShopId(), null);
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
