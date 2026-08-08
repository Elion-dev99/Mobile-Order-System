# Stripe 全自動セットアップ（創業者はシークレット1回 + Run）

Cursor / GitHub Actions が **Stripe 商品・Payment Link・Webhook・Cloudflare シークレット・config 更新**まで行います。  
創業者が Stripe Dashboard を触る必要は **ほぼありません**（テストキーを GitHub に1回入れるだけ）。

## 創業者が1回だけやること

### A. GitHub Actions シークレット（必須）

[Repo → Settings → Secrets and variables → Actions](https://github.com/Elion-dev99/Mobile-Order-System/settings/secrets/actions)

| 名前 | 値 | 取得場所 |
|------|-----|----------|
| `STRIPE_TEST_SECRET_KEY` | `sk_test_...` | Stripe Dashboard → 開発者 → API キー（**テストモード**） |

既にあるはず（Cardinal 用）:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

### B. ワークフローを1回実行

**注意:** GitHub は `workflow_dispatch` を **default ブランチ（main）にワークフローがあるとき**だけ Actions 一覧に出します。  
PR [#64](https://github.com/Elion-dev99/Mobile-Order-System/pull/64) を **main にマージ**してから:

[Actions → **Stripe full setup (one-click)**](https://github.com/Elion-dev99/Mobile-Order-System/actions/workflows/stripe-full-setup.yml) → **Run workflow**

- `register_webhook`: ON（推奨）
- `upload_cloudflare_secrets`: ON（推奨）
- `commit_generated_links`: ON（推奨 → `js/stripe-links.generated.js` をコミット）

完了後: **PR が自動作成**されるか、同ブランチにコミットされます。Cardinal 自動マージが止まっている場合は **手動マージ** → Deploy。

### C. Cursor Cloud Agent に全部任せる（推奨）

1. GitHub に `STRIPE_TEST_SECRET_KEY` を入れる（上記 A）
2. （任意）Cursor の **Cloud Agent 環境シークレット**にも `STRIPE_SECRET_KEY` を同じ `sk_test_...` で入れると、マージ前でも Agent が直接 bootstrap を実行できる
3. チャットで一言:

> `STRIPE_TEST_SECRET_KEY` を入れた。Stripe 全自動を実行して。

Agent は可能ならワークフロー dispatch、または VM 上で `stripe-bootstrap.mjs` を実行してコミットまで行います。

### D. 自分で Run する場合

## ワークフローがやること

1. `scripts/stripe-bootstrap.mjs --write-generated --register-webhook`
2. Payment Link 8本（4プラン × 月/年）、初月クーポン、初期+サブスク Checkout
3. Webhook `https://mobile-order-system.pages.dev/api/stripe` 作成（署名シークレット取得）
4. Cloudflare Pages に `STRIPE_WEBHOOK_SECRET` / `STRIPE_SECRET_KEY` / `STRIPE_MODE=test` を投入
5. `js/stripe-links.generated.js` を更新してコミット

## 私（Cursor）が**できない**こと

| 理由 |
|------|------|
| Stripe / GitHub / Cloudflare の **秘密鍵を自分で生成** | セキュリティ上、あなたのアカウントにしかない |
| **本番 `sk_live_`** の初回登録 | 同じく創業者のみ（切替時に `STRIPE_LIVE_SECRET_KEY` + 別ワークフロー or 手動） |
| **銀行口座・Stripe 本番有効化** | Stripe の KYC は人間必須 |

テストモードの範囲では、**キーを GitHub に預けて Run するだけ**でほぼ全自動です。

## 動作確認（テストカード）

1. Ops で店舗作成 → Admin「カードで契約」
2. カード `4242 4242 4242 4242`
3. 成功 URL / Ops 鍵タブの Stripe キュー / Discord

## 関連

- [`stripe-pricing-model.md`](./stripe-pricing-model.md) — 金額設計
- [`stripe-setup.md`](./stripe-setup.md) — 手動フォールバック
- [`cursor-founder-division-of-labor.md`](./cursor-founder-division-of-labor.md) — 役割分担
