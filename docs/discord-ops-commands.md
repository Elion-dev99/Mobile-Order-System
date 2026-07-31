# Discord 運用コマンド（スラッシュ）

Discord 上から **メンテ開始・解除・サーバー停止・復旧** を実行します。  
Webhook（通知専用）ではなく **Discord Application + Interactions** を使います。

---

## 1. Discord 側の準備

1. [Discord Developer Portal](https://discord.com/developers/applications) で Application を作成
2. **Bot** を追加 → Token を控える（`DISCORD_BOT_TOKEN`）
3. **General Information** → **Public Key**（`DISCORD_PUBLIC_KEY`）
4. **General Information** → **Application ID**（`DISCORD_APPLICATION_ID`）
5. Bot をサーバーに招待（`applications.commands` スコープ）
6. **General → Interactions Endpoint URL**  
   `https://mobile-order-system.pages.dev/api/discord`  
   （保存時に Discord が PING を送る — デプロイ後に設定）

---

## 2. Cloudflare Pages シークレット

| Secret | 内容 |
|--------|------|
| `DISCORD_PUBLIC_KEY` | 署名検証用 |
| `DISCORD_OPS_USER_IDS` | コマンドを実行できる Discord ユーザー ID（カンマ区切り） |
| `DISCORD_BOT_TOKEN` | コマンド登録スクリプト用（ランタイム API では不要） |
| `DISCORD_APPLICATION_ID` | 同上 |
| `DISCORD_WEBHOOK_URL` | 任意 — コマンド実行結果の監査 embed |

ユーザー ID の調べ方: Discord 設定 → 詳細 → 開発者モード ON → 自分のアイコン右クリック → ID をコピー

---

## 3. スラッシュコマンド登録（1回）

```bash
export DISCORD_APPLICATION_ID=...
export DISCORD_BOT_TOKEN=...
# すぐ試すならギルド指定（即反映）
export DISCORD_GUILD_ID=あなたのサーバーID

node scripts/register-discord-commands.mjs
```

---

## 4. コマンド一覧

| コマンド | 動作 |
|----------|------|
| `/qo maint start` [message] | メンテ ON（客席停止・案内文 optional） |
| `/qo maint stop` | メンテ OFF |
| `/qo maint status` | メンテ状態 + 簡易プローブ |
| `/qo server stop` [message] | 緊急停止（メンテ ON） |
| `/qo server recover` | 復旧（メンテ OFF） |

内部では `GET/POST /api/maintenance` と同じ **Cache API キルスイッチ** を更新します（Firestore が落ちていても edge で効く）。

---

## 5. セキュリティ

- リクエストは **Ed25519 署名** のみ受理（Discord 公式）
- **`DISCORD_OPS_USER_IDS` に無いユーザーは拒否**（未設定時は全拒否）
- 監査: 成功/失敗を `DISCORD_WEBHOOK_URL` に embed（設定時）

---

## 6. トラブルシュート

| 症状 | 対処 |
|------|------|
| Interactions URL が保存できない | 本番 `/api/discord` が 200 で PONG できるか（`DISCORD_PUBLIC_KEY` 設定後デプロイ） |
| コマンドが出ない | `register-discord-commands.mjs` 再実行。ギルド未指定なら最大1時間待つ |
| 権限がありません | `DISCORD_OPS_USER_IDS` に自分の ID を追加して再デプロイ |

---

## 関連

- `functions/api/discord.js`
- `functions/api/maintenance.js`
- `docs/security.md`
