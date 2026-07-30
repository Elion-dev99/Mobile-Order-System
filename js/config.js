/** QuickOrder 商用設定 — Stripe Payment Link を貼ると課金が有効になります */
export const PRODUCT = {
  name: 'QuickOrder',
  tagline: '席で注文、厨房で受信。スマホ1台ではじめるモバイルオーダー',
  /** 月額（税別）。1店舗で Cursor Pro 月額を上回る */
  priceMonthly: 3980,
  /** 初期導入（任意・税別） */
  priceSetup: 19800,
  currency: 'JPY',
  trialDays: 14,
  /**
   * Stripe Dashboard → Payment Links で月額サブスクを作り、URLを貼る
   * 例: https://buy.stripe.com/xxxx
   */
  stripePaymentLink: '',
  /** 決済成功後の戻り先（Payment Link の after_completion に設定） */
  successPath: 'admin.html?billing=success',
};

export const DEFAULT_SHOP = {
  name: 'QuickOrder',
  subtitle: 'モバイルオーダー',
  tableCount: 12,
  adminPin: '',
  subscribed: false,
  subscribedAt: null,
  ownerEmail: '',
  ownerPhone: '',
};
