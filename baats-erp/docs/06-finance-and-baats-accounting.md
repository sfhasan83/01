# 06. Finance engine and BAATS Accounting

Phase 2 starts with the accounting engine, built on **BAATS Accounting v10.86, UAE edition** (the generic `web` build, whose defaults are UAE: AED, 5% VAT, FTA, PINT AE). The other country editions share the same core.

## 1. What BAATS Accounting is today

* A Node.js 22 server (`server.js`, about 700 KB) with SQLite or PostgreSQL, serving a single-page app (`public/index.html`, about 1.8 MB).
* Each set of books is stored as JSON documents (invoices, bills, payments, journals, customers ...) in one table, `bk_rec`.
* **The general ledger is not stored.** The browser derives it on every view (`GL()`, `sysJE()`) by replaying the documents through posting rules.
* Rich UAE functionality: VAT with return periods and FTA reconciliation, corporate tax, PDC cheques, customer and supplier advances with VAT, IFRS 16 leases, fixed assets, prepayments and accruals, end-of-service gratuity, payroll and WPS, inventory, bank statement import, budgets, locations, e-invoicing (PINT AE through an accredited provider), excise tax, approvals, roles, and an MCP server for AI assistants.

## 2. What carries over, and what changes

| BAATS Accounting | BAATS Enterprise ERP |
|---|---|
| Chart of accounts from `defAcc()` + `ensureAcc()` (1000 Cash … 5950 Corporate Tax Expense) | **Same codes, names and structure**, seeded per company from `src/fin/coa.ts`, with a `system_role` on each account the engine needs |
| Customers and suppliers in subledgers under 1100 / 2000, no per-party GL accounts | Same: 1100 / 2000 are **control accounts**; the database rejects a line on them without a party |
| Posting rules in `GL()`: invoice Dr 1100 / Cr 4000 / Cr 2100; bill Dr expense / Dr 1200 / Cr 2000; receipts, payments, credit notes, write-offs | Same rules in `src/fin/documents.ts`, written as **persisted, numbered, immutable journals** |
| VAT on the balance sheet: 1200 input, 2100 output, 2110 FTA settlement; VAT return clears them | Same accounts and clearing entry (`fileVatReturn`), plus a VAT 201 box breakdown by tax code |
| Tax categories S, Z, E, O, AE (reverse charge) from the PINT AE mapping | Tax codes SR, ZR, EX, OS, RC with the same e-invoice categories |
| Corporate tax 9% above AED 375,000, rate and threshold configurable | Same (`provideCorporateTax`), posting only the change since the last provision |
| Exchange gain/loss account 4450 | Same, used for **realised** differences on settlement |
| Ledger recomputed in the browser; documents editable | Ledger stored and validated by PostgreSQL: balanced, open period, postable account, party on control lines; posted entries cannot change, only be reversed or credited |
| One "book" per login, with its own roles | Many companies per tenant, each a legal-entity org unit; roles scoped by org unit with approval limits (Phase 1 engine) |
| Approvals on some actions | Manual journals always go through maker-checker approval with amount limits; invoice and payment posting limits through ABAC conditions |
| Activity log | Hash-chained audit trail of every change |

## 3. Built in this phase

| Area | Capability |
|---|---|
| Books | Company setup from a legal-entity unit: UAE chart, tax codes, 12 open periods, journal approval workflow |
| Ledger | Posting API for every module; multi-currency with base-currency conversion and cent-exact balancing; gap-free numbering per type and year; reversal |
| Manual journals | Maker-checker through the workflow engine, approval limit by amount, control and VAT accounts blocked |
| Sales and purchases | Invoices and credit notes with lines, tax codes, cost centers, item-driven accounts, supplier-number duplicate check, reverse charge |
| Cash | Receipts and payments with allocation, advances, later allocation, realised FX |
| Tax | VAT 201 computation and filing, corporate tax provision |
| Reports | Trial balance, P&L (BAATS layout: revenue, direct costs, gross profit, expenses), balance sheet with current earnings, account ledger, partner statement, AR/AP ageing |
| Close | Month open/close, year-end close to retained earnings |
| API | `/v1/fin/...`, see `src/api/finance.ts` |

## 4. Still to port from BAATS Accounting

In priority order. Each one reuses the posting API, so it is mostly business rules.

1. **E-invoicing (PINT AE)**: port `einvoice.js`, `pintae.js` and the ASP adapters onto posted sales documents.
2. **PDC cheques** (1050 / 2050 clearing on cheque date, bounce handling) and **advances with VAT** (1150 / 2160).
3. **VAT timing**: output VAT declared in a later return (2105) and late bills (1210).
4. **Bank statement import and reconciliation** (`bankparse.js`).
5. **Fixed assets and IFRS 16 leases** (1500/1590/5800, 1600/1690/2600/5810/5820).
6. **Prepayments, accruals with auto-reversal, deferred revenue** (1250, 2200, 2300) and revenue recognised over time.
7. ~~Payroll, WPS and end-of-service gratuity~~: done in `src/hr` (2210, 2500/5920, 1260). Gratuity uses BAATS `eosb()` exactly; the ERP trues up the provision monthly with payroll instead of every 31 December.
8. ~~Inventory~~: done in `src/inv`, with procurement (`src/pur`, new account 2010 GRNI added to older books on first use, like `ensureAcc()`) and sales (`src/sal`, 5050 COGS).
9. Budgets, locations as dimensions, excise tax, payment gateways, customer portal.
10. **Data migration**: an importer that reads a BAATS book (`bk_rec` JSON documents) and replays it through the posting API, so existing customers move with full history.

## 5. Notes on the source received

The upload holds 32 builds (16 countries or variants × web and Windows). Only the generic `web` build was read; it was not run. The source is not copied into this repository: the ERP re-implements the rules, so BAATS Accounting can keep its own release cycle until customers migrate.
