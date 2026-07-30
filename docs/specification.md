# QuickOrder（Mobile-Order-System）システム仕様書

| 項目 | 内容 |
|------|------|
| プロダクト名 | QuickOrder |
| リポジトリ | Mobile-Order-System |
| 文書種別 | コード全体仕様（現行実装ベース） |
| 対象コミット | `main` 先端時点 |
| 関連文書 | [`cardinal.md`](./cardinal.md) / [`revenue.md`](./revenue.md) |

---

## 1. 概要

QuickOrder は飲食店向け **席 QR モバイルオーダー SaaS** である。客席ブラウザからメニュー閲覧・カート・注文・進捗確認ができ、厨房モニター（Admin）と店舗管理（Store）でオペレーションを回す。内部向け Ops コンソールでマルチ店舗・通知・負荷試験・双AI監視（Cardinal）を運用する。

### 1.1 目的

- 席の QR から厨房までの注文オペレーションを一本化する
- Lite〜Chain の段階プランで機能課金し、トライアル経由で契約転換する
- Firestore 障害時も保留キューで注文を失わない（`mos_pending_orders`）
- Cardinal（Guardian / Executor）で障害検知〜修正 PR まで半自動運転する

### 1.2 スコープ外（現行）

- Firebase Auth による本番級ユーザー認証
- 厳密な決済完了フロー（Stripe Payment Link は任意導線のみ）
- ネイティブアプリ（PWA の最小シェルのみ）
- Firestore セキュリティルールの本番締め（現状フルオープン）

---

## 2. システム構成

```text
  [客席ブラウザ]  [厨房/店舗]  [Ops]  [LP]
         │             │         │      │
         └─────────────┴────┬────┴──────┘
                            │ 静的 HTML/CSS/ESM
                            ▼
                 Cloudflare Pages
                   ├─ 静的配信 (_redirects)
                   └─ Pages Functions
                        /api/notify
                        /api/incident
                        /api/cardinal
                            │
                            ├─ Discord Webhook
                            └─ Cursor Cloud Agents / Automations
                            │
                            ▼
                   Firebase Firestore
                   (mobile-order-system-c7c70)
```

| 層 | 技術 | 備考 |
|----|------|------|
| フロント | HTML + CSS + ES Modules（ビルドなし） | Firebase JS SDK CDN `12.15.0` |
| 配信 | Cloudflare Pages | プロジェクト `mobile-order-system` |
| API | Pages Functions (`functions/api/*`) | Discord / Cursor 連携 |
| DB | Cloud Firestore | クライアント直読み書き |
| CI/CD | GitHub Actions | deploy / Cardinal cron / secrets 投入 |
| PWA | `manifest.webmanifest` + `sw.js` | 客席シェルの最小キャッシュ |

本番想定 URL: `https://mobile-order-system.pages.dev`

---

## 3. ディレクトリ構成

```text
/
├── index.html          # 客席メニュー SPA
├── cart.html           # → index.html?view=cart へリダイレクト
├── status.html         # 注文状況
├── admin.html          # 厨房モニター / 店長コンソール
├── store.html          # 店舗管理（QR・営業・在庫）
├── ops.html            # 内部 Ops HQ
├── lp.html             # SaaS LP / 見積・リード
├── sw.js / manifest.webmanifest
├── _redirects          # /s/:shop/... リライト
├── wrangler.jsonc      # Cloudflare Pages
├── firebase.json / firestore.rules / .firebaserc
├── css/                # guest / store / ops / lp / style
├── js/                 # フロント論理（ESM）
├── functions/api/      # Pages Functions
├── scripts/            # デプロイ・負荷試験
├── docs/               # 本仕様・Cardinal・収益
├── .cursor/rules/      # Cardinal Guardian / Executor 規範
└── .github/workflows/  # CI/CD
```

---

## 4. 画面・URL 仕様

### 4.1 ページ一覧

