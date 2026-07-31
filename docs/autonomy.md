# 自律運営ポリシー — Cursor が約90%を担う

創業者の意図: **運営・保守・不具合修正の約9割を Cursor（Cardinal）に任せる。**  
人間は残り約1割（危険なゲート）だけ触る。

## 役割分担（目標）

| 割合 | 担当 | 内容 |
|------|------|------|
| **~90%** | Cursor（Guardian / Executor） | 監視、自動メンテ、障害調査、CI失敗修正、予防保守、PRレビュー、draft PR |
| **~10%** | 人間 | シークレット初回設定、**main へのマージ**、`cardinal:escalate`、課金・破壊的データ操作 |

完全無人の自動マージはしない（意図的）。draft PR までが Cursor、マージ判断が人間。

## Cursor が自動で回すもの

```text
  GitHub cron (毎時)
        │
        ▼
  /api/cardinal tick ──► プローブ → 自動メンテ ON/OFF
        │                   │
        │                   └─ 異常 → Executor 起動（クールダウン付き）
        │                   └─ 継続異常 → followup 再起動
        │
        ├─ 日次 digest（Discord）
        ├─ 日次 steward（予防保守 Executor）
        └─ 週次 steward（Guardian レビュー）

  Deploy CI 失敗 ──► /api/cardinal dispatch kind=ci → Executor
  cursor/* PR   ──► /api/cardinal dispatch kind=pr_review → Guardian
  Ops AutoHeal  ──► /api/cardinal（優先）/ レガシー /api/incident
```

| トリガー | 役割 | API |
|----------|------|-----|
| 本番プローブ失敗 | Executor | `tick` / `followup` |
| Deploy 失敗 | Executor | `dispatch` kind=`ci` |
| `cursor/*` PR | Guardian | `dispatch` kind=`pr_review` |
| 健全時の予防保守 | Executor | `steward` mode=`executor` |
| 週次レビュー | Guardian | `steward` mode=`guardian` |
| Ops ヘルス連続失敗 | Executor | AutoHeal → Cardinal |

起動にはクールダウンがある（クレジット浪費防止）。`force: true` で突破可。

## 人間だけがやること（~10%）

1. Cloudflare / GitHub / Cursor の **初回シークレット**（`CURSOR_API_KEY`, `OPS_API_SECRET`, Discord）
2. **draft PR のマージ**（慣れたら範囲を広げるが、当面は人が最終承認）
3. Discord / Ops に来た **`cardinal:escalate`**（外部障害・曖昧・危険操作）
4. チェーン課金・店舗削除・セキュリティルールの破壊的変更

## エージェントへの指示原則

- 人間の承認待ちで止めない（マージ以外）
- 不明でも仮説で進め、PR に前提を書く
- 客席保留キュー・health・Cardinal を壊さない
- 変更不要なら理由を短く残して終了（無駄打ちしない）

プロンプト本体: `functions/api/cardinal.js` の `rolePrompt`  
行動規範: `.cursor/rules/cardinal-*.mdc`

## Ops での見え方

Cardinal タブの **自律 90%** パネルと API `action: status` の `autonomy` フィールド。

## 関連

- `docs/cardinal.md` — 双AIプロトコル
- `docs/hardening.md` — 既知バグ修正メモ（あれば）
- `.github/workflows/cardinal-cron.yml`
- `.github/workflows/cardinal-ci-dispatch.yml`
- `.github/workflows/cardinal-pr-guardian.yml`
