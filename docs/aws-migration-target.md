# AWS 全面移行 — サービス選定と段階プラン

| 項目 | 内容 |
|------|------|
| 目的 | **Firestore + Cloudflare を AWS に置き換える**とき、どのサービスを採用するか迷わないための指針 |
| 方針 | **全面移行**だが **一気に切らない**（デュアルラン → 切替）。Cursor / Cardinal が canary とロールバックで守る |
| 関連 | [`aws-integration.md`](./aws-integration.md)（既存ブリッジ） / [`pl.md`](./pl.md) / [`pl-50k-smaregi.md`](./pl-50k-smaregi.md) / [`specification.md`](./specification.md) / [**フェーズ別費用表**](./aws-migration-phase-costs.md) |

---

## 1. 結論 — おすすめの AWS 構成（QuickOrder 向け）

「とりあえず全部入り」ではなく、**今の機能を壊さず移す**ための **最小で足りるセット**です。

| いま（GCP / CF） | AWS 先 | 選ぶ理由 |
|------------------|--------|----------|
| Cloudflare Pages（静的 HTML/JS/CSS） | **S3 + CloudFront** | ビルドなし静的配信の定番。帯域安い |
| `_redirects` / カスタムドメイン | **CloudFront** + **Route 53**（または既存 DNS） | Pages と同じ「エッジ配信」 |
| `functions/api/*`（Cardinal / Stripe / Discord…） | **Lambda** + **API Gateway HTTP API** | Pages Functions と同型。VPC 不要で始める |
| Functions 内 Cache API（メンテ・prefs・ledger） | **DynamoDB**（TTL 付き） | キルスイッチ・Cardinal prefs をサーバ永続化 |
| Cloud Firestore（注文・店舗・メニュー） | **DynamoDB**（単一テーブル or テーブル分割） | スケール・従量。キー設計が要る |
| 厨房 `onSnapshot` リアルタイム | **AppSync**（Dynamo バックエンド）**または** API Gateway **WebSocket** + Lambda | AppSync = Firebase っぽい購読。WS = 細かく制御 |
| Firebase Auth（Ops / Admin） | **Amazon Cognito**（User Pool） | Email/Password 相当。店舗スコープはカスタム属性 or テーブル |
| 客席（Auth なし注文） | Cognito **未ログイン API** + **IAM なし**の公開 POST は **Lambda で検証** | 今の Rules と同じ「公開 create + サーバゲート」 |
| 画像・エクスポート（将来） | **S3** | メニュー写真・CSV 退避 |
| バッチ・連携（Stripe 集計・月末手数料） | **EventBridge** + **Lambda**（既存ブリッジから拡張） | cron を AWS 側に寄せる選択肢 |
| 監視・障害 | **CloudWatch** + 既存 **Discord**（SNS は任意） | Cardinal はそのまま AWS 上の API をプローブ |
| CI/CD | **GitHub Actions** → S3 sync + Lambda deploy（**SAM** or **CDK**） | 今の deploy ワークフローを差し替え |
| シークレット | **Secrets Manager**（Lambda から参照） | Cloudflare Pages secrets の代替 |

### あえて最初は入れないもの

| サービス | 理由 |
|----------|------|
| **ECS / EKS** | 静的 + Lambda で足りる。コンテナは運用コスト↑ |
| **ALB + 常時 EC2** | NAT/ALB 固定費。HTTP API + Lambda で代替 |
| **Aurora 本番第一選択** | リアルタイム厨房は AppSync/Dynamo が Firebase から近い。Aurora は分析・レポート段階で |
| **OpenSearch** | 店数が増えてから。まずは Dynamo + 集計 Lambda |
| **全面 Step Functions** | 障害フロー以外は EventBridge + Lambda で十分 |

### Amplify は使う？

| 選択 | 内容 |
|------|------|
| **Amplify Hosting + Auth + Data** | 移行を **早く**したいなら候補。Gen2 で Cognito + Dynamo + ホスティング一体 |
| **S3 + CloudFront + 素の Lambda** | **制御とコスト見通し**優先。今の「ビルドなし ESM」をそのまま載せやすい |