| ページ | パス | 主 JS | 利用者 |
|--------|------|-------|--------|
| 客席メニュー | `index.html` | `js/app.js` | 来店客 |
| カート互換 | `cart.html` → `index.html?view=cart` | （リダイレクト） | 来店客 |
| 注文状況 | `status.html` | `js/status.js` | 来店客 |
| 厨房 / Admin | `admin.html` | `js/admin.js` | 厨房・店長 |
| 店舗管理 | `store.html` | `js/store.js` | 店長・ホール |
| Ops | `ops.html` | `js/ops.js` | 内部（Cursor/Owner） |
| LP | `lp.html` | `js/lp.js` | 見込み顧客 |

### 4.2 店舗スコープ URL

`_redirects` により次を書き換え:

| パス | 実体 |
|------|------|
| `/s/:shop` | `index.html?shop=:shop` |
| `/s/:shop/cart` | `cart.html?shop=:shop` |
| `/s/:shop/status` | `status.html?shop=:shop` |
| `/s/:shop/admin` | `admin.html?shop=:shop` |
| `/s/:shop/store` | `store.html?shop=:shop` |

### 4.3 共通クエリ

| パラメータ | 説明 |
|------------|------|
| `shop` / `store` | 店舗 ID（`js/tenant.js`） |
| `table` | 席番号（未指定時: 本番 `1` / デモ `デモ`） |
| `demo=1` / `mode=demo` | デモモード開始（`demo=0` で解除） |
| `view=cart` / `#cart` | 客席 SPA でカート表示 |
| `order` | `status.html` の注文 ID |
| `queued=1` | Firestore 失敗後の保留ステータス |
| `tab=` | Ops タブ（`notify` / `cardinal` 等） |
| `billing=success` | Stripe 成功戻り → 課金有効化 |

### 4.4 店舗 ID 解決順（`resolveShopId`）

1. クエリ `shop` / `store`
2. パス `/s/{id}/`
3. `sessionStorage.mos_shop_id`
4. 既定 `default`

正規化: 小文字、`[a-z0-9_-]`、最大 48 文字。

シード店舗: `default` / `hanako-sushi` / `ichi-ramen`（`js/tenant.js`）。

---

## 5. モジュール責務（`js/`）

| ファイル | 責務 |
|----------|------|
| `config.js` | プロダクト定数・プラン定義・`DEFAULT_SHOP` |
| `plans.js` | 価格計算・機能ゲート・トライアル/アクセス状態 |
| `firebase.js` | Firestore 初期化 |
| `tenant.js` | マルチテナント URL / キー |
| `shop.js` | 店舗・メニュー読込、売切・在庫・ラストオーダー、機能可否 |
| `data.js` | デフォルトメニューシード |
| `app.js` | 客席 SPA 本体 |
| `place-order.js` | 注文確定・合計計算・保留キュー連携 |
| `cart.js` | 旧カート実装（現行経路は SPA + `place-order.js`） |
| `status.js` | 注文進捗・デモ疑似進行・ETA |
| `demo.js` | デモ判定・カートキー分離・URL 付与 |
| `pin.js` | 席 PIN |
| `guest-features.js` | 呼出/会計・混雑 ETA・アップセル・アンケート |
| `guest-extras.js` | お気に入り・人数・年齢確認・クイックフィルタ |
| `i18n-menu.js` | 日英 UI / メニュー文言 |
| `coupons.js` | クーポン検証・適用 |
| `order-history.js` | 席履歴・再注文 |
| `admin.js` | 厨房 KDS・分析・メニュー・リード・収益・設定 |
| `store.js` | QR・店舗プロフィール・呼出対応・在庫/クーポン |
| `staff-auth.js` | 厨房/ホール/店長 PIN（Business+） |
| `ops.js` / `ops-auth.js` | Ops HQ・ブラウザ内認証 |
| `notify.js` / `notify-orders.js` | Discord 通知 |
| `leads.js` | LP リード投稿 |
| `lp.js` | LP UI・見積・CTA |
| `health.js` | ヘルスプローブ・保留注文 flush |
| `auto-heal.js` | 連続障害時の `/api/incident` エスカレーション |
| `cardinal.js` | Guardian/Executor 神経系（Ops 上） |
| `load-monitor.js` | 混雑レベル算出・通知 |
| `load-test.js` | 負荷試験オーケストレーション |

