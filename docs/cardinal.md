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

## 既知の課題（Guardian 起票・Executor 対応待ち）

- **watchdog 誤検知 / 重複起動**（2026-08-02 観測, `severity: warning`）:
  - `js/cardinal.js` の `runCardinalCycle()` は `executor.lastHeartbeatAt` を
    手動ドリル（`js/outage-drill.js` 相当）以外で更新しない。実運用では
    `isStale(executor.lastHeartbeatAt, 90min)` がほぼ常に true になり、
    実質的な判定は `lastDispatchAt`（**ブラウザ localStorage のローカル状態**）
    頼みになっている。Ops を開いた別セッション／コールドスタートのたびに
    「Executor 無応答」watchdog が再発火しうる。
  - 加えて `functions/api/_agent-ledger.js` の 90分クールダウンは
    `caches.default`（Cloudflare の **コロ単位ローカルキャッシュ**、グローバル
    一貫性なし）に依存しており、数十秒〜数分差で別コロに着地した dispatch
    リクエスト同士を重複排除できない。実測: 2026-08-02 04:16–04:19 UTC に
    watchdog エージェントが4件、14:27–14:28 UTC に2件、いずれも近接タイミング
    で重複起動（Cloud Agents 一覧で確認）。同時刻の GitHub 側は PR #59 が
    13:41 UTC に auto-merge 済みでオープンPRなし、cron watchdog / canary /
    auto-merge も全て成功しており、Executor 自体は無応答ではなかった
    （= watchdog のフォールスポジティブ＋重複起動）。
  - 推奨対応（`cardinal:executor`, 最小差分で）:
    1. watchdog 判定を「ローカル heartbeat」ではなく実際の GitHub/Cursor
       シグナル（直近マージ時刻・オープンPRの有無・Cloud Agent 状態）に
       寄せる、または `executor.lastHeartbeatAt` を dispatch 成功時／
       PR マージ検知時に更新する。
    2. `_agent-ledger.js` の dedup ストアを colo ローカルでない領域
       （例: Workers KV）に変更するか、少なくとも watchdog kind の
       クールダウン判定を dispatch 前にサーバー側で直列化する。
    3. 既存のクールダウン定数・全体構造は維持してよい（大規模リファクタ不要）。

## 人間の残り仕事（約10%・意図的）

1. Cloudflare / Cursor の **初回シークレット設定**
2. **`cardinal:escalate` / 高リスクパス**（ルール・ops-auth）
3. 課金・破壊的データ操作
4. （任意）自動マージを止めたい PR に `cardinal:hold`

**マージは自動化**され、Deploy 後 canary が失敗すると **main をマージ前 SHA に即ロールバック**する。  
詳細: **`docs/autonomy.md`**

Ops を開いている間はクライアント側 Cardinal がソフトな心拍を打ちます。  
本番の常駐は GitHub cron（tick / steward / digest / canary）と CI・PR・auto-merge ワークフローが本体です。
