# 製品バックログ（Cardinal スカウト用）

Cursor Executor が **市場調査・提案** するときに追記する。  
**Guardian + Executor の双方 approve 前は、こことドキュメント以外のプロダクトコードを変更しない。**

方針: `docs/growth-zero-cash.md` / ゲート: `docs/cardinal-product-gate.md`

---

## 提案テンプレ（コピー用）

```markdown
### [提案タイトル] — YYYY-MM-DD

- **市場シグナル**:
- **マーケ角度**（広告費ゼロ）:
- **ユーザー価値**:
- **スコープ**（最小）:
- **受け入れ条件**:
- **リスク**:
- **API proposalId**（product_propose 後）:
```

---

## 進行中

### [テスト] LP紹介ヒーロー文言の微調整 — 2026-07-31

- **市場シグナル**: 客席透かし→LP はあるがヒーローが汎用。`docs/growth-zero-cash.md` の PLG。
- **マーケ角度**: ref 付き LP のヒーロー1行を PR で差し替え（広告費ゼロ）。
- **ユーザー価値**: 紹介経由の期待値が伝わり、トライアル申込につながりやすい。
- **スコープ**: `js/lp.js` または LP ヒーロー部分のみ（**Cardinal 双方向 approve 後に実装**）。
- **受け入れ条件**: `?ref=demo` でコピー変化、canary OK、有料 API 追加なし。
- **リスク**: 低（表示文案のみ）。
- **API proposalId**: （GitHub `Cardinal product gate test` 実行後に Discord / API レスポンスを参照）

（Cardinal 通知テスト用 — 実装はゲート approve 後のみ）

---

## 完了・却下（履歴）

| 日付 | タイトル | Guardian | Executor | 結果 |
|------|----------|----------|----------|------|
| — | — | — | — | — |