---

## 6. ドメインモデル（Firestore）

ルールファイル: `firestore.rules`（現状すべて `allow read, write: if true` — Demo/MVP）。

### 6.1 コレクション一覧

| コレクション | 用途 |
|--------------|------|
| `orders/{orderId}` | 注文 |
| `shops/{shopId}` | 店舗設定（現行） |
| `shopMenus/{shopId}` | メニュー |
| `shop/settings`, `shop/menu` | レガシー単一店舗 |
| `leads/{id}` | LP 問い合わせ |
| `serviceRequests/{id}` | 店員呼出・会計リクエスト |
| `surveys/{id}` | 完了後アンケート |
| `ops/settings` | Discord 等の運用設定 |

### 6.2 `orders/{orderId}`

| フィールド | 型 | 説明 |
|------------|-----|------|
| `id` | string | ドキュメント ID（`ORD-xxxxxx` / `DEMO-xxxxxx`） |
| `shopId` | string | 店舗 |
| `tableNumber` | string | 席 |
| `partySize` | number? | 人数 |
| `items` | array | カート行スナップショット |
| `subtotal` | number | 小計 |
| `discount` | number | クーポン割引 |
| `couponCode` | string\|null | 適用コード |
| `serviceCharge` / `serviceChargePercent` | number | サービス料 |
| `tip` / `tipPercent` | number | チップ |
| `tax` | number | 税（割引後＋サービス＋チップの 10%、floor） |
| `total` | number | 合計 |
| `platformFee` / `platformFeePercent` / `platformFeeStatus` | number/string | Chain 手数料（`unbilled` / `none`） |
| `timestamp` | number | `Date.now()` |
| `status` | string | `received` → `cooking` → `finishing` → `done` |
| `demo` | boolean | デモフラグ |
| `loadTest` | boolean? | 負荷試験フラグ |

**items[] 行**

| フィールド | 説明 |
|------------|------|
| `id` | 行ローカル ID |
| `itemId` | メニュー ID |
| `name` / `emoji` / `price` / `qty` | 表示・単価（カスタム込）・数量 |
| `customizations` | `{ [optId]: selectedValue }` |
| `toggles` | `{ [optId]: boolean }` |
| `note` | リクエスト |
| `saleApplied` | セール適用時 |

### 6.3 `shops/{shopId}`（主要フィールド）

`DEFAULT_SHOP`（`js/config.js`）をベースとする。

| グループ | フィールド |
|----------|------------|
| 基本 | `name`, `subtitle`, `tableCount`, `adminPin`, `locale`, `address`, `hoursNote` |
| 営業 | `isOpen`, `lastOrderEnabled`, `lastOrderTime` |
| 課金 | `subscribed`, `subscribedAt`, `trialStartedAt`, `trialEndsAt`, `planId`, `billingCycle`, `ownerEmail`, `ownerPhone`, `stores` |
| 客席 UX | `accentColor`, `minOrderAmount`, `partySizeRequired`, `ageGateEnabled`, `quickServiceEnabled` |
| 収益機能 | `serviceChargePercent`, `tipEnabled`, `tipPresets`, `coupons[]` |
| 在庫 | `stock{}`, `soldOut{}` |
| 権限/KDS | `staffPins{kitchen,floor,manager}`, `kdsMode`（`timeline`\|`byTable`\|`byItem`） |
| 運用 | `loadTest` |

### 6.4 `shopMenus/{shopId}`

| フィールド | 説明 |
|------------|------|
| `categories` | `{ id, label, icon }[]` |
| `allergens` | `{ id, label, emoji }[]` |
| `items` | メニュー配列 |
| `updatedAt` / `shopId` | メタ |

メニュー item: `id`, `category`, `name`, `description`, `price`, `emoji`, `popular`, `allergens[]`, `customizable[]`、任意で `tags[]`（`veg`/`spicy`/`kids`/`alcohol`/`set`）、`calories`、`alcohol`、セール（`saleEnabled`/`salePrice`/`saleFrom`/`saleUntil`）。

