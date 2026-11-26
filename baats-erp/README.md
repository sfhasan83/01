# BAATS Enterprise ERP

**One Organization. One Platform. Complete Control.**

BAATS Enterprise ERP is a multi-tenant enterprise business operating system: one platform where every department runs as an integrated module on shared engines for organization, identity, workflow, master data, audit and rules.

This folder holds the **Phase 1 enterprise core**, **Phase 2 core business** (finance built on BAATS Accounting, UAE edition, plus inventory, procurement, sales and CRM, HR and payroll), a Windows trial installer, and the foundation documents for the full programme.

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
| `PORT`, `HOST` | server | Listen address (default `0.0.0.0:3000`) |
| `ESCALATION_SWEEP_SECONDS` | server | Escalation sweep interval (default 300) |
| `MIGRATION_DATABASE_URL` | migrate | Owner connection |
| `APP_DB_PASSWORD` | migrate | Enables login for `baats_app` with this password |
| `TEST_ADMIN_DATABASE_URL` | tests | Superuser connection used to create per-file test databases |
