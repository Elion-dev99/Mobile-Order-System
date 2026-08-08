# システム監視（Watchdog）と Discord デバッグ

全主要ページの **コードエラー・API 5xx・無反応（タイムアウト）** を検知し、**機能名 + 原因** を Discord に通知します。創業者は Discord からデバッグ依頼をかけ、Cursor Cloud Agent が修正 PR を作成します。

## 検知の流れ

1. **クライアント** (`js/system-watchdog.js`) — 客席・店舗フロア・Admin・Ops
   - `window.onerror` / `unhandledrejection`
   - 同一オリジン `/api/*` の HTTP 5xx、fetch 失敗、45s タイムアウト
   - 長時間アイドル時の `/api/maintenance` 無反応プローブ

2. **POST** `/api/system-report` — body: `{ feature, cause, kind?, shopId?, url? }`

3. **サーバー** (`functions/api/_system-incidents.js`)
   - Cache キューに記録（10分 dedupe、同一原因は回数カウント）
   - `DISCORD_WEBHOOK_URL` へ embed（機能・原因・種別・店舗）
   - 1時間あたり Discord 送信上限 40 件

4. **Cardinal tick** (`action=tick`) — 本番プローブ失敗時に `recordProbeFailures` で同じ ledger + Discord

## Discord コマンド

登録: `node scripts/register-discord-commands.mjs`

| コマンド | 説明 |
|---------|------|
| `/qo debug status` | オープンインシデント一覧 |
| `/qo debug request feature:… cause:…` | 手動依頼 → Discord + **Cursor Agent 起動** |
| `/qo debug fix incident_id:…` | 既存 ID を Agent に修正依頼 |
| `/qo debug dismiss incident_id:…` | 解消済みにする |

権限: `DISCORD_OPS_USER_IDS` に含まれるユーザーのみ。

## Ops UI

`ops.html` → Dev ツール → **システムインシデント**  
Ops API 鍵付きで一覧・「Agent修正」・dismiss。

## 必要な Cloudflare シークレット

| 変数 | 用途 |
|------|------|
| `DISCORD_WEBHOOK_URL` | インシデント通知 |
| `CURSOR_API_KEY` | `/qo debug request|fix` と Ops「Agent修正」 |
| `OPS_API_SECRET` | Ops 一覧・dispatch_fix |

## 自己テスト（本番）

1. Ops Dev ツールで意図的に `throw new Error('watchdog-test')` をコンソール実行 → Discord に `guest` / `ops` 機能名で通知（テスト後 dismiss）
2. `/qo debug request feature:test cause:手動テスト` → Agent 起動ログを Cursor Agents で確認

## 関連ファイル

- `js/system-watchdog.js`
- `functions/api/system-report.js`
- `functions/api/_system-incidents.js`
- `functions/api/_incident-dispatch.js`
- `functions/api/_discord-ops.js`（`debug` サブコマンド）
