/**
 * Firebase Auth for staff surfaces (Ops / Admin / Store).
 * Guests stay anonymous. Privileged Firestore writes require request.auth != null.
 */

import { auth } from './firebase.js';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";

let ready = null;

export function waitForAuthReady() {
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  if (ready) return ready;
  ready = new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      ready = null;
      resolve(user || null);
    });
  });
  return ready;
}

export function getStaffUser() {
  return auth.currentUser;
}

export function isStaffSignedIn() {
  return !!auth.currentUser;
}

export async function signInStaff(email, password) {
  const em = String(email || '').trim();
  const pw = String(password || '');
  if (!em || !pw) throw new Error('メールとパスワードを入力してください');
  const cred = await signInWithEmailAndPassword(auth, em, pw);
  return cred.user;
}

export async function signOutStaff() {
  await signOut(auth);
}

/**
 * Ensure Firebase staff session. Shows a modal if missing.
 * @returns {Promise<import('firebase/auth').User|null>}
 */
export async function ensureStaffFirebase({ title = 'スタッフログイン', hint = '' } = {}) {
  await waitForAuthReady();
  if (auth.currentUser) return auth.currentUser;
  return promptStaffLogin({ title, hint });
}

function promptStaffLogin({ title, hint }) {
  return new Promise((resolve) => {
    const existing = document.getElementById('staffFirebaseGate');
    if (existing) existing.remove();

    const wrap = document.createElement('div');
    wrap.id = 'staffFirebaseGate';
    wrap.className = 'staff-firebase-gate';
    wrap.innerHTML = `
      <div class="staff-firebase-card" role="dialog" aria-modal="true" aria-labelledby="staffFbTitle">
        <p class="staff-firebase-eyebrow">Firebase Auth</p>
        <h2 id="staffFbTitle">${escapeHtml(title)}</h2>
        <p class="staff-firebase-hint">${escapeHtml(hint || '店舗・メニュー・注文削除など特権操作に必要です。Firebase Authentication のユーザーで入室してください。')}</p>
        <label>メール
          <input id="staffFbEmail" type="email" autocomplete="username" required>
        </label>
        <label>パスワード
          <input id="staffFbPassword" type="password" autocomplete="current-password" required>
        </label>
        <p id="staffFbError" class="staff-firebase-error" hidden></p>
        <div class="staff-firebase-actions">
          <button type="button" id="staffFbSubmit" class="staff-firebase-primary">ログイン</button>
          <button type="button" id="staffFbSkip" class="staff-firebase-secondary">後で（読み取りのみ）</button>
        </div>
        <p class="staff-firebase-foot">未作成なら Firebase Console → Authentication → ユーザー追加。手順: docs/security.md</p>
      </div>
    `;
    document.body.appendChild(wrap);

    const err = wrap.querySelector('#staffFbError');
    const finish = (user) => {
      wrap.remove();
      resolve(user);
    };

    wrap.querySelector('#staffFbSkip')?.addEventListener('click', () => finish(null));
    wrap.querySelector('#staffFbSubmit')?.addEventListener('click', async () => {
      const email = wrap.querySelector('#staffFbEmail')?.value;
      const password = wrap.querySelector('#staffFbPassword')?.value;
      const btn = wrap.querySelector('#staffFbSubmit');
      if (btn) { btn.disabled = true; btn.textContent = 'ログイン中...'; }
      if (err) { err.hidden = true; err.textContent = ''; }
      try {
        const user = await signInStaff(email, password);
        finish(user);
      } catch (e) {
        if (err) {
          err.hidden = false;
          err.textContent = mapAuthError(e);
        }
        if (btn) { btn.disabled = false; btn.textContent = 'ログイン'; }
      }
    });
  });
}

function mapAuthError(e) {
  const code = e?.code || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) {
    return 'メールまたはパスワードが違います';
  }
  if (code.includes('too-many-requests')) return '試行回数が多すぎます。しばらく待ってください';
  return String(e?.message || e || 'ログインに失敗しました');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inject minimal styles once */
export function ensureStaffAuthStyles() {
  if (document.getElementById('staffFirebaseStyles')) return;
  const style = document.createElement('style');
  style.id = 'staffFirebaseStyles';
  style.textContent = `
    .staff-firebase-gate {
      position: fixed; inset: 0; z-index: 9999;
      display: grid; place-items: center;
      padding: 20px;
      background: rgba(8, 14, 12, 0.72);
      backdrop-filter: blur(6px);
    }
    .staff-firebase-card {
      width: min(420px, 100%);
      background: #162823;
      border: 1px solid #2a433c;
      border-radius: 16px;
      padding: 22px;
      color: #e7f2ee;
      font-family: "IBM Plex Sans JP", "Hiragino Sans", sans-serif;
    }
    .staff-firebase-eyebrow { margin: 0; color: #3dcf9a; font-size: 12px; font-weight: 700; letter-spacing: .04em; }
    .staff-firebase-card h2 { margin: 6px 0 8px; font-size: 22px; }
    .staff-firebase-hint, .staff-firebase-foot { color: #8eaaa2; font-size: 13px; line-height: 1.45; }
    .staff-firebase-card label { display: grid; gap: 6px; margin: 12px 0; font-size: 13px; color: #8eaaa2; }
    .staff-firebase-card input {
      padding: 12px 14px; border-radius: 10px; border: 1px solid #2a433c;
      background: #0d1815; color: #e7f2ee; font: inherit;
    }
    .staff-firebase-actions { display: flex; gap: 8px; margin-top: 8px; }
    .staff-firebase-primary, .staff-firebase-secondary {
      flex: 1; border: 0; border-radius: 10px; padding: 12px; font: inherit; font-weight: 700; cursor: pointer;
    }
    .staff-firebase-primary { background: #3dcf9a; color: #06261b; }
    .staff-firebase-secondary { background: transparent; color: #8eaaa2; border: 1px solid #2a433c; }
    .staff-firebase-error { color: #ff6b6b; font-size: 13px; }
  `;
  document.head.appendChild(style);
}
