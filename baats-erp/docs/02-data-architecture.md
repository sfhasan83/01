# 02. Data architecture and ER model

## 1. Principles

* **One database, one schema per engine or module.** Phase 1 creates `platform`, `ref`, `org`, `iam`, `audit`, `mdm` and `wf`. Each later module gets its own schema (`fin`, `tax`, `hr`, `pay`, `proc`, `inv`, `sales`, ...). Modules read each other only through views or service APIs, never by writing another module's tables.
* **Tenant on every row.** Every tenant-owned table has `tenant_id` and a row-level security policy `tenant_id = app.tenant()`. The application sets `app.tenant_id` and `app.user_id` at the start of each transaction (`Db.withTenant`).
* **Composite foreign keys.** Tenant tables have `UNIQUE (tenant_id, id)` and reference each other with `(tenant_id, x_id)`. A row in one tenant can never point at a row in another, even through a bug.
* **Database-enforced invariants.** Hierarchy level order, org cycles, reporting-line cycles, one root per tenant, one active workflow version, one pending approval per record, audit immutability: all enforced in PostgreSQL, so no client can bypass them.
* **Extensible without code.** Units, employees, partners and items carry an `attributes` JSONB column for tenant-defined fields. The form and field builders (Phase 4 to 5) will manage a metadata registry describing those fields, their validation and permissions.
* **Reference data is global.** Countries, currencies and the permission catalog live in `ref` and are read-only to the application.

## 2. Database roles

| Role | Used by | Rights |
|---|---|---|
| Owner (migration role) | `npm run migrate` | Owns all objects; applies migrations |
| `baats_app` | The API at runtime | DML on module tables; **subject to RLS**; read-only on `audit.entries`; can call `audit.append` only |
| Superuser | Database operations only | Not used by the application |

## 3. Phase 1 ER diagram

```mermaid
erDiagram
  TENANTS ||--o{ UNIT_TYPES : defines
  TENANTS ||--o{ UNITS : owns
  UNIT_TYPES ||--o{ UNITS : classifies
  UNITS ||--o{ UNITS : "parent of"
  UNITS ||--o{ EMPLOYEES : "home unit"
  DESIGNATIONS ||--o{ EMPLOYEES : holds
  EMPLOYEES ||--o{ EMPLOYEES : "reports to"
  EMPLOYEES |o--o| UNITS : "heads"
  EMPLOYEES |o--o| USERS : "has login"
  USERS ||--o{ SESSIONS : opens
  ROLES ||--o{ ROLE_PERMISSIONS : grants
  PERMISSIONS ||--o{ ROLE_PERMISSIONS : "granted as"
  USERS ||--o{ ROLE_ASSIGNMENTS : holds
  ROLES ||--o{ ROLE_ASSIGNMENTS : "assigned as"
  UNITS ||--o{ ROLE_ASSIGNMENTS : "scope"
  PERMISSIONS ||--o{ SOD_RULES : "conflicts"
  USERS ||--o{ DELEGATIONS : "delegates / receives"
  UOMS ||--o{ ITEMS : measures
  UNITS ||--o{ PARTIES : "owns"
  COUNTRIES ||--o{ PARTIES : "located in"
  DEFINITIONS ||--o{ INSTANCES : "version used"
  USERS ||--o{ INSTANCES : requests
  UNITS ||--o{ INSTANCES : "subject"
  INSTANCES ||--o{ TASKS : has
  USERS ||--o{ TASKS : "assigned / on behalf of"
  INSTANCES ||--o{ HISTORY : records
  TENANTS ||--o{ AUDIT_ENTRIES : "hash chain"

  TENANTS { uuid id PK; text code UK; char base_currency }
  UNIT_TYPES { uuid id PK; text code; smallint rank; bool is_legal_entity }
  UNITS { uuid id PK; uuid parent_id FK; text path; int depth; bool is_cost_center; bool is_profit_center; jsonb attributes }
  EMPLOYEES { uuid id PK; text employee_no; uuid unit_id FK; uuid manager_id FK; text status }
  USERS { uuid id PK; text email; text password_hash; bool mfa_enabled; int failed_logins }
  ROLES { uuid id PK; text code }
  ROLE_PERMISSIONS { uuid role_id FK; text permission_code FK; jsonb conditions }
  ROLE_ASSIGNMENTS { uuid user_id FK; uuid role_id FK; uuid scope_unit_id FK; bool include_descendants; timestamptz valid_from; timestamptz valid_to }
  PARTIES { uuid id PK; text code; bool is_customer; bool is_supplier; text tax_registration_no; numeric credit_limit; text status }
  DEFINITIONS { uuid id PK; text code; int version; jsonb definition; bool is_active }
  INSTANCES { uuid id PK; text entity_type; text entity_id; jsonb payload; text status; int current_step }
  TASKS { uuid id PK; int step_index; uuid assignee_user_id; uuid on_behalf_of_user_id; text status; timestamptz due_at }
  AUDIT_ENTRIES { uuid tenant_id PK; bigint seq PK; text category; text action; jsonb before; jsonb after; text prev_hash; text hash }
```

