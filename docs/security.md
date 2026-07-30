# Security notes — QuickOrder

## Current posture

| Layer | Status |
|-------|--------|
| Ops UI password | Client-side SHA-256 gate (session only). **Not** real auth. |
| Firebase Auth | **Required** for privileged Firestore writes (Ops / Admin / Store) |
| `OPS_API_SECRET` | Required for Cardinal dispatch/tick, Incident, and client Discord webhooks |
| Firestore `ops/*` | **Denied** to all clients (no webhook storage) |
| Shop / menu create·delete·full update | **Signed-in only** |
| Guest shop patch | Narrow keys only: `stock`, `soldOut`, `coupons`, `updatedAt`, `trialStartedAt`, `trialEndsAt` |
| Orders | Guest **create** OK; kitchen **status-only** update OK; delete = signed-in |
| Leads / surveys read | Signed-in only (LP may still **create** leads) |
| Discord | Prefer Cloudflare `DISCORD_WEBHOOK_URL`; client webhook needs Ops secret |

## Firebase Auth setup (required before deploying rules)

1. Firebase Console → **Authentication** → Get started
2. Sign-in method → enable **Email/Password**
3. Users → **Add user** (shared staff account is fine for v1)
4. Deploy rules (below)
5. Open Ops / Admin / Store → complete the Firebase login modal (separate from Ops password)

Staff sessions persist in the browser (`browserLocalPersistence`). Ops「鍵」タブから再ログイン / ログアウト可能。

## Deploy Firestore rules

```bash
firebase deploy --only firestore:rules
```

Or Firebase Console → Firestore → Rules → publish `firestore.rules`.

**Deploy rules only after at least one Auth user exists**, or Ops/Admin writes will fail until you create that user.

## Required secrets

### Cloudflare Pages

```
OPS_API_SECRET=<long random string>
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
CURSOR_API_KEY=...
```

### GitHub Actions

```
OPS_API_SECRET=<same as Cloudflare>
```

### Ops browser (鍵タブ)

Paste the same `OPS_API_SECRET` after login so Cardinal / AutoHeal / 通知テストが動きます.

## What guests can still do (anonymous)

- Place orders (`orders` create)
- Kitchen tablets: update order `status` only
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
