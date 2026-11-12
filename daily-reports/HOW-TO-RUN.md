# How the daily report is produced

A new file `daily-reports/YYYY-MM-DD.md` is added every day, following `TEMPLATE.md`.

## Daily process (about 20 minutes)
1. **Collect signals for all three stores (Amazon.com, Amazon.ae, Amazon.sa)**
   - Amazon.ae and Amazon.sa Best Sellers (or MetricsCart bestseller reports for those stores), Arabic search trends, Gulf event calendar (White Friday, National Days, Ramadan, Eid, DSF)
   - Amazon Best Sellers and Movers & Shakers (amazon.com/gp/bestsellers, amazon.com/gp/movers-and-shakers) for: Home & Kitchen, Pet Supplies, Beauty, Health, Sports, Electronics accessories, Toys
   - TikTok "TikTokMadeMeBuyIt" and Amazon finds trends
   - Seasonal calendar (what sells 6–10 weeks from today, when new stock would land)
2. **Update the scored table** from yesterday's report: keep niches that still score well, mark ↑ / ↓ / =, add new ones, drop ones under 7/13.
3. **Pick one top pick** and write the deep-dive with unit economics.
4. **Write "Changes since yesterday"** and list sources.

## Scoring rules
- Demand 1–5: Best Seller / Movers presence, "bought in past month" counts, search trend
- Competition 1–5: median reviews of top 10 (under 300 = 1–2, 300–1,000 = 3, 1,000+ = 4–5), brand dominance, price war
- Net margin: price − referral fee (US ~15%; UAE/KSA 5–15% by category) − FBA fee − landed cost (Gulf: add customs duty and import VAT) − 15% ads
- Flag any product needing SABER / SFDA (KSA) or ECAS (UAE) certificates
- Score = Demand + (6 − Competition) + margin points (≥30% = 3, 20–29% = 2, <20% = 1). Max 13. Consider only 9+.

## Better data (optional, paid)
With **Helium 10**, **Jungle Scout** or **SellerSprite**, or Amazon **Brand Analytics** (free with Brand Registry), the report can include exact search volumes and estimated monthly sales.

## PDF copy
After writing the report, create a PDF next to it for easy reading and download:

```
node scripts/md2pdf.js daily-reports/YYYY-MM-DD.md
```

This needs `pandoc` and Playwright (Chromium). The style is in `scripts/pdf-style.css`.
