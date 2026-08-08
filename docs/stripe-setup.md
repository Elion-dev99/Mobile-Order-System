# Stripe 連携（準備段階）

本番の自動課金反映の**前**に、テストモードで Payment Link・Webhook・Ops キューを通します。  
**現状**: Webhook で支払いを記録 → Discord 通知 → Ops で店舗「課金中」ON（または Admin `?billing=success`）。

## 1. Stripe Dashboard（テストモード）

1. [Stripe Dashboard](https://dashboard.stripe.com/test/dashboard) で **テストモード** を ON
2. **商品・価格** — Lite / Growth 等（月額・初期費用は Payment Link でまとめても可）
3. **Payment Links** — プランごとにリンク作成
4. Payment Link の **メタデータ**（任意）: `planId=growth` など
5. **成功時の URL**（重要）:
   ```
   https://mobile-order-system.pages.dev/admin.html?billing=success&shop={CHECKOUT_SESSION_CLIENT_REFERENCE_ID}
   ```
   `client_reference_id` に店舗 ID を載せるため、Admin の「カードで契約」から遷移させる（下記）。

## 2. リポジトリ `js/config.js`

```javascript
stripeMode: 'test',
stripePaymentLinks: {
  lite: 'https://buy.stripe.com/test_xxxx',
  growth: 'https://buy.stripe.com/test_xxxx',
  business: '',
  chain: '',
},
// 後方互換（growth フォールバック）
stripePaymentLink: '',
```

LP は汎用リンク、**Admin / Store** は `client_reference_id=店舗ID` 付き URL を自動生成します。

## 3. Cloudflare Pages シークレット

| シークレット | 必須 | 用途 |
|-------------|------|------|
| `STRIPE_WEBHOOK_SECRET` | Webhook 時 **必須** | 署名検証 `whsec_...` |
| `STRIPE_SECRET_KEY` | 任意 | `verify_session`（Ops デバッグ）`sk_test_...` |
| `STRIPE_MODE` | 任意 | `test` / `live`（表示用） |
| `DISCORD_WEBHOOK_URL` | 任意 | 支払い通知 |
| `OPS_API_SECRET` | Ops キュー操作時 | 既存と同じ |

GitHub Action: **Configure Stripe secrets**（`configure-stripe.yml`）で投入可。

## 4. Webhook エンドポイント

| 項目 | 値 |
|------|-----|
| URL | `https://mobile-order-system.pages.dev/api/stripe` |
| イベント | `checkout.session.completed`（推奨） |

Stripe CLI でローカル試験:

```bash
stripe listen --forward-to https://mobile-order-system.pages.dev/api/stripe
```

## 5. 運用フロー（準備段階）

```text
店舗 Admin →「カードで契約」（shopId 付き Payment Link）
    → Stripe テストカードで支払い
    → 成功 URL で Admin（billing=success → subscribed フラグ）
    → 並行: Webhook → Ops 鍵タブ「待機キュー」に表示 → Discord
    → Ops 店舗編集で「課金中」確認（Webhook だけの場合は手動 ON）
```

テストカード: `4242 4242 4242 4242`（任意の将来日・CVC）

## 6. API（デバッグ）

| メソッド | 認証 | 内容 |
|----------|------|------|
| `GET /api/stripe` | なし | 設定状況・待機件数（概要） |
| `POST /api/stripe` + `Stripe-Signature` | Webhook | キュー追加 |
| `POST { action: list_pending }` | Ops secret | 待機一覧 |
| `POST { action: dismiss, id }` | Ops secret | キューから削除 |
| `POST { action: verify_session, sessionId }` | Ops secret + API key | Session 照会 |

## 7. 本格連携（次フェーズ・未実装）

- Webhook から Firestore `shops.subscribed` を **サーバー直接更新**（Firebase Admin / 信頼できるバックエンド）
- Stripe Customer Portal・サブスク更新
- 本番 `live` キーと `stripeMode: 'live'`
- 請求書・領収書メール

## 関連

- [`revenue.md`](./revenue.md) — 価格・MRR
- [`revenue-go-live.md`](./revenue-go-live.md) — 導入チェックリスト
- [`security.md`](./security.md) — シークレット一覧
