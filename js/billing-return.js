/**
 * Stripe Checkout return + billing activation guards.
 */

import { getShopId, loadShop, markSubscribed } from './shop.js';
import { resolveShopId, withShop } from './tenant.js';
import { isValidShopIdForBilling } from './billing-money.js';

/**
 * @returns {{ handled: boolean, ok: boolean, message: string, code?: string }}
 */
export async function handleBillingSuccessReturn(searchParams) {
  const params = searchParams || new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  if (params.get('billing') !== 'success') {
    return { handled: false, ok: true, message: '' };
  }

  resolveShopId();
  await loadShop();

  const returnShop = String(params.get('shop') || '').trim();
  const currentShop = getShopId();
  const sessionId = String(params.get('session_id') || '').trim();

  if (returnShop && returnShop !== currentShop) {
    return {
      handled: true,
      ok: false,
      code: 'shop_mismatch',
      message: `支払いの店舗ID（${returnShop}）と今開いている店舗（${currentShop}）が違います。店舗URLを確認してください。`,
    };
  }

  if (returnShop && !isValidShopIdForBilling(returnShop)) {
    return {
      handled: true,
      ok: false,
      code: 'invalid_shop',
      message: '戻りURLの店舗IDが不正です。Ops に連絡してください。',
    };
  }

  try {
    await markSubscribed();
  } catch (e) {
    console.error('[billing] markSubscribed failed', e);
    return {
      handled: true,
      ok: false,
      code: 'persist_failed',
      message: '課金フラグの保存に失敗しました。Firebase ログイン後に再度お試しするか、Ops で「課金中」を ON にしてください。',
    };
  }

  const cleanUrl = withShop('admin.html');
  if (typeof history !== 'undefined') {
    history.replaceState({}, '', cleanUrl);
  }

  const sessionNote = sessionId ? `（Stripe session: ${sessionId.slice(0, 20)}…）` : '';
  return {
    handled: true,
    ok: true,
    code: 'activated',
    message: `課金を有効にしました。ありがとうございます。${sessionNote}`,
  };
}
