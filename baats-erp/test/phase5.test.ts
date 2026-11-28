import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { one, type Ctx } from '../src/core/db.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../src/core/errors.ts';
import * as setup from '../src/fin/setup.ts';
import * as docs from '../src/fin/documents.ts';
import * as ledger from '../src/fin/ledger.ts';
import * as reports from '../src/fin/reports.ts';
import * as flt from '../src/flt/service.ts';
import * as kpi from '../src/bi/kpi.ts';
import * as rep from '../src/bi/reports.ts';
import * as strat from '../src/bi/strategy.ts';
import * as esg from '../src/bi/esg.ts';
import * as anom from '../src/bi/anomaly.ts';
import { buildServer } from '../src/api/server.ts';
import { createTestDb, giveRole, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

let t: TestDb;
let s: Seed;
let co: string;
let admin: Ctx, mgr: Ctx, rep1: Ctx, uk: Ctx;
let customer: string, customer2: string, supplier: string;

const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);
const balance = (codes: string[], to: string) => tx(admin, async (q) =>
  Number((await one(q, `SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM fin.journal_lines l
     JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
    WHERE a.company_id = $1 AND a.code = ANY($2) AND j.date <= $3`, [co, codes, to])).b));
async function party(code: string, isCustomer: boolean) {
  return tx(admin, async (q) => (await one(q, `INSERT INTO mdm.parties (tenant_id, code, name, normalized_name, is_customer, is_supplier, country_code, currency_code, owner_unit_id, status)
    VALUES (app.tenant(), $1, $1, lower($1), $2, $3, 'AE', 'AED', $4, 'active') RETURNING id`, [code, isCustomer, !isCustomer, co])).id as string);
}
async function invoice(input: Omit<docs.InvoiceInput, 'companyId'>) {
  const d = await tx(admin, (q) => docs.createInvoice(q, admin, { companyId: co, ...input }));
  return tx(admin, (q) => docs.postInvoice(q, admin, d.id));
}

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  co = s.units.uae;
  admin = s.adminCtx;
  mgr = s.ctxOf(s.people.finMgr.userId);
  rep1 = s.ctxOf(s.people.salesRep.userId);
  uk = s.ctxOf(s.people.ukStaff.userId);
  await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: co, legalName: 'Acme UAE LLC', openFrom: '2026-01-01' }));
  // The finance manager reads the books and reviews anomalies; the sales rep sees the dashboard but not the books; UK staff read only the UK books.
  await giveRole(t.db, s, s.people.finMgr.userId, 'CONTROLLER', { 'fin.report.read': {}, 'bi.dashboard': {}, 'bi.report.manage': {}, 'bi.anomaly.review': {}, 'bi.esg.manage': {} }, s.units.root);
  await giveRole(t.db, s, s.people.salesRep.userId, 'VIEWER', { 'bi.dashboard': {}, 'crm.manage': {}, 'bi.report.manage': {} }, co);
  await giveRole(t.db, s, s.people.ukStaff.userId, 'UK_FINANCE', { 'fin.report.read': {}, 'bi.report.manage': {} }, s.units.uk);
  customer = await party('Gulf Retail', true);
  customer2 = await party('Desert Foods', true);
  supplier = await party('Office Hub', false);
  await tx(admin, (q) => ledger.post(q, admin, { companyId: co, type: 'manual', date: '2026-01-02', memo: 'Capital', lines: [{ account: '1010', debit: 100000 }, { account: '3000', credit: 100000 }] }));
  const jan = await invoice({ kind: 'sales_invoice', partyId: customer, date: '2026-01-15', dueDate: '2026-02-14', lines: [{ description: 'Consulting', quantity: 10, unitPrice: 1000, taxCode: 'SR' }] });
  await invoice({ kind: 'sales_invoice', partyId: customer2, date: '2026-02-10', dueDate: '2026-03-12', lines: [{ description: 'Consulting', quantity: 5, unitPrice: 1000, taxCode: 'SR' }] });
  await invoice({ kind: 'sales_invoice', partyId: customer, date: '2026-03-05', dueDate: '2026-04-04', lines: [{ description: 'Training', quantity: 1, unitPrice: 6000, taxCode: 'SR' }] });
  await invoice({ kind: 'purchase_invoice', partyId: supplier, supplierRef: 'OH-1001', date: '2026-02-01', lines: [{ description: 'Paper', quantity: 1, unitPrice: 2000, taxCode: 'SR', account: '5500' }] });
  await tx(admin, (q) => ledger.post(q, admin, { companyId: co, type: 'manual', date: '2026-03-10', memo: 'Subcontracted delivery cost', lines: [{ account: '5050', debit: 4000 }, { account: '1010', credit: 4000 }] }));
  await tx(admin, (q) => docs.recordPayment(q, admin, { companyId: co, kind: 'receipt', partyId: customer, date: '2026-02-20', bankAccount: '1010', amount: 10500, allocations: [{ invoiceId: jan.id, amount: 10500 }] }));
});
after(async () => { await t.drop(); });

