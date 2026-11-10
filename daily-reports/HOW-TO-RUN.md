# How the daily report is produced

A new file `daily-reports/YYYY-MM-DD.md` is added every day, following `TEMPLATE.md`.

## Daily process (about 20 minutes)
1. **Collect signals**
   - Amazon Best Sellers and Movers & Shakers (amazon.com/gp/bestsellers, amazon.com/gp/movers-and-shakers) for: Home & Kitchen, Pet Supplies, Beauty, Health, Sports, Electronics accessories, Toys
   - TikTok "TikTokMadeMeBuyIt" and Amazon finds trends
   - Seasonal calendar (what sells 6–10 weeks from today, when new stock would land)
2. **Update the scored table** from yesterday's report: keep niches that still score well, mark ↑ / ↓ / =, add new ones, drop ones under 7/13.
3. **Pick one top pick** and write the deep-dive with unit economics.
4. **Write "Changes since yesterday"** and list sources.

## Scoring rules
- Demand 1–5: Best Seller / Movers presence, "bought in past month" counts, search trend
- Competition 1–5: median reviews of top 10 (under 300 = 1–2, 300–1,000 = 3, 1,000+ = 4–5), brand dominance, price war
- Net margin: price − 15% referral − FBA fee − landed cost − 15% ads
- Score = Demand + (6 − Competition) + margin points (≥30% = 3, 20–29% = 2, <20% = 1). Max 13. Consider only 9+.

## Better data (optional, paid)
With **Helium 10**, **Jungle Scout** or **SellerSprite**, or Amazon **Brand Analytics** (free with Brand Registry), the report can include exact search volumes and estimated monthly sales.