**推奨:** まず **S3 + CloudFront + Lambda + DynamoDB + Cognito**。リアルタイムは **AppSync** を Phase 3 で。Amplify は「フロントを大きく書き換える段階」で再評価。

---

## 2. Firestore → AWS のデータ設計（概要）

現行コレクション（`specification.md`）を Dynamo に載せるイメージ:

| Firestore | DynamoDB 案 | 備考 |
|-----------|-------------|------|
| `shops/{id}` | `PK=SHOP#id` | プラン・メンテ・課金フラグ |
| `menus` / shop 配下 | `PK=SHOP#id SK=MENU#...` | または shop 埋め込み + 更新頻度で分割 |
| `orders` | `PK=SHOP#id SK=ORDER#ts#id` | GSI: `status` / `shopId+created` で厨房クエリ |
| `leads` / `surveys` | 別テーブル or 同テーブル `LEAD#` | 低頻度 |
| `ops/*`（Rules deny） | **クライアント直アクセス禁止** — Lambda のみ | 今と同じ |

**リアルタイム:** AppSync の `subscribe` で `orders` 変更を厨房に配信（`onSnapshot` 置き換え）。

**保留キュー `mos_pending_orders`:** 移行期も **端末 localStorage は維持**。サーバ側は **SQS FIFO（店舗単位）** または Dynamo + 冪等 PUT を Phase 2 で検討。

---

## 3. Cloudflare → AWS の API 対応表

| 現行パス | 移行先 |
|----------|--------|
| `/api/cardinal` | `POST /cardinal` Lambda（既存 `cardinal.js` を移植） |
| `/api/maintenance` | Lambda + **DynamoDB**（Cache API 廃止） |
| `/api/notify` | Lambda（Discord はそのまま） |
| `/api/stripe` | Lambda |
| `/api/system-report` | Lambda + Dynamo ledger |
| `/api/aws` | 不要になる or 内部診断のみ |
| `/api/discord` | Lambda（Interactions 署名は同じ） |

**メンテの「Firestore 落ちても edge で効く」** → **Dynamo + CloudFront で `/api/maintenance` を常に叩く**（今の `maintenance.js` クライアントは URL 差し替えのみ）。

---

## 4. 段階移行（Cursor が回す順序）

```text
Phase 0  準備（1〜2 PR）
  · IAM・OIDC（GitHub→AWS）· Secrets Manager
  · EventBridge bus（既存ブリッジ）
  · docs + SAM/CDK スケルトン

Phase 1  配信だけ AWS（デュアル CDN）
  · S3+CloudFront に静的をデプロイ
  · API はまだ CF Pages または Lambda 並行
  · canary: 両 URL をプローブ

Phase 2  API 全面 Lambda
  · functions/api/* を SAM で Lambda に移植
  · メンテ・Cardinal prefs を Dynamo に
  · GitHub Actions を AWS deploy に切替
  · Cloudflare Pages は read-only フォールバック

Phase 3  データ層（最大リスク）
  · Dynamo テーブル作成
  · バックフィル Firestore → Dynamo（一括スクリプト）
  · 厨房: AppSync 購読に切替（`admin.js` / `store.js`）
  · デュアル書き込み期間（短く）→ Firestore 読み取り停止

Phase 4  認証
  · Cognito User Pool · スタッフ移行
  · Rules 相当を Lambda + AppSync 認可に

Phase 5  片付け
  · Firebase / Cloudflare プロジェクト停止
  · コスト・監視を CloudWatch 一本化
```

各 Phase は **draft PR + canary + ロールバック**（`docs/autonomy.md`）。創業者の手動マージは不要（auto-merge 再開前提）。

---

## 5. 費用の目安（移行後・小〜中規模）

[`pl.md`](./pl.md) を AWS 版に読み替え:

| 店舗規模 | 静的+Lambda | Dynamo+AppSync | 注意 |
|----------|-------------|----------------|------|
| 〜10店 | 数千〜1万/月 | 無料枠内多め | NAT を作らない |
| 〜50店 | 1〜3万/月 | 数千〜2万/月 | 読取設計が効く |
| 〜100店 | 2〜8万/月 | 1〜5万/月 | AppSync 接続数 |
| 5万店 | **再設計必須** | [`pl-50k-smaregi.md`](./pl-50k-smaregi.md) | 単一リージョン Dynamo + シャーディング |

