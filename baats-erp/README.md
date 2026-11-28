# BAATS Enterprise ERP

**One Organization. One Platform. Complete Control.**

BAATS Enterprise ERP is a multi-tenant enterprise business operating system: one platform where every department runs as an integrated module on shared engines for organization, identity, workflow, master data, audit and rules.

This folder holds the **Phase 1 enterprise core**, **Phase 2 core business** (finance built on BAATS Accounting, UAE edition, plus inventory, procurement, sales and CRM, HR and payroll), **Phase 3 operations** (projects, manufacturing with MRP, maintenance, fleet), **Phase 4 corporate functions** (documents, legal and contracts, risk, compliance and internal audit, corrective actions, service desk, quality, health and safety, facilities), **Phase 5 intelligence** (KPI engine, executive dashboard, report builder, strategy scorecard, ESG, anomaly checks, and the AI assistant), **Phase 6a to 6c** (the interactive dashboard, country packs for the six GCC states, money in three decimals, BAATS Mobile, expense claims, API keys and webhooks), a Windows trial installer, and the foundation documents for the full programme.

## Documents

| | |
|---|---|
| [01 Architecture](docs/01-architecture.md) | Stack recommendation, engines, deployment models, scale and availability targets, security, DR, cost |
| [02 Data architecture](docs/02-data-architecture.md) | Multi-tenant model, ER diagram, schemas, forward design |
| [03 Module dependency matrix](docs/03-module-dependency-matrix.md) | 30 modules × engines, build order, end-to-end processes |
| [04 Roles and permissions](docs/04-roles-and-permissions.md) | RBAC + ABAC model, catalog, portal role templates, SoD, approval matrices |
| [05 Roadmap](docs/05-roadmap.md) | Phases 1 to 7, deliverable status, testing and deployment strategy |
| [06 Finance and BAATS Accounting](docs/06-finance-and-baats-accounting.md) | How BAATS Accounting (UAE) became the financial foundation, what is built, what is still to port |

## What works today

