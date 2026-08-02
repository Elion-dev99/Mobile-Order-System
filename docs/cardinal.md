# Cardinal — 双AI相互監視プロトコル

SAO のカーディナルシステムに着想した、**監視体（Guardian）** と **実行体（Executor）** の2体構成です。  
人が手を動かさなくても、障害検知・修正・レビュー・再起動判断を回すことを目指します。

```text
  障害 / CI失敗 / 無応答
           │
           ▼
   ┌───────────────┐     タスク起票 / webhook      ┌───────────────┐
   │   Guardian    │ ───────────────────────────▶ │   Executor    │
   │ 監視・レビュー │ ◀─────────────────────────── │ 実装・修正PR  │
   └───────────────┘     PR / ハートビート         └───────────────┘
           │                                            │
           └──────────── Discord / Ops UI ──────────────┘
```

## 役割

| 役割 | 主務 | やってはいけないこと |
|------|------|----------------------|
| **Guardian** | ヘルス監視、PRレビュー、Executor無応答検知、タスク起票 | 大きな機能実装、自動マージ |
| **Executor** | 障害修正、機能実装、テスト、draft PR | スコープ外の大規模リファクタ、本番直書きマージ |

お互いのハートビート（SLA 既定 90分）が途切れたら、相手側を起こして状況整理します。

## リポジトリ内の部品

| パス | 役割 |
|------|------|
| `js/cardinal.js` | Ops 上の神経系（サイクル・ハートビート・ディスパッチ） |
| `js/cardinal-features.js` | 機能スイッチ・静穏時間・タイムライン・自己診断・異常スキャン・日次ダイジェスト |
| `js/auto-heal.js` | ヘルス異常時の自動復旧・エスカレーション |
| `functions/api/cardinal.js` | Cursor Automations / Cloud Agents 起動バス（`tick` / `diagnose` / `digest` 含む） |
| `functions/api/incident.js` | レガシー障害エスカレーション |
| `.cursor/rules/cardinal-*.mdc` | 各ロールの行動規範 |
| Ops → **Cardinal** タブ | 状態・機能スイッチ・診断・ダイジェスト・ドリル |

## Ops 側の追加機能

| 機能 | 内容 |
|------|------|
| **機能スイッチ** | 自動メンテ / Executor起動 / ウォッチドッグ / 異常スキャン / 日次ダイジェスト / 静穏時間 / 履歴（ブラウザ `localStorage`） |
| **静穏時間** | 既定 JST 23:00–08:00。warning 以下の Discord・ウォッチドッグ起動を抑制（`down` / `critical` は通す） |
| **自己診断** | Firestore・通知API・Ops鍵・メンテ・保留注文などを一括チェック。サーバー側 `action: diagnose` も併用可 |
| **異常スキャン** | 営業中店舗の注文ゼロ（履歴あり）・保留キュー過多・メンテ中を検知し Discord 通知 |
| **日次ダイジェスト** | 設定した JST 時刻に 1日1回、注文数/GMV/ヘルスを Discord へ（手動強制送信あり） |
| **アクション履歴** | サイクル・起動・診断などの判断ログを Ops に表示 |
| **製品ゲート** | 市場スカウト → Guardian+Executor レビュー → 双方 approve 後に実装（`docs/cardinal-product-gate.md`） |

## いま動いている常駐ルート（推奨・設定済み）

Cursor Automations UI なしでも運用できます（**自律 90%**: `docs/autonomy.md`）。

1. **Cloudflare** に `CURSOR_API_KEY` と **`OPS_API_SECRET`** が入っている  
2. **GitHub** に同じ `OPS_API_SECRET`（cron / CI / PR の `X-Ops-Secret` 用）  
3. **GitHub Actions** `Cardinal cron watchdog` が毎時 `:15` UTC に `/api/cardinal` の `tick` を叩く  
   - 正常 → エージェント起動なし（Discord があれば心拍のみ）＋**自動メンテナンス解除**（Cardinal が入れた場合のみ）  
   - 異常 → **自動メンテナンス ON** ＋ **Executor** 起動（クールダウン後は `followup`）  
   - 日次 `digest` / 日次 `steward`（Executor 予防保守） / 週次 Guardian steward  
4. **Deploy 失敗** → `cardinal-ci-dispatch` が Executor を起動  
5. **`cursor/*` PR** → `cardinal-pr-guardian` が Guardian レビューを起動  
6. **週次製品ゲート** → `cardinal-product-cycle` が `product_cycle`（スカウト・双方向レビュー・実装）  
7. 客席は `GET /api/maintenance` と Firestore `platform/config` をマージして参照  
8. **定期スケジュール** — Ops HQ で曜日＋時間帯 / 単発窓を設定。tick でも評価  
9. **障害メンテテスト** — Ops → Cardinal タブのドリル（エージェントは起動しない）  
10. **Ops → 鍵** タブに `OPS_API_SECRET` を保存（ブラウザからの dispatch / AutoHeal 用）  
11. 詳細: `docs/security.md` / `docs/autonomy.md`

手動で今すぐ tick:

```bash
curl -X POST https://mobile-order-system.pages.dev/api/cardinal \
  -H 'content-type: application/json' \
  -H "x-ops-secret: $OPS_API_SECRET" \
  -d '{"action":"tick","force":false}'
```