describe('KPI engine', () => {
  it('agrees with the profit and loss and the balance sheet', async () => {
    const pl = await tx(admin, (q) => reports.profitAndLoss(q, admin, co, '2026-01-01', '2026-03-31'));
    const v = (code: string, from = '2026-01-01', to = '2026-03-31') => tx(admin, (q) => kpi.kpiValue(q, admin, co, code, from, to));
    assert.equal(await v('revenue'), pl.totalRevenue);
    assert.equal(await v('revenue'), 21000);
    assert.equal(await v('gross_profit'), pl.grossProfit);
    assert.equal(await v('net_profit'), pl.netProfit);
    assert.equal(await v('net_profit'), 21000 - 4000 - 2000);
    assert.equal(await v('gross_margin_pct'), Math.round((21000 - 4000) / 21000 * 10000) / 100);
    assert.equal(await v('cash'), await balance(['1000', '1010'], '2026-03-31'));
    assert.equal(await v('receivables'), await balance(['1100'], '2026-03-31'));
    assert.equal(await v('receivables'), 22050 - 10500);
    // Overdue at 31 March: the February invoice to Desert Foods (5,250 due 12 March); the paid January one is settled.
    assert.equal(await v('overdue_receivables'), 5250);
    // DSO = receivables / revenue x days
    assert.equal(await v('dso'), Math.round(11550 / 21000 * 90));
    assert.equal(await v('purchases'), 2000);
  });
  it('builds monthly trends that add up to the year to date', async () => {
    const tr = await tx(admin, (q) => kpi.kpiTrend(q, admin, co, 'revenue', '2026-03-31', 3));
    assert.deepEqual(tr.points.map((p: any) => [p.month, p.value]), [['2026-01', 10000], ['2026-02', 5000], ['2026-03', 6000]]);
    await assert.rejects(tx(admin, (q) => kpi.kpiTrend(q, admin, co, 'no_such_kpi', '2026-03-31')), ValidationError);
  });
  it('shows each person only the KPIs their roles allow', async () => {
    const full: any = await tx(admin, (q) => kpi.dashboard(q, admin, co, '2026-03-31'));
    assert.ok(full.kpis.find((k: any) => k.code === 'revenue'));
    assert.equal(full.trend.length, 12);
    assert.equal(full.trend.at(-1).revenue, 6000);
    assert.deepEqual(full.topCustomers[0], { name: 'Gulf Retail', revenue: 16000 });
    const r = full.kpis.find((k: any) => k.code === 'revenue');
    assert.deepEqual([r.mtd, r.mtdPrior, r.ytd], [6000, 5000, 21000]);
    // The sales rep may see the dashboard, but not the books: no finance KPIs, trend or customers.
    const limited = await tx(rep1, (q) => kpi.dashboard(q, rep1, co, '2026-03-31'));
    assert.ok(!limited.kpis.find((k: any) => k.module === 'finance'));
    assert.ok(limited.kpis.find((k: any) => k.code === 'pipeline'));
    assert.equal(limited.trend, null);
    assert.ok(limited.hidden > 20);
    await assert.rejects(tx(rep1, (q) => kpi.kpiValue(q, rep1, co, 'revenue', '2026-01-01', '2026-03-31')), ForbiddenError);
    await assert.rejects(tx(uk, (q) => kpi.dashboard(q, uk, co, '2026-03-31')), ForbiddenError);
  });
});

