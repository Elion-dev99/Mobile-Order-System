# Security notes — QuickOrder

## Current posture

| Layer | Status |
|-------|--------|
| Ops UI password | Client-side SHA-256 gate (session only). **Not** real auth. |
| Firebase Auth | **Required** for Ops / Admin privileged writes (not Store floor tablets) |
| `OPS_API_SECRET` | Required for Cardinal dispatch/tick, Incident, and client Discord webhooks |
| Firestore `ops/*` | **Denied** to all clients (no webhook storage) |
| Shop / menu create·delete·full update | **Signed-in only** |
| Store / guest shop patch | Floor-tablet keys (profile, `isOpen`, stock, coupons, …) without Auth. Plan/billing/create/delete still signed-in |
| Orders | Guest **create** OK; kitchen **status-only** update OK; delete = signed-in |
| Leads / surveys read | Signed-in only (LP may still **create** leads) |
| Discord | Prefer Cloudflare `DISCORD_WEBHOOK_URL`; client webhook needs Ops secret; **運用スラッシュ**は `docs/discord-ops-commands.md` |
| `platform/config` | Public **read** (maintenance flag). **Write** = Firebase Auth (Ops). Guest creates (orders/leads/requests/…) denied while `maintenance == true` |
| `GET /api/maintenance` | Public edge copy of maintenance (Cache API). Cardinal tick / Ops POST with `OPS_API_SECRET` can set it when Firestore is down |

## Firebase Auth setup (one-shot)

Auth is not enabled on the project until this runs once (`CONFIGURATION_NOT_FOUND` until then).

### Recommended: GitHub Action

1. Locally: `npx firebase-tools@latest login:ci` (Firebase owner Google account) → copy the token
2. Run workflow: [Configure Firebase Auth + Rules](https://github.com/Elion-dev99/Mobile-Order-System/actions/workflows/configure-firebase-auth.yml)
3. Paste token + staff email/password → Run  
   - Enables Email/Password  
   - Creates the staff user  
   - Deploys `firestore.rules`
4. Open Ops / Admin → Firebase login modal (Store needs no Auth)

### Manual (Console)

1. [Authentication](https://console.firebase.google.com/project/mobile-order-system-c7c70/authentication/providers) → Get started → Email/Password ON → Add user
2. Deploy rules: `npx firebase-tools@latest deploy --only firestore:rules --project mobile-order-system-c7c70`  
   or publish in [Firestore Rules](https://console.firebase.google.com/project/mobile-order-system-c7c70/firestore/rules)

Staff sessions persist in the browser (`browserLocalPersistence`). Ops「鍵」タブから再ログイン / ログアウト可能。

## Required secrets

### Cloudflare Pages

```
OPS_API_SECRET=<long random string>
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_PUBLIC_KEY=...                 # Discord Application Public Key（/api/discord 署名検証）
DISCORD_OPS_USER_IDS=123456789,...      # スラッシュコマンド実行を許可する Discord ユーザー ID
CURSOR_API_KEY=...
```

### GitHub Actions

```
OPS_API_SECRET=<same as Cloudflare>
```

### Ops browser (鍵タブ)

Paste the same `OPS_API_SECRET` after login so Cardinal / AutoHeal / 通知テストが動きます.

## What can still run without Firebase Auth

- Place orders (`orders` create)
- Kitchen tablets: update order `status` only
- **Store page**: profile / open-close / coupons / sold-out / stock (narrow field patch)
- Checkout: decrement stock / mark soldOut / mark coupon used / stamp trial window
- Create leads from LP; create surveys / service requests

## Remaining gaps

1. Per-shop Auth claims (today any signed-in user can write any shop)
2. Hash admin/staff PINs server-side; stop storing plaintext PINs on shop docs
3. Rate-limit `/api/notify` (env webhook path is still public for guest events)
4. Broader XSS pass on guest `app.js` / `status.js` / `cart.js`
5. Optional: Cloudflare Access in front of `ops.html` as a second gate

## Ops passwords

Defaults remain for internal use but are **never rendered** in HTML. Prefer changing them via Ops「鍵」タブ (custom hash in that browser) and putting the console behind Cloudflare Access.
