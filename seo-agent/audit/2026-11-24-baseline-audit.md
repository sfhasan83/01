# Baseline SEO audit: baatsaccounting.com

Date: 2026-11-24. Pages read: homepage, robots.txt, sitemap.xml, /uae/, /uae/ar/, /pakistan/. The other 12 regions follow the same template; the agent's first run will audit them all.

**Limit of this audit:** the pages were read as extracted text, so the raw `<head>` was not visible. JSON-LD, `html lang` and on-page hreflang could not be confirmed and are marked "verify" below. Search rankings were not measured yet; the agent's first run sets that baseline.

## Summary

The site has a good foundation: one folder per country, Arabic versions for the Gulf, a clean robots.txt that welcomes search engines and AI crawlers, and a sitemap with hreflang. What holds it back is that the 15 regional pages are close copies of one template, some pages contradict each other, and there are almost no local trust signals. Fixing contradictions and adding real local substance per region will do more for ranking than anything else.

## Priority fixes

| # | Fix | Where | Why it matters | Effort |
|---|---|---|---|---|
| 1 | Make UAE prices identical in English and Arabic (EN shows 4 plans, AR shows 6, with different prices) | /uae/, /uae/ar/, both pricing.html | Contradictory prices hurt trust and conversions; Google may pick the wrong one for rich results | Small |
| 2 | Give one answer on where the web edition runs (EN: customer's own server with Node.js; AR and Pakistan: hosted by Baats) | /uae/ FAQ and web edition section | Same reason; also a data-protection question buyers ask | Small |
| 3 | Show the full 15-country switcher on every page (UAE EN lists 10) | /uae/ and any page with the short list | Internal links spread ranking strength to every region | Small |
| 4 | Add JSON-LD: Organization sitewide, SoftwareApplication with local-currency offers per region, FAQPage for each FAQ (verify none exists first) | All region index pages | Eligible for rich results; helps Google understand each region page | Small, see `fixes/` |
| 5 | Shorten the homepage title (about 80 characters) and description (about 330) | Homepage | Both are truncated in search results today | Small, see `fixes/` |
| 6 | Add local trust signals per region: a local phone or WhatsApp where possible, registered address or entity, local customer quotes | All regions | Every region now shows one US number, which reads as "not local" to buyers and to Google | Medium |
| 7 | Make each region page unique: local tax walkthroughs, forms, deadlines, payment gateways, local examples in place of the shared sample invoice | All regions, starting with UAE, Saudi, Pakistan, India | Near-duplicate pages compete with each other and rank weaker | Large, the agent writes briefs |
| 8 | Add Arabic-first content for Saudi Arabia, and local-language pages where search exists (Turkish for Türkiye; Urdu, Hindi, Bangla later) | /saudi/ar/, /turkey/ | Most searches in those markets are in the local language | Large |
| 9 | Publish helpful guides that match what people search: "how to file a VAT return in UAE", "ZATCA e-invoicing phase 2 requirements", "GSTR-3B filing steps", "Making Tax Digital software" | New /<region>/guides/ pages | This is how accounting software sites win top positions | Ongoing, the agent writes briefs |
| 10 | Set real `lastmod` dates in the sitemap (all 2026-11-20 today) and list the homepage, /turkey/ and the features/pricing pages as their own entries | sitemap.xml | Helps crawling and indexing of all pages | Small |
| 11 | Add Terms, Refunds and Cookies links to the UAE English footer (present on AR and Pakistan) | /uae/ footer | Trust signal and consistency | Small |
| 12 | Point the x-default hreflang to the homepage only if it stays a country chooser; make sure every regional page lists its own alternate | Sitemap and heads | Correct hreflang avoids the wrong country page ranking | Small, verify |

## Things to set up outside the site

- **Google Search Console and Bing Webmaster Tools**, with the sitemap submitted. This gives real rankings and clicks per country; the agent can only approximate rankings with web search until this is connected.
- **Google Business Profile** for any location where Baats has a real office.
- Listings on software directories that rank for these searches (G2, Capterra, GetApp) and on local business directories, with consistent name and contact details.

## What was good

- robots.txt allows Google, Bing and the main AI crawlers, and points to the sitemap.
- Canonical tags are self-referencing on the pages checked.
- Each region page is substantial (about 1,500 words) with clear trial and pricing calls to action.
- Local tax features are real and specific (UAE corporate tax threshold, Pakistan provincial sales tax, local payment gateways).