### 6.5 その他

**`serviceRequests`**: `shopId`, `tableNumber`, `type`（`staff`\|`bill`）, `note`, `status`（`open`\|`done`）, `timestamp`, `orderingLocked`, `demo`, `loadTest`

**`surveys`**: `shopId`, `orderId`, `score`, `comment`, `timestamp`, `shopName`, `demo`

**`leads`**: `shopName`, `email`, `phone`, `planId`, `estimatedMrr`, `billingCycle`, `status`（`new`/`contacted`/`won`）, `source`（実装上 `'lp'`）, `createdAt`

**`ops/settings`**: `discordWebhook`, `discordEnabled`, `discordChannel`, `discordSetupDone`, `discordEvents`, `updatedAt`

---

## 7. 主要ユースケース

### 7.1 客席注文フロー

```text
QR/席URL → index.html?shop&table[&demo]
  → resolveShopId / 任意 PIN / loadShop+Menu
  → メニュー操作 → localStorage cart
  → view=cart → placeGuestOrder
       ├ demo → sessionStorage → status（疑似進行）
       ├ ok   → Firestore orders → status（onSnapshot）
       └ fail → mos_pending_orders → status?queued=1
  → done → アンケート / 追加注文（同 table）
```

詳細:

1. Store が `tableCount`（1〜80、印刷台紙最大 40）分の席 URL を生成（`guestEntryUrl`）
2. メニュー: カテゴリ / 検索 / アレルゲン除外 / クイックフィルタ
3. カスタム（select/toggle）・メモ・年齢ゲート（アルコール）
4. チェックアウト: クーポン（Growth+）・チップ・サービス料・税 10%・割り勘・最低注文
5. ステータス: `received` → `cooking` → `finishing` → `done`（デモは約 8.5 秒で自動進行）

### 7.2 厨房 KDS（Admin）

- `orders` を `shopId` + `timestamp` で `onSnapshot`（失敗時クライアントフィルタ）
- ステータス更新 + Discord `order_status`
- KDS モード（Growth+）: timeline / byTable / byItem
- SLA（Business+）: 8 分 warn / 15 分 late
- 音アラート・厨房伝票印刷（Growth+）
- `serviceRequests` open → 対応済で done + 会計ロック解除

タブ: 注文 / 分析 / メニュー / リード / 収益 / 設定

### 7.3 店舗管理（Store）

- 本日状況、QR 一覧・印刷、営業/ラストオーダー、ブランド色
- 最低注文・人数必須・年齢確認・クイック依頼
- Growth+: サービス料・チップ・スタッフ PIN・クーポン・テーブルボード
- 呼出・会計対応、品切れ・在庫、注文履歴

### 7.4 Ops HQ

| タブ | 内容 |
|------|------|
| HQ | 横断 KPI・ヘルス・未請求手数料 |
| 店舗 | 作成・一覧・削除（`default` 削除不可） |
| 通知 | Discord Webhook セットアップ・イベントテスト |
| 呼出 | 全店舗 `serviceRequests` |
| アンケート | `surveys` |
| テスト | 負荷試験・機能マトリクス |
| Cardinal | 双 AI 監視 UI |
| 鍵 | Ops パスワード（ブラウザ内ハッシュ） |

### 7.5 LP / SaaS ファネル

- 料金・ROI・比較・導入相談（`lp.html`）
- デモ: `index.html?shop=default&table=1&demo=1`
- リード → Firestore `leads` + Discord `lead_new`
- Stripe Payment Link 設定時は「カードで契約」、未設定時は見積フォーム

---

## 8. 料金・プラン仕様

詳細の運用メモは [`revenue.md`](./revenue.md)。定義本体は `js/config.js`。

### 8.1 価格（税別）

