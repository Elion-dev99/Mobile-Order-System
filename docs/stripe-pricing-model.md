# Stripe 課金モデル（双方に有利な既定）

QuickOrder の Payment Link / クーポンは **`js/config.js` の `stripeCommerce`** と **`scripts/stripe-bootstrap.mjs`** で定義します。

## なぜこの形か

| 観点 | 店舗（顧客） | QuickOrder（事業者） |
|------|----------------|----------------------|
| トライアル | アプリ内 **14日無料** で厨房まで試せる。Stripe では二重トライアルしない | 無料期間のサポートコストを抑えつつ転換率を上げる |
| 初期費用 | 導入・設定の対価が明確（Lite ¥29,800 等） | オンボーディング人件・設定工数の回収 |
| 月払い | **初月サブスクのみ値引き**（Lite なら ¥4,000 off → 初月 ¥2,980） | 初期＋初月を **1回の Checkout** にまとめ、決済手数料の回数を抑える |
| 年払い | 月額×**10**（**2ヶ月無料**）— LP 既定 | 前払いでキャッシュフロー・解約率改善（ACV 最大化） |
| 年払いクーポン | 初月値引きは **付けない**（年払い割引と二重にしない） | 粗利の健全化 |

Stripe 日本のカード手数料はおおむね **3.6%** 前後。小額の月次だけに分散すると事業者負担が増えるため、**契約時に初期＋サブスク開始をまとめる** Checkout が基本です。

## 金額一覧（税別・`config.js` / `PLANS` と一致）

| プラン | 初期（一回） | 月額 | 年額（一括） | 初月サブスク値引き |
|--------|-------------|------|--------------|-------------------|
| Lite | ¥29,800 | ¥6,980 | ¥69,800 | ¥4,000 |
| Growth | ¥49,800 | ¥14,800 | ¥148,000 | ¥5,000 |
| Business | ¥98,000 | ¥29,800 | ¥298,000 | ¥10,000 |
| Chain | ¥198,000 | ¥49,800 | ¥498,000 | ¥15,000 |

**初回 Checkout の目安（月払い・Lite）**: ¥29,800 + ¥2,980 = **¥32,780**（2ヶ月目以降 ¥6,980/月）。

**初回 Checkout の目安（年払い・Lite）**: ¥29,800 + ¥69,800 = **¥99,600**（次回は 1 年後）。

## 技術上の対応

1. **Payment Link** — 各プラン×（月払い / 年払い）で 1 リンク  
   - 明細: 初期 Price（一回） + サブスク Price（月 or 年）  
   - メタデータ: `planId`, `cycle`（Webhook / Ops 表示用）

2. **クーポン ID**（月払いリンクにのみ自動適用）  
   - `QO_LITE_INTRO`, `QO_GROWTH_INTRO`, `QO_BUSINESS_INTRO`, `QO_CHAIN_INTRO`  
   - `duration=once`, `amount_off` は `stripeCommerce.introFirstMonthOff`

3. **成功 URL**（全リンク共通）  
   `https://mobile-order-system.pages.dev/admin.html?billing=success&shop={CHECKOUT_SESSION_CLIENT_REFERENCE_ID}`

4. **フロント** — `stripePaymentLinksByCycle` + 店舗の `billingCycle` で正しいリンクへ。`client_reference_id` は Admin から店舗 ID を付与。

## 一括セットアップ（推奨）

既存の Lite リンクを手作業で直すより、テストキーで API 一括作成が整合しやすいです。

```bash
STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-bootstrap.mjs
```

出力 JSON を `js/config.js` の `stripePaymentLinksByCycle` に貼り付けてデプロイ。

プラン単体:

```bash
STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-bootstrap.mjs --plan lite
```

`--dry-run` で API を叩かず設計ログのみ表示。

## 手作業で Dashboard だけ使う場合

[`stripe-setup.md`](./stripe-setup.md) に従い、上表の金額・クーポン・成功 URL を **Payment Link ごと**に合わせる。Lite の既存リンクは **月払い（初期＋月額サブスク）** 用として `lite.monthly` に登録済みの場合、年払いは別リンクを追加。

## 関連

- [`stripe-setup.md`](./stripe-setup.md) — Webhook・シークレット  
- [`revenue.md`](./revenue.md) — MRR / ACV 方針