describe('report builder', () => {
  it('groups, totals and filters over the catalogue only', async () => {
    const r = await tx(mgr, (q) => rep.runReport(q, mgr, 'sales_invoices', { groupBy: ['customer'], measures: [{ field: 'net', agg: 'sum' }, { field: 'no', agg: 'count' }], sort: [{ by: 'sum_net', dir: 'desc' }] }));
    assert.deepEqual(r.rows, [{ customer: 'Gulf Retail', sum_net: 16000, count_no: 2 }, { customer: 'Desert Foods', sum_net: 5000, count_no: 1 }]);
    assert.equal(r.totals.sum_net, 21000);
    const gl = await tx(mgr, (q) => rep.runReport(q, mgr, 'gl_lines', { groupBy: ['account_code'], measures: [{ field: 'net', agg: 'sum' }], filters: [{ field: 'account_type', op: 'eq', value: 'revenue' }] }));
    assert.equal(gl.totals.sum_net, -21000);
    // Values are data, never SQL.
    const none = await tx(mgr, (q) => rep.runReport(q, mgr, 'sales_invoices', { columns: ['no'], filters: [{ field: 'customer', op: 'contains', value: "x' OR '1'='1" }] }));
    assert.equal(none.rows.length, 0);
    await assert.rejects(tx(mgr, (q) => rep.runReport(q, mgr, 'sales_invoices', { columns: ['no; DROP TABLE fin.invoices'] })), ValidationError);
    await assert.rejects(tx(mgr, (q) => rep.runReport(q, mgr, 'sales_invoices', { columns: ['no'], sort: [{ by: 'customer' }] })), ValidationError);
    await assert.rejects(tx(mgr, (q) => rep.runReport(q, mgr, 'sales_invoices', { groupBy: ['customer'], measures: [{ field: 'customer', agg: 'sum' }] })), ValidationError);
    await assert.rejects(tx(mgr, (q) => rep.runReport(q, mgr, 'pg_catalog', { columns: ['x'] })), ValidationError);
  });
  it('returns only rows from units the user may see', async () => {
    const r = await tx(uk, (q) => rep.runReport(q, uk, 'gl_lines', { columns: ['journal_no', 'net'] }));
    assert.equal(r.rows.length, 0);
    await assert.rejects(tx(rep1, (q) => rep.runReport(q, rep1, 'gl_lines', { columns: ['journal_no'] })), ForbiddenError);
    const sets = await tx(rep1, (q) => rep.datasetCatalog(q, rep1));
    assert.ok(!sets.find((d: any) => d.code === 'gl_lines'));
  });
  it('saves and shares reports; only the owner changes them', async () => {
    const saved = await tx(mgr, (q) => rep.saveReport(q, mgr, { name: 'Revenue by month', dataset: 'sales_invoices', shared: true,
      spec: { groupBy: ['month'], measures: [{ field: 'net', agg: 'sum' }] } }));
    await assert.rejects(tx(mgr, (q) => rep.saveReport(q, mgr, { name: 'Bad', dataset: 'sales_invoices', spec: { columns: ['nope'] } })), ValidationError);
    const seenByUk = await tx(uk, (q) => rep.listReports(q, uk));
    assert.ok(seenByUk.find((x: any) => x.id === saved.id));
    const ran = await tx(uk, (q) => rep.runSaved(q, uk, saved.id));
    assert.equal(ran.rows.length, 0);   // same report, UK scope: no UAE rows
    assert.ok(!(await tx(rep1, (q) => rep.listReports(q, rep1))).find((x: any) => x.id === saved.id));
    await assert.rejects(tx(uk, (q) => rep.deleteReport(q, uk, saved.id)), ForbiddenError);
    const mine = await tx(mgr, (q) => rep.runSaved(q, mgr, saved.id));
    assert.deepEqual(mine.rows.map((r: any) => [r.month, r.sum_net]), [['2026-01', 10000], ['2026-02', 5000], ['2026-03', 6000]]);
    const csv = rep.toCsv({ columns: [{ key: 'a', label: 'Name' }, { key: 'b', label: 'Amount' }], rows: [{ a: '=HYPERLINK("http://x")', b: -5 }, { a: 'Plain, "quoted"', b: 3.5 }] });
    assert.equal(csv, 'Name,Amount\r\n"\'=HYPERLINK(""http://x"")",-5\r\n"Plain, ""quoted""",3.5\r\n');
  });
});