| Engine | Capabilities |
|---|---|
| Platform | Automated tenant onboarding (tenant, default hierarchy levels, root unit, admin role and user, default approval workflow) in one transaction |
| Tenant isolation | PostgreSQL row-level security on every table, composite tenant foreign keys, runtime role without bypass rights |
| Organization | Configurable hierarchy levels, units with cost and profit centers, moves with subtree re-pathing and cycle checks, designations, employees, reporting lines, org chart queries |
| Identity | Scrypt passwords with policy, TOTP MFA enrolment and enforcement, lockout, revocable sessions, instant revocation on disable |
| Access control | Roles scoped to org subtrees, ABAC conditions (approval limits), validity windows, segregation of duties, no self-elevation, delegation, decision explanations, scoped list filtering |
| Workflow | Versioned JSON definitions; sequential, parallel (any, all, quorum) and conditional steps; approver by user, role, reporting manager or unit head; approval limits; maker-checker; distinct approvers; delegation; escalation sweep; withdrawal; full history; completion callbacks into modules |
| Master data | Units of measure, items, customers and suppliers with duplicate detection and workflow-governed activation |
| Audit | Database-captured before/after for every governed table, security events (logins, denials, MFA), append-only, SHA-256 hash chain per tenant with verification |
| Finance (Phase 2) | Company books with the BAATS Accounting UAE chart of accounts; immutable, balanced, numbered journals; manual journals with maker-checker approval and limits; sales and purchase invoices, credit notes, reverse charge; receipts and payments with allocation, advances and realised FX; VAT 201 return and filing; corporate tax provision; PINT AE e-invoices (UBL XML, UAE pre-validation); bank statement import, matching and reconciliation; fixed assets with monthly depreciation and disposal; trial balance, P&L, balance sheet, ledgers, statements, ageing; period and year-end close |
| Inventory (Phase 2) | Warehouses, perpetual stock at moving average, opening stock, adjustments, transfers, item movement history, stock value reconciled to the 1300 Inventory account |
| Procurement (Phase 2) | Purchase orders approved through the workflow engine with amount limits, goods receipts into stock against 2010 GRNI, supplier bills drafted from the order with three-way match |
| Sales and CRM (Phase 2) | Leads, qualification, conversion to customers through master-data approval, opportunities and pipeline, activities; quotations, credit-limit-checked orders, deliveries at cost (5050 COGS), invoicing from orders |
| HR and payroll (Phase 2) | Employment contracts with WPS details, leave with manager approval and annual leave accrual, monthly payroll pro-rated for joiners, leavers and unpaid leave, posting by cost center, UAE WPS salary file, end-of-service gratuity provision and final settlement (BAATS rule) |
| Projects (Phase 3) | Projects as a ledger dimension on every invoice and journal line; teams with bill rates; timesheets approved by someone else and costed from the employment contract (monthly gross / 30 / 8) from 5000 Salaries onto 5015 Project labour; time and material billing of approved hours, fixed price billing by milestone; budget against actual cost, revenue and margin |
| Manufacturing (Phase 3) | Work centers with hourly rates, bills of materials with scrap and routing, standard cost roll-up, work orders released from the BOM, material issue and backflush through 1350 WIP, labour and overhead absorbed to 5060, products into stock at actual cost; reorder minimums and multi-level MRP with make and buy suggestions |
| Maintenance (Phase 3) | Preventive plans for fixed assets and vehicles by days or kilometres, due list and automatic work orders, corrective and breakdown orders, spare parts from stock to 5250 on the asset's cost center, plans rolled forward on completion |
| Fleet (Phase 3) | Vehicles linked to fixed assets, drivers and cost centers; fuel posted to 5610 with input VAT reclaimed in the VAT return; trips; odometer tracking, fuel economy and cost per km; registration and insurance expiry alerts |
| Documents (Phase 4) | Versioned files up to 10 MB with SHA-256 fingerprints, attached to any record; access follows the org tree, confidential documents need dms.confidential; retention date; archiving keeps every version |
| Legal and contracts (Phase 4) | Contracts by kind and party; the signed copy must be attached before approval by someone holding lgl.contract.approve; obligations with due dates; notice-by dates; auto-renewal or expiry; termination with reason |
| Risk, compliance and audit (Phase 4) | Risk register with likelihood x impact, appetite and a residual heat map; controls tested by someone other than their owner, failures raise actions (and findings in an audit); recurring compliance obligations; audit engagements from planning to opinion, findings with management responses |
| Corrective actions (Phase 4) | One action list for audit findings, control failures, NCRs and incidents; the owner marks done, someone else verifies or sends back; sources close only when their actions are verified |
| Service desk (Phase 4) | IT, facilities, HR and finance queues; P1 to P4 response and resolution targets with breach tracking; public replies and internal notes; requester confirms or reopens; faults on assets go to a maintenance work order |
| Quality (Phase 4) | Inspections on supplier receipts, work orders or stock; rejects raise NCRs; scrap and return dispositions post the write-off (Dr 5070, Cr 1300) and returns draft the supplier credit note at the billed price; supplier rejection rates |
| Health and safety (Phase 4) | Anyone can report incidents and near misses; investigation with root cause and actions; closure only with verified actions; LTIFR, TRIR, days lost and days since the last lost-time injury |
| Facilities (Phase 4) | Rooms, desks, offices and parking per site; bookings with clash, capacity and 12-hour checks; utilisation by space |
| KPIs and dashboard (Phase 5) | 36 KPIs computed live from the ledger and modules (revenue, margins, cash, DSO, DPO, current ratio, overdue, pipeline, inventory turns, headcount, payroll, SLA, risks, NCRs, LTIs, emissions...), each shown only to people who may read its source; month and year to date against prior periods; 12-month trends, top customers, overdue balances |
| Report builder (Phase 5) | Governed datasets (ledger lines, sales and supplier invoices, stock, sales orders, payslips, tickets, incidents, timesheets); columns or groups with totals, filters and sort; CSV export with formula neutralising; saved and shared reports; rows limited to the units a user's roles cover |
| Strategy scorecard (Phase 5) | Objectives by balanced scorecard perspective with KPI targets per year; amounts judged pro rata to date and projected to year end, rates as they stand; red, amber and green with a tolerance band |
| ESG (Phase 5) | Scope 1 from fleet fuel logs, LPG and refrigerant; scope 2 from grid electricity; water, waste, recycling and solar; overridable emission factors with their source; intensity per revenue and per employee |
| Anomaly checks (Phase 5) | Whole-ledger rules: duplicate supplier bills, weekend and round-amount manual journals, late postings, high customer credit notes, unmatched supplier payments, Benford's law; review outcomes recorded, and nobody can explain away their own document |
| AI assistant (Phase 5b) | Chat about one company at a time; Claude by default (`claude-opus-5-5` through the Anthropic SDK, with prompt caching and refusal fallbacks) or any OpenAI-compatible service, including a local model such as Ollama; 19 tools over the KPIs, statements, ageing, stock, report builder, anomaly checks, ESG, scorecard and service desk, each running as the user so permissions and unit scoping apply; changes (raise a ticket, record an ESG reading, save a report) wait for the user to confirm; API keys encrypted at rest (`BAATS_SECRET_KEY`) and kept out of the audit trail; monthly token allowance; every tool call audited |
| Interactive dashboard (Phase 6a) | Any period (this or last month, quarter, financial year, last 12 months, or custom dates) against the previous period or the same period last year; tiles with sparklines; click a KPI for its monthly line against the comparison, breakdowns (customer, supplier, account, cost center, vehicle, department, age) and the records behind it; personal tiles, order, period and comparison per user and company |
| Country packs (Phase 6a, 6b) | UAE, Saudi Arabia, Oman, Bahrain, Qatar and Kuwait. Oman: 5% VAT and its return, 15% income tax, Social Protection Fund. Bahrain: 10% VAT and the NBR return, SIO with the stepped leaving indemnity. Qatar and Kuwait: no VAT, GRSIA and PIFSS. Each has its own end-of-service rule, and dinars and rials are kept to three decimals. Saudi: SAR books, 15% VAT codes with ZATCA exemption reasons, the ZATCA VAT return, ZATCA e-invoices (UBL 2.1, standard and simplified, invoice counter, hash chain, QR code, chain check), GOSI by nationality from editable company rates, end-of-service per the Saudi Labor Law with the resignation reductions. Not yet: ZATCA onboarding, stamping and clearance, zakat and income tax |
| Expense claims (Phase 6c) | Employees claim what they paid themselves, one claim with up to 30 expenses and a receipt photo or PDF for each (kept in the database, at most 750 KB). VAT is worked out from the amount paid and the VAT code; reverse charge is refused. The line manager approves (HR or an administrator when there is none); approval posts the expense net of VAT, input VAT to 1200 and the amount owed to the employee to 2230 (journal ECJ); paying it from the bank clears 2230 (journal ECP). Only the employee, the approver and holders of `hr.expense.manage` see a claim and its receipts |
| BAATS Mobile (Phase 6c) | A phone web app at `/m/`, served by the BAATS server and added to the home screen (no app store): approvals with the claim and its receipts, leave balance and requests, payslips of posted payrolls, and expense claims with the camera, shrunk on the phone to about 200 KB. Self-service is limited to the signed-in user's own employee record (`/v1/ess/...`) |
| API keys (Phase 6c) | Keys for other systems (`Authorization: Bearer <key>`), each acting as one user with exactly that user's roles; shown once, stored as a hash, optional expiry, revocable, last use recorded. Keys skip the second factor, so making one needs `int.manage` and a key for another user also `iam.user.manage` |
| Webhooks (Phase 6c) | Events `invoice.posted`, `payment.recorded`, `payroll.posted`, `expense.approved`, `expense.paid`, `leave.approved`, `ticket.created`, written in the same transaction as the change (an outbox), sent as JSON with `X-BAATS-Signature: t=<unix time>,v1=<HMAC-SHA256 hex of "t.body">`, retried after 1, 2, 4 ... minutes up to 8 attempts, then marked failed and can be sent again. The signing secret is sealed with `BAATS_SECRET_KEY`. Private and local addresses are refused, also after DNS resolution, unless the server allows them |
| Data import (Phase 7a) | Customers, suppliers, items with opening stock per warehouse, employees with their contracts, open customer invoices and supplier bills (with FX), and the opening trial balance, from CSV files as Excel saves them (comma, semicolon or tab; dates as 2026-12-31 or 31/12/2026; thousands commas). Each file is checked first, row by row, and saved all at once or not at all. Existing codes are skipped, so a file can be imported again. The trial balance must balance; receivables, payables and inventory are checked against the open items and stock already imported instead of being posted twice; the rest goes to one opening journal (OB-) and opening balance equity (3200) ends at zero. A BAATS Accounting book (Import / Export, All) is turned into the customer, supplier and item files. Every import is recorded with the file's SHA-256 and who ran it; importing needs `mig.import` |
| Backup and restore (Phase 7a) | A backup of the whole database while it runs, in one consistent snapshot, without pg_dump: a gzip file of the rows exactly as PostgreSQL holds them, with the schema version. A restore builds a new database from the backup's own schema version, loads the rows with triggers off (so the audit hash chain and every total come back exactly), brings it up to the installed version, and only then swaps it in; the replaced database is kept. A backup from a newer BAATS is refused. In the Windows trial: one backup a day (14 kept), backups by hand, download, and restore of a kept or uploaded backup, all needing `sys.backup` |
| Sign-in protection (Phase 7a) | Failed sign-ins limited per address (30 in 5 minutes) and per account (10), on top of the lockout after 5 wrong passwords; successful sign-ins are not counted. Each session or API key is limited to 1,200 requests a minute (`429` with `Retry-After`). Sign-ins say when an authenticator code is needed, only once the password is right. Security headers on every answer and `no-store` on the API. Users see where they are signed in (address and device) and can end those sessions, change their password (ending the other sessions) and set up an authenticator app; administrators can set a password, which unlocks the account and ends its sessions |
| Bank files (Phase 6d) | Bank statements as MT940 or CAMT.053 (opening and closing balances, the account found by its IBAN or number, currency checked) as well as CSV, into the same reconciliation and auto-matching. Bank details per ledger bank account (bank, IBAN checked by mod 97, BIC, currency). Supplier payments put into ISO 20022 credit transfer files (pain.001.001.03) to upload to online banking: each supplier's IBAN is checked first, a payment goes into one live file only, the file is kept exactly as made with its SHA-256, and it can be marked sent or cancelled (which frees its payments); needs `fin.payment.file` |
| Sign-in with Microsoft 365 and Google (Phase 6d) | OpenID Connect sign-in with Microsoft Entra ID, Google Workspace or any OpenID provider: code flow with PKCE, state and nonce, the ID token's RS256 signature checked against the provider's keys, issuer, audience and expiry. Only existing active BAATS users can sign in, only from the allowed email domains, and Google and other providers must say the email is verified. Someone with the BAATS authenticator app on must have used multi-factor sign-in at the provider. The session is the same as a password session and records the provider; the client secret is kept encrypted; managing providers needs `iam.sso.manage` |
| Email (Phase 6d) | Through your own mail server (SMTP with STARTTLS or TLS, AUTH PLAIN or LOGIN) or Microsoft 365 (Graph sendMail with an app registration). Sales invoices and credit notes sent as a PDF, with the e-invoice XML when there is one and the card payment link when one is open; approvers told by email when a step waits for them. Every email goes through an outbox, tried again after 1, 4, 16 and 64 minutes, visible with its last error and can be sent again. Needs `int.mail.manage` to set up and `int.mail.send` to send invoices |
| Card payment links (Phase 6d) | A Stripe Checkout link for the open amount of a posted sales invoice (amounts in fils and baisa where the currency has three decimals), put in the invoice email. When the customer pays, the receipt is recorded and allocated to the invoice in a card clearing account (1040), at the invoice's exchange rate. Payment is confirmed by asking Stripe about open links every two minutes, or at once by Stripe's signed notice (`/v1/pay/stripe/notice`, checked with the webhook secret, five minutes' tolerance) where the server is reachable from the internet. Needs `fin.payment.link` and `fin.payment.post` |
| Invoice PDF (Phase 6d) | Posted invoices and credit notes as a PDF made by BAATS itself (no external tool): seller and customer with their tax numbers, lines, VAT by rate, totals, open amount and the payment link |
| Excel import (Phase 6d) | Data import reads Excel workbooks (.xlsx) directly, any visible sheet, with dates and formulas' values, through exactly the same checks as CSV |
| API | REST `/v1` with schema validation for all of the above |

## Run it

Requirements: Node.js 22.18 or later (runs TypeScript directly) and PostgreSQL 16.

```bash
npm ci

# Tests: start a throwaway PostgreSQL (or point TEST_ADMIN_DATABASE_URL at any superuser connection)
eval "$(scripts/test-db.sh)"
npm run typecheck
npm test

# Local server
docker compose up -d db
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/baats APP_DB_PASSWORD=dev-app-password npm run migrate
DATABASE_URL=postgres://baats_app:dev-app-password@localhost:5432/baats PLATFORM_ADMIN_KEY=change-me npm start
```

First tenant:

```bash
curl -X POST localhost:3000/v1/platform/tenants -H 'x-platform-admin-key: change-me' -H 'content-type: application/json' -d '{
  "code":"acme","name":"Acme Group","baseCurrency":"AED","countryCode":"AE",
  "admin":{"email":"admin@acme.example","displayName":"Admin","password":"Choose-A-Strong-Passw0rd"}}'
curl -X POST localhost:3000/v1/auth/login -H 'content-type: application/json' \
  -d '{"tenant":"acme","email":"admin@acme.example","password":"Choose-A-Strong-Passw0rd"}'
# then: -H "authorization: Bearer <token>" on every other call
```

## Code layout

```
db/migrations/    SQL schema: tenants, org, iam, audit, mdm, wf, RLS policies, triggers, reference data
src/core/         database access (tenant-bound transactions), errors, rules engine, migrations
src/platform/     tenant onboarding; backup and restore (backup.ts)
src/mig/          data import from CSV, Excel workbooks (xlsx.ts) and BAATS Accounting books
src/org/          organization engine
src/iam/          authentication, authorization, roles, SoD, delegation, single sign-on (sso.ts)
src/workflow/     workflow and approval engine
src/mdm/          master data
src/audit/        audit queries and hash-chain verification
src/fin/          accounting engine: chart of accounts, ledger, documents, tax, reports; bank and payment files, invoice PDF, card payment links
src/inv/          inventory
src/pur/          procurement
src/crm/          leads, opportunities, activities
src/sal/          quotations, orders, deliveries, invoicing from orders
src/hr/           contracts, leave, payroll, WPS, gratuity, expense claims
src/ess/          employee self-service for BAATS Mobile
src/int/          webhooks: event outbox, signing and delivery; email (mail.ts)
src/mobile/       BAATS Mobile (phone web app, served at /m/)
installer/windows Windows trial installer (NSIS), launcher and trial console
scripts/          load test (loadtest.ts)
src/api/          HTTP API
test/             unit, integration (real PostgreSQL) and API tests
```

## Environment

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | server | Connection as `baats_app` (never the owner) |
| `PLATFORM_ADMIN_KEY` | server | Required header for tenant onboarding |
| `BAATS_SECRET_KEY` | server | 32 bytes (base64 or hex) that encrypt AI provider API keys, webhook signing secrets, mail passwords, sign-in client secrets and Stripe keys at rest; without it, none of them can be saved |
| `AI_ALLOW_PRIVATE_URLS` | server | `true` lets tenants point the assistant at http:// or private addresses (on-premises local models); leave unset for hosted, multi-tenant servers |
| `PORT`, `HOST` | server | Listen address (default `0.0.0.0:3000`) |
| `ESCALATION_SWEEP_SECONDS` | server | Escalation sweep interval (default 300) |
| `WEBHOOK_DISPATCH_SECONDS` | server | How often due webhook deliveries are sent (default 30) |
| `WEBHOOK_ALLOW_PRIVATE_URLS` | server | `true` allows webhook receivers on http:// or private addresses (on-premises); leave unset for hosted servers |
| `API_REQUESTS_PER_MINUTE` | server | Requests a minute for one session or API key (default 1200) |
| `LOGINS_PER_5_MINUTES` | server | Failed sign-ins in 5 minutes from one address (default 30) |
| `TRUST_PROXY` | server | Behind a reverse proxy: `true`, or the proxy's addresses, so limits and sessions see the client's address from `X-Forwarded-For` |
| `PUBLIC_URL` | server | The address people reach this server at (`https://erp.example.com`); used for sign-in return addresses, card payment return pages and the redirect address shown to administrators. Without it, the address of each request is used |
| `SSO_ALLOW_HTTP` | server | `true` allows an OpenID provider on http:// (on-premises identity servers, tests) |
| `MIGRATION_DATABASE_URL` | migrate | Owner connection |
| `APP_DB_PASSWORD` | migrate | Enables login for `baats_app` with this password |
| `TEST_ADMIN_DATABASE_URL` | tests | Superuser connection used to create per-file test databases |

## Backups

On a server, back up PostgreSQL with your platform's tools (managed database snapshots, or `pg_dump` and WAL archiving for point-in-time recovery) and rehearse a restore. `src/platform/backup.ts` makes and restores backups without them, from Node, as the database owner:

```
node -e "import('./src/platform/backup.ts').then(b => b.backupDatabase(process.env.MIGRATION_DATABASE_URL, 'baats.baatsbak', '0.12.0')).then(console.log)"
```

`restoreDatabase` needs the owner connection to another database of the cluster (to create, rename and drop databases) and stops all connections to the database it replaces for the moment of the swap. A backup file holds every tenant's data in the clear: store it encrypted.

## Load test

`scripts/loadtest.ts` signs in a number of workers, each sending one request after another for a fixed time over the busiest reads (dashboard, trial balance, invoice, stock, party and item lists, approvals inbox) and, with `--writes`, creating and posting sales invoices, then prints requests a second and the 50th, 95th and 99th percentile times:

```
node scripts/loadtest.ts --url http://127.0.0.1:3000 --tenant demo --email admin@demo.test --password '...' --workers 25 --seconds 30 --writes
```

Measured on the Windows trial's own setup (one Node process, PostgreSQL 16 on the same machine, 4 CPU cores, the demo company of about 1,200 records), 30 seconds, no errors, and the books balanced and the audit chain intact afterwards:

| Workers | Requests a second | 50% | 95% | 99% | Dashboard 50% |
|---|---|---|---|---|---|
| 1 (reads) | 23 | 5 ms | 183 ms | 201 ms | 151 ms |
| 10 (reads) | 107 | 13 ms | 466 ms | 512 ms | 403 ms |
| 25 (reads, 17 invoices posted a second) | 94 | 83 ms | 1,119 ms | 2,105 ms | 965 ms |

Everything but the executive dashboard answers in well under 100 ms at 10 simultaneous users. The dashboard computes 36 KPIs live, four periods each, and is the slowest page by far; under load it is what people will notice first. This is a small dataset on one machine: it is not yet a test at the scale of a large company (millions of journal lines), which needs a generated dataset and is still open in Phase 7.

