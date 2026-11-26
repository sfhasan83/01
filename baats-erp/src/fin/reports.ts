import { ConflictError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { company, post, resolveAccount, round2, type PostingLine } from './ledger.ts';

/** Financial statements and ledgers, computed from posted journals only. */

export function fiscalYear(startMonth: number, startYear: number): { from: string; to: string } {
  const from = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const to = new Date(Date.UTC(startYear + 1, startMonth - 1, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

const n = (v: unknown) => round2(Number(v));

export async function trialBalance(tx: Tx, ctx: Ctx, companyId: string, to: string, from?: string) {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  const rows = await many(tx, `
    SELECT a.code, a.name, a.type,
           coalesce(sum(CASE WHEN j.date < $3 THEN l.debit - l.credit END), 0) AS opening,
           coalesce(sum(CASE WHEN j.date >= $3 THEN l.debit END), 0) AS debit,
           coalesce(sum(CASE WHEN j.date >= $3 THEN l.credit END), 0) AS credit
      FROM fin.accounts a
      JOIN fin.journal_lines l ON l.account_id = a.id
      JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' AND j.date <= $2
     WHERE a.company_id = $1
     GROUP BY a.code, a.name, a.type ORDER BY a.code`, [companyId, to, from ?? '0001-01-01']);
  const lines = rows.map((r) => {
    const opening = n(r.opening), debit = n(r.debit), credit = n(r.credit);
    return { code: r.code, name: r.name, type: r.type, opening, debit, credit, closing: round2(opening + debit - credit) };
  }).filter((r) => r.opening || r.debit || r.credit);
  const totals = lines.reduce((t, r) => ({
    debit: round2(t.debit + r.debit), credit: round2(t.credit + r.credit),
    closingDebit: round2(t.closingDebit + Math.max(r.closing, 0)), closingCredit: round2(t.closingCredit + Math.max(-r.closing, 0)),
  }), { debit: 0, credit: 0, closingDebit: 0, closingCredit: 0 });
  return { from: from ?? null, to, lines, totals, balanced: totals.closingDebit === totals.closingCredit };
}

/** Profit and loss in BAATS layout: revenue, direct costs (52), gross profit, other expenses, net profit. */
export async function profitAndLoss(tx: Tx, ctx: Ctx, companyId: string, from: string, to: string) {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  const rows = await many(tx, `
    SELECT a.code, a.name, a.type, p.code AS group_code, p.name AS group_name, sum(l.credit - l.debit) AS amount
      FROM fin.journal_lines l
      JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' AND j.type <> 'closing'
      JOIN fin.accounts a ON a.id = l.account_id AND a.type IN ('revenue','expense')
      LEFT JOIN fin.accounts p ON p.id = a.parent_id
     WHERE j.company_id = $1 AND j.date BETWEEN $2 AND $3
     GROUP BY 1,2,3,4,5 ORDER BY a.code`, [companyId, from, to]);
  const revenue = rows.filter((r) => r.type === 'revenue').map((r) => ({ code: r.code, name: r.name, amount: n(r.amount) }));
  const exp = rows.filter((r) => r.type === 'expense').map((r) => ({ code: r.code, name: r.name, group: r.group_code, groupName: r.group_name, amount: n(-r.amount) }));
  const sum = (xs: Array<{ amount: number }>) => round2(xs.reduce((s, x) => s + x.amount, 0));
  const directCosts = exp.filter((e) => e.group === '52');
  const otherExpenses = exp.filter((e) => e.group !== '52');
  const totalRevenue = sum(revenue), totalDirect = sum(directCosts), grossProfit = round2(totalRevenue - totalDirect);
  return { from, to, revenue, totalRevenue, directCosts, totalDirectCosts: totalDirect, grossProfit,
    expenses: otherExpenses, totalExpenses: sum(otherExpenses), netProfit: round2(grossProfit - sum(otherExpenses)) };
}

export async function balanceSheet(tx: Tx, ctx: Ctx, companyId: string, asOf: string) {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  const rows = await many(tx, `
    SELECT a.code, a.name, a.type, sum(l.debit - l.credit) AS bal
      FROM fin.journal_lines l
      JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' AND j.date <= $2
      JOIN fin.accounts a ON a.id = l.account_id
     WHERE j.company_id = $1 GROUP BY 1,2,3 ORDER BY 1`, [companyId, asOf]);
  const pick = (t: string, sign: number) => rows.filter((r) => r.type === t && n(r.bal) !== 0).map((r) => ({ code: r.code, name: r.name, amount: n(sign * r.bal) }));
  const sum = (xs: Array<{ amount: number }>) => round2(xs.reduce((s, x) => s + x.amount, 0));
  const assets = pick('asset', 1), liabilities = pick('liability', -1), equity = pick('equity', -1);
  // Profit not yet closed to retained earnings.
  const unclosed = round2(-rows.filter((r) => r.type === 'revenue' || r.type === 'expense').reduce((s, r) => s + Number(r.bal), 0));
  const totalEquity = round2(sum(equity) + unclosed);
  return { asOf, assets, totalAssets: sum(assets), liabilities, totalLiabilities: sum(liabilities), equity, currentEarnings: unclosed,
    totalEquity, balanced: sum(assets) === round2(sum(liabilities) + totalEquity) };
}

export async function accountLedger(tx: Tx, ctx: Ctx, companyId: string, accountRef: string, from: string, to: string) {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  const acc = await resolveAccount(tx, companyId, accountRef);
  const opening = n((await one(tx, `SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM fin.journal_lines l
      JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' WHERE l.account_id = $1 AND j.date < $2`, [acc.id, from])).b);
  const rows = await many(tx, `SELECT j.date, j.no, j.memo, l.description, l.debit, l.credit, p.name AS party
      FROM fin.journal_lines l JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted'
      LEFT JOIN mdm.parties p ON p.id = l.party_id
     WHERE l.account_id = $1 AND j.date BETWEEN $2 AND $3 ORDER BY j.date, j.no, l.line_no`, [acc.id, from, to]);
  let bal = opening;
  const lines = rows.map((r) => { bal = round2(bal + Number(r.debit) - Number(r.credit)); return { ...r, debit: n(r.debit), credit: n(r.credit), balance: bal }; });
  return { account: acc.code, from, to, opening, lines, closing: bal };
}

/** Customer or supplier statement from the control account, in base currency. */
export async function partyStatement(tx: Tx, ctx: Ctx, companyId: string, partyId: string, from: string, to: string) {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  const rows = await many(tx, `SELECT j.date, j.no, j.memo, l.debit, l.credit, a.code
      FROM fin.journal_lines l JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted'
      JOIN fin.accounts a ON a.id = l.account_id AND a.control IS NOT NULL
     WHERE j.company_id = $1 AND l.party_id = $2 AND j.date <= $3 ORDER BY j.date, j.no`, [companyId, partyId, to]);
  let bal = 0, opening = 0;
  const lines = [];
  for (const r of rows) {
    bal = round2(bal + Number(r.debit) - Number(r.credit));
    if (r.date.toISOString().slice(0, 10) < from) { opening = bal; continue; }
    lines.push({ date: r.date, no: r.no, memo: r.memo, debit: n(r.debit), credit: n(r.credit), balance: bal });
  }
  return { partyId, from, to, opening, lines, closing: bal };
}

/** Open documents by partner and days overdue: current, 1–30, 31–60, 61–90, over 90; plus unapplied advances. */
export async function ageing(tx: Tx, ctx: Ctx, companyId: string, side: 'receivable' | 'payable', asOf: string) {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  const kind = side === 'receivable' ? 'sales_invoice' : 'purchase_invoice';
  const docs = await many(tx, `
    SELECT i.id, i.no, i.supplier_ref, i.party_id, p.name AS party, i.due_date, i.currency,
           i.gross_total - coalesce((SELECT sum(a.amount) FROM fin.allocations a WHERE a.invoice_id = i.id AND a.date <= $3), 0) AS open,
           ($3::date - i.due_date) AS days
      FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id
     WHERE i.company_id = $1 AND i.kind = $2 AND i.status = 'posted' AND i.date <= $3`, [companyId, kind, asOf]);
  const adv = await many(tx, `
    SELECT y.party_id, p.name AS party, y.currency, y.amount - coalesce((SELECT sum(a.amount) FROM fin.allocations a WHERE a.payment_id = y.id AND a.date <= $3), 0) AS open
      FROM fin.payments y JOIN mdm.parties p ON p.id = y.party_id
     WHERE y.company_id = $1 AND y.kind = $2 AND y.date <= $3`, [companyId, side === 'receivable' ? 'receipt' : 'payment', asOf]);
  const buckets = ['current', '1-30', '31-60', '61-90', 'over_90'] as const;
  const bucket = (d: number) => (d <= 0 ? 'current' : d <= 30 ? '1-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : 'over_90');
  const byParty = new Map<string, any>();
  const get = (id: string, name: string, cur: string) => {
    const k = `${id}|${cur}`;
    if (!byParty.has(k)) byParty.set(k, { partyId: id, party: name, currency: cur, ...Object.fromEntries(buckets.map((b) => [b, 0])), advances: 0, total: 0, documents: [] });
    return byParty.get(k);
  };
  for (const d of docs) {
    const open = n(d.open);
    if (open <= 0) continue;
    const row = get(d.party_id, d.party, d.currency);
    const b = bucket(Number(d.days));
    row[b] = round2(row[b] + open); row.total = round2(row.total + open);
    row.documents.push({ no: d.no, supplierRef: d.supplier_ref, dueDate: d.due_date, daysOverdue: Math.max(0, Number(d.days)), open });
  }
  for (const a of adv) {
    const open = n(a.open);
    if (open <= 0) continue;
    const row = get(a.party_id, a.party, a.currency);
    row.advances = round2(row.advances + open); row.total = round2(row.total - open);
  }
  return { side, asOf, partners: [...byParty.values()].sort((x, y) => y.total - x.total) };
}

/**
 * Year-end close: move every revenue and expense balance of the financial year into
 * retained earnings with one closing journal on the last day, then close the year's periods.
 */
export async function closeYear(tx: Tx, ctx: Ctx, companyId: string, fyStartYear: number) {
  await authorize(tx, ctx, 'fin.period.manage', { unitId: companyId });
  const c = await company(tx, companyId);
  const fy = fiscalYear(c.fiscal_year_start_month, fyStartYear);
  if (await one(tx, `SELECT 1 FROM fin.journals WHERE company_id = $1 AND type = 'closing' AND date = $2 AND status = 'posted'`, [companyId, fy.to])) {
    throw new ConflictError('this financial year is already closed');
  }
  const rows = await many(tx, `SELECT l.account_id, sum(l.debit - l.credit) AS bal
      FROM fin.journal_lines l JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted'
      JOIN fin.accounts a ON a.id = l.account_id AND a.type IN ('revenue','expense')
     WHERE j.company_id = $1 AND j.date BETWEEN $2 AND $3 GROUP BY 1 HAVING sum(l.debit - l.credit) <> 0`, [companyId, fy.from, fy.to]);
  if (!rows.length) throw new ValidationError('nothing to close in this financial year');
  const lines: PostingLine[] = rows.map((r) => {
    const b = n(r.bal);
    return { account: r.account_id, ...(b > 0 ? { credit: b } : { debit: -b }) };
  });
  const profit = round2(-rows.reduce((s, r) => s + Number(r.bal), 0));
  lines.push({ account: 'role:retained_earnings', ...(profit >= 0 ? { credit: profit } : { debit: -profit }), description: 'Profit for the year' });
  const j = await post(tx, ctx, { companyId, type: 'closing', date: fy.to, memo: `Year-end close ${fy.from} to ${fy.to}`, lines });
  await tx.query(`UPDATE fin.periods SET status = 'closed', closed_at = now(), closed_by = $4
                   WHERE company_id = $1 AND period BETWEEN $2 AND $3`, [companyId, fy.from, fy.to, ctx.userId]);
  return { fiscalYear: fy, profit, journalNo: j.no };
}
