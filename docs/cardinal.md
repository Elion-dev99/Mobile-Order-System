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

## Cursor Automations の作り方（ダッシュボード）

1. [cursor.com/automations](https://cursor.com/automations) を開く  
2. **Guardian** Automation を作成  
   - Triggers: 毎時 cron ＋ PR opened/pushed ＋ CI failed  
   - Prompt: 「あなたは Cardinal Guardian…（`.cursor/rules/cardinal-guardian.mdc` に従う）」  
   - Webhook を有効化し URL / API key を控える  
3. **Executor** Automation を作成  
   - Triggers: Issue labeled `cardinal:executor` ＋ webhook  
   - Prompt: 「あなたは Cardinal Executor…（`.cursor/rules/cardinal-executor.mdc` に従う）」  
   - Webhook を控える  
4. Cloudflare Pages secrets に設定:

```bash
CURSOR_GUARDIAN_WEBHOOK_URL=...
CURSOR_GUARDIAN_API_KEY=...
CURSOR_EXECUTOR_WEBHOOK_URL=...
CURSOR_EXECUTOR_API_KEY=...
# または単一キーで Cloud Agents API:
CURSOR_API_KEY=...
DISCORD_WEBHOOK_URL=...
```

GitHub Actions ワークフロー `configure-cursor-cardinal.yml` でも secrets 投入できます。

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
