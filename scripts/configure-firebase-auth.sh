#!/usr/bin/env bash
# Enable Email/Password Auth, create a staff user, deploy Firestore rules.
# Requires FIREBASE_TOKEN from: npx firebase-tools@latest login:ci
set -euo pipefail

PROJECT_ID="${FIREBASE_PROJECT_ID:-mobile-order-system-c7c70}"
API_KEY="${FIREBASE_WEB_API_KEY:-AIzaSyBDe3aI2F-W9wSFxHtcaplYs5-U2MdrNI8}"
STAFF_EMAIL="${STAFF_EMAIL:?STAFF_EMAIL required}"
STAFF_PASSWORD="${STAFF_PASSWORD:?STAFF_PASSWORD required}"
FIREBASE_TOKEN="${FIREBASE_TOKEN:?FIREBASE_TOKEN required (npx firebase-tools login:ci)}"

# Public Firebase CLI OAuth client (used by firebase-tools CI tokens)
CLIENT_ID="563584335869-fgrhgmd47bqnek1034d9pejz9hvuj0ah.apps.googleusercontent.com"
CLIENT_SECRET="FAKESECRET_u1v2w3x4y5z6a7b8c9d0"

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "::add-mask::${FIREBASE_TOKEN}"
  echo "::add-mask::${STAFF_PASSWORD}"
fi

echo "==> Exchanging CI token for access token"
TOKEN_JSON=$(curl -sS https://oauth2.googleapis.com/token \
  -d "grant_type=refresh_token" \
  -d "refresh_token=${FIREBASE_TOKEN}" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}")
ACCESS_TOKEN=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]);
assert "access_token" in d, "Token exchange failed: "+sys.argv[1][:400];
print(d["access_token"])' "$TOKEN_JSON")
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "::add-mask::${ACCESS_TOKEN}"
fi
AUTHZ="Authorization: Bearer ${ACCESS_TOKEN}"

echo "==> Initialize Identity Platform / Auth (ok if already done)"
INIT_CODE=$(curl -sS -o /tmp/fb-init.json -w "%{http_code}" -X POST \
  "https://identitytoolkit.googleapis.com/v2/projects/${PROJECT_ID}/identityPlatform:initializeAuth" \
  -H "$AUTHZ" -H "Content-Type: application/json" -H "X-Goog-User-Project: ${PROJECT_ID}" \
  -d '{}')
echo "initializeAuth HTTP ${INIT_CODE}"
python3 -c 'import json; print(json.load(open("/tmp/fb-init.json")))' || true

echo "==> Enable Email/Password sign-in"
curl -sS -X PATCH \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT_ID}/config?updateMask=signIn.email" \
  -H "$AUTHZ" -H "Content-Type: application/json" -H "X-Goog-User-Project: ${PROJECT_ID}" \
  -d '{"signIn":{"email":{"enabled":true,"passwordRequired":true}}}' \
  -o /tmp/fb-config.json
python3 -c 'import json; d=json.load(open("/tmp/fb-config.json"));
print("signIn:", json.dumps(d.get("signIn", d.get("error", d)), ensure_ascii=False)[:600])'
python3 -c 'import json,sys; d=json.load(open("/tmp/fb-config.json"));
sys.exit(1 if "error" in d and "signIn" not in d else 0)'

echo "==> Create staff user (or confirm exists)"
CREATE=$(curl -sS -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${STAFF_EMAIL}\",\"password\":\"${STAFF_PASSWORD}\",\"returnSecureToken\":true}")
CREATE_MSG=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print((d.get("error") or {}).get("message","") or ("OK:"+str(d.get("email") or d.get("localId"))))' "$CREATE")
echo "signUp: ${CREATE_MSG}"
if [[ "$CREATE_MSG" != OK:* && "$CREATE_MSG" != "EMAIL_EXISTS" ]]; then
  echo "Trying Admin accounts API..."
  ADMIN_CREATE=$(curl -sS -X POST \
    "https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts" \
    -H "$AUTHZ" -H "Content-Type: application/json" \
    -d "{\"email\":\"${STAFF_EMAIL}\",\"password\":\"${STAFF_PASSWORD}\"}")
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); e=(d.get("error") or {}).get("message","");
print("admin:", e or ("OK:"+str(d.get("email") or d.get("localId"))));
sys.exit(0 if e in ("EMAIL_EXISTS","") or "localId" in d else 1)' "$ADMIN_CREATE"
fi

echo "==> Deploy Firestore rules"
npx --yes firebase-tools@latest deploy --only firestore:rules \
  --project "$PROJECT_ID" --token "$FIREBASE_TOKEN" --non-interactive

echo "==> Verify Auth responds"
VERIFY=$(curl -sS "https://www.googleapis.com/identitytoolkit/v3/relyingparty/getProjectConfig?key=${API_KEY}")
python3 -c 'import json,sys; d=json.loads(sys.argv[1]);
print("getProjectConfig:", "error" in d and d["error"] or "ok", "domains=", d.get("authorizedDomains",[])[:3])' "$VERIFY"

echo "DONE. Staff login email: ${STAFF_EMAIL}"
