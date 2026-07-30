# Security notes — QuickOrder

## Current posture (after hardening)

| Layer | Status |
|-------|--------|
| Ops UI password | Client-side SHA-256 gate (session only). **Not** real auth. |
| `OPS_API_SECRET` | Required for Cardinal dispatch/tick, Incident, and client Discord webhooks |
| Firestore `ops/*` | **Denied** to all clients (no webhook storage) |
| Shop / menu delete | **Denied** anonymously |
| Orders | Still open (guest create + kitchen) until Firebase Auth |
| Discord | Prefer Cloudflare `DISCORD_WEBHOOK_URL`; client webhook needs Ops secret |

## Required secrets (set now)

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

Paste the same `OPS_API_SECRET` after login so Cardinal / AutoHeal / 通知テストが動きます。

## Deploy Firestore rules

```bash
firebase deploy --only firestore:rules
```

Or Firebase Console → Firestore → Rules → publish `firestore.rules`.

## Rotate after this PR

Assume previous `ops/settings` webhooks and open `/api/cardinal` may have been scraped:

1. Rotate Discord webhook
2. Rotate `CURSOR_API_KEY` if it was ever exposed
3. Set a new `OPS_API_SECRET` (CF + GitHub + Ops 鍵タブ)

## Remaining gaps (need infra)

1. **Firebase Auth** (or Cloudflare Access in front of `ops.html`) — only real fix for shops/orders writes
2. Hash admin/staff PINs server-side; stop storing plaintext PINs on shop docs
3. Rate-limit `/api/notify` (env webhook path is still public for guest events)
4. Broader XSS pass on guest `app.js` / `status.js` / `cart.js`

## Ops passwords

Defaults remain for internal use but are **never rendered** in HTML. Prefer changing them via Ops「鍵」タブ (custom hash in that browser) and putting the console behind Cloudflare Access.
