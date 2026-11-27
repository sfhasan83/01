import { ConflictError, ForbiddenError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';

/**
 * Anomaly checks on the books: rules an auditor would run, applied to the
 * whole population rather than a sample. Findings are computed on demand;
 * a reviewer records whether each one is explained or a confirmed problem,
 * and the record sticks to the finding's stable key so it is not raised again.
 * Nobody can clear a finding on a document they created themselves.
 */

export const RULES: Record<string, { title: string; severity: 'high' | 'medium' | 'low'; why: string }> = {
  duplicate_bill: { title: 'Possible duplicate supplier bill', severity: 'high', why: 'Same supplier and amount within 14 days, or the same supplier reference twice: a classic double payment.' },
  weekend_journal: { title: 'Manual journal dated on a weekend', severity: 'medium', why: 'Manual entries on non-working days deserve a second look.' },
  round_amount: { title: 'Large round-amount manual journal', severity: 'medium', why: 'Estimates and plugs are often round thousands.' },
  late_posting: { title: 'Posted long after its date', severity: 'low', why: 'Journals, invoices and payments booked more than 30 days back can move closed results (scheduled runs such as depreciation are left out).' },
  credit_ratio: { title: 'High credit notes for a customer', severity: 'medium', why: 'Credits above 20% of a customer\'s sales can hide revenue reversals or kickbacks.' },
  unallocated_payment: { title: 'Supplier payment not matched to bills', severity: 'medium', why: 'Money paid out more than 30 days ago with nothing to show for it.' },
  benford: { title: 'Amounts do not follow Benford\'s law', severity: 'low', why: 'In natural populations about 30% of amounts start with 1; large deviations can point to invented figures.' },
};

const WEEKEND: Record<string, number[]> = { AE: [0, 6], SA: [5, 6], QA: [5, 6], KW: [5, 6], OM: [5, 6], BH: [5, 6] };
const BENFORD = [0, 0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046];

interface Finding { rule: string; key: string; title: string; severity: string; detail: string; amount: number | null; refs: { type: string; id: string; no: string | null }[]; createdBy: string[] }

async function findings(tx: Tx, companyId: string, from: string, to: string) {
  const out: Finding[] = [];
  const add = (rule: string, key: string, detail: string, amount: number | null, refs: Finding['refs'], createdBy: (string | null)[] = []) =>
    out.push({ rule, key, title: RULES[rule].title, severity: RULES[rule].severity, detail, amount, refs, createdBy: createdBy.filter(Boolean) as string[] });

  // Duplicate bills
  const dups = await many(tx, `SELECT a.id AS a_id, a.no AS a_no, a.supplier_ref AS a_ref, a.date AS a_date, a.created_by AS a_by,
        b.id AS b_id, b.no AS b_no, b.supplier_ref AS b_ref, b.date AS b_date, b.created_by AS b_by, a.gross_total::float AS amount, a.currency, p.name AS supplier,
        (upper(regexp_replace(coalesce(a.supplier_ref, ''), '[^A-Za-z0-9]', '', 'g')) = upper(regexp_replace(coalesce(b.supplier_ref, ''), '[^A-Za-z0-9]', '', 'g')) AND coalesce(a.supplier_ref, '') <> '') AS same_ref
      FROM fin.invoices a JOIN fin.invoices b ON b.party_id = a.party_id AND b.id > a.id AND b.kind = 'purchase_invoice' AND b.status = 'posted'
      JOIN mdm.parties p ON p.id = a.party_id
     WHERE a.company_id = $1 AND b.company_id = $1 AND a.kind = 'purchase_invoice' AND a.status = 'posted'
       AND (a.date BETWEEN $2 AND $3 OR b.date BETWEEN $2 AND $3)
       AND ((a.gross_total = b.gross_total AND a.currency = b.currency AND abs(a.date - b.date) <= 14)
         OR (upper(regexp_replace(coalesce(a.supplier_ref, ''), '[^A-Za-z0-9]', '', 'g')) = upper(regexp_replace(coalesce(b.supplier_ref, ''), '[^A-Za-z0-9]', '', 'g')) AND coalesce(a.supplier_ref, '') <> ''))`,
  [companyId, from, to]);
  for (const d of dups) {
    add('duplicate_bill', [d.a_id, d.b_id].sort().join(':'),
      `${d.supplier}: ${d.a_no} (${d.a_ref ?? 'no ref'}) and ${d.b_no} (${d.b_ref ?? 'no ref'}), ${d.same_ref ? 'same supplier reference' : `same amount ${d.amount.toFixed(2)} ${d.currency} within 14 days`}`,
      d.amount, [{ type: 'fin.invoice', id: d.a_id, no: d.a_no }, { type: 'fin.invoice', id: d.b_id, no: d.b_no }], [d.a_by, d.b_by]);
  }

  // Manual journals: weekends and round amounts
  const country = (await one(tx, 'SELECT country_code FROM fin.companies WHERE unit_id = $1', [companyId]))?.country_code ?? 'AE';
  const weekend = WEEKEND[country] ?? [0, 6];
  const manual = await many(tx, `SELECT j.id, j.no, j.date, j.memo, j.created_by, extract(dow FROM j.date)::int AS dow, max(l.debit)::float AS biggest,
        bool_or(l.debit >= 10000 AND mod(l.debit, 1000) = 0) AS round
      FROM fin.journals j JOIN fin.journal_lines l ON l.journal_id = j.id
     WHERE j.company_id = $1 AND j.type = 'manual' AND j.status = 'posted' AND j.date BETWEEN $2 AND $3 GROUP BY j.id`, [companyId, from, to]);
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (const j of manual) {
    const ref = [{ type: 'fin.journal', id: j.id, no: j.no }];
    if (weekend.includes(j.dow)) add('weekend_journal', j.id, `${j.no} dated ${dayName[j.dow]} ${j.date.toISOString().slice(0, 10)}: ${j.memo}`, j.biggest, ref, [j.created_by]);
    if (j.round) add('round_amount', j.id, `${j.no}: ${j.memo}, largest line ${j.biggest.toFixed(2)}`, j.biggest, ref, [j.created_by]);
  }

  // Late postings
  const late = await many(tx, `SELECT j.id, j.no, j.type, j.date, j.posted_at::date AS posted, (j.posted_at::date - j.date) AS lag, j.created_by,
        (SELECT sum(debit)::float FROM fin.journal_lines WHERE journal_id = j.id) AS amount
      FROM fin.journals j WHERE j.company_id = $1 AND j.status = 'posted' AND j.type IN ('manual','sales_invoice','sales_credit','purchase_invoice','purchase_credit','receipt','payment','write_off','reversal') AND j.date BETWEEN $2 AND $3
       AND j.posted_at IS NOT NULL AND j.posted_at::date - j.date > 30`, [companyId, from, to]);
  for (const j of late) add('late_posting', j.id, `${j.no} (${j.type}) dated ${j.date.toISOString().slice(0, 10)}, posted ${j.lag} days later`, j.amount, [{ type: 'fin.journal', id: j.id, no: j.no }], [j.created_by]);

  // Customer credit ratio
  const credits = await many(tx, `SELECT p.id, p.name,
        coalesce(sum(i.net_total * i.fx_rate) FILTER (WHERE i.kind = 'sales_invoice'), 0)::float AS sales,
        coalesce(sum(i.net_total * i.fx_rate) FILTER (WHERE i.kind = 'sales_credit'), 0)::float AS credits
      FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id
     WHERE i.company_id = $1 AND i.status = 'posted' AND i.kind IN ('sales_invoice','sales_credit') AND i.date BETWEEN $2 AND $3 GROUP BY p.id, p.name`, [companyId, from, to]);
  for (const c of credits) {
    if (c.credits >= 1000 && c.credits > 0.2 * c.sales) {
      add('credit_ratio', `${c.id}:${from}:${to}`, `${c.name}: credit notes ${c.credits.toFixed(2)} against sales ${c.sales.toFixed(2)} (${c.sales ? Math.round(c.credits / c.sales * 100) : 100}%)`,
        c.credits, [{ type: 'mdm.party', id: c.id, no: null }]);
    }
  }

  // Unmatched supplier payments
  const pays = await many(tx, `SELECT y.id, y.no, y.date, y.created_by, p.name, y.currency,
        (y.amount - coalesce((SELECT sum(a.amount) FROM fin.allocations a WHERE a.payment_id = y.id), 0))::float AS open
      FROM fin.payments y JOIN mdm.parties p ON p.id = y.party_id
     WHERE y.company_id = $1 AND y.kind = 'payment' AND y.date BETWEEN $2 AND $3 AND y.date < $3::date - 30`, [companyId, from, to]);
  for (const y of pays) if (y.open > 0.005) add('unallocated_payment', y.id, `${y.no} to ${y.name} on ${y.date.toISOString().slice(0, 10)}: ${y.open.toFixed(2)} ${y.currency} not matched to any bill`, y.open, [{ type: 'fin.payment', id: y.id, no: y.no }], [y.created_by]);

  // Benford's law on first digits of bills and supplier payments
  const amounts = await many(tx, `SELECT gross_total::float AS v FROM fin.invoices WHERE company_id = $1 AND kind = 'purchase_invoice' AND status = 'posted' AND date BETWEEN $2 AND $3 AND gross_total >= 10
                                  UNION ALL SELECT amount::float FROM fin.payments WHERE company_id = $1 AND kind = 'payment' AND date BETWEEN $2 AND $3 AND amount >= 10`, [companyId, from, to]);
  const counts = Array(10).fill(0);
  for (const a of amounts) counts[Number(String(Math.floor(a.v))[0])]++;
  const n = amounts.length;
  const digits = BENFORD.slice(1).map((e, i) => ({ digit: i + 1, expectedPct: Math.round(e * 1000) / 10, actualPct: n ? Math.round(counts[i + 1] / n * 1000) / 10 : 0 }));
  const mad = n ? digits.reduce((s, d) => s + Math.abs(d.actualPct - d.expectedPct) / 100, 0) / 9 : null;
  const benford = { sample: n, enough: n >= 100, mad: mad === null ? null : Math.round(mad * 10000) / 10000, threshold: 0.015, digits };
  if (n >= 100 && mad! > 0.015) add('benford', `${from}:${to}`, `First digits of ${n} bills and payments deviate from Benford's law (mean absolute deviation ${benford.mad}, above 0.015)`, null, []);
  return { list: out, benford };
}

export async function anomalyScan(tx: Tx, ctx: Ctx, companyId: string, from: string, to: string) {
  await authorize(tx, ctx, 'bi.anomaly.review', { unitId: companyId });
  if (from > to) throw new ValidationError('the period ends before it starts');
  const { list, benford } = await findings(tx, companyId, from, to);
  const reviews = await many(tx, `SELECT r.rule, r.finding_key, r.outcome, r.note, r.reviewed_at, u.display_name AS reviewer FROM bi.anomaly_reviews r
                                   JOIN iam.users u ON u.id = r.reviewed_by WHERE r.company_id = $1`, [companyId]);
  const order = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  const rows = list.map(({ createdBy: _c, ...f }) => ({ ...f, review: reviews.find((r) => r.rule === f.rule && r.finding_key === f.key) ?? null }))
    .sort((a, b) => Number(!!a.review) - Number(!!b.review) || order[a.severity] - order[b.severity] || (b.amount ?? 0) - (a.amount ?? 0));
  const byRule = Object.entries(RULES).map(([code, r]) => ({ code, ...r, found: rows.filter((x) => x.rule === code).length, open: rows.filter((x) => x.rule === code && !x.review).length }));
  return { from, to, findings: rows, rules: byRule, benford, open: rows.filter((r) => !r.review).length };
}

/** Record the outcome of a review. A finding about your own document cannot be explained away by you. */
export async function reviewFinding(tx: Tx, ctx: Ctx, companyId: string, input: { rule: string; key: string; outcome: 'explained' | 'confirmed'; note: string; from: string; to: string }) {
  await authorize(tx, ctx, 'bi.anomaly.review', { unitId: companyId });
  if (!RULES[input.rule]) throw new ValidationError(`unknown rule ${input.rule}`);
  if (!input.note?.trim()) throw new ValidationError('say what you found');
  const f = (await findings(tx, companyId, input.from, input.to)).list.find((x) => x.rule === input.rule && x.key === input.key);
  if (!f) throw new ValidationError('that finding is not in the period checked');
  if (input.outcome === 'explained' && f.createdBy.includes(ctx.userId!)) {
    throw new ForbiddenError('bi.anomaly.review', { unitId: companyId }, 'someone other than the person who entered the document must explain it');
  }
  const done = await one(tx, 'SELECT 1 FROM bi.anomaly_reviews WHERE company_id = $1 AND rule = $2 AND finding_key = $3', [companyId, input.rule, input.key]);
  if (done) throw new ConflictError('this finding has already been reviewed');
  return one(tx, `INSERT INTO bi.anomaly_reviews (tenant_id, company_id, rule, finding_key, outcome, note, reviewed_by) VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
    [companyId, input.rule, input.key, input.outcome, input.note.trim(), ctx.userId]);
}
