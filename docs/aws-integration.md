# AWS 連携（ハイブリッド運用）

QuickOrder の **本番は Cloudflare Pages + Firebase** のまま。AWS は **必要に応じて横に繋ぐ**（全面移行は前提にしない）。

## なぜハイブリッドか

| 現行 | AWS で足す典型 |
|------|----------------|
| 静的 + `/api/*` Functions | Lambda / Step Functions（バッチ・連携） |
| Firestore リアルタイム | S3（エクスポート・画像）、Athena |
| Discord 通知 | SNS → メール/SMS、EventBridge → 社内ツール |
| Cardinal 監視 | EventBridge でインシデントを社内 WF に流す |

[`pl.md`](./pl.md) の結論どおり、**小規模では AWS 固定費より Cursor 従量が先に効く**。店数・規制・既存 AWS 契約が理由で足す。

## 実装済みブリッジ

| 経路 | 説明 |
|------|------|
| `GET /api/aws` | 設定有無（公開） |
| `POST /api/aws` | Ops 鍵付き: `ping`, `event`, `sqs`, `sns`, `mirror_incident` |
| システムインシデント | 初回検知時に **EventBridge**（+ 任意 SQS）へミラー |
| Cardinal `diagnose` | STS `GetCallerIdentity` で接続確認 |

コード: `functions/api/_aws-bridge.js`, `functions/api/aws.js`

## Cloudflare Pages シークレット

| Secret | 必須 | 用途 |
|--------|------|------|
| `AWS_ACCESS_KEY_ID` | 連携時 | IAM ユーザー or ロールキー |
| `AWS_SECRET_ACCESS_KEY` | 連携時 | 同上 |
| `AWS_REGION` | 推奨 | 既定 `ap-northeast-1` |
| `AWS_EVENT_BUS_NAME` | 任意 | カスタム Event bus 名 |
| `AWS_SQS_QUEUE_URL` | 任意 | インシデント JSON をキュー投入 |
| `AWS_SNS_TOPIC_ARN` | 任意 | 手動 `sns` アクション用 |
| `AWS_MIRROR_INCIDENTS` | 任意 | `false` で EventBridge ミラー停止（既定 ON） |

**IAM 最小権限の例**

- `sts:GetCallerIdentity`
- `events:PutEvents`（対象 bus）
- `sqs:SendMessage`（対象キュー）
- `sns:Publish`（対象トピック）

## 初回設定（Cursor / 創業者 1 回）

1. AWS で EventBridge bus（例: `QuickOrderOps`）と IAM ユーザーを作成
2. GitHub Actions → **Configure AWS bridge** → キーと ARN を入力（Cloudflare に投入）
3. `curl https://mobile-order-system.pages.dev/api/aws` で `configured.credentials: true`
4. Ops 鍵付き: `POST /api/aws` `{"action":"ping"}`

## EventBridge 受け側（これから足す例）

```text
QuickOrder SystemIncident (DetailType)
    → EventBridge Rule
    → Lambda（Slack 転送 / チケット起票 / データレイク S3）
```

Detail JSON: `id`, `feature`, `cause`, `kind`, `severity`, `shopId`, `url`, `count`, `at`

## 全面 AWS 移行はいつ検討するか

- 有料 **数百店以上** で Firestore 読取・ egress が支配的
- 既存 POS/ERP が **AWS VPC 内**のみ
- スマレジ級は [`pl-50k-smaregi.md`](./pl-50k-smaregi.md) を別途

日常運用は **Cursor + Cardinal** が継続。AWS は **連携・バッチ・将来のスケール**用。

## 関連

- [`security.md`](./security.md) — シークレット一覧
- [`system-watchdog.md`](./system-watchdog.md) — インシデント発火元
- [`cursor-full-ops-delegation.md`](./cursor-full-ops-delegation.md) — Cursor 運用委譲
