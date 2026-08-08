# 課金デバッグ（お金周り）

## 自動チェック（リリース前）

```bash
node scripts/billing-selfcheck.mjs
```

- 全プランの初回 Checkout 見積もりの整合
- Stripe JPY / USD 金額変換
- Payment Link URL 形式
- 店舗ID バリデーション

Canary（本番デプロイ後）: `/api/stripe` が `ok: true` を返すことを確認。

## 店舗 UI デバッグモード

店舗管理 / Admin 料金タブのダッシュボードで詳細を表示:

- URL: `?billing_debug=1`（例: `store.html?shop=demo&billing_debug=1`）
- またはブラウザで `localStorage.setItem('mos_billing_debug', '1')`

表示内容: 課金フラグ整合、初回見積もり、Payment Link 有無、Stripe API 応答（秘密情報は含まない）。

## Stripe 戻り URL（重要）

成功 URL は **店舗ID付き** で Admin に戻します。

- `admin.html?billing=success&shop={CHECKOUT_SESSION_CLIENT_REFERENCE_ID}`

`billing-return.js` が **loadShop 後** に店舗ID一致を検証してから `subscribed` を付与します。不一致時は課金 ON しません。

## Ops API

`POST /api/stripe`（Ops secret）:

| action | 用途 |
|--------|------|
| `billing_health` | Webhook/API 設定とキュー健全性 |
| `verify_session` | Session 照会（`amountMajor` 付き） |
| `list_pending` | 未反映支払い一覧 |

`GET /api/stripe?shop=<id>&debug=1` — 店舗向けキュー要約 + diagnostics（非公開鍵なし）。

## よくある不整合

| 症状 | 確認 |
|------|------|
| 支払ったが未課金 | Ops キュー / `billing=success` の shop パラメータ / Firestore `subscribed` |
| 金額表示がおかしい | JPY は Stripe の `amount_total` がそのまま円（÷100 しない） |
| 別店舗が課金 ON | 成功 URL の `shop=` と `?shop=` の一致 |

関連: [`stripe-setup.md`](./stripe-setup.md), [`stripe-pricing-model.md`](./stripe-pricing-model.md)
