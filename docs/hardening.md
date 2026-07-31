# 横断改修メモ（system hardening）

監査で見つかった不具合の修正記録。詳細は PR を参照。

| # | 問題 | 修正 |
|---|------|------|
| 1 | 自動メンテ OFF でも既存 Cardinal ロックが残る | サイクル／Prefs保存時に `syncAutoMaintenance(false)` |
| 2 | `dispatchOnOutage` OFF でも AutoHeal が Incident 起動 | `isCapabilityOn('dispatchOnOutage')` でゲート |
| 3 | メンテ merge が古い ON で新しい OFF を潰す | **新しい `updatedAt` 優先** |
| 4 | 成長透かしが `position:relative` に潰される | `:not(.qo-growth-mark)` + `fixed !important` |
| 5 | LP リード `source` が属性で上書き | `source: lp_revenue_max` 固定、属性は別フィールド |
| 6 | UTM 後勝ちで `ref` が消える | first-touch merge |
| 7 | AutoHeal + Cardinal 二重ディスパッチ | heal 済みなら cycle 側スキップ／Executor 偽心拍停止 |
| 8 | 共有キャンセルでも紹介クレジット加算 | 成功後のみ `recordReferralShare` |
| 9 | 席パルスが常に「1名」 | `splitPeople` デフォルトを人数表示に使わない |
