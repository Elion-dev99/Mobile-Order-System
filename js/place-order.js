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
import { resolveOrderChannel, channelTableCode } from './channels.js';
import { createPaymentSession, authorizePayment } from './payments.js';
import { getLocalMember, applyOrderToMember, pointsYenValue } from './loyalty.js';
import { maybeAutoPrint } from './printers.js';
import { pushOrderToPos } from './pos-bridge.js';
import { enqueueMutation } from './offline-sync.js';
import { isMaintenanceMode, maintenanceMessage } from './maintenance.js';

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
  let pointsRedeem = Math.max(0, Number(opts.pointsRedeem) || 0);
  if (shopCanUse('loyalty') && pointsRedeem > 0) {
    const member = opts.member || getLocalMember(getShopId());
    const maxPts = Math.min(pointsRedeem, Number(member?.points) || 0, Math.max(0, subtotal - discount));
    pointsRedeem = maxPts;
    discount += pointsYenValue(pointsRedeem);
  } else {
    pointsRedeem = 0;
  }
  const afterDiscount = Math.max(0, subtotal - discount);
  const servicePct = shopCanUse('serviceCharge') ? Math.max(0, Number(shop?.serviceChargePercent) || 0) : 0;
  const serviceCharge = Math.floor(afterDiscount * (servicePct / 100));
  // tipEnabled defaults on for Growth+; only hide when explicitly false
  const tipPercent = shopCanUse('tip') && shop?.tipEnabled !== false
    ? Math.max(0, Number(opts.tipPercent) || 0)
    : 0;
  const tip = Math.floor(afterDiscount * (tipPercent / 100));
  const taxable = afterDiscount + serviceCharge + tip;
  const tax = Math.floor(taxable * 0.1);
  const total = taxable + tax;
  return {
    subtotal, discount, coupon, pointsRedeem, serviceCharge, servicePct, tip, tipPercent, tax, total, afterDiscount,
  };
}

export async function placeGuestOrder({
  cart, tableNumber, partySize = 0, onProgress, tipPercent = 0,
  channel, paymentMethod = 'pay_at_register', pointsRedeem = 0,
  memberPhone = '',
} = {}) {
  if (!cart?.length) return { ok: false, error: 'empty' };
  // Demo keeps working so Ops can smoke-test UI during maintenance
  if (isMaintenanceMode() && !isDemoMode()) {
    return { ok: false, error: 'maintenance', message: maintenanceMessage() };
  }

  const orderId = (isDemoMode() ? 'DEMO-' : 'ORD-') + Math.random().toString(36).substring(2, 8).toUpperCase();
  const shop = getShop();
  const plan = getPlan(shop?.planId);
  const resolvedChannel = resolveOrderChannel({ channel, tableNumber });
  const tableCode = channelTableCode(resolvedChannel, tableNumber);
  const member = shopCanUse('loyalty') ? getLocalMember(getShopId()) : null;
  const totals = computeOrderTotals(cart, shop, { tipPercent, pointsRedeem, member });
  const platformFee = platformFeeForOrder(shop, totals.total);

  let payment = null;
  if (shopCanUse('payments')) {
    const session = await createPaymentSession({
      orderId,
      amount: totals.total,
      method: paymentMethod,
      shopId: getShopId(),
    });
    const auth = await authorizePayment(session);
    payment = auth.payment || session;
  }

  const order = {
    id: orderId,
    shopId: getShopId(),
    tableNumber: tableCode,
    channel: resolvedChannel,
    partySize: Number(partySize) > 0 ? Number(partySize) : undefined,
    items: cart,
    subtotal: totals.subtotal,
    discount: totals.discount,
    couponCode: totals.coupon?.code || null,
    pointsRedeemed: totals.pointsRedeem || 0,
    memberId: member?.id || null,
    serviceCharge: totals.serviceCharge,
    serviceChargePercent: totals.servicePct,
    tip: totals.tip,
    tipPercent: totals.tipPercent,
    tax: totals.tax,
    total: totals.total,
    platformFee,
    platformFeePercent: plan.orderFeePercent || 0,
    platformFeeStatus: platformFee > 0 ? 'unbilled' : 'none',
    payment,
    paymentStatus: payment?.status || 'none',
    timestamp: Date.now(),
    status: 'received',
    demo: isDemoMode(),
  };

  const statusUrl = withDemo(`status.html?order=${orderId}&table=${encodeURIComponent(tableCode)}`);
  const pingDiscord = () => notifyOrderPlaced({
    shopId: getShopId(),
    shopName: getShop()?.name,
    order,
  }).catch(() => {});

  const afterSuccess = async () => {
    if (totals.coupon?.code) await markCouponUsed(totals.coupon.code).catch(() => {});
    await consumeStockForCart(cart).catch(() => {});
    if (shopCanUse('loyalty') && member) {
      await applyOrderToMember(member, order, { redeem: totals.pointsRedeem }).catch(() => {});
    } else if (shopCanUse('loyalty') && memberPhone) {
      // phone captured but member upsert happens in UI before place
    }
    if (shopCanUse('autoPrint') && shop.autoPrintOnOrder) {
      maybeAutoPrint(order, shop, 'order').catch(() => {});
    }
    if (shopCanUse('posBridge')) {
      pushOrderToPos(order, shop).catch(() => {});
    }
    localStorage.removeItem(cartStorageKey());
    setAppliedCoupon(getShopId(), null);
    pingDiscord();
  };

  try {
    onProgress?.('sending');
    if (isDemoMode()) {
      sessionStorage.setItem('mos_demo_order_' + orderId, JSON.stringify(order));
      await afterSuccess();
      return { ok: true, orderId, order, statusUrl };
    }
    await setDoc(doc(db, 'orders', orderId), order);
    await afterSuccess();
    return { ok: true, orderId, order, statusUrl };
  } catch (e) {
    console.error(e);
    // Do not locally queue during platform maintenance (rules deny create on purpose)
    if (isMaintenanceMode() && !isDemoMode()) {
      return { ok: false, error: 'maintenance', message: maintenanceMessage() };
    }
    enqueueMutation({ type: 'orderCreate', collection: 'orders', docId: orderId, data: order });
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
      statusUrl: withDemo(`status.html?order=${orderId}&table=${encodeURIComponent(tableCode)}&queued=1`),
      error: String(e?.message || e),
    };
  }
}