| Plan | 月額 | 年払い実質/月 | 初期 | 席上限 | 店舗上限 | 注文手数料 |
|------|------|---------------|------|--------|----------|------------|
| Lite | ¥6,980 | ¥5,817 | ¥29,800 | 15 | 1 | 0% |
| Growth | ¥14,800 | ¥12,333 | ¥49,800 | 50 | 1 | 0% |
| Business | ¥29,800 | ¥24,833 | ¥98,000 | ∞ | 3 | 0% |
| Chain | ¥49,800 | ¥41,500 | ¥198,000 | ∞ | ∞ | **0.8%** |

- 年払い: `annualMultiplier = 10`（2 ヶ月分無料）
- LP 既定課金サイクル: `annual`
- 追加店舗: ¥9,800/月（Chain 以外）
- トライアル: 14 日。終了後は分析/CSV/多言語/音/SLA 等をロック、厨房基本は継続

### 8.2 機能マトリクス（抜粋）

| 機能キー | Lite | Growth | Business | Chain |
|----------|:----:|:------:|:--------:|:-----:|
| kitchenMonitor / menuEdit / tablePin / tableBoard / allergenFilter | ● | ● | ● | ● |
| analytics / exportCsv / coupons / inventory / kdsModes / kitchenTickets / multiLang / soundAlert / serviceCharge / tip | — | ● | ● | ● |
| staffRoles / slaTimer / brandCustom / multiStore | — | — | ● | ● |
| hqDashboard | — | — | — | ● |

判定: `featureEnabled` → `canUseFeature`（プラン AND 契約/有効トライアル）→ `shopCanUse`。

### 8.3 アクセス状態（`getAccessState`）

| reason | 意味 |
|--------|------|
| `subscribed` | 課金有効 |
| `trial` | トライアル中 |
| `trial_expired` | 期限切れ（プレミアムロック） |
| `trial_pending` | 未スタンプ（初回アクセスで付与） |

負荷試験店舗（`load-*` / `loadTest`）はトライアル付与をスキップ。

---

## 9. 認証・権限

### 9.1 客席 PIN（`js/pin.js`）

- 席ごとの PIN（`localStorage mos_table_pins_{shopId}`）
- 認証状態は `sessionStorage mos_table_pin_auth_{shopId}`
- デモでは PIN ゲートを抑制

### 9.2 スタッフ（`js/staff-auth.js`）

- Business+ `staffRoles` 時のみ有効。未ゲート時は実質 `manager`
- ロール: `kitchen` / `floor` / `manager`
- PIN: `shops.*.staffPins.*`（店長は `adminPin` も可）
- 厨房ロールは注文タブ中心、設定/課金/分析/リードは店長のみ

### 9.3 Ops（`js/ops-auth.js`）

- クライアント側ゲート（本番向け堅牢認証ではない）
- ロール: `cursor` / `owner`
- 既定平文（開発用）: `cursor2026` / `owner2026`
- カスタムハッシュ: `localStorage.mos_ops_custom_hashes`（SHA-256）

---

## 10. 通知

実装: `js/notify.js` + `js/notify-orders.js`、API: `POST /api/notify`。

保存先: Firestore `ops/settings` および localStorage `mos_discord_*`（旧 Slack キーから移行。Slack URL は破棄）。

### 10.1 イベント一覧（`NOTIFY_EVENTS`）

`system_load`, `system_health`, `lead_new`, `lead_won`, `contract_activated`, `plan_changed`, `shop_created`, `shop_deleted`, `item_added`, `item_removed`, `bill_request`, `order_new`, `order_status`, `staff_call`, `load_test`

互換エイリアス `notifySlack*` は Discord 実装へ委譲。

---

## 11. ヘルス・AutoHeal・Cardinal

詳細プロトコルは [`cardinal.md`](./cardinal.md)。

### 11.1 Health（`js/health.js`）

- プローブ: Firestore（`shops/default`, `ops/settings`, `shop/settings`）+ `/api/notify`
- 状態: `ok` / `degraded` / `down` / `offline`
- 遷移時 Discord `system_health`
- 保留注文: `localStorage mos_pending_orders`（最大 30）。復旧時 flush

### 11.2 AutoHeal（`js/auto-heal.js`）

- 約 45 秒周期。連続失敗 → `POST /api/incident`
- クールダウン 30 分

