# Enterprise parity pack

Gap fill vs major mobile-order platforms. **Payment providers are stub-shaped only** — UI, order fields, and close flow exist; real Stripe/PayPay/IC charge comes later.

## Shipped

| Area | What |
|------|------|
| Channels | dine-in / takeout / delivery on guest cart |
| Payments (shape) | method picker, `payment` + `paymentStatus` on orders, 会計クローズ |
| POS (shape) | `js/pos-bridge.js` stub connect / push order / menu sync |
| Printers | browser kitchen ticket + auto-print hook + network stub |
| Offline | `offline-sync` mutation queue + pending order flush |
| Loyalty | phone members, points earn/redeem |
| Reservations / waitlist | guest prompt + Admin/Store boards |
| Analytics | channel × hour deep panel (Business+) |
| Audit | `auditLogs` + local fallback |
| Shop scope | staff email ↔ shop bind (client; claims later) |
| i18n / a11y | zh/ko toggles + focus/reduced-motion basics |

## Collections (Firestore)

`members`, `reservations`, `waitlist`, `auditLogs` — see `firestore.rules`.

## Payment integration later

Replace bodies in `js/payments.js`:

- `createPaymentSession`
- `authorizePayment`

Keep order field shapes (`payment`, `paymentStatus`, `paidAt`, `closedAt`) stable.
