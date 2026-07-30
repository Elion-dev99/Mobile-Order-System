/**
 * Guest UI strings: ja / en / zh / ko + basic a11y helpers.
 */

const DICT = {
  ja: {
    search: 'メニューを検索',
    cart: 'カートを見る',
    placeOrder: '注文を確定する',
    channel: '注文タイプ',
    dine_in: '店内',
    takeout: 'テイクアウト',
    delivery: 'デリバリー',
    payment: 'お支払い方法',
    member: 'ポイント会員',
    reserve: '予約する',
    waitlist: '順番待ち',
  },
  en: {
    search: 'Search menu',
    cart: 'View cart',
    placeOrder: 'Place order',
    channel: 'Order type',
    dine_in: 'Dine in',
    takeout: 'Takeout',
    delivery: 'Delivery',
    payment: 'Payment method',
    member: 'Loyalty',
    reserve: 'Reserve',
    waitlist: 'Waitlist',
  },
  zh: {
    search: '搜索菜单',
    cart: '查看购物车',
    placeOrder: '确认下单',
    channel: '用餐方式',
    dine_in: '堂食',
    takeout: '外带',
    delivery: '外送',
    payment: '支付方式',
    member: '积分会员',
    reserve: '预约',
    waitlist: '排队',
  },
  ko: {
    search: '메뉴 검색',
    cart: '장바구니',
    placeOrder: '주문하기',
    channel: '주문 유형',
    dine_in: '매장',
    takeout: '포장',
    delivery: '배달',
    payment: '결제 수단',
    member: '포인트 회원',
    reserve: '예약',
    waitlist: '대기',
  },
};

export function normalizeLang(lang) {
  const l = String(lang || 'ja').toLowerCase();
  if (l.startsWith('zh')) return 'zh';
  if (l.startsWith('ko')) return 'ko';
  if (l.startsWith('en')) return 'en';
  return 'ja';
}

export function t(key, lang = 'ja') {
  const l = normalizeLang(lang);
  return DICT[l]?.[key] || DICT.ja[key] || key;
}

export function applyLangToDocument(lang = 'ja') {
  const l = normalizeLang(lang);
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : l;
  const search = document.getElementById('searchInput');
  if (search) search.placeholder = t('search', l);
  const cartBtn = document.querySelector('#cartBarBtn .cart-bar-left span');
  if (cartBtn) cartBtn.textContent = t('cart', l);
  const place = document.getElementById('placeOrderBtn');
  if (place && !place.disabled) place.textContent = t('placeOrder', l);
}

/** Prefer reduced-motion / focus visibility */
export function ensureA11yBasics() {
  if (document.getElementById('mosA11yStyle')) return;
  const style = document.createElement('style');
  style.id = 'mosA11yStyle';
  style.textContent = `
    :focus-visible { outline: 3px solid #0A84FF; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
    }
  `;
  document.head.appendChild(style);
}
