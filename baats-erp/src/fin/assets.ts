import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { company, post, resolveAccount, roundMoney } from './ledger.ts';

/**
 * Fixed assets (BAATS 1500 Fixed assets – cost, 1590 Accumulated depreciation, 5800 Depreciation):
 *   register     from a posted purchase bill line charged to 1500 (no new posting), or as an
 *                opening balance (Dr 1500 | Cr 3200, and Dr 3200 | Cr 1590 for depreciation to date)
 *   depreciate   straight line, monthly, (cost - residual) / useful life, from the start month;
 *                one journal per company and month, Dr 5800 by cost center | Cr 1590, never twice
 *   dispose      remove cost and accumulated depreciation; proceeds to the bank; gain or loss to
 *                4100 Other income
 */

const months = (fromYm: string, toYm: string) => (Number(toYm.slice(0, 4)) - Number(fromYm.slice(0, 4))) * 12 + Number(toYm.slice(5, 7)) - Number(fromYm.slice(5, 7));
const ym = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 7);
const nextYm = (p: string) => { const d = new Date(`${p}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return ym(d); };
const monthEnd = (period: string) => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

export interface AssetInput {
  companyId: string; code: string; name: string; category: string; unitId?: string;
  acquisitionDate: string; depreciationStart?: string; usefulLifeMonths: number; residualValue?: number;
  /** A posted purchase bill line charged to 1500; cost comes from it. */
  invoiceLineId?: string;
  /** Opening balance: cost and depreciation already charged before these books. */
  cost?: number; openingAccumulated?: number;
  /** Date the opening balance is posted on; defaults to the first open month of the books. */
  openingDate?: string;
}

async function accumulated(tx: Tx, assetId: string) {
  const a = await one(tx, `SELECT a.opening_accumulated + coalesce((SELECT sum(amount) FROM fin.asset_depreciation d WHERE d.asset_id = a.id), 0) AS acc
                             FROM fin.assets a WHERE a.id = $1`, [assetId]);
  return roundMoney(Number(a.acc));
}

export async function registerAsset(tx: Tx, ctx: Ctx, input: AssetInput) {
  await authorize(tx, ctx, 'fin.asset.manage', { unitId: input.companyId });
  await company(tx, input.companyId);
  let cost: number;
  if (input.invoiceLineId) {
    const l = await one(tx, `SELECT l.net_amount, i.fx_rate, i.status, i.kind, i.company_id, a.system_role FROM fin.invoice_lines l
                               JOIN fin.invoices i ON i.id = l.invoice_id JOIN fin.accounts a ON a.id = l.account_id WHERE l.id = $1`, [input.invoiceLineId]);
    if (!l || l.company_id !== input.companyId || l.kind !== 'purchase_invoice' || l.status !== 'posted') throw new ValidationError('choose a line of a posted purchase bill of this company');
    if (l.system_role !== 'fixed_assets') throw new ValidationError('the bill line must be charged to 1500 Fixed assets – cost');
    if (input.openingAccumulated) throw new ValidationError('a newly bought asset has no depreciation yet');
    cost = roundMoney(Number(l.net_amount) * Number(l.fx_rate));
  } else {
    if (!(input.cost && input.cost > 0)) throw new ValidationError('give the cost, or the purchase bill line the asset was bought on');
    cost = roundMoney(input.cost);
  }
  const residual = roundMoney(input.residualValue ?? 0);
  const opening = roundMoney(input.openingAccumulated ?? 0);
  if (residual >= cost) throw new ValidationError('the residual value must be below the cost');
  if (opening > cost - residual) throw new ValidationError('depreciation to date cannot exceed cost less residual value');
  const start = input.depreciationStart ?? input.acquisitionDate;
  const a = await one(tx, `INSERT INTO fin.assets (tenant_id, company_id, code, name, category, unit_id, acquisition_date, depreciation_start, cost,
      residual_value, useful_life_months, opening_accumulated, source_invoice_line_id)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [input.companyId, input.code, input.name, input.category, input.unitId ?? null, input.acquisitionDate, start, cost, residual,
      input.usefulLifeMonths, opening, input.invoiceLineId ?? null]);
  if (!input.invoiceLineId) {
    const lines = [{ account: 'role:fixed_assets', debit: cost }, { account: 'role:opening_balance_equity', credit: cost }];
    if (opening > 0) lines.push({ account: 'role:opening_balance_equity', debit: opening }, { account: 'role:accumulated_depreciation', credit: opening });
    const first = await one(tx, `SELECT min(period)::text AS p FROM fin.periods WHERE company_id = $1 AND status = 'open'`, [input.companyId]);
    const on = input.openingDate ?? (input.acquisitionDate > first.p ? input.acquisitionDate : first.p);
    await post(tx, ctx, { companyId: input.companyId, type: 'opening', date: on, memo: `Opening balance, asset ${input.code}`,
      source: { type: 'asset', id: a.id }, lines });
  }
  return getAsset(tx, ctx, a.id);
}