The authoritative definition is [`db/migrations/001_core.sql`](../db/migrations/001_core.sql).

## 4. Key structures

### Organization hierarchy

`org.unit_types` holds the tenant's levels with a `rank` (group 0, company 10, country 20, region 30, branch 40, business unit 50, division 60, department 70, sub-department 80, team 90 by default; tenants add their own). A trigger stops a unit from sitting under a unit of equal or lower level, and maintains `path` (`/root/.../self/`) and `depth`. Moving a unit rewrites its whole subtree in one statement and rejects cycles. Subtree queries are a single indexed `LIKE 'prefix%'`, which keeps permission checks fast for tens of thousands of units.

Legal entities (`is_legal_entity`), cost centers and profit centers are flags on units, so finance dimensions and the org chart are the same tree.

### Access model

`role_assignments` says *who* holds *which role* over *which subtree* and *when*. `role_permissions` says what the role allows and under which attribute conditions. A decision needs a grant whose scope covers the resource's unit and whose conditions match the resource's attributes. Details in [04-roles-and-permissions.md](04-roles-and-permissions.md).

### Audit chain

`audit.append()` (security definer) serializes appends per tenant with an advisory lock, assigns the next `seq`, and stores `hash = sha256(payload || prev_hash)`. Update, delete and truncate are blocked by trigger and by privileges. `verifyChain` recomputes every hash in the application.

## 5. Forward design for Phase 2 to 3 (not yet built)

| Schema | Core tables |
|---|---|
| `fin` | `ledgers`, `accounts` (chart per company), `fiscal_periods`, `journals`, `journal_lines` (partitioned by period; amount in transaction and functional currency; dimensions: company, cost center, profit center, project, partner), `exchange_rates` |
| `tax` | `jurisdictions`, `tax_codes`, `tax_rules` (rule-engine conditions), `tax_returns`, `einvoice_submissions` |
| `hr` | `positions`, `assignments` (effective-dated), `leave_types`, `leave_requests`, `attendance` |
| `pay` | `pay_groups`, `elements`, `runs`, `results` (country packs: UAE WPS, KSA GOSI, UK PAYE, US federal and state, PK, IN PF/ESI, AU STP, NZ, CA) |
| `proc` | `requisitions`, `rfqs`, `purchase_orders`, `receipts`, `supplier_invoices` (three-way match) |
| `inv` | `warehouses`, `locations`, `stock_moves` (append-only), `stock_balances`, `lots`, `serials` |
| `sales` | `leads`, `opportunities`, `quotes`, `sales_orders`, `deliveries`, `customer_invoices` |

All will reference `org.units`, `mdm.parties`, `mdm.items` and post through the accounting engine.

## 6. Scale considerations

* Partition high-volume tables (`audit.entries`, `wf.history`, `fin.journal_lines`, `inv.stock_moves`) by tenant hash and by month when volumes require it.
* PgBouncer in transaction mode works with this design because tenant settings are transaction-local (`set_config(..., true)`).
* Read replicas serve lists and reports; analytics leave the OLTP database through CDC.
* Very large tenants move to a dedicated database without code change.
