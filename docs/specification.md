# QuickOrder システム仕様書（PM向け）

| 項目 | 内容 |
|------|------|
| プロダクト名 | **QuickOrder** |
| リポジトリ | [Elion-dev99/Mobile-Order-System](https://github.com/Elion-dev99/Mobile-Order-System) |
| 文書種別 | システム全体仕様（プロダクト / 画面 / モジュール / データ / 運用） |
| 読者 | PM・オーナー・導入支援・Cursor エージェント |
| 本番 URL | `https://mobile-order-system.pages.dev` |
| 関連文書 | [`revenue.md`](./revenue.md) / [`security.md`](./security.md) / [`cardinal.md`](./cardinal.md) / [`enterprise-parity.md`](./enterprise-parity.md) |
| 版 | **2.0**（2026-07-30 · 現行 `main` 実装ベース） |

---

## 0. この文書の使い方

| 知りたいこと | 見る節 |
|--------------|--------|
| 何のプロダクトか・誰が使うか | §1〜§2 |
| 画面とユーザーフロー | §4〜§5 |
| プランで何が使えるか | §6 |
| **各プログラム（ファイル）の役割** | §7 |
| データ・API・認証 | §8〜§10 |
| 障害時・運用・Cardinal | §11〜§12 |
| 未実装・制約・ロードマップ | §13〜§14 |

技術の細部（Rules の関数名、Cursor 秘密鍵の投入手順など）は関連文書へ委ね、本仕様は **意思決定と引き継ぎに足りる粒度** で書く。

---

## 1. プロダクト概要

### 1.1 一言で

飲食店向け **席 QR モバイルオーダー SaaS**。客席ブラウザで注文し、厨房モニターと店舗管理でオペレーションを回し、内部 Ops でマルチ店舗・通知・障害対応を運用する。

### 1.2 ビジネス目的

1. 席の QR → 厨房までの注文オペレーションを一本化する  
2. Lite〜Chain の段階プランで機能課金し、14日トライアル経由で契約転換する  
3. Firestore 障害時も注文を失わない（端末側保留キュー）  
4. プラットフォーム障害時は客席を自動でレジ誘導し、復旧後に再開する  
5. 双 AI（社内名 Cardinal）で監視・自動メンテ・修正依頼まで半自動運転する  

### 1.3 スコープ外・スタブ（現行）

| 領域 | 状態 |
|------|------|
| 実決済（Stripe / PayPay / IC 課金） | **形のみ**（`payments.js`）。Payment Link は任意導線 |
| POS 本番連携 | **スタブ**（`pos-bridge.js`） |
| ネイティブアプリ | なし（客席 PWA 最小シェルのみ） |
| 店舗単位の Firebase Auth クレーム | 未実装（サインイン済みなら現状どの店も触れる） |
| サーバー側注文 intake の耐久キュー | なし（クライアント保留キューのみ） |

### 1.4 技術スタック（要約）

| 層 | 技術 |
|----|------|
| フロント | HTML + CSS + ES Modules（**ビルドなし**）、Firebase JS SDK CDN 12.15.0 |
| 配信 | Cloudflare Pages（`mobile-order-system`） |
| API | Pages Functions（`functions/api/*`） |
| DB | Cloud Firestore（`mobile-order-system-c7c70`） |
| CI/CD | GitHub Actions（deploy / Cardinal cron / secrets 投入） |
| 通知 | Discord Incoming Webhook |
| 自動修復 | Cursor Cloud Agents（Cardinal / Incident） |

---

## 2. ペルソナと権限の考え方

| ペルソナ | 主な画面 | 認証 |
|----------|----------|------|
| **来店客** | 客席メニュー / カート / 注文状況 | なし（任意で席 PIN） |
| **厨房スタッフ** | Admin（注文タブ中心） | スタッフ PIN（Business+）/ Firebase Auth は特権操作時 |
| **ホール / 店長** | Store / Admin | Store はフロア端末向けに Auth 不要の狭い更新可。メニュー全文・削除等は Auth |
| **本部 / オーナー** | Ops HQ | Ops パスワード + 特権書き込みは Firebase Auth + `OPS_API_SECRET` |
| **見込み顧客** | LP | なし（リード投稿のみ） |
| **内部 AI（Cardinal）** | API / Discord / PR | Cloudflare secrets |

設計方針（重要）:

- **Store（フロア端末）は Auth フリーを維持**する（狭いフィールドパッチのみ）。  
- **Ops / Admin の特権書き込みは Firebase Auth**。  
- **ゲストの注文 create は公開**（メンテナンス中は Rules で拒否）。

---

## 3. システム構成

```text
  [客席]   [厨房 Admin]   [Store]   [Ops]   [LP]
     │          │           │        │      │
     └──────────┴─────┬─────┴────┬───┴──────┘
                      │ 静的 HTML/CSS/ESM
                      ▼
             Cloudflare Pages
               ├─ 静的配信（_redirects）
               └─ Pages Functions
                    /api/notify
                    /api/incident
                    /api/cardinal
                    /api/maintenance
                      │
                      ├─ Discord
                      └─ Cursor Agents
                      │
                      ▼
               Cloud Firestore
```

### 3.1 リポジトリ構成（トップレベル）

```text
/
├── index.html / cart.html / status.html   # 客席
├── admin.html / store.html                # 店舗オペ
├── ops.html / lp.html                     # 内部・マーケ
├── sw.js / manifest.webmanifest           # PWA
├── _redirects / wrangler.jsonc / firebase.*
├── css/  js/  functions/api/  scripts/  docs/
├── .cursor/rules/                         # Cardinal 行動規範
└── .github/workflows/                     # CI/CD
```

---

## 4. 画面・URL 仕様

### 4.1 ページ一覧

| ページ | パス | 主プログラム | 利用者 | 役割（PM向け） |
|--------|------|-------------|--------|----------------|
| 客席メニュー | `index.html` | `js/app.js` | 来店客 | メニュー閲覧・カート・注文 |
| カート互換 | `cart.html` | リダイレクト | 来店客 | 旧 URL 互換 → `?view=cart` |
| 注文状況 | `status.html` | `js/status.js` | 来店客 | 進捗・ETA・追加注文 |
| 厨房 / Admin | `admin.html` | `js/admin.js` | 厨房・店長 | KDS・分析・メニュー・課金 |
| 店舗管理 | `store.html` | `js/store.js` | 店長・ホール | QR・営業・在庫・クーポン・呼出 |
| Ops | `ops.html` | `js/ops.js` | 内部 | 横断運用・Cardinal・負荷試験 |
| LP | `lp.html` | `js/lp.js` | 見込み客 | 料金・ROI・安心運用・リード |

### 4.2 店舗スコープ URL（`_redirects`）

| 公開パス | 実体 |
|----------|------|
| `/s/:shop` | `index.html?shop=:shop` |
| `/s/:shop/cart` | `cart.html?shop=:shop` |
| `/s/:shop/status` | `status.html?shop=:shop` |
| `/s/:shop/admin` | `admin.html?shop=:shop` |
| `/s/:shop/store` | `store.html?shop=:shop` |

### 4.3 主要クエリ

| パラメータ | 意味 |
|------------|------|
| `shop` / `store` | 店舗 ID |
| `table` | 席番号 |
| `demo=1` | デモ（Firestore に注文を書かない） |
| `view=cart` / `#cart` | 客席でカート表示 |
| `order` | 状況画面の注文 ID |
| `queued=1` | 送信失敗後の保留表示 |
| `tab=` | Ops タブ指定 |
| `billing=success` | Stripe 戻り → 課金フラグ付与 |

### 4.4 店舗 ID 解決（`js/tenant.js`）

1. クエリ `shop` / `store`  
2. パス `/s/{id}/`  
3. `sessionStorage.mos_shop_id`  
4. 既定 `default`  

正規化: 小文字・`[a-z0-9_-]`・最大 48 文字。  
シード店舗: `default` / `hanako-sushi` / `ichi-ramen`。

---

## 5. 主要ユースケース（ジャーニー）

### 5.1 客席注文（コア）

```text
QR → index.html?shop&table
  → 店舗/メニュー読込 → カート（localStorage）
  → placeGuestOrder
       ├ デモ → sessionStorage → status（疑似進行）
       ├ 成功 → Firestore orders → status（リアルタイム）
       └ 失敗 → mos_pending_orders → status?queued=1
  → done → 任意アンケート / 追加注文
```

含まれる体験: カテゴリ・検索・アレルゲン除外・カスタム・年齢ゲート・クーポン・チップ・サービス料・税・チャネル（店内/テイクアウト/デリバリー）・決済方法選択（形）。

### 5.2 厨房 KDS（Admin）

- 注文をリアルタイム受信し、`received → cooking → finishing → done` を更新  
- KDS 表示切替（Growth+）: timeline / byTable / byItem  
- SLA タイマー（Business+）: 8分警告 / 15分遅延  
- 呼出・会計リクエスト対応、会計ロック解除  
- 厨房伝票印刷（ブラウザ / 自動印刷フック）  

### 5.3 店舗管理（Store）

- 席 QR 一覧・印刷台紙、営業 ON/OFF、ラストオーダー  
- 在庫・売切、クーポン、呼出対応、テーブルボード  
- **Firebase Auth なしで** プロフィール / 営業 / 在庫 / クーポン等を更新可能（狭いパッチ）  

### 5.4 LP → リード → 契約

- 料金・比較・ROI シミュレータ・**安心運用（Cardinal を匿名紹介）**  
- 導入相談フォーム → `leads` + Discord  
- Stripe Payment Link 設定時のみ「カードで契約」CTA  

### 5.5 障害時フェイルセーフ

1. Health / Cardinal tick が連続異常を検知  
2. 自動メンテナンス ON（エッジ `/api/maintenance` + Firestore `platform/config`）  
3. 客席の新規注文・呼出・予約・リードを停止しレジ案内  
4. 復旧後、**Cardinal が入れた自動メンテのみ**自動解除（手動 ON は触らない）  

---

## 6. 料金・プラン・機能ゲート

詳細運用: [`revenue.md`](./revenue.md)。定義本体: `js/config.js` / `js/plans.js`。

### 6.1 価格（税別）

| Plan | 月額 | 年払い実質/月 | 初期 | 席 | 店舗 | 注文手数料 |
|------|------|---------------|------|----|------|------------|
| Lite | ¥6,980 | ¥5,817 | ¥29,800 | 15 | 1 | 0% |
| Growth | ¥14,800 | ¥12,333 | ¥49,800 | 50 | 1 | 0% |
| Business | ¥29,800 | ¥24,833 | ¥98,000 | ∞ | 3 | 0% |
| Chain | ¥49,800 | ¥41,500 | ¥198,000 | ∞ | ∞ | **0.8%** |

- 年払い: 月額 × 10（2ヶ月分無料）。LP 既定は年払い  
- 追加店舗: ¥9,800/月（Chain 以外）  
- トライアル: **14日**。終了後は分析/CSV/多言語/音/SLA 等をロック（厨房基本は継続）  

### 6.2 機能マトリクス（抜粋）

| 機能 | Lite | Growth | Business | Chain |
|------|:----:|:------:|:--------:|:-----:|
| 客席注文・厨房モニター・メニュー編集・席PIN・テーブルボード | ● | ● | ● | ● |
| 分析・CSV・クーポン・在庫・KDSモード・伝票・多言語・音・サ料・チップ | — | ● | ● | ● |
| スタッフ権限・配膳SLA・ブランド色・多店舗 | — | — | ● | ● |
| HQ 横断・注文手数料 0.8% | — | — | — | ● |
| 決済 UI / テイクアウト（形） | ● | ● | ● | ● |
| デリバリー / 予約 / 会員 / POS / 深堀分析 / 監査（プラン差あり） | 一部 | 一部 | ●寄り | ●寄り |

判定チェーン: `featureEnabled` → `canUseFeature`（プラン AND 契約/トライアル）→ `shopCanUse`。

### 6.3 アクセス状態

| reason | 意味 |
|--------|------|
| `subscribed` | 課金有効 |
| `trial` | トライアル中 |
| `trial_expired` | 期限切れ（プレミアムロック） |
| `trial_pending` | 初回アクセスでトライアル開始待ち |

---

## 7. プログラム詳細カタログ

PM が「どのファイルが何をしているか」を追える一覧。行数目安は実装規模の感覚用。

### 7.1 画面エントリ（HTML）

| ファイル | 行数目安 | 説明 |
|----------|----------|------|
| `index.html` | ~170 | 客席シェル。ヘッダー・検索・メニュー領域・カート導線。`app.js` を読込 |
| `cart.html` | ~26 | 旧カート URL 互換。`index.html?view=cart` へリダイレクト |
| `status.html` | ~78 | 注文状況ページ。進捗バー・追加注文・アンケート掛口 |
| `admin.html` | ~260 | 厨房/店長コンソールの Dom 骨格（タブ・KDS・設定） |
| `store.html` | ~160 | 店舗管理 UI（QR・営業・在庫・クーポン） |
| `ops.html` | ~580 | 内部 Ops HQ（多数タブ・Cardinal・メンテ・負荷試験） |
| `lp.html` | ~220 | SaaS LP（ヒーロー・なぜ・安心運用・料金・ROI・比較・リード） |

### 7.2 客席・注文コア

| ファイル | 行数目安 | PM向け説明 | 主な責務 |
|----------|----------|------------|----------|
| `js/app.js` | ~1540 | **客席 SPA 本体**。メニュー描画・カート UI・チェックアウト導線の中心 | UI 状態、フィルタ、カート操作、注文呼び出し |
| `js/place-order.js` | ~180 | **注文確定の心臓**。合計計算と Firestore 書き込み / 失敗時キュー | `computeOrderTotals`, `placeGuestOrder` |
| `js/status.js` | ~250 | 注文進捗画面。デモはタイマーで疑似進行 | onSnapshot / ETA / 追加注文 |
| `js/cart.js` | ~380 | 旧カートページ実装。現行主流は SPA + place-order | 互換・一部ロジック参照 |
| `js/shop.js` | ~590 | 店舗・メニューの読込/保存、売切・在庫・ラストオーダー、機能可否 | `loadShop`, `patchShopFields`, `shopCanUse` |
| `js/tenant.js` | ~110 | マルチテナント URL・店舗 ID 解決・シード店・客席 URL 生成 | `resolveShopId`, `guestEntryUrl` |
| `js/data.js` | ~170 | デフォルトメニューシード | 新規店の初期メニュー |
| `js/demo.js` | ~70 | デモ判定・カートキー分離・URL に `demo=1` を維持 | 営業デモで本番データを汚さない |
| `js/pin.js` | ~90 | 席ごとの PIN ゲート | テーブル共有端末の誤注文防止 |
| `js/order-history.js` | ~190 | 席の注文履歴・再注文 | リピート導線 |

### 7.3 客席付加機能

| ファイル | 行数目安 | PM向け説明 |
|----------|----------|------------|
| `js/guest-features.js` | ~380 | 店員呼出・会計リクエスト、混雑 ETA、アップセル、アンケート、会計ロック Overlay |
| `js/guest-extras.js` | ~350 | お気に入り、人数、年齢確認、クイックフィルタ、ブランド色、共有リンク、CSV ユーティリティ |
| `js/coupons.js` | ~150 | クーポン下書き・検証・適用・利用回数。Store から編集 |
| `js/channels.js` | ~45 | 店内 / テイクアウト / デリバリーのチャネル選択 |
| `js/payments.js` | ~100 | **決済の形**。方法選択・セッション・承認スタブ・会計クローズフィールド |
| `js/i18n-menu.js` / `js/i18n-ui.js` | ~90 each | 日英中韓のメニュー/UI 文言と a11y 基礎 |
| `js/reservations.js` | ~120 | 予約・ウェイティングリスト作成と購読 |
| `js/loyalty.js` | ~100 | 電話番号会員・ポイント付与/利用 |

### 7.4 厨房・店舗

| ファイル | 行数目安 | PM向け説明 |
|----------|----------|------------|
| `js/admin.js` | ~1580 | **厨房/店長コンソール本体**。KDS、分析、メニュー編集、リード、収益、設定、課金 CTA |
| `js/store.js` | ~680 | **店舗管理本体**。QR、営業、在庫、クーポン、呼出、Auth 不要パッチ |
| `js/staff-auth.js` | ~80 | 厨房/ホール/店長 PIN（Business+）。未ゲート時は実質店長権限 |
| `js/staff-firebase-auth.js` | ~170 | Firebase Email/Password ログイン UI（Ops/Admin 特権用） |
| `js/shop-scope.js` | ~60 | スタッフ email ↔ 店舗のクライアント側バインド（将来クレームの前段） |
| `js/printers.js` | ~65 | 厨房伝票 HTML・ブラウザ印刷・自動印刷フック |
| `js/pos-bridge.js` | ~85 | POS 接続/注文送信/在庫・メニュー同期の **スタブ** |
| `js/analytics-deep.js` | ~70 | チャネル×時間帯などの深堀分析（Business+） |
| `js/audit-log.js` | ~60 | 監査ログ（Firestore + ローカルフォールバック） |

### 7.5 SaaS・課金・LP

| ファイル | 行数目安 | PM向け説明 |
|----------|----------|------------|
| `js/config.js` | ~320 | **商品定義のソース・オブ・トゥルース**。PRODUCT / PLANS / ADDONS / DEFAULT_SHOP |
| `js/plans.js` | ~180 | 価格計算、機能ゲート、トライアル/アクセス状態、MRR 見積、比較表行 |
| `js/lp.js` | ~270 | LP UI。プラン描画、ROI、リード送信、メンテバナー |
| `js/leads.js` | ~20 | LP リードを Firestore へ投稿 |

### 7.6 Ops・通知・負荷

| ファイル | 行数目安 | PM向け説明 |
|----------|----------|------------|
| `js/ops.js` | ~2070 | **Ops HQ 本体**。全タブ、メンテ、Cardinal UI、負荷試験、HQ KPI |
| `js/ops-auth.js` | ~95 | Ops ブラウザ内パスワード（cursor / owner）。本番級 Auth ではない |
| `js/ops-secret.js` | ~40 | `OPS_API_SECRET` のブラウザ保持と API ヘッダ |
| `js/notify.js` | ~670 | Discord 通知エンジン。イベント定義、Webhook、API 経由送信 |
| `js/notify-orders.js` | ~85 | 注文系イベントの薄いラッパ |
| `js/load-monitor.js` | ~180 | 店舗混雑レベル（normal→critical）と Discord 通知 |
| `js/load-test.js` | ~610 | 負荷試験オーケストレーション（店舗量産・注文・掃除） |

### 7.7 ヘルス・メンテ・Cardinal

| ファイル | 行数目安 | PM向け説明 |
|----------|----------|------------|
| `js/health.js` | ~260 | Firestore / 通知 API プローブ、状態遷移通知、保留注文 flush |
| `js/auto-heal.js` | ~190 | 連続障害で Incident エスカレーション＋自動メンテ連携 |
| `js/cardinal.js` | ~460 | Ops 上の双 AI 神経系（サイクル・心拍・ディスパッチ） |
| `js/cardinal-features.js` | ~390 | 機能スイッチ、静穏時間、タイムライン、自己診断、異常スキャン、日次ダイジェスト |
| `js/maintenance.js` | ~490 | メンテ状態の読込/購読/手動・自動・スケジュール・ドリル |
| `js/maint-schedule.js` | ~155 | 曜日+時間帯 / 単発窓の評価（Asia/Tokyo） |
| `js/offline-sync.js` | ~85 | オフライン mutation キューと flush |

社内名 **Cardinal** の運用プロトコル詳細は [`cardinal.md`](./cardinal.md)。  
LP では名前を出さず「安心運用 / 障害のときも席を混乱させない」として紹介。

### 7.8 基盤・共通

| ファイル | 行数目安 | PM向け説明 |
|----------|----------|------------|
| `js/firebase.js` | ~25 | Firebase App / Firestore / Auth 初期化（Web 設定はクライアント公開） |
| `css/style.css` / `guest.css` | 大 | 客席デザインシステム |
| `css/store.css` / `ops.css` / `lp.css` | 中 | 各コンソール・LP |
| `sw.js` | ~50 | Service Worker（シェルキャッシュ）。注文本体はオンライン前提 |

### 7.9 Pages Functions（サーバー）

| ファイル | 行数目安 | PM向け説明 |
|----------|----------|------------|
| `functions/api/notify.js` | ~130 | Discord Webhook プロキシ。ゲストイベントもここ経由 |
| `functions/api/incident.js` | ~190 | 障害 intake → Cursor Agent + Discord |
| `functions/api/cardinal.js` | ~570 | heartbeat / dispatch / tick / diagnose / digest。自動メンテ連動 |
| `functions/api/maintenance.js` | ~200 | エッジ側メンテ GET/POST（Cache API）。FS 障害時の殺スイッチ |
| `functions/api/_ops-auth.js` | ~75 | `OPS_API_SECRET` 検証ヘルパ |
| `functions/api/_maintenance-store.js` | ~140 | メンテ状態の Cache 読み書き |
| `functions/api/_maint-schedule.js` | ~110 | サーバー側スケジュール評価 |

### 7.10 CI / スクリプト

| パス | 用途 |
|------|------|
| `.github/workflows/deploy-cloudflare-pages.yml` | `main` push で Pages デプロイ |
| `.github/workflows/cardinal-cron.yml` | 毎時 tick（異常時のみ Executor） |
| `.github/workflows/cardinal-ci-dispatch.yml` | Deploy 失敗時の Discord 信号 |
| `.github/workflows/configure-*.yml` | Discord / Cursor / Firebase Auth の秘密情報投入 |
| `scripts/run-load-test.mjs` | Puppeteer 負荷試験 |
| `scripts/cleanup-load-test-shops.mjs` | `load-*` 店舗掃除 |
| `scripts/deploy-cloudflare-pages.sh` | ローカル簡易デプロイ（正式は CI） |
| `scripts/configure-firebase-auth.sh` | Auth + Rules セットアップ補助 |

---

## 8. ドメインモデル（Firestore）

Rules: `firestore.rules`（Auth・メンテ・フロア更新を考慮した現行版）。詳細姿勢は [`security.md`](./security.md)。

### 8.1 コレクション一覧

| コレクション | 用途 | 作成者の目安 |
|--------------|------|--------------|
| `orders/{id}` | 注文 | ゲスト create / 厨房 status 更新 |
| `shops/{shopId}` | 店舗設定 | Ops/Auth。Store は狭い update |
| `shopMenus/{shopId}` | メニュー | Auth 必須 |
| `shop/*` | レガシー単一店舗 | 互換 |
| `leads/{id}` | LP 問い合わせ | 公開 create / 読取は Auth |
| `serviceRequests/{id}` | 呼出・会計 | ゲスト create |
| `surveys/{id}` | アンケート | ゲスト create / 読取 Auth |
| `members/{id}` | 会員 | ゲスト upsert |
| `reservations` / `waitlist` | 予約・待ち | ゲスト create |
| `auditLogs/{id}` | 監査 | クライアント記録 |
| `platform/config` | メンテ旗など | 読取公開 / 書込 Auth |
| `ops/*` | 旧運用設定 | **クライアント全面拒否**（Webhook は CF secrets） |

### 8.2 注文ステータス

`received` → `cooking` → `finishing` → `done`

金額系: `subtotal` / `discount` / `serviceCharge` / `tip` / `tax` / `total`。  
Chain: `platformFee` + `platformFeeStatus`（`unbilled` 等）。  
決済形: `payment` / `paymentStatus` / `paidAt` / `closedAt`。

### 8.3 店舗ドキュメントのグループ

| グループ | 例 |
|----------|-----|
| 基本 | name, tableCount, locale, address |
| 営業 | isOpen, lastOrder* |
| 課金 | planId, subscribed, trial*, billingCycle |
| UX | accentColor, minOrderAmount, ageGate, partySizeRequired |
| 収益 | serviceChargePercent, tip*, coupons[] |
| 在庫 | stock{}, soldOut{} |
| 権限 | adminPin, staffPins, staffEmails |
| 拡張 | channelsEnabled, paymentMethodsEnabled, pos*, printer*, loyaltyEnabled |

---

## 9. API 仕様（Pages Functions）

共通: JSON、`cache-control: no-store`。特権操作は `X-Ops-Secret: OPS_API_SECRET`。

| エンドポイント | 用途 | 認証 |
|----------------|------|------|
| `POST/GET /api/notify` | Discord 送信 | 環境 Webhook は公開経路あり。クライアント指定 Webhook は秘密鍵 |
| `POST/GET /api/incident` | 障害 → Cursor + Discord | 秘密鍵 |
| `POST/GET /api/cardinal` | heartbeat / dispatch / tick / diagnose / digest / status | status 以外は秘密鍵 |
| `GET/POST /api/maintenance` | エッジメンテ旗 | GET 公開。POST は秘密鍵 |

Cardinal `tick`（cron）: Pages + Firestore REST をプローブ → 異常なら自動メンテ ON + Executor、復旧なら自動メンテ解除。

---

## 10. 認証・セキュリティ（現行）

要約のみ。手順は [`security.md`](./security.md)。

| 層 | 状態 |
|----|------|
| Ops UI パスワード | クライアント SHA-256。**本番級ではない** |
| Firebase Auth | Ops/Admin 特権書き込みに必要 |
| `OPS_API_SECRET` | Cardinal / Incident / 一部通知に必須 |
| Store フロア更新 | Auth なしの狭いキーのみ許可 |
| 厨房 | 注文 `status`（と決済クローズ系）は Auth なし更新可 |
| メンテ中 | ゲスト create（注文・リード・呼出等）を Rules + UI で拒否 |
| 残課題 | 店舗単位クレーム、PIN 平文廃止、notify レート制限、XSS 追加点検、Ops への CF Access |

---

## 11. 通知イベント

実装: `js/notify.js`。代表イベント:

`order_new`, `order_status`, `staff_call`, `bill_request`, `lead_new`, `lead_won`, `contract_activated`, `plan_changed`, `shop_created`, `shop_deleted`, `item_added`, `item_removed`, `system_load`, `system_health`, `load_test`

---

## 12. 運用・Cardinal・受け入れ不変条件

### 12.1 Ops タブ（概要）

HQ / 店舗 / 注文 / リード / 手数料 / 通知 / 呼出 / アンケート / ラボ / ツール / **Cardinal** / 鍵（セキュリティ）

### 12.2 Cardinal（社内）↔ LP（対外）

| 対外（LP）表現 | 社内実体 |
|----------------|----------|
| 常時ウォッチ | Health + tick プローブ |
| フェイルセーフ | 自動メンテナンス |
| 相互バックアップ | Guardian / Executor |
| 知らせは絞る | 静穏時間 + 日次ダイジェスト |

### 12.3 壊してはいけない中核

1. 客席保留キュー `mos_pending_orders` と flush  
2. Health プローブと `system_health`  
3. Cardinal tick / heartbeat / dispatch  
4. 自動メンテと **手動メンテの非干渉**  
5. シード店舗（特に `default`）削除禁止  
6. 負荷試験店舗の消し忘れ防止（`loadTest` / cleanup）  
7. Store の Auth フリー狭いパッチ  

### 12.4 人間が残す判断

1. Cloudflare / Cursor / Discord の初回シークレット  
2. draft PR のマージ  
3. `cardinal:escalate` 時の最終確認  
4. Chain 未請求手数料の月末請求  
5. `introSlotsRemaining` の月次更新  

---

## 13. クライアント永続化（抜粋）

### localStorage

| キー | 用途 |
|------|------|
| `mos_cart_*` / `mos_cart_demo_*` | カート |
| `mos_pending_orders` | 未送信注文（最大 30） |
| `mos_table_pins_*` / `mos_favs_*` / `mos_party_*` | 席 PIN・お気に入り・人数 |
| `mos_discord_*` | 通知設定キャッシュ |
| `mos_cardinal_*` / `mos_autoheal_*` | Cardinal / AutoHeal |
| `mos_ops_*` | Ops 認証・秘密鍵（任意 persist） |

### sessionStorage

| キー | 用途 |
|------|------|
| `mos_demo` / `mos_shop_id` | デモ・店舗 |
| `mos_demo_order_*` | デモ注文 |
| `mos_staff_role_*` / `mos_ops_role` | ロール |

---

## 14. ロードマップ上のギャップ（PM向け）

| 優先度感 | 項目 | メモ |
|----------|------|------|
| 高 | 実決済接続 | `payments.js` の session/authorize を置換。注文フィールド形は維持 |
| 高 | 店舗単位 Auth クレーム | サインインユーザーの越権防止 |
| 中 | POS 本番 | Square 等。スタブ IF は用意済 |
| 中 | サーバー側注文キュー | FS 長時間障害でも受付を落とさない |
| 中 | PIN のサーバーハッシュ化 | 店舗ドキュメントの平文 PIN 廃止 |
| 低 | ネイティブアプリ | 現状 PWA で十分かの検証次第 |

エンタープライズ差分の現状一覧: [`enterprise-parity.md`](./enterprise-parity.md)。

---

## 15. 用語集

| 用語 | 意味 |
|------|------|
| KDS | Kitchen Display System（厨房モニター） |
| Growth+ | Growth 以上で解放される機能群 |
| Cardinal | Guardian（監視）と Executor（実行）の双 AI。対外では「安心運用」 |
| platformFee | Chain の注文手数料 0.8% |
| queued | Firestore 書込失敗後のローカル保留注文 |
| フロアパッチ | Store が Auth なしで更新できる狭い店舗フィールド群 |
| tick | Cardinal の定期本番プローブ（GitHub cron） |
| 自動メンテ | 障害検知で客席を止める旗。手動メンテとは分離 |

---

## 改訂履歴

| 版 | 日付 | 内容 |
|----|------|------|
| 1.0 | （初版） | アーキテクチャ・画面・データ・API・運用の技術仕様 |
| **2.0** | 2026-07-30 | **PM向け全面改訂**。ペルソナ、ジャーニー、全プログラム詳細カタログ、Auth/メンテ/Cardinal/エンタープライズ差分を現行実装に同期 |
