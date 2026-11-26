# 04. Roles, permissions and approvals

## 1. The model

An access decision answers: **may user U perform permission P on resource R?**

1. **Permission** — a named action from the catalog in `ref.permissions`, such as `mdm.party.approve`. Modules register their permissions in migrations.
2. **Role** — a tenant-defined bundle of permissions (`iam.roles`, `iam.role_permissions`). Each grant may carry **attribute conditions** (ABAC), for example `{"credit_limit": {"lte": 100000}}` or `{"currency": {"in": ["AED","USD"]}, "country": "AE"}`.
3. **Assignment** — user U holds role X **over an org unit**, optionally including its whole subtree, within a validity window (`iam.role_assignments`).
4. **Decision** — allowed if some active assignment's role grants P, its scope covers R's unit, and the grant's conditions match R's attributes. Tenant-wide actions (managing roles, reading the audit trail) need a grant scoped at the root unit.

Conditions use the shared rules engine: `eq`, `ne`, `in`, `nin`, `lt`, `lte`, `gt`, `gte`, `exists`, and `any` for OR. A missing attribute fails the condition, so rules fail closed.

Lists are filtered the same way: a user sees employees or partners only in units their grants cover.

`POST /v1/iam/check` explains any decision ("granted via FIN_MANAGER at Dubai", or "conditions on your grant are not met").

### Built-in controls

| Control | How it works |
|---|---|
| Segregation of duties | `iam.sod_rules` lists conflicting permission pairs. A role grant or assignment that would give one user both is rejected. Creating a rule reports existing conflicts for remediation. |
| No self-elevation | Users cannot assign roles to themselves; assigning a role over a unit needs `iam.assignment.manage` over that unit. |
| Maker-checker | A workflow requester is never an approver of their own request, including through delegation. |
| Distinct approvers | By default one person cannot approve two steps of the same request. |
| Approval limits | A workflow's `approvalPermission` is checked at the moment of approval against the request's payload, using the approver's (or, under delegation, the delegator's) grant conditions. |
| Delegation of authority | Time-boxed; tasks route to the delegate, recorded as "on behalf of"; the delegate acts with the delegator's limits. |
| Joiner-mover-leaver | Disabling a user ends all sessions at once. Phase 1b automates this from HR events and SCIM. |
| Evidence | Every grant, assignment, approval, login and denial is in the hash-chained audit trail. |

## 2. Permission catalog (Phase 1)

| Permission | Meaning |
|---|---|
| `org.unit.read` / `org.unit.manage` | View / change org units and hierarchy levels |
| `org.employee.read` / `org.employee.manage` | View / change employee records in scope |
| `iam.user.read` / `iam.user.manage` | View / create, disable users |
| `iam.role.manage` | Create roles and grant permissions |
| `iam.assignment.manage` | Assign roles over a unit |
| `iam.delegation.manage` | Delegate on behalf of others |
| `iam.sod.manage` | Maintain SoD rules |
| `audit.read` / `audit.verify` | Read the audit trail / verify its integrity |
| `mdm.uom.manage`, `mdm.item.read`, `mdm.item.manage` | Units of measure and items |
| `mdm.party.read`, `mdm.party.manage`, `mdm.party.approve` | Customers and suppliers |
| `wf.definition.manage`, `wf.instance.read`, `wf.escalation.run` | Workflow administration |

Each later module adds its own (`fin.journal.post`, `fin.period.close`, `pay.run.approve`, `proc.po.approve`, ...).

## 3. Standard role templates per portal

Tenants copy and adapt these; nothing is hard-coded. Scope is where the role is assigned.

| Portal / role | Typical scope | Key permissions | Notes |
|---|---|---|---|
| Employee (self-service) | Own record | View own profile, payslips, leave balance; submit requests; act on own inbox | Granted to every active employee automatically (Phase 2) |
| Supervisor / team lead | Team | Read team employees; approve leave and time; endorse requests | Approver via `reporting_manager` |
| Department manager | Department | Above, plus department budget view, purchase requisition approval within limit | Limit via conditions |
| Department head | Department subtree | Above with higher limits; performance reviews | |
| Regional director | Region or country | Read all departments in region; approve within regional limits | |
| CFO | Group | Finance approvals without limit; period close; treasury | SoD: not AP clerk |
| CHRO | Group | HR and payroll approval; org changes | |
| COO, CTO, CIO | Group | Operational, IT and security approvals in their domain | |
| CEO / executive management | Group | Read-only dashboards across modules; top-level approvals | |
| Chairman / board member | Group | Board portal: board packs, resolutions, voting; read-only KPIs | Phase 4 |
| Internal auditor | Group | `audit.read`, `audit.verify`, read-only on all modules | No create or approve rights |
| External auditor | Legal entity | Time-boxed read-only on finance and audit evidence | `valid_to` required |
| Customer (external portal) | Own account | Orders, invoices, statements, cases | Separate identity realm |
| Supplier (external portal) | Own account | POs, ASN, invoices, payment status | Separate identity realm |
| Tenant administrator | Group | Everything in the catalog | Should be held by few; reported as SoD conflict by design |
| Master data steward | Company | `mdm.*.manage` or `mdm.*.approve` (not both) | |

## 4. Baseline SoD rules (recommended on onboarding)

| Rule | Conflicting permissions |
|---|---|
| Partner creation vs approval | `mdm.party.manage` × `mdm.party.approve` |
| Role design vs assignment | `iam.role.manage` × `iam.assignment.manage` (for non-admins) |
| Vendor maintenance vs payment (Phase 2) | `mdm.party.manage` × `fin.payment.release` |
| Journal entry vs posting approval (Phase 2) | `fin.journal.create` × `fin.journal.approve` |
| Payroll input vs payroll approval (Phase 2) | `pay.input.manage` × `pay.run.approve` |
| PO creation vs goods receipt (Phase 2) | `proc.po.manage` × `inv.receipt.post` |

## 5. Approval matrix example

Defined as data (`POST /v1/wf/definitions`), versioned, and applied without code changes:

```json
{
  "approvalPermission": "mdm.party.approve",
  "steps": [
    { "key": "manager", "approvers": [{ "type": "reporting_manager" }], "endorseOnly": true,
      "dueHours": 24, "escalateTo": [{ "type": "reporting_manager", "level": 2 }] },
    { "key": "finance", "when": { "credit_limit": { "gt": 0, "lte": 100000 } },
      "approvers": [{ "type": "role", "role": "FIN_MANAGER" }] },
    { "key": "cfo", "when": { "credit_limit": { "gt": 100000 } },
      "approvers": [{ "type": "role", "role": "CFO" }] }
  ]
}
```

Approver types: a named `user`, holders of a `role` whose scope covers the request's unit, the requester's `reporting_manager` at any level, or the `unit_head` of the nearest unit (optionally of a given level). A step completes on `any` (default), `all`, or `{ "quorum": n }` approvals. Steps without matching `when` are skipped. Overdue tasks escalate.
