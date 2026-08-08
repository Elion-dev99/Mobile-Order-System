# 収益最大化（実装済み）

- [`pl.md`](./pl.md) — 現行は AWS 行 ¥0。**連携**は [`aws-integration.md`](./aws-integration.md)  
スマレジ規模（契約5万店）の必要費用・対比は [`pl-50k-smaregi.md`](./pl-50k-smaregi.md)。  
**広告費ゼロの獲得**は [`growth-zero-cash.md`](./growth-zero-cash.md)。

## 方針
1. **ACVを上げる** — LP既定を年払い、Growth年払いCTA、見積プレビューで初回請求額を明示
2. **転換を急かす** — 14日トライアル＋希少性（今月の優先導入枠）
3. **機能で課金を強制** — トライアル終了後は分析/CSV/多言語/音/SLAをロック（厨房基本は継続）
4. **Chain手数料を可視化** — 注文に `platformFee` を付与し Ops の「未請求手数料」に合算

## 価格（税別）
| Plan | 月額 | 年払い実質/月 | 初期 |
|------|------|---------------|------|
| Lite | ¥6,980 | ¥5,817 | ¥29,800 |
| Growth | ¥14,800 | ¥12,333 | ¥49,800 |
| Business | ¥29,800 | ¥24,833 | ¥98,000 |
| Chain | ¥49,800 | ¥41,500 | ¥198,000 + 注文0.8% |

## Stripe
`js/config.js` の `stripePaymentLinksByCycle` / `stripePaymentLinks` に Payment Link を入れると、LP/Admin のCTAがプラン・月/年に応じて「カードで契約」に切替わります（Admin は店舗ID付き URL）。  
設計・一括作成: [`stripe-pricing-model.md`](./stripe-pricing-model.md) · Webhook: [`stripe-setup.md`](./stripe-setup.md)

## 運用
- `PRODUCT.introSlotsRemaining` を月次で更新
- Ops HQ の未請求手数料を月末に請求
- リードの `billingCycle=annual` / `chargeNow` を優先クローズ
- 実用稼働チェックリスト: [`revenue-go-live.md`](./revenue-go-live.md)