export async function getAsset(tx: Tx, ctx: Ctx, id: string) {
  const a = await one(tx, 'SELECT * FROM fin.assets WHERE id = $1', [id]);
  if (!a) throw new NotFoundError('asset');
  await authorize(tx, ctx, 'fin.report.read', { unitId: a.company_id });
  const acc = await accumulated(tx, id);
  const schedule = await many(tx, 'SELECT period, amount::float AS amount FROM fin.asset_depreciation WHERE asset_id = $1 ORDER BY period', [id]);
  return { ...a, accumulated: acc, net_book_value: roundMoney(Number(a.cost) - acc), schedule };
}

export async function listAssets(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  return many(tx, `SELECT a.id, a.code, a.name, a.category, a.acquisition_date, a.cost::float AS cost, a.useful_life_months, a.status,
                          (a.opening_accumulated + coalesce((SELECT sum(amount) FROM fin.asset_depreciation d WHERE d.asset_id = a.id), 0))::float AS accumulated,
                          (a.cost - a.opening_accumulated - coalesce((SELECT sum(amount) FROM fin.asset_depreciation d WHERE d.asset_id = a.id), 0))::float AS net_book_value
                     FROM fin.assets a WHERE a.company_id = $1 ORDER BY a.code`, [companyId]);
}

/** Straight-line charge for one month, never taking the asset below its residual value. */
async function chargeFor(tx: Tx, a: any, period: string): Promise<number> {
  if (period < ym(a.depreciation_start)) return 0;
  if (await one(tx, 'SELECT 1 FROM fin.asset_depreciation WHERE asset_id = $1 AND period = $2', [a.id, period])) return 0;
  const monthly = (Number(a.cost) - Number(a.residual_value)) / a.useful_life_months;
  const remaining = roundMoney(Number(a.cost) - Number(a.residual_value) - await accumulated(tx, a.id));
  return Math.min(roundMoney(monthly), remaining);
}