describe('strategy scorecard', () => {
  it('judges additive KPIs pro rata and rates as they stand', async () => {
    assert.equal(strat.rag('up', 95, 100, 10), 'amber');
    assert.equal(strat.rag('up', 89, 100, 10), 'red');
    assert.equal(strat.rag('down', 104, 100, 5), 'amber');
    assert.equal(strat.rag('down', 99, 100, 5), 'green');
    const o = await tx(admin, (q) => strat.createObjective(q, admin, { companyId: co, code: 'F1', title: 'Grow profitably', perspective: 'financial' }));
    await tx(admin, (q) => strat.setTarget(q, admin, o.id, { kpiCode: 'revenue', year: 2026, target: 100000 }));
    await tx(admin, (q) => strat.setTarget(q, admin, o.id, { kpiCode: 'gross_margin_pct', year: 2026, target: 85, tolerancePct: 5 }));
    await assert.rejects(tx(admin, (q) => strat.setTarget(q, admin, o.id, { kpiCode: 'receivables', year: 2026, target: 1 })), ValidationError);
    const sc = await tx(admin, (q) => strat.scorecard(q, admin, co, 2026, '2026-03-31'));
    const m: any[] = sc.objectives[0].measures;
    const revenue = m.find((x: any) => x.kpi === 'revenue');
    // 90 of 365 days: 24,657.53 due, 21,000 actual: within 10%? no, 14.8% short, so red; projected 85,166.67.
    assert.equal(revenue.dueToDate, Math.round(100000 * 90 / 365 * 100) / 100);
    assert.equal(revenue.status, 'red');
    assert.equal(revenue.projected, Math.round(21000 / (90 / 365) * 100) / 100);
    const margin = m.find((x: any) => x.kpi === 'gross_margin_pct');
    assert.equal(margin.dueToDate, 85);
    assert.equal(margin.status, 'amber');   // 80.95% is within 5% of 85
    assert.equal(sc.objectives[0].status, 'red');
    // The sales rep may see the scorecard but not the finance measures.
    const limited = await tx(rep1, (q) => strat.scorecard(q, rep1, co, 2026, '2026-03-31'));
    assert.equal(limited.objectives[0].measures.length, 0);
    assert.equal(limited.summary.hidden, 2);
  });
});

describe('ESG', () => {
  it('turns fuel and meter readings into scope 1 and 2 emissions', async () => {
    const v = await tx(admin, (q) => flt.createVehicle(q, admin, { companyId: co, code: 'V1', plateNo: 'DXB 1', fuelType: 'diesel', odometer: 1000 }));
    await tx(admin, (q) => flt.logFuel(q, admin, { vehicleId: v.id, date: '2026-03-03', odometer: 1500, litres: 100, amount: 315, vatAmount: 15, paidFrom: '1010' }));
    await tx(mgr, (q) => esg.recordReading(q, mgr, co, { month: '2026-03', metric: 'electricity_kwh', value: 8000 }));
    await tx(mgr, (q) => esg.recordReading(q, mgr, co, { month: '2026-03', metric: 'electricity_kwh', value: 10000, note: 'Corrected meter reading' }));
    await tx(mgr, (q) => esg.recordReading(q, mgr, co, { month: '2026-03', metric: 'waste_kg', value: 300 }));
    await tx(mgr, (q) => esg.recordReading(q, mgr, co, { month: '2026-03', metric: 'recycled_kg', value: 100 }));
    await assert.rejects(tx(mgr, (q) => esg.recordReading(q, mgr, co, { month: '2026-03', metric: 'unicorns', value: 1 })), ValidationError);
    let r = await tx(mgr, (q) => esg.esgReport(q, mgr, co, '2026-01-01', '2026-03-31'));
    assert.equal(r.totals.electricity_kwh, 10000);
    assert.equal(r.totals.scope1, 0.268);
    assert.equal(r.totals.scope2, 4);
    assert.equal(r.recycledPct, 25);
    assert.equal(r.intensity.perMillionRevenue, Math.round(4.268 / 0.021 * 1000) / 1000);
    await tx(mgr, (q) => esg.setFactor(q, mgr, co, { key: 'grid_kg_per_kwh', value: 0.5, source: 'Utility sustainability report 2025' }));
    r = await tx(mgr, (q) => esg.esgReport(q, mgr, co, '2026-01-01', '2026-03-31'));
    assert.equal(r.totals.scope2, 5);
    assert.equal(r.factors.grid_kg_per_kwh.overridden, true);
    assert.equal(await tx(mgr, (q) => kpi.kpiValue(q, mgr, co, 'emissions', '2026-01-01', '2026-03-31')), 5.268);
    await assert.rejects(tx(rep1, (q) => esg.esgReport(q, rep1, co, '2026-01-01', '2026-03-31')), ForbiddenError);
  });
});

