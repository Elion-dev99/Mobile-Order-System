#!/usr/bin/env bash
# Enable Email/Password Auth, create a staff user, deploy Firestore rules.
# Requires FIREBASE_TOKEN from: npx firebase-tools@latest login:ci
set -euo pipefail

PROJECT_ID="${FIREBASE_PROJECT_ID:-mobile-order-system-c7c70}"
API_KEY="${FIREBASE_WEB_API_KEY:-AIzaSyBDe3aI2F-W9wSFxHtcaplYs5-U2MdrNI8}"
STAFF_EMAIL="${STAFF_EMAIL:?STAFF_EMAIL required}"
STAFF_PASSWORD="${STAFF_PASSWORD:?STAFF_PASSWORD required}"
FIREBASE_TOKEN="${FIREBASE_TOKEN:?FIREBASE_TOKEN required (npx firebase-tools login:ci)}"
TOOLS_ROOT="$(npm root -g 2>/dev/null)/firebase-tools"
if [[ ! -d "$TOOLS_ROOT" ]]; then
  npx --yes firebase-tools@latest --version >/dev/null
  TOOLS_ROOT="$(find "$HOME/.npm/_npx" -path '*/firebase-tools/package.json' 2>/dev/null | head -1 | xargs dirname)"
fi

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "::add-mask::${FIREBASE_TOKEN}"
  echo "::add-mask::${STAFF_PASSWORD}"
fi

echo "==> Deploy Firestore rules"
npx --yes firebase-tools@latest deploy --only firestore:rules \
  --project "$PROJECT_ID" --token "$FIREBASE_TOKEN" --non-interactive

echo "==> Auth enable + staff user (via firebase-tools token refresh)"
PROJECT_ID="$PROJECT_ID" API_KEY="$API_KEY" STAFF_EMAIL="$STAFF_EMAIL" \
STAFF_PASSWORD="$STAFF_PASSWORD" FIREBASE_TOKEN="$FIREBASE_TOKEN" \
BILLING_ACCOUNT="$BILLING_ACCOUNT" TOOLS_ROOT="$TOOLS_ROOT" \
node <<'NODE'
const path = require('path');
const https = require('https');
const tools = process.env.TOOLS_ROOT;
const auth = require(path.join(tools, 'lib/auth.js'));
const scopes = require(path.join(tools, 'lib/scopes.js'));
const project = process.env.PROJECT_ID;
const apiKey = process.env.API_KEY;
const email = process.env.STAFF_EMAIL;
const password = process.env.STAFF_PASSWORD;
const refresh = process.env.FIREBASE_TOKEN;
const billingAccount = process.env.BILLING_ACCOUNT || '';
const sc = [scopes.CLOUD_PLATFORM, scopes.FIREBASE_PLATFORM, scopes.EMAIL, scopes.OPENID];

function req(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : JSON.stringify(body);
    const r = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => {
        let j; try { j = JSON.parse(b || '{}'); } catch { j = { raw: b }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const tok = await auth.getAccessToken(refresh, sc);
  const access = tok.access_token;
  if (!access || String(access).startsWith('1//')) throw new Error('Failed to refresh access token');
  const az = { Authorization: 'Bearer ' + access, 'X-Goog-User-Project': project };

  // Ensure billing if initializeAuth needs it
  let init = await req('POST', `https://identitytoolkit.googleapis.com/v2/projects/${project}/identityPlatform:initializeAuth`, az, {});
  console.log('initializeAuth', init.status, JSON.stringify(init.body).slice(0, 200));
  if (init.status >= 400 && /BILLING_NOT_ENABLED/.test(init.body.error?.message || '')) {
    await req('POST', `https://serviceusage.googleapis.com/v1/projects/${project}/services/cloudbilling.googleapis.com:enable`, az, {});
    await new Promise((r) => setTimeout(r, 5000));
    let account = billingAccount;
    if (!account) {
      const list = await req('GET', 'https://cloudbilling.googleapis.com/v1/billingAccounts', az, null);
      account = (list.body.billingAccounts || []).find((a) => a.open)?.name || '';
    }
    if (!account) throw new Error('No open billing account; link billing in GCP Console then retry');
    const link = await req('PUT', `https://cloudbilling.googleapis.com/v1/projects/${project}/billingInfo`, az, {
      billingAccountName: account,
    });
    console.log('billing link', link.status, JSON.stringify(link.body).slice(0, 200));
    await new Promise((r) => setTimeout(r, 5000));
    init = await req('POST', `https://identitytoolkit.googleapis.com/v2/projects/${project}/identityPlatform:initializeAuth`, az, {});
    console.log('initializeAuth2', init.status, JSON.stringify(init.body).slice(0, 200));
  }

  const cfg = await req('PATCH',
    `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config?updateMask=signIn.email,authorizedDomains`,
    az, {
      signIn: { email: { enabled: true, passwordRequired: true } },
      authorizedDomains: [
        `${project}.firebaseapp.com`,
        `${project}.web.app`,
        'mobile-order-system.pages.dev',
        'localhost',
      ],
    });
  console.log('updateConfig', cfg.status, JSON.stringify(cfg.body.signIn || cfg.body.error || {}).slice(0, 300));
  if (cfg.status >= 400) process.exit(1);

  let signup = await req('POST', `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`, {},
    { email, password, returnSecureToken: true });
  const msg = (signup.body.error && signup.body.error.message) || ('OK ' + signup.body.email);
  console.log('signUp', signup.status, msg);
  if (signup.body.error && signup.body.error.message !== 'EMAIL_EXISTS') {
    const admin = await req('POST', `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts`, az, { email, password });
    console.log('adminCreate', admin.status, (admin.body.error && admin.body.error.message) || ('OK'));
  }

  const login = await req('POST', `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {},
    { email, password, returnSecureToken: true });
  if (login.status >= 400) {
    console.error('signIn failed', login.body);
    process.exit(1);
  }
  console.log('signIn OK', login.body.email);
  console.log('DONE. Staff login:', email);
})().catch((e) => { console.error(e); process.exit(1); });
NODE