### 11.3 Cardinal（`js/cardinal.js` + `/api/cardinal`）

| 役割 | 主務 |
|------|------|
| Guardian | ヘルス監視・PR レビュー・Executor 無応答検知 |
| Executor | 障害修正・機能実装・draft PR |

- Ops オープン中 60 秒サイクル（心拍）
- GitHub Actions `cardinal-cron.yml` が毎時 `:15` UTC に `tick`
- ラベル: `cardinal:guardian` / `cardinal:executor` / `cardinal:stuck` / `cardinal:escalate`

### 11.4 混雑レベル（`js/load-monitor.js`）

`normal` → `busy` → `crowded` → `critical`（待ち分・未完了・滞留 15 分超・呼出数）。変化時 `system_load`。

---

## 12. Pages Functions API

共通: JSON、`cache-control: no-store`。認証なし（公開 POST）。

### 12.1 `POST|GET /api/notify`

Discord Incoming Webhook プロキシ。

| | |
|--|--|
| Body | `content`\|`text`, 任意 `embeds[]`, `username`, `avatar_url`, 任意 `webhook` |
| Webhook 解決 | `env.DISCORD_WEBHOOK_URL` → なければ許可済み Discord URL の `body.webhook` |
| 成功 | `{ ok: true }` |

### 12.2 `POST|GET /api/incident`

障害 intake → Cursor Agent/Automation + Discord。

主な body: `status`, `summary`, `firestoreOk`, `notifyApiOk`, `cardinalRole` 等。

### 12.3 `POST|GET /api/cardinal`

| `action` | 内容 |
|----------|------|
| `heartbeat` | 役割心拍 |
| `dispatch` | Guardian/Executor 起動 |
| `tick` | 本番プローブ。異常 or `force` で dispatch |
| （省略） | 設定 readiness（`configured.*`） |

CORS: `access-control-allow-origin: *`

---

## 13. 環境変数・シークレット

### 13.1 Cloudflare Pages

| 変数 | 用途 |
|------|------|
| `DISCORD_WEBHOOK_URL` | 通知・incident・cardinal |
| `CURSOR_API_KEY` | Cloud Agents API |
| `CURSOR_REPO` | 既定リポジトリ URL |
| `CURSOR_AUTOMATION_*` | 共有 Automations（legacy） |
| `CURSOR_GUARDIAN_*` / `CURSOR_EXECUTOR_*` | 役割別 webhook/key |

### 13.2 GitHub Actions

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DISCORD_WEBHOOK_URL`（任意）

### 13.3 クライアント公開

`js/firebase.js` に Firebase Web 設定をハードコード（プロジェクト `mobile-order-system-c7c70`）。

---

## 14. CI/CD・スクリプト

| Workflow | トリガ | 処理 |
|----------|--------|------|
| `deploy-cloudflare-pages.yml` | `main` push / 手動 | Pages へ deploy（`functions` 含む） |
| `cardinal-cron.yml` | 毎時 `:15` UTC / 手動 | `POST /api/cardinal` `tick` |
| `cardinal-ci-dispatch.yml` | Deploy 失敗時 / 手動 | Discord に Guardian 信号 |
| `configure-*.yml` | 手動 | Pages secrets 投入 |

スクリプト:

| パス | 用途 |
|------|------|
| `scripts/deploy-cloudflare-pages.sh` | ローカル簡易デプロイ（`functions` 等を含まない場合あり。正式は CI） |
| `scripts/run-load-test.mjs` | Puppeteer 負荷試験 |
| `scripts/cleanup-load-test-shops.mjs` | `load-*` 店舗掃除 |

負荷試験フロー（`js/load-test.js`）: 店舗一括作成 → メニュー/リード/注文投入 → ステータス進行 → 呼出 → 任意クリーンアップ。シード店舗は削除しない。

---

## 15. PWA

| 項目 | 内容 |
|------|------|
| Manifest | name `QuickOrder`、`standalone`、theme `#0D5C4D`、`start_url: ./index.html` |
| Service Worker | cache `qo-shell-v1`。HTML/JS は network-first、CSS/SVG/manifest は cache-first |
| 登録 | `index.html` load 時に `sw.js` 登録 |

