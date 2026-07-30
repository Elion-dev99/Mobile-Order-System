const DEMO_FLAG = 'mos_demo';
const DEMO_CART = 'mos_cart_demo';
const PROD_CART = 'mos_cart';

function readDemoFlag() {
  try {
    return sessionStorage.getItem(DEMO_FLAG) === '1';
  } catch {
    return false;
  }
}

function writeDemoFlag(on) {
  try {
    if (on) sessionStorage.setItem(DEMO_FLAG, '1');
    else sessionStorage.removeItem(DEMO_FLAG);
  } catch (_) {}
}

export function isDemoMode() {
  const q = new URLSearchParams(location.search);
  if (q.get('demo') === '0') return false;
  if (q.get('demo') === '1' || q.get('mode') === 'demo') return true;
  return readDemoFlag();
}

export function clearDemoMode() {
  writeDemoFlag(false);
}

export function activateDemoFromUrl() {
  const q = new URLSearchParams(location.search);
  if (q.get('demo') === '0') {
    writeDemoFlag(false);
    return false;
  }
  if (q.get('demo') === '1' || q.get('mode') === 'demo') {
    writeDemoFlag(true);
    return true;
  }
  return isDemoMode();
}

export function cartStorageKey() {
  return isDemoMode() ? DEMO_CART : PROD_CART;
}

export function withDemo(url) {
  const u = new URL(url, location.href);
  if (isDemoMode()) u.searchParams.set('demo', '1');
  else u.searchParams.delete('demo');
  return `${u.pathname}${u.search}${u.hash}`;
}

export function ensureDemoBanner() {
  if (!isDemoMode()) return;
  if (document.getElementById('demoBanner')) return;
  document.body.classList.add('demo-mode');
  const bar = document.createElement('div');
  bar.id = 'demoBanner';
  bar.className = 'demo-banner';
  bar.innerHTML = `
    <div class="demo-banner-inner">
      <strong>テストモード</strong>
      <span>注文は本番に入りません。体験用の動作です。</span>
      <a href="lp.html" id="demoExitLink">LPへ戻る</a>
    </div>`;
  document.body.prepend(bar);
  bar.querySelector('#demoExitLink')?.addEventListener('click', () => clearDemoMode());
}
