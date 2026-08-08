# Cursor に運用を任せる（創業者ほぼゼータッチ）

あなたの意図: **日常の運用・障害・マージ・デプロイ・Discord 通知・修正 PR まで Cursor / GitHub Actions が回す。**  
創業者は **初回シークレット** と **例外（課金・破壊・escalate）** だけ。

## 創業者がやらないこと（Cursor がやる）

| 領域 | 自動経路 |
|------|----------|
| 本番監視・自動メンテ | `cardinal-cron.yml` → `tick` |
| 表示/API 異常 → ロールバック | Deploy canary → main 復元 + Executor |
| `cursor/*` PR マージ | `cardinal-auto-merge.yml` |
| マージ後 Deploy | auto-merge → `workflow_dispatch` Deploy |
| CI 失敗 → 修正 | `cardinal-ci-dispatch.yml` |
| 客席 JS エラー / API 5xx | `system-watchdog` → Discord → **critical なら Executor 自動起動** |
| プローブ失敗 | `tick` + system incident ledger |
| Discord 監査・障害通知 | `DISCORD_WEBHOOK_URL`（Cloudflare） |
| スラッシュコマンド登録 | Deploy 成功後（GitHub に Bot secrets がある場合） |
| Cardinal 能力 ON | 毎時 cron が `prefs_autonomy_90`（自律90%バンドル） |

**Discord で `/qo debug request` を打つ必要はない**（打ってもよいが、検知→通知→Agent は上記で回る）。

## 創業者が一度だけやること（保存して使い回し）

| 置き場所 | 内容 |
|----------|------|
| Cloudflare Pages secrets | `OPS_API_SECRET`, `DISCORD_WEBHOOK_URL`, `CURSOR_API_KEY`, `DISCORD_PUBLIC_KEY`, `DISCORD_OPS_USER_IDS` |
| GitHub Secrets | **同じ** `OPS_API_SECRET`, `DISCORD_WEBHOOK_URL`, 任意 `DISCORD_BOT_TOKEN` + `DISCORD_APPLICATION_ID` |
| Discord Developer | Interactions URL → `/api/discord`（済なら不要） |

Ops「鍵」タブは **不要**（GitHub cron が `OPS_API_SECRET` で Cardinal を叩く）。ブラウザから手動 dispatch したいときだけ保存。

## 自律90%バンドル（`prefs_autonomy_90`）

GitHub cron 起動時に edge に書き込み:

- Cursor dispatch / cron / 自動メンテ / 障害時 Executor / CI / PR Guardian / steward など ON
- 健全時の tick Discord スパム（`tickHealthyDiscord`）は OFF

手動で全部止めたいときだけ Ops の「全停止」または `prefs_shutdown_all`。

## 止めたいとき

- 特定 PR: ラベル `cardinal:hold`
- 全体: `docs/cardinal-automation-pause.md` の手順（再び pause）

## 関連

- `docs/autonomy.md` — ポリシー
- `docs/cursor-founder-division-of-labor.md` — 分担一覧
- `docs/system-watchdog.md` — クライアント監視
- `docs/cardinal-automation-pause.md` — pause / 再開