予防保守ステュワード:

```bash
curl -X POST https://mobile-order-system.pages.dev/api/cardinal \
  -H 'content-type: application/json' \
  -H "x-ops-secret: $OPS_API_SECRET" \
  -d '{"action":"steward","mode":"executor"}'
```
## （任意）Cursor Automations を足す場合

より細かい「PRレビュー専用 Guardian」などが欲しければ:

1. [cursor.com/automations](https://cursor.com/automations) で Guardian / Executor を作成  
2. Webhook を Cloudflare secrets（`CURSOR_GUARDIAN_*` / `CURSOR_EXECUTOR_*`）へ  
3. または GitHub Actions「Configure Cursor Cardinal」で投入

```bash
CURSOR_API_KEY=...                 # 必須級（済）
OPS_API_SECRET=...                 # 必須（dispatch/tick/incident）
DISCORD_WEBHOOK_URL=...            # 推奨（サーバ側 webhook）
CURSOR_GUARDIAN_WEBHOOK_URL=...    # 任意
CURSOR_EXECUTOR_WEBHOOK_URL=...    # 任意
```

## ラベル規約

- `cardinal:guardian` — Guardian 向けタスク
- `cardinal:executor` — Executor 向け実装タスク
- `cardinal:stuck` — どちらかが止まった
- `cardinal:escalate` — 人間確認が必要

## 既知の問題（ウォッチドッグ関連）

- **「ハートビートが古い」≠「Executor が止まっている」** — `docs/autonomy.md` の設計どおり、正常時は
  tick が Executor を起動しない（`鯖健全 → dispatch なし`）。ウォッチドッグが古い心拍を検知したら、
  まず GitHub の *open PR* と *Cloud Agents の RUNNING 状態* を確認し、両方とも動きが無ければ
  「無応答」ではなく「対応不要（健全な待機）」を優先して判断する。
- **watchdog 起動の重複（Cache API colo レース）** — `functions/api/_agent-ledger.js` の起動台帳は
  `caches.default`（Cloudflare Cache API）に保存しており、colo（エッジ拠点）ごとに独立していて
  グローバルな一貫性が無い。さらに `readAgentLedger` → 起動 → `recordLaunch` の間に非同期の空白が
  あるため、短時間に複数リクエスト（複数 Ops タブ／同時 tick）が別々の colo に着弾すると
  `recentlyLaunched()`（既定 90 分クールダウン）を回避して同一 `kind` の Guardian/Executor が
  多重起動しうる（2026-08-02 04:16–04:24 UTC に `kind: watchdog`「Executor 無応答の監視」が
  同一クールダウン内に少なくとも 4〜5 回連続起動した実例あり）。
  - 対応方針（Executor 向け）: 起動前に一意トークンを先に書き込む CAS 風の二段階書き込みにするか、
    より一貫性の高いストア（Cloudflare **KV** の `put`+`expirationTtl`、または D1 の一意制約）に
    ledger を置き換える。`js/cardinal.js` 側の同一ブラウザ内多重実行防止ロックも合わせて検討。
- **日次/週次 steward が特定の UTC 時間帯に一度も発火していない（要修正）** — `cardinal-cron.yml` は
  `case "$HOUR_UTC" in 01) run_steward ;; esac` のように **実行時刻がちょうど 01 時（Executor 日次
  steward）／日曜 02 時（Guardian 週次 steward）と完全一致した時だけ**起動する設計になっている。
  しかし本ワークフローの全 31 実行（2026-07-30〜08-02 の全履歴）を調べたところ、
  **`HOUR_UTC == 01` および `HOUR_UTC == 02` の実行が一度も発生していない**
  （GitHub Actions のスケジュール実行はこのリポジトリの負荷下で数十分〜数時間単位でずれ／間引かれる
  ことがあり、たまたま連日この2時間帯だけを飛ばし続けている）。結果として、日次 Executor
  steward・週次 Guardian steward は自動では実質一度も発火せず、Executor の心拍はインシデント発生時
  以外は更新されない。`steward` の起動は既に `COOLDOWN.steward`（約20時間, `functions/api/cardinal.js`）
  でサーバー側冪等になっているため、**厳密な時刻一致ではなく毎時 tick のたびに `run_steward` /
  （日曜のみ）`run_steward_g` を無条件に呼び、サーバー側クールダウンで一日一回に間引く**方式へ
  変更するのが低リスクな直し方（対応方針・Executor 向け）。

## 人間の残り仕事（約10%・意図的）

1. Cloudflare / Cursor の **初回シークレット設定**
2. **`cardinal:escalate` / 高リスクパス**（ルール・ops-auth）
3. 課金・破壊的データ操作
4. （任意）自動マージを止めたい PR に `cardinal:hold`

**マージは自動化**され、Deploy 後 canary が失敗すると **main をマージ前 SHA に即ロールバック**する。  
詳細: **`docs/autonomy.md`**

Ops を開いている間はクライアント側 Cardinal がソフトな心拍を打ちます。  
本番の常駐は GitHub cron（tick / steward / digest / canary）と CI・PR・auto-merge ワークフローが本体です。
