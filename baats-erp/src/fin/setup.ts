import { ConflictError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { insertDefinition } from '../workflow/engine.ts';
import { companyPack, packFor } from './country.ts';
import { checkCompanySlot } from '../platform/billing.ts';
import { JOURNAL_WORKFLOW, openPeriods } from './ledger.ts';

export interface CompanySetup {
  unitId: string;
  legalName: string;
  taxRegistrationNo?: string;
  fiscalYearStartMonth?: number;
  vatPeriod?: 'monthly' | 'quarterly';
  vatQuarterStartMonth?: number;
  corporateTaxRate?: number;
  corporateTaxThreshold?: number;
  /** First month to open for posting (YYYY-MM-DD); twelve months are opened from it. */
  openFrom: string;
}

/**
 * Give a legal-entity org unit its own books from its country's pack: company
 * record, chart of accounts, VAT codes, payroll contribution rules, open periods,
 * and a default journal approval workflow.
 */
export async function setupCompany(tx: Tx, ctx: Ctx, input: CompanySetup) {
  await authorize(tx, ctx, 'fin.company.manage', { unitId: input.unitId });
  if (!(await one(tx, 'SELECT 1 FROM fin.companies WHERE unit_id = $1', [input.unitId]))) await checkCompanySlot(tx);
  const unit = await one(tx, `SELECT u.id, u.country_code, u.currency_code, t.is_legal_entity
                                FROM org.units u JOIN org.unit_types t ON t.id = u.type_id WHERE u.id = $1`, [input.unitId]);
  if (!unit) throw new ValidationError('unknown org unit');
  if (!unit.is_legal_entity) throw new ValidationError('books can only be kept by a legal-entity unit (for example a company)');
  if (!unit.country_code || !unit.currency_code) throw new ValidationError('set the unit\'s country and currency first');
  const pack = packFor(unit.country_code);
  if (unit.currency_code !== pack.currency) throw new ValidationError(`books in ${pack.name} are kept in ${pack.currency}; set the unit's currency to ${pack.currency}`);
  if (await one(tx, 'SELECT 1 FROM fin.companies WHERE unit_id = $1', [input.unitId])) throw new ConflictError('this company already has books');
  if (input.taxRegistrationNo && !pack.taxNumber.test(input.taxRegistrationNo)) throw new ValidationError(pack.taxNumber.message);

  const company = await one(tx, `INSERT INTO fin.companies (tenant_id, unit_id, legal_name, country_code, base_currency,
      fiscal_year_start_month, tax_registration_no, vat_period, vat_quarter_start_month, corporate_tax_rate, corporate_tax_threshold)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [input.unitId, input.legalName, unit.country_code, unit.currency_code, input.fiscalYearStartMonth ?? 1,
      input.taxRegistrationNo ?? null, input.vatPeriod ?? 'quarterly', input.vatQuarterStartMonth ?? 1,
      input.corporateTaxRate ?? pack.defaults.corporateTaxRate, input.corporateTaxThreshold ?? pack.defaults.corporateTaxThreshold]);

  const ids = new Map<string, string>();
  for (const a of pack.chart) {
    const row = await one(tx, `INSERT INTO fin.accounts (tenant_id, company_id, code, name, type, parent_id, is_group, control, system_role, allow_manual)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [input.unitId, a.code, a.name, a.type, a.parent ? ids.get(a.parent) : null, a.kind === 'G', a.control ?? null, a.role ?? null, a.manual ?? true]);
    ids.set(a.code, row.id);
  }

  for (const t of pack.taxCodes) {
    await tx.query(`INSERT INTO fin.tax_codes (tenant_id, country_code, code, name, category, rate, einvoice_category, exemption_reason_code, exemption_reason)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, country_code, code) DO NOTHING`,
      [pack.country, t.code, t.name, t.category, t.rate, t.einvoice, t.exemptionCode ?? null, t.exemptionReason ?? null]);
  }
  for (const r of pack.contributions) {
    await tx.query(`INSERT INTO hr.contribution_rules (tenant_id, company_id, code, name, applies_to, employee_pct, employer_pct, base, monthly_cap,
                       after_years, employer_pct_after)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [input.unitId, r.code, r.name, r.appliesTo, r.employeePct, r.employerPct, r.base, r.monthlyCap, r.afterYears ?? null, r.employerPctAfter ?? null]);
  }

  await openPeriods(tx, input.unitId, input.openFrom, 12);

  // Default maker-checker for manual journals: a finance controller (or the tenant
  // administrator) approves, within the limits of their fin.journal.approve grant.
  if (!(await one(tx, 'SELECT 1 FROM iam.roles WHERE code = $1', ['FIN_CONTROLLER']))) {
    await tx.query(`INSERT INTO iam.roles (tenant_id, code, name, is_system) VALUES (app.tenant(), 'FIN_CONTROLLER', 'Finance controller', true)`);
  }
  if (!(await one(tx, 'SELECT 1 FROM wf.definitions WHERE code = $1', [JOURNAL_WORKFLOW]))) {
    await insertDefinition(tx, {
      code: JOURNAL_WORKFLOW, name: 'Manual journal approval', entityType: 'fin.journal',
      definition: { approvalPermission: 'fin.journal.approve', steps: [{ key: 'controller', name: 'Finance controller',
        approvers: [{ type: 'role', role: 'FIN_CONTROLLER' }, { type: 'role', role: 'TENANT_ADMIN' }] }] },
    });
  }
  return company;
}

/**
 * Like BAATS Accounting's ensureAcc(): an account a newer module needs is added to
 * books created before that module existed, from the same chart template.
 */
export async function ensureRoleAccount(tx: Tx, companyId: string, role: string): Promise<string> {
  const found = await one(tx, 'SELECT id FROM fin.accounts WHERE company_id = $1 AND system_role = $2', [companyId, role]);
  if (found) return found.id;
  const t = (await companyPack(tx, companyId)).chart.find((a) => a.role === role);
  if (!t) throw new ValidationError(`no chart template for ${role}`);
  const parent = t.parent ? await one(tx, 'SELECT id FROM fin.accounts WHERE company_id = $1 AND code = $2', [companyId, t.parent]) : null;
  const row = await one(tx, `INSERT INTO fin.accounts (tenant_id, company_id, code, name, type, parent_id, is_group, control, system_role, allow_manual)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, false, $6, $7, $8) RETURNING id`,
    [companyId, t.code, t.name, t.type, parent?.id ?? null, t.control ?? null, role, t.manual ?? true]);
  return row.id;
}

export async function listAccounts(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  return many(tx, `SELECT a.id, a.code, a.name, a.type, p.code AS parent_code, a.is_group, a.control, a.system_role, a.allow_manual, a.status
                     FROM fin.accounts a LEFT JOIN fin.accounts p ON p.id = a.parent_id
                    WHERE a.company_id = $1 ORDER BY a.code`, [companyId]);
}

export async function createAccount(tx: Tx, ctx: Ctx, companyId: string, input: { code: string; name: string; parentCode: string }) {
  await authorize(tx, ctx, 'fin.account.manage', { unitId: companyId });
  const parent = await one(tx, 'SELECT id, type, is_group FROM fin.accounts WHERE company_id = $1 AND code = $2', [companyId, input.parentCode]);
  if (!parent || !parent.is_group) throw new ValidationError('parent must be a group account (for example 51)');
  if (!/^\d{3,10}$/.test(input.code)) throw new ValidationError('account codes are 3 to 10 digits');
  return one(tx, `INSERT INTO fin.accounts (tenant_id, company_id, code, name, type, parent_id)
    VALUES (app.tenant(), $1, $2, $3, $4, $5) RETURNING *`, [companyId, input.code, input.name, parent.type, parent.id]);
}

export async function listTaxCodes(tx: Tx, countryCode: string) {
  return many(tx, 'SELECT * FROM fin.tax_codes WHERE country_code = $1 AND active ORDER BY code', [countryCode]);
}
