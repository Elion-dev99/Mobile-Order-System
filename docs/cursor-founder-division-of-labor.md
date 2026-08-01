# Cursor と創業者 — 役割分担書

| 項目 | 内容 |
|------|------|
| 文書名 | QuickOrder 自律運営・成長における役割分担 |
| 対象 | Mobile-Order-System（QuickOrder SaaS） |
| 目的 | **運営・管理・開発・成長**について、Cursor（Cardinal 含む）が担う作業と創業者が担う作業を一覧化する |
| 方針 | 創業者の手を必要としない運営を最大化する（目標 **約90%** を Cursor / GitHub Actions が担当） |
| 関連 | `docs/autonomy.md`（最優先ポリシー）、`docs/growth-zero-cash.md`、`docs/cardinal.md` |

---

## 1. 総括

| 担当 | 目安 | 一言 |
|------|------|------|
| **Cursor**（Guardian / Executor + GitHub Actions + Cardinal API） | **約90%+** | 監視、障害対応、保守、PR、レビュー、自動マージ、canary、ロールバック、予防保守、製品提案〜実装（ゲート通過後） |
| **創業者（あなた）** | **約10%-** | 初回シークレット、セキュリティ最終線、金・契約・破壊的操作、意図的 escalate、例外判断 |

**創業者が日常でやらないこと:** PR のマージ判断、定常的な障害調査、小さな不具合修正の指示出し、マーケ用 LP の微修正依頼（製品ゲート経由で Cursor が提案・実装まで回す）。

**創業者が Discord / 通知だけで済ませること:** 異常検知、ロールバック報告、製品ゲートの提案・レビュー・実装の全文監査、日次ダイジェスト（任意）。

---

## 2. Cursor（Cardinal）がやること — 運営・技術

### 2.1 常駐監視・障害（自律 ~90% の本体）

| 内容 | 経路・根拠 |
|------|------------|
| 毎時本番プローブ（サイト / API / Firestore 相当） | GitHub `cardinal-cron.yml` → `/api/cardinal` `tick` |
| 障害検知時の **自動メンテナンス ON**（客席キルスイッチ） | `tick` + `functions/api/_maintenance-store.js` |
| 復旧後、Cardinal が入れた自動メンテのみ **自動 OFF** | `tick`（手動メンテは上書きしない） |
| 障害時 **Executor 起動**（調査・draft PR） | `tick` / `followup` / Ops AutoHeal |
| 障害継続時 **followup**（クールダウン後再調査） | `action: followup` |
| Guardian / Executor **相互ウォッチドッグ** | Ops `cardinal-features.js` + 心拍 |
| **鯖落ちドリル**（模擬障害、エージェント起動なし） | `cardinal-outage-drill.yml` / `scripts/outage-drill.sh` |
| Deploy **CI 失敗 → Executor** | `cardinal-ci-dispatch.yml` |
| Ops ヘルス連続失敗 → Executor | `js/auto-heal.js` |

### 2.2 変更の ship（マージ・デプロイ・安全網）

| 内容 | 経路・根拠 |
|------|------------|
| `cursor/*` PR の **Guardian レビュー** | `cardinal-pr-guardian.yml` |
| 条件を満たす PR の **squash 自動マージ** | `cardinal-auto-merge.yml` |
| マージ後 **Deploy 起動**（GITHUB_TOKEN 制約の dispatch） | auto-merge 後 `workflow_dispatch` |
| Deploy 後 **canary**（HTML/CSS/JS/API） | `scripts/canary-probe.mjs` |
| canary 失敗時 **main をマージ前 SHA に即ロールバック** + Discord + Executor | deploy workflow / `cardinal-canary-rollback.yml` |
| **予防保守**（健全時の小修正・ドキュメントずれ） | 日次 `steward`（Executor）、週次 Guardian steward |
| 不具合・CI・canary 後の **draft PR 作成** | Executor（**自分で main にマージしない**） |

### 2.3 製品・マーケ（会話で追加した製品ゲート）

| 内容 | 経路・根拠 |
|------|------------|
| **市場調査・機能提案**（広告費ゼロ方針に沿う） | `product_cycle` → Executor `product_scout` |
| 提案の **Guardian レビュー**（approve / reject） | `product_review`（role: guardian） |
| 提案の **Executor レビュー**（実装可否） | `product_review`（role: executor） |
| **双方 approve 後のみ** プロダクトコード実装 PR | `product_implement` |
| 週次サイクル | `cardinal-product-cycle.yml` |
| 提案・レビュー・実装報告の **Discord 全文監査** | `DISCORD_WEBHOOK_URL` + `notifyProductGateDiscord` |
| スカウト用バックログ追記 | `docs/product-backlog.md`（approve 前はドキュメント中心） |

