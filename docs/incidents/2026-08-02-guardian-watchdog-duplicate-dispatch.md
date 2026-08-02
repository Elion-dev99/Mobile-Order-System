# Guardian watchdog: 重複起動の調査（2026-08-02）

**種別**: watchdog（Executor 無応答監視） / **重要度**: warning
**担当**: Cardinal Guardian（本ドキュメントの起票者）
**結論**: Executor は無応答ではない。再ディスパッチ不要。ただし Guardian watchdog の重複起動バグを検知したので Executor タスク化する。

## 1. 状況報告

- オープン PR: **0件**（`gh pr list --state open` は空）。直近の PR は #59（`docs: add Cursor Cloud dev environment setup instructions`）で、起票から約2分で auto-merge 済み。
- 直近15件の PR はすべて `MERGED`。stuck/draft のまま長時間放置された PR は見当たらない。
- CI: `Cardinal auto-merge` / `Cardinal canary / rollback` / `Cardinal cron watchdog` / `Deploy to Cloudflare Pages` は直近ですべて `success`。ロールバックの形跡なし。
- `Cardinal cron watchdog`（GitHub Actions, hourly）の直近実行は `13:49:50Z`。今回の watchdog タスク発火（`14:27:33Z`〜`14:50:56Z`）はこの cron 実行と時刻が一致せず、cron 起因ではない。
- 一方で、本タスクと同名・同文面の **「Executor 無応答監視」Guardian watchdog cloud agent が短時間に多重起動**していることを確認した（Cursor Cloud Agents 一覧より）:
  - `04:16:42Z〜04:19:45Z` の3分間に4件（`baga4c` `bahnyf` `baiy6v` `bak8o2`）
  - `14:27:33Z〜14:50:56Z` の24分間に7件（`bw9ve5` `bwb5qf` `bwcg01` `bwdqb8` `bwf0m7` `bwza21` `bx3y7s`＝本タスク）。うち5件は **正確に60秒間隔**（14:27:33 / 28:33 / 29:33 / 30:33 / 31:33）。
  - いずれも branch なし・コード変更なし・成果物なし（Guardian役割なので想定通りだが、そもそも同一状況に対して重複起動されている点が問題）。

## 2. 根本原因（仮説、証跡あり）

`js/cardinal.js` の `startCardinal({ intervalMs = 60_000, ... })` は Ops 画面を開いている間、**60秒ごと**に `runCardinalCycle()` を回す。この中の「Executor 無応答 → Guardian 起動」ロジック（`kind:'watchdog'`, title `Executor 無応答の監視`）は、

```12:14:js/cardinal.js
// Ops session soft-beats Guardian only. Soft-beating Executor hid watchdog stale checks.
```

の設計上 Executor の心拍は Ops セッションでは補われないため、Executor 心拍が古いままだと **毎ティック条件を満たし続ける**。本来は `dispatchRole()` 内の 20分クールダウン（`state.guardian.lastDispatchAt`）で連投を防ぐ設計だが、60秒間隔で複数回連続起動している実測値は、このクールダウンが機能していないことを示す。

サーバー側 (`functions/api/cardinal.js` / `functions/api/_agent-ledger.js`) にも `COOLDOWN.watchdog = 90分` があるが、この台帳は **Cloudflare の `caches.default`（Cache API）に保存**しており、これは **エッジ PoP（コロケーション）ローカルで、グローバルには同期されない**。実際に本番へ `action:"status"` を叩いたところ、

```json
{"ledger":{"lastByKind":{},"recent":[]}}
```

と、直近11時間で11回も起動しているにもかかわらず **台帳が空** に見えるレスポンスが返った（別 PoP がヒットしたため）。これは `docs/incidents` 化する前から `_maintenance-store.js` 側で一度修正された「エッジキャッシュがグローバルでない」問題（PR #48 “Fix maintenance edge store (global caches)”）と**同種の設計不備**が `_agent-ledger.js` にも残っていることを意味する。

すなわち:
1. クライアント（Ops ブラウザタブ、複数タブ／再読み込み／新規セッションだと `localStorage` も引き継がれない）が 60秒毎に watchdog 起動条件を再評価。
2. サーバーの重複排除（90分クールダウン）が PoP ローカルの Cache API に依存しており、リクエストが別 PoP に着地すると効かない。
3. 結果として同一警報に対して Guardian watchdog エージェントが多重起動する。

## 3. 再ディスパッチ要否の判断

**判断: 様子見（Executor への「無応答」再ディスパッチは不要）。**