オフラインは客席シェル向けの最小構成。注文本体はオンライン（失敗時は保留キュー）を前提とする。

---

## 16. クライアント永続化キー（抜粋）

### localStorage

| キー | 用途 |
|------|------|
| `mos_cart_{shopId}` / `mos_cart_demo_{shopId}` | カート |
| `mos_table_pins_{shopId}` | 席 PIN |
| `mos_favs_{shopId}` | お気に入り |
| `mos_party_{shopId}_{table}` | 人数 |
| `mos_age_ok_{shopId}` | 年齢確認 |
| `mos_locale` | UI 言語 |
| `mos_bill_lock_{shopId}_{table}` | 会計ロック |
| `mos_pending_orders` | 未送信注文（最大 30） |
| `mos_local_menu_{shopId}` / `mos_shop_settings_{shopId}` / `mos_local_shops` | オフライン/フォールバック |
| `mos_discord_*` | 通知設定キャッシュ |
| `mos_cardinal_state` / `mos_autoheal_*` | Cardinal / AutoHeal |
| `mos_ops_custom_hashes` / `mos_ops_role_local` | Ops 認証 |

### sessionStorage

| キー | 用途 |
|------|------|
| `mos_demo` | デモ継続 |
| `mos_shop_id` | 解決済み店舗 |
| `mos_table_pin_auth_{shopId}` | 席 PIN 認証 |
| `mos_demo_order_{orderId}` | デモ/キュー注文 |
| `mos_coupon_{shopId}` | 適用中クーポン |
| `mos_staff_role_{shopId}` / `mos_admin_ok_{shopId}` | スタッフ/Admin |
| `mos_ops_role` | Ops ロール |

---

## 17. デモモード

- 起動: `?demo=1` / `?mode=demo` → `sessionStorage.mos_demo=1`
- Firestore 注文非書込。`DEMO-*` を sessionStorage に保存
- ステータスはタイマーで自動進行
- サービス要求・アンケートもローカルのみ
- カートキーを本番と分離
- リンク遷移は `withDemo` で `demo=1` を維持

---

## 18. セキュリティ・制約（現行）

1. **Firestore rules が全面許可** — 本番前にテナント境界・認証必須化が必要
2. **Pages Functions に認証なし** — Discord 送信・Cursor Agent 起動が公開 POST 可能
3. **Ops / スタッフ PIN はクライアントゲート** — サーバー側強制ではない
4. **Firebase Web 設定・開発用 Ops パスワードがリポジトリに含まれる**
5. **税表示**: UI「税込」表記と、小計系への 10% 加算（外税計算）の実装差に注意
6. **複合インデックス欠如時**: 席履歴等はクライアントフィルタにフォールバック

---

## 19. 受け入れ・運用上の不変条件

Executor / Guardian が壊してはいけない中核:

- 客席保留キュー `mos_pending_orders` と flush 経路
- Health プローブと Discord `system_health`
- Cardinal tick / heartbeat / dispatch
- シード店舗（特に `default`）の削除禁止
- 負荷試験店舗の消し忘れ防止（`loadTest` / cleanup）

人間が残す判断:

1. Cloudflare / Cursor の初回シークレット設定
2. draft PR のマージ判断
3. `cardinal:escalate` 時の最終確認
4. 月末の Chain 未請求手数料請求、`introSlotsRemaining` の月次更新

---

## 20. 用語集

| 用語 | 意味 |
|------|------|
| KDS | Kitchen Display System（厨房モニター） |
| SPA | 客席メニューとカートを同一 HTML で切替 |
| Growth+ | Growth 以上で解放される機能群 |
| Cardinal | Guardian（監視）と Executor（実行）の双 AI 体制 |
| platformFee | Chain プランの注文手数料（0.8%） |
| queued | Firestore 書込失敗後のローカル保留注文 |

---

## 改訂履歴

| 版 | 内容 |
|----|------|
| 1.0 | コード全体仕様の初版（アーキテクチャ・画面・データ・API・運用） |