**Cursor が製品ゲートでやらないこと:** Guardian+Executor 双方 approve 前の **新機能 PR**（スカウト中は `docs/` と API 報告のみ）。

### 2.4 通知・報告

| 内容 | 経路 |
|------|------|
| 障害・起動・診断・日次ダイジェスト | Discord（`DISCORD_WEBHOOK_URL`） |
| 製品ゲート監査（提案 / レビュー / dual approve / 実装全文） | 同上 |
| Cardinal サイクル・異常スキャン（Ops 起動時） | ブラウザ + 任意 Discord |

### 2.5 成長（ゼロ現金 — Cursor 自走プレイブック）

| 内容 | 根拠 |
|------|------|
| LP ヒーロー等の **コード上の A/B**（PR で ship） | `docs/growth-zero-cash.md`、製品ゲート |
| デモ URL・投稿文案の下書き | 週次エージェント作業（ドキュメント / Discord 下書き） |
| 客席透かし・紹介・UTM・Store 紹介キットの **維持改善** | `js/growth.js` 等（ゲート通過後） |
| SEO・構造化データの改善 PR | 同上 |
| **有料広告・有料 API 増やさない** チェック | エージェントチェックリスト（growth doc） |

---

## 3. Cursor がやること — 管理（現状と将来）

| 内容 | 状態 | 備考 |
|------|------|------|
| リードの **記録**（LP・ref / utm） | 実装済 | Firestore + Discord |
| 紹介経由リードの **優先フォロー文案・改善 PR** | Cursor 可 | クローズ判断の完全自動は未 |
| トライアル → 年払い **セルフサーブ決済** | 要インフラ | 入ると「入金確認」が創業者から消える |
| 紹介クレジット → トライアル延長 | **一部手動** | growth doc「Ops が目視で付与」→ **自動化候補** |
| 店舗削除・課金調整・返金 | **創業者ゲート** | 意図的 |
| Firebase ルール・ops-auth 変更 | Guardian レビュー + **高リスク** | auto-merge 対象外パス |

---

## 4. 創業者（あなた）がやること

### 4.1 初回・稀な設定（会話・ドキュメント共通）

| # | 内容 | 頻度 |
|---|------|------|
| 1 | Cloudflare Pages シークレット（`OPS_API_SECRET`, `DISCORD_WEBHOOK_URL`, `CURSOR_*` 等） | 初回 + ローテ時 |
| 2 | GitHub Secrets（`OPS_API_SECRET` 同期、Actions 用） | 初回 |
| 3 | Cursor API / Automations（Guardian・Executor） | 初回 |
| 4 | Discord Application（Public Key、`DISCORD_OPS_USER_IDS`、Interactions URL、コマンド登録） | 初回（`docs/discord-ops-commands.md`、PR #57 系） |
| 5 | Ops「鍵」タブに `OPS_API_SECRET`（ブラウザから dispatch 用） | 初回 |
| 6 | Firebase Auth 初回（staff ユーザー） | 初回（`docs/security.md`） |

### 4.2 意図的な人間ゲート（~10%）

| # | 内容 | 理由 |
|---|------|------|
| 1 | ラベル **`cardinal:escalate`** が付いた事項 | 人間判断が必要な案件 |
| 2 | **`cardinal:hold` / `cardinal:no-automerge`** を付ける判断 | 自動マージを止めたい PR |
| 3 | **`firestore.rules` / `functions/api/_ops-auth.js`** 変更の最終責任 | 高リスクパス |
| 4 | **課金・返金・契約・店舗削除** 等の破壊的・金銭操作 | 法的・信用リスク |
| 5 | シークレットの **漏洩疑い・ローテ** | セキュリティ |

### 4.3 日常で「やらなくてよい」が、任意で残せること

| 内容 | 推奨 |
|------|------|
| PR マージ | **しない**（auto-merge に任せる） |
| 定常デプロイ | **しない**（merge → deploy → canary） |
| 障害の一次調査 | **しない**（Discord + Executor） |
| 製品機能の approve | **しない**（Guardian+Executor 双方向ゲート） |

