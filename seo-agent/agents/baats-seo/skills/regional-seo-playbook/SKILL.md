---
name: regional-seo-playbook
description: The 15 BAATS Accounting regions with their URLs, languages, tax vocabulary, seed keywords and competitors, plus the per-region checklist and report format. Read at the start of every SEO run.
---

# BAATS Accounting regional SEO playbook

## About the site (as of 2026-11-24)

- Product: BAATS Accounting by Baats LLC. Double-entry accounting with local tax built in. Web edition and Windows edition. 15-day free trial. Plans from Starter to Enterprise, priced in local currency.
- Structure: `https://baatsaccounting.com/<region>/` with `features.html`, `pricing.html`, `subscribe.html`, `download.html`, `contact.html`, `privacy.html`, `terms.html`, `refunds.html`, `cookies.html`. The five Gulf regions also have an Arabic copy under `/<region>/ar/`. Each region's app is on its own subdomain, e.g. `uae.baatsaccounting.com`, `pk.baatsaccounting.com`.
- Homepage `https://baatsaccounting.com/` is a country chooser and the hreflang x-default.
- Contact shown everywhere: WhatsApp +1 802 965 0326, support@baatsaccounting.com. No local phone or address per region.
- The regional pages share one template (same H2s and sample invoice). Unique local substance is the main lever for ranking each region.

## The 15 regions

Facts in this table are starting points. Verify every rate and rule against the official authority before it goes into a draft.

| Region | URL | Languages to target | Currency | Tax vocabulary people search for | Authority | Competitors to check first |
|---|---|---|---|---|---|---|
| UAE | /uae/, /uae/ar/ | English, Arabic | AED | VAT 5%, VAT return, FTA, EmaraTax, corporate tax 9%, TRN, e-invoicing (PINT AE) | Federal Tax Authority (tax.gov.ae) | Zoho Books, QuickBooks, Xero, Wafeq, Tally, Odoo |
| Saudi Arabia | /saudi/, /saudi/ar/ | Arabic first, English | SAR | VAT 15%, ZATCA, FATOORA e-invoicing phase 2, zakat | ZATCA (zatca.gov.sa) | Qoyod, Wafeq, Daftra, Zoho Books, Odoo |
| Bahrain | /bahrain/, /bahrain/ar/ | English, Arabic | BHD | VAT 10%, NBR VAT return | National Bureau for Revenue (nbr.gov.bh) | Zoho Books, QuickBooks, Xero |
| Oman | /oman/, /oman/ar/ | English, Arabic | OMR | VAT 5%, Oman Tax Authority, VAT return | Tax Authority (taxoman.gov.om) | Zoho Books, Tally, QuickBooks |
| Qatar | /qatar/, /qatar/ar/ | English, Arabic | QAR | Corporate income tax, Dhareeba, e-invoicing plans; confirm VAT status before mentioning VAT | General Tax Authority (gta.gov.qa) | Zoho Books, QuickBooks, Odoo |
| Pakistan | /pakistan/ | English, Urdu | PKR | Sales tax 18%, FBR, IRIS, NTN, STRN, PRA / SRB / KPRA / BRA provincial sales tax on services | FBR (fbr.gov.pk) | Tally, QuickBooks, Zoho Books, local ERP vendors |
| India | /india/ | English, Hindi | INR | GST, GSTR-1, GSTR-3B, e-invoice IRN, e-way bill, TDS | GSTN / CBIC (gst.gov.in, cbic.gov.in) | Tally Prime, Zoho Books, Vyapar, Busy, Marg |
| Bangladesh | /bangladesh/ | English, Bangla | BDT | VAT 15%, Mushak forms, NBR, BIN | NBR (nbr.gov.bd) | Tally, local accounting software vendors |
| USA | /usa/ | English, Spanish | USD | Sales tax (by state), 1099, small business accounting, bookkeeping | IRS and state revenue departments | QuickBooks, Xero, FreshBooks, Wave, Zoho Books |
| Canada | /canada/ | English, French | CAD | GST/HST, PST, QST, CRA | CRA (canada.ca) | QuickBooks, Xero, Sage, Wave |
| Australia | /australia/ | English | AUD | GST 10%, BAS, ATO, Single Touch Payroll | ATO (ato.gov.au) | Xero, MYOB, QuickBooks |
| New Zealand | /newzealand/ | English | NZD | GST 15%, IRD, GST return | Inland Revenue (ird.govt.nz) | Xero, MYOB, QuickBooks |
| UK | /uk/ | English | GBP | VAT 20%, Making Tax Digital, HMRC, bridging software | HMRC (gov.uk) | Xero, QuickBooks, Sage, FreeAgent |
| Europe (EU) | /europe/ | English, then German, French, Spanish, Italian, Dutch | EUR | VAT, OSS, reverse charge, e-invoicing (EN 16931), ViDA | National tax authorities, European Commission | Xero, QuickBooks, Sage, sevDesk, lexoffice, Holded |
| Türkiye | /turkey/ | Turkish, English | TRY | KDV, e-Fatura, e-Arşiv, GİB | Revenue Administration (gib.gov.tr) | Paraşüt, Logo, Mikro, Luca |

## Seed keyword patterns

Expand these per region with the local terms above and the local language. Check what actually appears in search; drop keywords no one in that country uses.

- `accounting software <country>` / `best accounting software in <country>`
- `<tax> software <country>` (VAT, GST, sales tax, KDV)
- `<tax> return software`, `how to file <tax> return in <country>`
- `invoice software <country>`, `<e-invoicing scheme> compliant software`
- `free accounting software <country>`, `online accounting software for small business <country>`
- `<competitor> alternative`, `<competitor> vs`
- Local-language equivalents, e.g. Arabic `برنامج محاسبة`, `برنامج ضريبة القيمة المضافة`; Turkish `muhasebe programı`, `e-fatura programı`; Urdu, Hindi and Bangla where search volume exists.

## Per-region checklist

For each region, check and report:

1. Title (under 60 characters, primary keyword plus country), meta description (under 160), one H1, canonical to itself.
2. `html lang` and hreflang: each page lists every language/region alternate and itself, the Arabic copies use `ar-XX`, and alternates are reciprocal.
3. JSON-LD: Organization (once, sitewide), SoftwareApplication with offers in local currency, FAQPage for the visible FAQ, BreadcrumbList.
4. Local substance: local tax rates and forms with official links, local deadlines, local currency examples, local payment gateways, local language copy. Flag passages that are identical to another region.
5. Consistency: prices, plan names and hosting claims match between the language versions and between index and pricing pages.
6. Local trust signals: local contact number or WhatsApp, address or registered entity, local testimonials or case studies, tax authority accreditation where it exists.
7. Internal links: the region switcher lists all 15 regions on every page, and each region links to its own features, pricing and guides.
8. Search position for the tracked keywords and the top 3 competitors for each.

## Region report format (for each region's worker)

```
## <Region>
Tracked keywords: <keyword> (language) – observed position or "not in top 20" – top result
Top competitors: <name> (<url>) – what they do better
On-page issues: <URL> – <issue> – <fix>
Content gaps: <topic people search for that the site doesn't answer>
Unverified facts: <anything you could not confirm>
```