/** Depreciate every active asset for a month. Months must be run in order. */
export async function runDepreciation(tx: Tx, ctx: Ctx, companyId: string, period: string) {
  await authorize(tx, ctx, 'fin.asset.manage', { unitId: companyId });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new ValidationError('the period is YYYY-MM');
  const assets = await many(tx, `SELECT * FROM fin.assets WHERE company_id = $1 AND status = 'active' ORDER BY code FOR UPDATE`, [companyId]);
  const charges: { a: any; amount: number }[] = [];
  for (const a of assets) {
    const last = await one(tx, 'SELECT max(period) AS p FROM fin.asset_depreciation WHERE asset_id = $1', [a.id]);
    const startYm = ym(a.depreciation_start);
    // An asset brought in with depreciation to date (opening balance) starts from the first month run.
    const expectedPrev = last.p ?? null;
    if (expectedPrev && months(expectedPrev, period) > 1) throw new ValidationError(`asset ${a.code}: run ${nextYm(expectedPrev)} first`);
    if (!expectedPrev && period > startYm && Number(a.opening_accumulated) === 0 && months(startYm, period) > 0) {
      throw new ValidationError(`asset ${a.code}: depreciation starts ${startYm}; run that month first`);
    }
    const amount = await chargeFor(tx, a, period);
    if (amount > 0) charges.push({ a, amount });
  }
  if (!charges.length) return { period, journalId: null, total: 0, assets: 0 };
  const byUnit = new Map<string, number>();
  for (const c of charges) byUnit.set(c.a.unit_id ?? '', roundMoney((byUnit.get(c.a.unit_id ?? '') ?? 0) + c.amount));
  const total = roundMoney(charges.reduce((x, c) => x + c.amount, 0));
  const j = await post(tx, ctx, { companyId, type: 'depreciation', date: monthEnd(period), memo: `Depreciation ${period}`,
    source: { type: 'depreciation', id: (await one(tx, `SELECT md5($1 || $2)::uuid AS u`, [companyId, period])).u },
    lines: [...[...byUnit].map(([u, amt]) => ({ account: 'role:depreciation', debit: amt, unitId: u || null })),
      { account: 'role:accumulated_depreciation', credit: total }] });
  for (const c of charges) {
    await tx.query(`INSERT INTO fin.asset_depreciation (tenant_id, asset_id, period, amount, journal_id) VALUES (app.tenant(), $1, $2, $3, $4)`,
      [c.a.id, period, c.amount, j.id]);
  }
  return { period, journalId: j.id, no: j.no, total, assets: charges.length };
}

export async function disposeAsset(tx: Tx, ctx: Ctx, assetId: string, input: { date: string; proceeds?: number; bankAccount?: string }) {
  const a = await one(tx, 'SELECT * FROM fin.assets WHERE id = $1 FOR UPDATE', [assetId]);
  if (!a) throw new NotFoundError('asset');
  await authorize(tx, ctx, 'fin.asset.manage', { unitId: a.company_id });
  if (a.status !== 'active') throw new ConflictError('the asset is already disposed');
  const last = await one(tx, 'SELECT max(period) AS p FROM fin.asset_depreciation WHERE asset_id = $1', [assetId]);
  const prevMonth = (() => { const d = new Date(`${input.date.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return ym(d); })();
  if (prevMonth >= ym(a.depreciation_start) && (last.p ?? '') < prevMonth && await accumulated(tx, assetId) < roundMoney(Number(a.cost) - Number(a.residual_value))) {
    throw new ValidationError(`run depreciation up to ${prevMonth} before disposing`);
  }
  const acc = await accumulated(tx, assetId);
  const cost = Number(a.cost);
  const proceeds = roundMoney(input.proceeds ?? 0);
  const gain = roundMoney(proceeds - (cost - acc));
  const lines: { account: string; debit?: number; credit?: number }[] = [{ account: 'role:fixed_assets', credit: cost }];
  if (acc > 0) lines.push({ account: 'role:accumulated_depreciation', debit: acc });
  if (proceeds > 0) lines.push({ account: (await resolveAccount(tx, a.company_id, input.bankAccount ?? 'role:bank')).id, debit: proceeds });
  if (gain !== 0) lines.push({ account: '4100', ...(gain > 0 ? { credit: gain } : { debit: -gain }) });
  const j = await post(tx, ctx, { companyId: a.company_id, type: 'asset_disposal', date: input.date, memo: `Disposal of ${a.code} ${a.name}`,
    source: { type: 'asset', id: a.id }, lines });
  await tx.query(`UPDATE fin.assets SET status = 'disposed', disposal_date = $2, disposal_proceeds = $3, disposal_journal_id = $4 WHERE id = $1`,
    [assetId, input.date, proceeds, j.id]);
  return { ...(await getAsset(tx, ctx, assetId)), gain };
}
