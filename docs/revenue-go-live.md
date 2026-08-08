# 収益化・実用稼働チェックリスト

店舗が **厨房で毎日使える**状態にし、**課金・手数料**まで回すための最短手順です。  
価格・機能の詳細は [`revenue.md`](./revenue.md)。

## 1. 基盤（初回のみ）

| # | 項目 | 確認 |
|---|------|------|
| 1 | [Configure Firebase Auth](https://github.com/Elion-dev99/Mobile-Order-System/actions/workflows/configure-firebase-auth.yml) を実行 | Ops/Admin で Firebase ログインできる |
| 2 | Cloudflare Pages シークレット（`OPS_API_SECRET`, `DISCORD_WEBHOOK_URL` 等） | `docs/security.md` |
| 3 | Ops「鍵」に `OPS_API_SECRET` | Cardinal / 通知テストが動く |
| 4 | （任意）`js/config.js` の `stripePaymentLink` | LP/Admin が「カードで契約」に切替 |
| 5 | `firestore.rules` デプロイ | 本 PR 以降は店舗タブレットからトライアル延長不可 |

## 2. 導入フロー（毎店舗）

```text
LP 問い合わせ → Ops リード対応 → 成約
    → 店舗タブで作成（14日トライアル自動）
    → オーナーに admin.html / store.html URL
    → 厨房で注文テスト → 本番メニュー
    → 契約（Stripe または Ops「課金中」ON）
```

1. **成約** — Ops → リード →「成約」→ 店舗フォームが自動入力される  
2. **店舗作成** — ID（英小文字）を確認して作成  
3. **オンボーディング** — `admin.html?shop=<id>` で Firebase ログイン・メニュー保存  
4. **客席** — `index.html?shop=<id>&table=1` の QR を印刷  
5. **課金** — Stripe 成功（`?billing=success`）または Ops 店舗編集で「課金中」

## 3. トライアル・課金のルール

| 状態 | 客席注文 | 厨房モニター | 分析・CSV・多言語等 |
|------|----------|--------------|---------------------|
| トライアル中 | OK | OK | OK |
| トライアル終了・未課金 | OK | OK | **ロック** |
| 課金中 | OK | OK | プランに応じて OK |

- 課金状態は **Firestore `shops/{id}.subscribed`** が正（ブラウザだけの偽装は不可）
- トライアル開始・終了日は **Ops / Firebase ログイン済み** からのみ変更

## 4. Ops HQ で毎日見る数字

- **課金中店舗** — 実 MRR の根拠（未課金は MRR に含めない）
- **トライアル7日以内** — クローズ優先
- **トライアル終了** — 課金 or ダウングレード説明
- **未請求手数料** — Chain プラン（月末請求）
- **新規リード** — 24h 以内に一次返信

## 5. 本番前スモークテスト

1. メンテ OFF、店舗「営業中」
2. 客席から注文 → 厨房で受付→調理→完了
3. 会計リクエスト / 店員呼出（該当プラン）
4. Ops で注文・手数料が見える
5. `scripts/canary-probe.mjs` または Deploy 後 canary 成功

## 6. Cardinal 自動化

トークン節約・障害時は [`cardinal-automation-pause.md`](./cardinal-automation-pause.md)。  
収益化フェーズでは **自動マージ OFF のまま**、手動マージ + 手動 Deploy で問題ありません。

## 関連

- [`growth-zero-cash.md`](./growth-zero-cash.md) — 獲得（広告費ゼロ）
- [`enterprise-parity.md`](./enterprise-parity.md) — 機能の形（決済 API は後接続）
- [`cursor-founder-division-of-labor.md`](./cursor-founder-division-of-labor.md) — 創業者が触る設定
