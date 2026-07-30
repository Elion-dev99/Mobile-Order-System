import { PRODUCT } from './config.js';
import { submitLead } from './leads.js';

function yen(n) {
  return n.toLocaleString('ja-JP');
}

document.getElementById('priceMonthly').textContent = yen(PRODUCT.priceMonthly);
document.getElementById('priceSetup').textContent = yen(PRODUCT.priceSetup);

const stripeBtn = document.getElementById('stripePayBtn');
if (PRODUCT.stripePaymentLink) {
  stripeBtn.href = PRODUCT.stripePaymentLink;
  stripeBtn.classList.remove('hidden');
}

const form = document.getElementById('leadForm');
const status = document.getElementById('leadStatus');
const submitBtn = document.getElementById('leadSubmit');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  status.hidden = false;
  status.classList.remove('error');
  status.textContent = '送信中...';
  submitBtn.disabled = true;

  const fd = new FormData(form);
  const payload = {
    shopName: String(fd.get('shopName') || '').trim(),
    email: String(fd.get('email') || '').trim(),
    phone: String(fd.get('phone') || '').trim(),
    tables: String(fd.get('tables') || ''),
    message: String(fd.get('message') || '').trim(),
    planPrice: PRODUCT.priceMonthly,
  };

  try {
    await submitLead(payload);
    status.textContent = '送信しました。担当より折り返します。';
    form.reset();
  } catch (err) {
    console.error(err);
    status.classList.add('error');
    status.textContent = '送信に失敗しました。Firestoreルールまたはネットワークを確認してください。';
  } finally {
    submitBtn.disabled = false;
  }
});