### 4.4 まだ手が残りやすい管理（会話で明示したギャップ）

| 内容 | 創業者の関与 | 自動化の方向 |
|------|--------------|--------------|
| 紹介クレジットのトライアル延長 | 目視付与 | cron / Firestore で自動 |
| リード → 年払い **成約** | 交渉・例外 | セルフサーブ決済 + リマインド自動化 |
| パートナー契約の最終サイン | 人 | 成功報酬ルールを文書化のみ Cursor |

### 4.5 創業者の「最小運用」モデル（会話での推奨）

1. **Discord だけ見る** — 異常、ロールバック、製品ゲート、日次ダイジェスト  
2. **緊急時** — `/qo maint start|stop` または `server stop|recover`（Interactions 設定後）  
3. **月次程度** — outage drill / CI が緑か（見ないなら drill 失敗通知に依存）  
4. **お金** — 年払いの例外・返金のみ  

---

## 5. 自動化パイプライン一覧（書類用参照）

```text
【運営】
  cron tick → プローブ → 自動メンテ → Executor / followup
  AutoHeal → dispatch
  outage drill（模擬）

【変更】
  cursor/* PR → Guardian → auto-merge → Deploy → canary
       └─ NG → ロールバック → Executor

【製品・収益】
  product_cycle → scout → Guardian review → Executor review
       └─ 双方 approve → implement PR → product_implemented → Discord 全文
  PLG: 透かし → LP(ref) → リード → トライアル → 年払い → 売上 → Cursor 再投資

【通知】
  DISCORD_WEBHOOK_URL: 障害 / 起動 / 製品ゲート / ダイジェスト
  Discord /qo（設定後）: メンテ・停止・復旧（創業者の Ops 不要）
```

---

## 6. 収益を上げる役割分担

| レバー | Cursor | 創業者 |
|--------|--------|--------|
| 露出（透かし・紹介・SEO） | 改善 PR・文案 | なし（方針: 広告費ゼロ） |
| 転換（LP・CTA・年払い導線） | 製品ゲート経由で実装 | 例外交渉のみ |
| 紹介優先 | 文案・Ops 向け playbook PR | 自動化までの暫定クローズ |
| 再投資 | 売上の一部で Cursor / CF を賄う（ルールは growth doc） | 創業者の財布から出さない |

---

## 7. 会話で触れた PR・機能（履歴）

| テーマ | 内容 |
|--------|------|
| 自律 ~90% | `docs/autonomy.md`、Cardinal steward / followup |
| 自動マージ + canary ロールバック | #44–#45 系、deploy dispatch |
| 鯖落ちテスト | outage drill、Cache API 修正 #48–#51 |
| 製品ゲート | 市場 → 双方向 Cardinal approve → 実装（#54 等） |
| Discord 製品監査 | 提案・レビュー・実装の全文通知 |
| Discord 運用コマンド | `/qo maint` / `server`（#57、`docs/discord-ops-commands.md`） |
| 通知テスト | `cardinal-product-gate-test.yml`、`prop_ms8xb46v_jmxp` テスト提案 |

---

## 8. 関連ドキュメント索引

| ドキュメント | 用途 |
|--------------|------|
| `docs/autonomy.md` | 自律 90%・auto-merge・canary・人間ゲート |
| `docs/cardinal.md` | 双 AI・Ops 機能・cron |
| `docs/cardinal-product-gate.md` | 製品提案〜実装パイプライン |
| `docs/growth-zero-cash.md` | 広告ゼロ成長・週次 Cursor 作業 |
| `docs/discord-ops-commands.md` | スラッシュコマンドセットアップ |
| `docs/security.md` | シークレット・Auth |
| `docs/product-backlog.md` | スカウト用バックログ |
| `.cursor/rules/cardinal-guardian.mdc` | Guardian 行動規範 |
| `.cursor/rules/cardinal-executor.mdc` | Executor 行動規範 |

---

## 9. 改訂履歴

| 版 | 日付 | 内容 |
|----|------|------|
| 1.0 | 2026-08-01 | 会話履歴（自律90%、auto-merge、outage drill、製品ゲート、Discord 監査・運用コマンド、手を離す運営・収益方針）を統合した初版 |

---

**承認・運用:** 本書は `docs/autonomy.md` と矛盾する場合、**autonomy.md を優先**する。
