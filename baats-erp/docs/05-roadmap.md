# 05. Development roadmap, testing and deployment

## 1. Honest scope statement

The full vision (30 modules, 12 engines, 10 jurisdictions, web and mobile, SaaS operations) is comparable to products that took vendors many years and hundreds of engineers. The plan below delivers it in usable increments: every phase ends with working, tested, integrated software that a real organization can run, rather than many partly built modules.

Indicative effort with a core team of 25 to 40 engineers plus domain specialists: Phase 1 about 4 to 6 months, Phases 2 to 3 about 12 to 18 months, Phases 4 to 7 a further 18 to 24 months, overlapping where dependencies allow.

## 2. Pre-development deliverables

| Deliverable | Status | Where |
|---|---|---|
| Enterprise system architecture | Draft done | [01-architecture.md](01-architecture.md) |
| Technology stack evaluation | Recommendation done, awaiting sign-off | [01-architecture.md §2](01-architecture.md) |
| Database architecture and ER diagrams | Phase 1 done, Phase 2 to 3 outlined | [02-data-architecture.md](02-data-architecture.md) |
| Module dependency matrix | Done | [03-module-dependency-matrix.md](03-module-dependency-matrix.md) |
| Roles and permissions matrix | Done for Phase 1, templates for all portals | [04-roles-and-permissions.md](04-roles-and-permissions.md) |
| Cybersecurity architecture | Summary done | [01-architecture.md §6](01-architecture.md) |
| Infrastructure and cost estimates | Indicative done | [01-architecture.md §11](01-architecture.md) |
| API and integration architecture | Principles done; OpenAPI per module as built | [01-architecture.md §8](01-architecture.md) |
| Business process flows | End-to-end flows listed | [03-module-dependency-matrix.md §3](03-module-dependency-matrix.md) |
| Business Requirements Document | To do with stakeholders, module by module, before each phase | |
| Software Requirements Specification | To do per phase, with acceptance criteria | |
| UI/UX designs | To do (design system first, then portals) | |
| Testing and deployment strategy | Done | Section 4 below |
| Technical and user documentation | Started (this folder, code comments); grows with each module | |

## 3. Phases

### Phase 1: Enterprise core (this pull request starts it)

**Built and tested now:** multi-tenant platform with database-enforced isolation and automated onboarding; configurable org hierarchy (levels, units, cost and profit centers, designations, employees, reporting lines, org chart); identity (passwords, TOTP MFA, lockout, sessions, revocation); RBAC scoped to org subtrees with ABAC conditions, SoD and delegation; tamper-evident audit trail; master data (UoM, items, customers and suppliers with governed activation and duplicate detection); no-code workflow engine (sequential, parallel, conditional, quorum, limits, maker-checker, delegation, escalation, versioning, history); REST API; CI.

**Phase 1b, to finish the core:** SSO (OIDC, SAML) and Active Directory, SCIM provisioning; notification engine (email, SMS, WhatsApp, push) with templates; document engine (object storage, versions, retention); transactional outbox and event bus; custom-field metadata registry; record- and field-level permissions; i18n framework; admin web console (org chart, roles, workflow designer); OpenAPI docs; rate limiting; tenant export and restore.

**Acceptance:** two tenants cannot read or write each other's data under any API or SQL path; every change is in a verifiable audit chain; an approval matrix can be changed by an administrator without a release; 50k-employee synthetic tenant meets latency targets for org and permission queries.

### Phase 2: Core business

**Started: finance.** The accounting engine, UAE tax, receivables, payables, cash and financial statements are built and tested on top of BAATS Accounting's UAE rules; see [06-finance-and-baats-accounting.md](06-finance-and-baats-accounting.md) for what is built and what is still to port. Next in this phase: e-invoicing, bank reconciliation, then HR and payroll, procurement, inventory, sales and CRM.

Accounting engine and finance (GL, AP, AR, cash and bank, fixed assets lite, period close, consolidation, IFRS reports); taxation (VAT, GST, corporate tax, withholding; UAE and KSA first, e-invoicing with FTA and ZATCA); HR (positions, contracts, leave, attendance with biometric import); payroll (UAE WPS and KSA GOSI first); procurement; inventory; sales and CRM. Integrate BAATS Accounting rules once its source or specification is supplied.

**Acceptance:** procure-to-pay, order-to-cash, hire-to-retire and record-to-report run end to end with automatic postings and no re-keying; trial balance always balances; tax returns reconcile to the ledger.

### Phase 3: Operations

Manufacturing (BOM, routing, MRP, work orders, costing), projects, supply chain and logistics, assets and maintenance, fleet.

### Phase 4: Corporate functions

Legal and contracts, GRC, audit management, administration and facilities, IT service management, quality, HSE, document management UI, learning, customer service, collaboration, board and corporate secretariat.

### Phase 5: Intelligence

Data warehouse and BI, dashboard and report builders, executive and board dashboards, strategy and performance, R&D, ESG, the BAATS AI assistant (permission-aware queries, document processing, forecasting, anomaly and fraud detection, automated reconciliation, predictive maintenance, decision support).

### Phase 6: Reach

Android and iOS apps; localization packs for Saudi Arabia, United States, United Kingdom, Canada, Pakistan, India, Australia, New Zealand and EU (tax, payroll, statutory reports, e-invoicing where available); integration marketplace (banks, payment gateways, Microsoft 365, Google Workspace, e-commerce, e-signature, GPS, RFID); industry extensions.

### Phase 7: Production readiness

Independent penetration test; load and soak tests at target scale; failover and DR drills; data migration tooling and rehearsals; UAT with pilot customers; SaaS billing and subscription management at full scale; ISO 27001 and SOC 2 readiness.

## 4. Testing and deployment strategy

| Layer | Practice |
|---|---|
| Unit | Pure logic (rules, crypto, validators) with Node's test runner |
| Integration | Every service test runs against a real PostgreSQL, connected as the runtime role so RLS and privileges are exercised exactly as in production; each test file gets a fresh database |
| API | End-to-end HTTP tests through the real server (Fastify inject) |
| Security | Tests for tenant isolation, privilege escalation, SoD, maker-checker and audit tampering; SAST and dependency scanning in CI; DAST and penetration tests before release |
| Performance | k6 scenarios per end-to-end process, run nightly against a scaled dataset; regression thresholds fail the build |
| UAT | Scripted scenarios per process, signed off by the business owner |
| CI/CD | GitHub Actions: typecheck and full test suite on every push; container build; deploy to staging via GitOps; production by approved promotion |
| Migrations | Forward-only, expand-and-contract so old and new versions run side by side; zero-downtime rollouts |
| Releases | Feature flags per tenant; tenants can be pinned to a release ring (early, standard, conservative) |