**固定費を膨らせないコツ:** HTTP API（not ALB）、Lambda 外 VPC、CloudFront オリジン S3、Dynamo on-demand → ピーク時だけ Provisioned 検討。

---

## 5.1 無料枠で行ける？（いまの規模）

**結論:** **開発・検証・有料数店〜十数店の本番**なら、設計を守れば **ほぼ無料枠〜月数千円**で回せる。  
**全面移行の Phase 1〜2（静的 + Lambda API）** は特に無料枠向き。**AppSync + 厨房常時接続**が最初の「枠を食う」ポイント。

| サービス | 無料の考え方（目安） | QuickOrder 現状 |
|----------|----------------------|-----------------|
| **Lambda** | 毎月 100万リクエスト程度の無料枠（恒常） | Cardinal cron + API は **十分枠内** |
| **API Gateway HTTP** | 一定リクエスト/月無料 | `/api/*` 数本なら問題小 |
| **S3** | 5GB 等（新規アカウント 12ヶ月） | 静的一式は **数百 MB 未満** |
| **CloudFront** | 転送量に無料枠（期間・条件あり） | 小規模店舗なら **枠内〜微課金** |
| **DynamoDB** | オンデマンドでも小容量は安い / 12ヶ月枠あり | 店舗少なら **ほぼ ¥0** |
| **Cognito** | MAU 数万まで無料枠 | スタッフのみなら **枠内** |
| **AppSync** | 接続・リクエストに無料枠（上限あり） | **厨房タブを常時開く店数**で増える → 10店未満なら軽い |
| **EventBridge** | カスタムイベントに無料枠 | 監視ミラーは **軽い** |

**無料枠でやらないもの（固定費が出る）**

- NAT Gateway、ALB、常時 EC2、Multi-AZ Aurora、大容量 OpenSearch

**いま CF + Firebase が無料に近い理由**と同じで、**トラフィックが小さい間は AWS も安い**。  
移行期は **CF と AWS 二重デプロイ**で一時的に両方に課金が乗る可能性あり → Phase 1 は **ステージング URL だけ AWS** にすると無料枠を守りやすい。

**Cursor 本体の月額・Agents 従量は AWS 無料枠とは別**（[`pl.md`](./pl.md) §3.4）。

---

## 6. 迷ったときの選択肢早見表

| 悩み | A | B | QuickOrder なら |
|------|---|---|-----------------|
| ホスティング | Amplify | S3+CloudFront | **B**（現行 HTML そのまま） |
| DB | Aurora Postgres | DynamoDB | **Dynamo**（注文スパイク・キー設計） |
| リアルタイム | WebSocket 自前 | AppSync | **AppSync**（厨房 UI 置き換えコスト低） |
| API | API Gateway | Function URL 直 | **API Gateway HTTP**（ルート多い） |
| 認証 | Cognito | Auth0 等 | **Cognito**（AWS 内完結） |
| 監視 | CloudWatch のみ | + Datadog | まず **CloudWatch + Discord** |

---

## 7. Cursor / 創業者の役割

| 担当 | 内容 |
|------|------|
| **Cursor** | 各 Phase の移植 PR、canary 更新、データ移行スクリプト、AppSync スキーマ |
| **創業者** | AWS アカウント・請求、Cognito 初回ドメイン、Stripe 本番、**移行ウィンドウの宣言**（メンテ 30分） |
| **不要** | 日常マージ、障害 PR、小修正の手動指示 |

---

## 8. 次に Cursor がやる実装タスク（合意後）

1. `infra/aws/` — SAM または CDK（S3, CloudFront, HTTP API, Lambda 1本 `health`）
2. `scripts/migrate-firestore-to-dynamodb.mjs` — 読み取りのみ・ドライラン
3. Phase 1 デプロイ workflow（CF 並行）
4. AppSync スキーマ草案（`orders` 購読）

「全面 AWS」は **Phase 1 から着手可能**。Firestore 切替は **Phase 3** までデュアルで安全に。

---

## 改訂

| 版 | 日付 | 内容 |
|----|------|------|
| 1.0 | 2026-08-08 | 初版 — サービス選定・段階移行 |