describe('anomaly checks', () => {
  it('finds duplicates and unusual journals, and needs an independent reviewer', async () => {
    await invoice({ kind: 'purchase_invoice', partyId: supplier, supplierRef: 'OH-1002', date: '2026-02-08', lines: [{ description: 'Paper', quantity: 1, unitPrice: 2000, taxCode: 'SR', account: '5500' }] });
    await invoice({ kind: 'purchase_invoice', partyId: supplier, supplierRef: 'oh 1001', date: '2026-03-20', lines: [{ description: 'Toner', quantity: 1, unitPrice: 750, taxCode: 'SR', account: '5500' }] });
    // Saturday 7 March 2026, a round 20,000 manual entry by the administrator.
    await tx(admin, (q) => ledger.post(q, admin, { companyId: co, type: 'manual', date: '2026-03-07', memo: 'Year-end estimate', lines: [{ account: '5900', debit: 20000 }, { account: '2200', credit: 20000 }] }));
    const scan = await tx(mgr, (q) => anom.anomalyScan(q, mgr, co, '2026-01-01', '2026-03-31'));
    const dups = scan.findings.filter((f: any) => f.rule === 'duplicate_bill');
    assert.equal(dups.length, 2);   // same amount within 14 days, and the same reference written differently
    assert.ok(dups.some((f: any) => /same supplier reference/.test(f.detail)));
    const weekend = scan.findings.find((f: any) => f.rule === 'weekend_journal');
    assert.ok(weekend && /Saturday/.test(weekend.detail));
    assert.ok(scan.findings.find((f: any) => f.rule === 'round_amount' && f.key === weekend.key));
    assert.equal(scan.findings.filter((f: any) => f.rule === 'weekend_journal').length, 1);
    assert.equal(scan.benford.enough, false);
    // The administrator entered the journal, so cannot explain it away; the finance manager can.
    const input = { rule: 'weekend_journal', key: weekend.key, outcome: 'explained' as const, note: 'Approved accrual', from: '2026-01-01', to: '2026-03-31' };
    await tx(admin, async (q) => { await assert.rejects(anom.reviewFinding(q, admin, co, input), ForbiddenError); });
    await tx(mgr, (q) => anom.reviewFinding(q, mgr, co, input));
    await assert.rejects(tx(mgr, (q) => anom.reviewFinding(q, mgr, co, input)), ConflictError);
    await assert.rejects(tx(mgr, (q) => anom.reviewFinding(q, mgr, co, { ...input, key: 'made-up' })), ValidationError);
    const again = await tx(mgr, (q) => anom.anomalyScan(q, mgr, co, '2026-01-01', '2026-03-31'));
    assert.equal(again.findings.find((f: any) => f.key === weekend.key && f.rule === 'weekend_journal')?.review?.outcome, 'explained');
    assert.equal(again.open, scan.open - 1);
    await assert.rejects(tx(rep1, (q) => anom.anomalyScan(q, rep1, co, '2026-01-01', '2026-03-31')), ForbiddenError);
  });
});

describe('Phase 5 API', () => {
  it('serves the dashboard, reports as CSV, scorecards, ESG and anomalies', async () => {
    const app = buildServer({ db: t.db, platformAdminKey: 'k' });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `finmgr@${s.code}.test`, password: PASSWORD } });
    const h = { authorization: `Bearer ${login.json().token}` };
    for (const url of [`/v1/bi/companies/${co}/dashboard?asOf=2026-03-31`, `/v1/bi/companies/${co}/kpis`, `/v1/bi/companies/${co}/kpis/revenue/trend?asOf=2026-03-31&months=3`,
      '/v1/bi/datasets', '/v1/bi/reports', `/v1/bi/companies/${co}/scorecard?year=2026&asOf=2026-03-31`, `/v1/bi/companies/${co}/esg?from=2026-01-01&to=2026-03-31`,
      `/v1/bi/companies/${co}/anomalies?from=2026-01-01&to=2026-03-31`]) {
      const r = await app.inject({ method: 'GET', url, headers: h });
      assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
    }
    const kv = await app.inject({ method: 'GET', url: `/v1/bi/companies/${co}/kpis/revenue?from=2026-01-01&to=2026-03-31`, headers: h });
    assert.equal(kv.json().value, 21000);
    const csv = await app.inject({ method: 'POST', url: '/v1/bi/query.csv', headers: h, payload: { dataset: 'sales_invoices', spec: { groupBy: ['customer'], measures: [{ field: 'net', agg: 'sum' }] } } });
    assert.match(csv.headers['content-type'] as string, /text\/csv/);
    assert.match(csv.body, /Gulf Retail,16000/);
    const bad = await app.inject({ method: 'POST', url: '/v1/bi/query', headers: h, payload: { dataset: 'sales_invoices', spec: { filters: [{ field: 'no', op: 'raw_sql' }] } } });
    assert.equal(bad.statusCode, 400);
    await app.close();
  });
  it('keeps the books balanced', async () => {
    assert.equal((await tx(admin, (q) => reports.trialBalance(q, admin, co, '2026-12-31'))).balanced, true);
  });
});
