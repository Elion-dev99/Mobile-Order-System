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

## リポジトリ内の部品（このPR）

| パス | 役割 |
|------|------|
| `js/cardinal.js` | Ops 上の神経系（サイクル・ハートビート・ディスパッチ） |
| `js/auto-heal.js` | ヘルス異常時の自動復旧・エスカレーション |
| `functions/api/cardinal.js` | Cursor Automations / Cloud Agents 起動バス |
| `functions/api/incident.js` | レガシー障害エスカレーション |
| `.cursor/rules/cardinal-*.mdc` | 各ロールの行動規範 |
| Ops → **Cardinal** タブ | 状態表示・ドリル起動・設定チェックリスト |

## いま動いている常駐ルート（推奨・設定済み）

Cursor Automations UI なしでも運用できます。

1. **Cloudflare** に `CURSOR_API_KEY` と **`OPS_API_SECRET`** が入っている  
2. **GitHub** に同じ `OPS_API_SECRET`（cron の `X-Ops-Secret` 用）  
3. **GitHub Actions** `Cardinal cron watchdog` が毎時 `:15` UTC に `/api/cardinal` の `tick` を叩く  
   - 正常 → エージェント起動なし（Discord があれば心拍のみ）＋**自動メンテナンス解除**（Cardinal が入れた場合のみ）  
   - 異常（Pages / 通知API / Firestore REST）→ **自動メンテナンス ON** ＋ **Executor** 起動  
4. 客席は `GET /api/maintenance` と Firestore `platform/config` をマージして参照（FS 障害時もエッジ側で止められる）  
5. **定期スケジュール** — Ops HQ で曜日＋時間帯 / 単発窓を設定。tick でも評価  
6. **障害メンテテスト** — Ops → Cardinal タブのドリル（`simulateUnhealthy` / `drill_outage`）。エージェントは起動しない  
7. **Ops → 鍵** タブに `OPS_API_SECRET` を保存（ブラウザからの dispatch / AutoHeal 用）  
8. 詳細: `docs/security.md`

手動で今すぐ tick:

```bash
curl -X POST https://mobile-order-system.pages.dev/api/cardinal \
  -H 'content-type: application/json' \
  -d '{"action":"tick","force":false}'
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

## 人間の残り仕事（意図的に残す）

完全無人の自動マージは危険なので、当面は:

1. Cloudflare / Cursor の **初回シークレット設定**
2. **draft PR のマージ判断**（慣れたら Autofix 範囲を広げる）
3. `cardinal:escalate` が付いたときの最終判断

Ops を開いている間はクライアント側 Cardinal がソフトな心拍を打ちます。  
本番の「常駐2体」は Cursor Automations の cron / webhook が本体です。
