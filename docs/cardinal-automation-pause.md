# Cardinal 自動デプロイの一時停止

GitHub Actions の通信障害・メンテ・トークン節約などで、**Cardinal 経路の自動マージと Deploy 起動**を止める手順です。

## いまの状態（2026-08 通信障害対応）

| 項目 | 状態 |
|------|------|
| `cardinal-auto-merge.yml` の **schedule / pull_request** | **無効**（コメントアウト） |
| マージ後の **Deploy workflow_dispatch** | **既定 OFF**（`DISPATCH_DEPLOY_AFTER_MERGE=false`） |
| 手動マージ | Actions → **Cardinal auto-merge** → `workflow_dispatch` のみ |

`main` への **通常 push** は引き続き `Deploy to Cloudflare Pages` を起動します（創業者の手動 push 用）。

## 再開手順

1. `.github/workflows/cardinal-auto-merge.yml` で `pull_request` と `schedule` のコメントを戻す
2. `CARDINAL_AUTOMATION_PAUSED: 'true'` を削除または `'false'`
3. `DISPATCH_DEPLOY_AFTER_MERGE` を `'true'` に戻す（マージジョブの env）
4. `docs/cardinal-automation-pause.md` の「いまの状態」を更新

## 緊急時だけマージ＋デプロイ

Actions → **Cardinal auto-merge** → Run workflow:

- `pr`: 番号（任意）
- `allow_deploy_dispatch`: **true**（Deploy を明示起動）

## 関連

- `docs/autonomy.md` — 自動マージ・canary・ロールバック方針
- Ops / サーバー prefs — Cursor Agent 起動は別スイッチ（`docs/cardinal.md`）
