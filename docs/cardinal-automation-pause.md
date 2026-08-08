# Cardinal 自動デプロイの一時停止

GitHub Actions の通信障害・メンテ・トークン節約などで、**Cardinal 経路の自動マージと Deploy 起動**を止める手順です。

## いまの状態（2026-08 — Cursor 運用委譲で **再開**）

| 項目 | 状態 |
|------|------|
| `cardinal-auto-merge.yml` の **schedule / pull_request** | **有効** |
| マージ後の **Deploy workflow_dispatch** | **既定 ON**（`DISPATCH_DEPLOY_AFTER_MERGE=true`） |
| `cardinal-cron.yml` **schedule** | **有効**（毎時 + `prefs_autonomy_90`） |

創業者の日常マージは不要。詳細: `docs/cursor-full-ops-delegation.md`

## 再び止める手順（緊急時）

1. `.github/workflows/cardinal-auto-merge.yml` で `pull_request` と `schedule` をコメントアウト
2. `CARDINAL_AUTOMATION_PAUSED: 'true'` に変更
3. `DISPATCH_DEPLOY_AFTER_MERGE` を `'false'` に
4. `cardinal-cron.yml` の `schedule` をコメントアウト
5. 本ファイルの「いまの状態」を更新

## 緊急時だけマージ＋デプロイ

Actions → **Cardinal auto-merge** → Run workflow:

- `pr`: 番号（任意）
- `allow_deploy_dispatch`: **true**

## 関連

- `docs/autonomy.md`
- `docs/cursor-full-ops-delegation.md`
- Ops / サーバー prefs — `prefs_shutdown_all` で Cursor 起動のみ停止
