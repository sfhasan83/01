# 07. Security testing

BAATS checks its own security with every change, and is ready for an outside penetration test. This page says what is checked automatically, what an outside tester should cover, and the rules of engagement.

## 1. Checked with every change (`test/security.test.ts`)

| Control | How it is checked |
|---|---|
| Tenant isolation in the database | Every table with a `tenant_id` column has row level security enabled and forced (so even the table owner is filtered) and at least one policy. |
| No unprotected tables | Apart from the plan list (`platform.plans`) and `platform.tenants` (filtered to the tenant itself), the application role cannot write any table without row level security. |
| Least privilege | `baats_app` is not a superuser, cannot bypass row level security, create roles or databases, and owns no table. Migrations run as a separate owner. |
| Owner-rights functions | Every `SECURITY DEFINER` function pins its `search_path`, so it cannot be redirected to an attacker's objects. |
| Audit trail | The application role cannot update or delete audit entries; entries are hash-chained per tenant and the chain is recomputed by `/v1/audit/verify` and by every restore drill. |
| Authentication on every route | Every route except the listed public ones answers 401 without a session, with a forged session token, and with a forged API key. The list of public routes is itself asserted, so a new public route fails the test until it is reviewed. |
| No reach across organizations | An administrator of one organization, holding the right ids, cannot read, change or block another organization's records. |

Elsewhere in the tests: password rules and lockout, rate limits on failed sign-ins and on requests, MFA, sessions ending on password change and on disabling a user, permission and segregation-of-duties checks per module, signed webhooks and Stripe notices, PKCE, state and nonce in single sign-on, sealed secrets, backups that refuse changed files.

## 2. Scope for an outside penetration test

In scope:
- The API (`/v1/...`), including sign-in, sessions, MFA, API keys, single sign-on and the public routes (`/v1/auth/*`, `/v1/pay/stripe/notice`, `/v1/platform/*` with the platform key, `/metrics`, `/health`).
- BAATS Mobile (`/m/`) and the trial console.
- Multi-tenancy: two test organizations are provided; the main question is whether one can see or change the other's data.
- Authorization: users with narrow roles (for example a sales representative, an employee using BAATS Mobile) trying to exceed them.
- File handling: imports (CSV, Excel), statement files (MT940, CAMT.053), document uploads, backups.
- Outbound requests the server makes on a tenant's behalf (webhooks, AI providers, mail, OpenID discovery): server-side request forgery.

Out of scope: denial of service by volume, the hosting provider's infrastructure, social engineering.

## 3. Rules of engagement

- Test against a staging server with its own database and keys, never production data.
- Give the testers two organizations, an administrator and a narrow user in each, and an API key.
- Findings are reported with steps to reproduce; each becomes a test in `test/security.test.ts` or the module's tests before it is fixed, so it cannot come back.

## 4. Not done by software

An outside penetration test, ISO 27001 and SOC 2 need an independent tester or auditor and the organization's own policies (access reviews, incident response, supplier management). The controls above provide the evidence for the technical parts.
