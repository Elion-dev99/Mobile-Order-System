# Watchdog インシデント: Guardian「Executor 無応答監視」重複起動 (2026-08-02)

- 種別: `watchdog` / 重要度: `warning`
- 起票元: Cardinal Guardian（本ドキュメントは `cursor/cardinal-guardian-watchdog-bwf0m7-a58c` の調査結果）
- 対象タスク: 「Executor 無応答の監視」（`js/cardinal.js` の `dispatch_guardian_watchdog` サイクルが起票する定型タスク）

## 1. 状況（調査結果）

タスクの前提「Executor のハートビートが古く、タスク進捗が不明」を GitHub / Cursor Cloud Agents で検証した結果、**Executor は無応答ではない**ことを確認した。

- 直近の PR は全て高速にマージされている（例: [#59](https://github.com/Elion-dev99/Mobile-Order-System/pull/59) は作成から11秒でマージ）。オープン PR は 0 件（`gh pr list --state open` が空）。
- `Cardinal auto-merge` / `Cardinal canary / rollback` / `Cardinal cron watchdog` の直近ワークフロー実行は全て `success`（ロールバック発火なし）。
- 一方で **Cursor Cloud Agents 側に、まったく同一内容の Guardian watchdog タスク（本タスク）が短時間に 5 重起動**されていることを発見した:

  | bcId | branch | createdAtMs | 前回との差 |
  |------|--------|-------------|-----------|
  | bc-b4b69806… | `...watchdog-bw9ve5-a58c` | 1785680853882 | — |
  | bc-df5394a3… | `...watchdog-bwb5qf-a58c` | 1785680913315 | +59.4s |
  | bc-9a3acb46… | `...watchdog-bwcg01-a58c` | 1785680973390 | +60.1s |
  | bc-a768e30b… | `...watchdog-bwdqb8-a58c` | 1785681033667 | +60.3s |
  | bc-f5d607fc…（本エージェント） | `...watchdog-bwf0m7-a58c` | 1785681093030 | +59.4s |

  5 件とも `status: RUNNING`、タイトル・要約・acceptance が完全に一致しており、同一トリガーが約60秒間隔で連続起票したことを示す。60秒間隔は Ops UI 側 Cardinal サイクルの `intervalMs = 60_000`（`js/cardinal.js` `startCardinal()`）と一致する。

### 推定原因（コードレベルで確認済み・仮説含む）

`js/cardinal.js` の `runCardinalCycle()` は、Executor のハートビート/最終ディスパッチが `executorSlaMs`（既定90分）を超えて古い場合に `dispatchRole('guardian', { kind: 'watchdog', ... })` を呼ぶ。本来は以下の二重の冷却機構で連発を防ぐ設計になっている:

1. **クライアント側**（`js/cardinal.js` `dispatchRole()`）: `localStorage` の `state.guardian.lastDispatchAt` を見て `cooldownMs`（既定20分）以内なら起票しない。
2. **サーバー側**（`functions/api/cardinal.js` `dispatchRole()` + `functions/api/_agent-ledger.js`）: Cloudflare **Cache API**（`caches.default`）に記録した `lastByKind.watchdog` を見て `COOLDOWN.watchdog`（90分）以内ならスキップする。

しかし今回、90分の冷却があるにもかかわらず 60 秒間隔で 5 回実際に Cloud Agent が起動された。考えられる原因:

- **サーバー側 Cache API はエッジ（Cloudflare データセンター/POP）ローカルであり、グローバルに一貫していない。** 短時間に発生した複数リクエストが異なる POP / アイソレートで処理されると、直前に書き込んだ `lastByKind.watchdog` が別リクエストからは "キャッシュミス" として見え、冷却が効かないケースがあり得る（`functions/api/_agent-ledger.js` の設計上の既知の制約）。
- **クライアント側の `state` がティックごとにリセットされている可能性。** Ops ページが 60 秒間隔でフレッシュな状態（`localStorage` 未初期化、または `health.status !== 'ok'` の状態）から `runCardinalCycle` を評価し続けると、`isStale(...)` の判定が常に真になり、冷却前に次の watchdog 条件を満たしてしまう。

いずれの場合も、**watchdog 起票の重複排除が本番トラフィック/自動化パターンの下で機能していない**ことが実害（Cloud Agent の無駄な多重起動＝コスト増、レビュー対象の水増し）として観測された。

## 2. 判断（再ディスパッチ要否）

- **Executor への再ディスパッチは不要。** Executor は無応答ではなく、直近まで正常に PR をマージしている。今この状況で追加の Executor / Guardian を起動すると、重複エージェント問題を悪化させるだけである。
- **本タスク自身を含む 5 件の重複 Guardian watchdog エージェントは統合すべき。** 後続の重複エージェントは、本ドキュメントの調査結果を参照して早期終了することを推奨する（同じ結論に達するはずのため、追加の調査コストは不要）。
- **恒久対処は Executor 向けタスクとして起票**（下記）。Guardian の役割上、実装は行わない。

## 3. Executor 向け Issue 文面（そのまま起票可）

> **タイトル:** Cardinal watchdog 起票の重複排除が機能しない（60秒間隔で5重起動を観測）
>
> **ラベル案:** `bug`, `cardinal:executor`
>
> **本文:**
>
> ## 概要
> 2026-08-02 に Guardian watchdog タスク「Executor 無応答の監視」が **60秒間隔で 5 回連続起動**（Cloud Agents: `bc-b4b69806`, `bc-df5394a3`, `bc-9a3acb46`, `bc-a768e30b`, `bc-f5d607fc`）。90分クールダウン（`COOLDOWN.watchdog`, `functions/api/cardinal.js`）が設定されているにもかかわらず抑止できていない。
>
> ## 疑わしい原因
> 1. `functions/api/_agent-ledger.js` の冷却台帳が Cloudflare **Cache API**（`caches.default`）に依存しており、POP/エッジ間でグローバルに一貫しない。連続リクエストが異なるエッジに着地すると冷却チェックが機能しない。
> 2. `js/cardinal.js` の `runCardinalCycle()` がクライアント状態リセット（ページ再読み込み・`localStorage` 未初期化・health 異常判定の揺らぎ）のたびに watchdog 条件を再評価し、クライアント側冷却をすり抜けている可能性。
>
> ## 提案する調査/修正の方向性（一例、実装は Executor 判断で）
> - サーバー側の冷却をより一貫性のあるストレージ（例: KV、または Durable Object、もしくは Firestore の軽量ドキュメント）に移すか、少なくとも Cache API の既知の制約を踏まえてより保守的に（例: 短時間の多重書き込みを避けるロック的な仕組み）実装し直す。
> - クライアント側 `runCardinalCycle` に「直近 N 分以内に同一 `kind` の watchdog がサーバーへ POST 済みなら再送しない」ような、サーバーレスポンス（`skipped/reason`）を見てローカル状態を即座に長めに更新するフォールバックを追加する。
> - 併せて、`dispatchRole()`（サーバー側）のレスポンスの `ok` は常に `true`（HTTP 成功）であり、実際に起動できたかどうか（`launched`）とは独立している点をクライアントがきちんと区別しているか確認する（`js/cardinal.js` `cardinalApi()` の `res.ok` は HTTP レベルのみを見ている）。
>
> ## 受け入れ条件
> - [ ] 同一 `kind` の watchdog/incident 系ディスパッチが冷却期間内に複数の Cloud Agent を実際に起動しないことを再現テスト or ロジックレビューで確認
> - [ ] 修正内容を draft PR に反映（客席保留キュー・health 監視を壊さないこと）
> - [ ] 変更が最小であれば、`docs/cardinal.md` の冷却設計の記述を更新

## 4. Discord 向けエスカレーション文面（簡潔・人間向け）

> ⚠️ **Cardinal Guardian 報告 — watchdog 重複起動（warning）**
> Executor は正常です（直近PRは秒単位でマージ済み、canary/auto-mergeも green）。ただし **Guardian の「Executor無応答監視」watchdog タスクが60秒間隔で5重起動**していました（Cloud Agentsに同一タスクが5件）。90分クールダウンが機能していないことが原因と推定（Cache APIのエッジ非一貫性、またはクライアント状態リセット）。
> **対応:** 追加の人間対応は不要（`cardinal:escalate` 対象ではない）。重複エージェントは統合し、恒久対処は Executor issue として起票済み。コスト影響（Cloud Agent 5並列起動）のみ念のため共有します。

## 5. 参照

- `js/cardinal.js`（`startCardinal`, `runCardinalCycle`, `dispatchRole`, `cardinalApi`）
- `functions/api/cardinal.js`（`dispatchRole`, `COOLDOWN`）
- `functions/api/_agent-ledger.js`（Cache API 冷却台帳）
- `docs/autonomy.md` / `docs/cardinal.md`
