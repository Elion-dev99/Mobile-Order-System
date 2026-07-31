# Cardinal 製品ゲート — 市場調査 → 双方向レビュー → 実装

Cursor が **市場（ゼロ現金成長）を見て機能を提案**し、**Guardian と Executor の双方が approve した場合のみ** プロダクトコードを実装するパイプライン。

| 項目 | 内容 |
|------|------|
| マーケ方針 | `docs/growth-zero-cash.md`（広告費なし・PLG・紹介） |
| バックログ | `docs/product-backlog.md` |
| 状態保存 | Cloudflare Cache API（`functions/api/_product-gate.js`） |
| 起動 | GitHub `cardinal-product-cycle.yml` / Ops「製品ゲート1サイクル」 |

---

## フロー

```text
  product_cycle (週次 or 手動)
        │
        ├─ 提案なし ──► Executor: product_scout
        │                 └─ product-backlog 更新 + product_propose API
        │
        ├─ 提案あり ──► Guardian: product_review (approve|reject)
        │
        ├─ G approve ──► Executor: product_review (approve|reject)
        │
        └─ 双方 approve ──► Executor: product_implement → draft PR
                              └─ product_implemented API
```

**reject** した時点でその提案は終了。次のスカウトはクールダウン（約7日）後。

---

## API（POST `/api/cardinal`、Ops secret 必須）

| action | 用途 |
|--------|------|
| `product_status` | 現在の提案・次ステップ |
| `product_propose` | スカウト後に提案を登録 → **Discord に提案全文** |
| `product_review` | `{ role, proposalId, verdict, notes }` → **Discord にレビュー全文**（双方 approve 時は追加通知） |
| `product_cycle` | 次ステップを判定して Cursor を起動 → **Discord にサイクル＋指示全文** |
| `product_implemented` | 実装 PR 完了報告（`summary`, `changes`, `filesChanged`, `prUrl`, `testsRun`, `verification`, `report`）→ **Discord に実施内容全文** |

`DISCORD_WEBHOOK_URL`（Cloudflare secret）が設定されている場合、上記イベントはすべて監査用に Discord へ送られます（長文は複数メッセージに分割）。

公開 GET では action 一覧のみ。`status` の `productGate` にサマリ。

---

## エージェント規約

### スカウト（Executor）

- 触ってよい: `docs/product-backlog.md`, `docs/growth-zero-cash.md`, マーケ文案
- **触らない**: `js/`, `store.html`, `functions/` 等の実装（レビュー前）

### Guardian レビュー

- 客席・セキュリティ・スコープ・マーケ整合
- コード PR は作らない
- 必ず `product_review` を POST

### Executor レビュー

- 工数・canary リスク・既存機能との重複
- まだ実装 PR なし
- 必ず `product_review` を POST

### 実装（Executor）

- **双方 approve 後のみ** draft PR
- 完了後 `product_implemented`

---

## 人間ゲート（変わらず）

- シークレット初回、`firestore.rules` / `_ops-auth.js`、`cardinal:escalate`
- 製品ゲートは **Cursor 内の双方向レビュー** で日常の機能判断を自動化する

---

## 関連

- `.cursor/rules/cardinal-guardian.mdc` / `cardinal-executor.mdc`
- `.github/workflows/cardinal-product-cycle.yml`
- `js/cardinal-features.js`（`productGate`, `marketScout`, `dualFeatureReview`）
