# BAATS Enterprise ERP

**One Organization. One Platform. Complete Control.**

BAATS Enterprise ERP is a multi-tenant enterprise business operating system: one platform where every department runs as an integrated module on shared engines for organization, identity, workflow, master data, audit and rules.

This folder holds the **Phase 1 enterprise core**, **Phase 2 core business** (finance built on BAATS Accounting, UAE edition, plus inventory, procurement, sales and CRM, HR and payroll), **Phase 3 operations** (projects, manufacturing with MRP, maintenance, fleet), **Phase 4 corporate functions** (documents, legal and contracts, risk, compliance and internal audit, corrective actions, service desk, quality, health and safety, facilities), **Phase 5 intelligence** (KPI engine, executive dashboard, report builder, strategy scorecard, ESG, anomaly checks, and the AI assistant), **Phase 6a and 6b** (the interactive dashboard, country packs for the six GCC states, and money in three decimals), a Windows trial installer, and the foundation documents for the full programme.

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
src/platform/     tenant onboarding
src/org/          organization engine
src/iam/          authentication, authorization, roles, SoD, delegation
src/workflow/     workflow and approval engine
src/mdm/          master data
src/audit/        audit queries and hash-chain verification
src/fin/          accounting engine: chart of accounts, ledger, documents, tax, reports
src/inv/          inventory
src/pur/          procurement
src/crm/          leads, opportunities, activities
src/sal/          quotations, orders, deliveries, invoicing from orders
src/hr/           contracts, leave, payroll, WPS, gratuity
installer/windows Windows trial installer (NSIS), launcher and trial console
src/api/          HTTP API
test/             unit, integration (real PostgreSQL) and API tests
```

## Environment

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | server | Connection as `baats_app` (never the owner) |
| `PLATFORM_ADMIN_KEY` | server | Required header for tenant onboarding |
| `BAATS_SECRET_KEY` | server | 32 bytes (base64 or hex) that encrypt AI provider API keys at rest; without it, keys cannot be saved |
| `AI_ALLOW_PRIVATE_URLS` | server | `true` lets tenants point the assistant at http:// or private addresses (on-premises local models); leave unset for hosted, multi-tenant servers |
| `PORT`, `HOST` | server | Listen address (default `0.0.0.0:3000`) |
| `ESCALATION_SWEEP_SECONDS` | server | Escalation sweep interval (default 300) |
| `MIGRATION_DATABASE_URL` | migrate | Owner connection |
| `APP_DB_PASSWORD` | migrate | Enables login for `baats_app` with this password |
| `TEST_ADMIN_DATABASE_URL` | tests | Superuser connection used to create per-file test databases |
