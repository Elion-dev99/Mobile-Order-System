# 自律運営ポリシー — Cursor が約90%＋自動マージ／即ロールバック

創業者の意図: **運営・保守・不具合修正の約9割を Cursor（Cardinal）に任せる。**  
**マージも自動化**する。ただしデプロイ後に表示エラーや不具合が出たら **即時でマージ前の SHA に戻す**。

## 役割分担（目標）

| 割合 | 担当 | 内容 |
|------|------|------|
| **~90%+** | Cursor（Guardian / Executor + GitHub Actions） | 監視、自動メンテ、障害修正、CI修正、予防保守、PRレビュー、**squash 自動マージ**、canary、**即ロールバック** |
| **~10%-** | 人間 | シークレット初回、`cardinal:escalate` / 高リスクパス、課金・破壊的データ操作 |

## 自動マージ → canary → ロールバック

```text
  cursor/* PR（escalate / hold ラベルなし）
        │
        ▼
  Cardinal auto-merge ──► squash merge → main
        │
        ▼
  Deploy (Cloudflare Pages)
        │
        ▼
  canary-probe（客席/店舗/Ops HTML・CSS・JS・API）
        │
        ├─ OK  → 完了
        │
        └─ NG  → main を マージ前 SHA に force-with-lease で復元
                  + Discord
                  + Executor 起動（再発修正）
```

### 自動マージの条件

- ブランチが `cursor/*`
- ラベルに `cardinal:escalate` / `do-not-merge` / `cardinal:hold` / `cardinal:no-automerge` が無い
- 致命的チェック失敗が無い
- 高リスクパスを触っていない（`firestore.rules` / `functions/api/_ops-auth.js`）
- draft は ready にしてから squash merge

止めたい PR には `cardinal:hold` または `cardinal:no-automerge` を付ける。

### 注意: GITHUB_TOKEN マージは Deploy を自動発火しない

GitHub 仕様で、`GITHUB_TOKEN` による merge の `push` は他ワークフローを起動しない。  
そのため auto-merge 成功後に **`Deploy to Cloudflare Pages` を `workflow_dispatch`** する。  
（任意）リポジトリ secret `CARDINAL_GH_PAT` を置けば PAT でマージし、通常の push→Deploy も使える。

### canary が見るもの

`scripts/canary-probe.mjs`:

- `/`（QuickOrder 表示）・`/ops.html`・`/store.html`・`/status.html`
- 主要 CSS/JS のサイズ
- `/api/cardinal`・`/api/maintenance`・`/api/notify`
- エラーページ断片（502 / Worker exception / ReferenceError など）

失敗時は **マージ直前の commit に main を戻す**（「マージ前に戻す」）。

## Cursor が自動で回すもの

```text
  GitHub cron (毎時)
        │
        ▼
  /api/cardinal tick ──► プローブ → 自動メンテ → Executor / followup

  Deploy 後 canary ──► NG なら即ロールバック + Executor
  毎時 canary（保険）──► NG ならロールバック

  Deploy CI 失敗 ──► Executor
  cursor/* PR   ──► Guardian レビュー →（条件OKなら）auto-merge
  Ops AutoHeal  ──► Cardinal dispatch
```

| トリガー | 役割 | 経路 |
|----------|------|------|
| 本番プローブ失敗 | Executor | `tick` / `followup` |
| Deploy 失敗 | Executor | `kind=ci` |
| Deploy 後表示/API異常 | ロールバック + Executor | deploy canary |
| `cursor/*` PR | Guardian → auto-merge | workflows |
| 予防保守 | Executor steward | cron |
| 製品・マーケ | スカウト → 双方向レビュー → 実装 | `product_cycle` / `cardinal-product-cycle.yml` |
| Ops ヘルス連続失敗 | Executor | AutoHeal |

## 人間だけがやること（縮小した ~10%）

1. Cloudflare / GitHub / Cursor の **初回シークレット**
2. **`cardinal:escalate` / 高リスクパス**（ルール・ops-auth）
3. チェーン課金・店舗削除など破壊的操作
4. （任意）自動マージを止めたい PR に `cardinal:hold`

マージ判断の日常作業は不要。異常時は Discord でロールバック通知が来る。

## エージェントへの指示原則

- 人間の承認待ちで止めない（escalate / 高リスク以外）
- **マージ操作はエージェント自身では行わない**（`cardinal-auto-merge` ワークフローに任せる）
- 不明でも仮説で進め、PR に前提を書く
- 客席保留キュー・health・Cardinal を壊さない
- 変更不要なら理由を短く残して終了

## Ops での見え方

Cardinal タブの **自律 90%** パネル。API `action: status` の `autonomy`。

## 関連

- `docs/cursor-founder-division-of-labor.md` — **Cursor と創業者の役割分担書（一覧）**
- `docs/cardinal.md`
- `docs/cardinal-product-gate.md`
- `scripts/canary-probe.mjs`
- `.github/workflows/cardinal-auto-merge.yml`
- `.github/workflows/deploy-cloudflare-pages.yml`
- `.github/workflows/cardinal-canary-rollback.yml`
- `.github/workflows/cardinal-cron.yml`
- `.github/workflows/cardinal-ci-dispatch.yml`
- `.github/workflows/cardinal-pr-guardian.yml`
- `.github/workflows/cardinal-outage-drill.yml` — 鯖落ち模擬（エージェント起動なし）
- `.github/workflows/cardinal-product-cycle.yml` — 市場スカウト・製品ゲート
- `scripts/outage-drill.sh`