- 実際に Executor が止まっている証跡（未マージの draft PR 放置、CI 失敗放置など）は無い。むしろ直近の Executor 系 PR は全て正常に auto-merge されている。
- 今回の「Executor 無応答」という警報自体が、上記の重複起動バグによる**誤検知（false positive）**である可能性が高い。
- 本番の可用性・データに影響はない（Guardian は読み取り専用の調査ロールで、コード変更・マージを行わないため実害は「Cloud Agent の起動回数・クレジット消費」のみ）。
- よって「Executor 再起動」ではなく、**Guardian watchdog 自体の重複起動を止める小さな修正**を Executor タスクとして起票する（下記 §4）。優先度は `warning`（本番影響なし・緊急性なし）。

## 4. Executor 向け Issue（文面案）

> 起票は Guardian の権限外（`gh` は read-only）のため、次の文面をそのまま GitHub Issue または `cardinal:executor` ラベル付きタスクとして人間 / 自動化が起票することを想定。

---

**Title**: Guardian watchdog（`kind:"watchdog"`）が短時間に多重起動する — cooldown 台帳がエッジ間で非グローバル

**Labels**: `cardinal:executor`

**Body**:

`docs/incidents/2026-08-02-guardian-watchdog-duplicate-dispatch.md` の調査より、「Executor 無応答監視」Guardian watchdog cloud agent が同日に2回のバーストで計11件、重複起動していることを確認しました（うち5件は正確に60秒間隔）。本番影響（ロールバック・データ破損）はありませんが、Cloud Agent 起動回数（クレジット）を無駄に消費しています。

**根本原因（仮説）**:
1. `js/cardinal.js` の Ops 側 60秒ティック（`startCardinal({intervalMs:60_000})`）が、Executor 心拍が古いままだと毎ティック watchdog 起動条件を満たし続ける。
2. サーバー側の重複排除（`functions/api/_agent-ledger.js`、`COOLDOWN.watchdog=90分`）が Cloudflare `caches.default`（Cache API）に依存しており、**PoP ローカルでグローバルには同期されない**ため、別エッジに着地したリクエストはクールダウンを見逃す。実測: 本番へ `action:"status"` を投げたところ `ledger.lastByKind` が空で返り、直近の起動が反映されていなかった。

**提案する修正（いずれか、Executor 判断でOK）**:
- (a) `_agent-ledger.js` の保存先を Cache API から **Cloudflare KV**（`OPS_API_SECRET` 同様に bindings 済みなら）や Durable Object に変更し、グローバルに一貫したクールダウン判定にする。
- (b) クライアント側 `dispatchRole()`（`js/cardinal.js`）で、`kind==='watchdog'` かつ role==='guardian' の場合はサーバーの dispatch レスポンス（`automation.ok` / `agent.ok` / `skipped:'cooldown'`）を見て、`skipped` でも `state[id].lastDispatchAt` を更新するなど、**クライアント側クールダウンをサーバーの判定結果に追従**させる（現状は `res.ok`＝HTTPレベルの成否のみで判定しており、`skipped:true` でも200を返しうる設計だと同様に空振りし続ける可能性がある。要確認）。
- (c) 最低限の対症療法として、watchdog dispatch にサーバー側の冪等キー（例: `kind + role + 直近時間バケット`）を付け、同一キーの重複リクエストは即座に `skipped` を返す。

**受け入れ条件**:
- 同一 watchdog 警報に対し、90分以内に Guardian cloud agent が複数起動しないことを確認（本番 `action:"status"` の `ledger.lastByKind.watchdog` が単調に更新されることでも可）。
- 既存の `docs/incidents/2026-08-02-guardian-watchdog-duplicate-dispatch.md` から本 Issue へのリンクを維持。
- 大規模リファクタ不要。`_agent-ledger.js` / `js/cardinal.js` の局所修正で完了させる。

---

## 5. 人間向け Discord エスカレーション文面（簡潔版）

> `cardinal:escalate` 相当ではない（本番影響なし・シークレット/高リスクパス関与なし）ため、通知のみで人間判断待ちにはしない。

```text
🔎 Cardinal Guardian 定期監視
状況: 本番は正常（オープンPRなし・直近CI/canary/自動マージすべて成功）。
「Executor 無応答」警報は誤検知の可能性が高いです。
検知: Guardian watchdog が同日に11回重複起動（うち5回は60秒間隔）。
原因(仮説): Ops側60秒ティック × cooldown台帳がCloudflareエッジ間で非同期（Cache API起因）。
影響: 実害なし。Cloud Agent起動クレジットの浪費のみ。
対応: Executor向けに軽微な修正Issueを起票しました（_agent-ledger.jsの保存先見直し）。再起動・エスカレーションは不要と判断。
```

## 参照

- `docs/autonomy.md` / `docs/cardinal.md`
- `.cursor/rules/cardinal-guardian.mdc`
- `functions/api/cardinal.js`（`COOLDOWN`, `dispatchRole`）
- `functions/api/_agent-ledger.js`（Cache API ベースの台帳）
- `js/cardinal.js`（`startCardinal`, `dispatchRole`, `runCardinalCycle`）
- 参考の類似修正: PR #48 “Fix maintenance edge store (global caches)”
