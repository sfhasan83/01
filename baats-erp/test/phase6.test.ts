import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { one, type Ctx } from '../src/core/db.ts';
import { ForbiddenError, ValidationError } from '../src/core/errors.ts';
import * as setup from '../src/fin/setup.ts';
import * as docs from '../src/fin/documents.ts';
import * as ledger from '../src/fin/ledger.ts';
import * as tax from '../src/fin/tax.ts';
import * as einv from '../src/fin/einvoice.ts';
import * as country from '../src/fin/country.ts';
import { FIRST_PIH, invoiceHash, readQr, withoutQr } from '../src/fin/zatca.ts';
import * as hr from '../src/hr/service.ts';
import * as org from '../src/org/service.ts';
import * as dash from '../src/bi/dashboard.ts';
import * as kpi from '../src/bi/kpi.ts';
import { buildServer } from '../src/api/server.ts';
import { createTestDb, giveRole, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

let t: TestDb;
let s: Seed;
let co: string, ksa: string;
let admin: Ctx, rep1: Ctx, mgr: Ctx;
let customer: string, customer2: string, supplier: string;

const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);
const balance = (company: string, codes: string[], to = '2026-12-31') => tx(admin, async (q) =>
  Number((await one(q, `SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM fin.journal_lines l
     JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
    WHERE a.company_id = $1 AND a.code = ANY($2) AND j.date <= $3`, [company, codes, to])).b));
async function party(code: string, isCustomer: boolean, owner: string, ctry = 'AE', cur = 'AED', extra: { trn?: string; attributes?: object } = {}) {
  return tx(admin, async (q) => (await one(q, `INSERT INTO mdm.parties (tenant_id, code, name, normalized_name, is_customer, is_supplier, country_code, currency_code,
      owner_unit_id, status, tax_registration_no, attributes)
    VALUES (app.tenant(), $1, $1, lower($1), $2, $3, $4, $5, $6, 'active', $7, $8) RETURNING id`,
  [code, isCustomer, !isCustomer, ctry, cur, owner, extra.trn ?? null, JSON.stringify(extra.attributes ?? {})])).id as string);
}
async function invoice(companyId: string, input: Omit<docs.InvoiceInput, 'companyId'>) {
  const d = await tx(admin, (q) => docs.createInvoice(q, admin, { companyId, ...input }));
  return tx(admin, (q) => docs.postInvoice(q, admin, d.id));
}

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  co = s.units.uae;
  admin = s.adminCtx;
  mgr = s.ctxOf(s.people.finMgr.userId);
  rep1 = s.ctxOf(s.people.salesRep.userId);
  await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: co, legalName: 'Acme UAE LLC', openFrom: '2026-01-01' }));
  await giveRole(t.db, s, s.people.finMgr.userId, 'CONTROLLER', { 'fin.report.read': {}, 'bi.dashboard': {} }, s.units.root);
  await giveRole(t.db, s, s.people.salesRep.userId, 'VIEWER', { 'bi.dashboard': {}, 'crm.manage': {} }, co);
  customer = await party('Gulf Retail', true, co);
  customer2 = await party('Desert Foods', true, co);
  supplier = await party('Office Hub', false, co);
  await tx(admin, (q) => ledger.post(q, admin, { companyId: co, type: 'manual', date: '2026-01-02', memo: 'Capital', lines: [{ account: '1010', debit: 100000 }, { account: '3000', credit: 100000 }] }));
  const jan = await invoice(co, { kind: 'sales_invoice', partyId: customer, date: '2026-01-15', dueDate: '2026-02-14', lines: [{ description: 'Consulting', quantity: 10, unitPrice: 1000, taxCode: 'SR' }] });
  await invoice(co, { kind: 'sales_invoice', partyId: customer2, date: '2026-02-10', dueDate: '2026-03-12', lines: [{ description: 'Consulting', quantity: 5, unitPrice: 1000, taxCode: 'SR' }] });
  await invoice(co, { kind: 'sales_invoice', partyId: customer, date: '2026-03-05', dueDate: '2026-04-04', lines: [{ description: 'Training', quantity: 1, unitPrice: 6000, taxCode: 'SR' }] });
  await invoice(co, { kind: 'purchase_invoice', partyId: supplier, supplierRef: 'OH-1001', date: '2026-02-01', lines: [{ description: 'Paper', quantity: 1, unitPrice: 2000, taxCode: 'SR', account: '5500' }] });
  await tx(admin, (q) => docs.recordPayment(q, admin, { companyId: co, kind: 'receipt', partyId: customer, date: '2026-02-20', bankAccount: '1010', amount: 10500, allocations: [{ invoiceId: jan.id, amount: 10500 }] }));

  // A Saudi company beside the UAE one.
  ksa = await tx(admin, async (q) => (await org.createUnit(q, admin, { typeCode: 'company', parentId: s.units.root, code: 'SA01', name: 'Acme KSA', countryCode: 'SA', currencyCode: 'SAR' })).id);
});
after(async () => { await t.drop(); });

describe('interactive dashboard', () => {
  it('turns presets into dates on the financial year, and finds the comparison period', async () => {
    const r = (p: dash.Preset) => tx(admin, (q) => dash.resolvePeriod(q, co, p, '2026-05-20'));
    assert.deepEqual(await r('this_month'), ['2026-05-01', '2026-05-20']);
    assert.deepEqual(await r('last_month'), ['2026-04-01', '2026-04-30']);
    assert.deepEqual(await r('this_quarter'), ['2026-04-01', '2026-05-20']);
    assert.deepEqual(await r('last_quarter'), ['2026-01-01', '2026-03-31']);
    assert.deepEqual(await r('this_year'), ['2026-01-01', '2026-05-20']);
    assert.deepEqual(await r('last_year'), ['2025-01-01', '2025-12-31']);
    assert.deepEqual(await r('last_12_months'), ['2025-06-01', '2026-05-20']);
    // Whole months compare with the same number of whole months before; other spans with the same number of days.
    assert.deepEqual(dash.comparisonRange('2026-02-01', '2026-03-31', 'previous_period'), ['2025-12-01', '2026-01-31']);
    assert.deepEqual(dash.comparisonRange('2026-03-10', '2026-03-19', 'previous_period'), ['2026-02-28', '2026-03-09']);
    assert.deepEqual(dash.comparisonRange('2028-02-01', '2028-02-29', 'previous_year'), ['2027-02-01', '2027-02-28']);
    assert.equal(dash.comparisonRange('2026-01-01', '2026-01-31', 'none'), null);
    assert.throws(() => dash.checkRange('2026-03-01', '2026-02-01'), /starts after it ends/);
    assert.throws(() => dash.checkRange('2026-02-30', '2026-03-01'), /real dates/);
    assert.throws(() => dash.checkRange('2020-01-01', '2026-03-01'), /three years/);
  });

  it('gives every visible KPI for any period with its comparison and whether it is good news', async () => {
    const a = await tx(mgr, (q) => dash.analyze(q, mgr, co, { from: '2026-02-01', to: '2026-03-31', compare: 'previous_period' }));
    assert.deepEqual(a.prior, ['2025-12-01', '2026-01-31']);
    const rev = a.kpis.find((k) => k.code === 'revenue')!;
    assert.equal(rev.value, 11000);
    assert.equal(rev.prior, 10000);
    assert.equal(rev.changePct, 10);
    assert.equal(rev.verdict, 'better');
    const opex = a.kpis.find((k) => k.code === 'operating_expenses')!;
    assert.equal(opex.value, 2000);
    assert.equal(opex.verdict, 'worse');
    // The same numbers as the single-KPI call.
    assert.equal(rev.value, await tx(mgr, (q) => kpi.kpiValue(q, mgr, co, 'revenue', '2026-02-01', '2026-03-31')));
    // Only chosen tiles, with monthly sparklines.
    const b = await tx(mgr, (q) => dash.analyze(q, mgr, co, { from: '2026-01-01', to: '2026-03-31', compare: 'none', codes: ['revenue', 'cash'], spark: true }));
    assert.deepEqual(b.kpis.map((k) => k.code), ['revenue', 'cash']);
    assert.deepEqual(b.kpis[0].spark!.map((p) => p.value), [10000, 5000, 6000]);
    assert.equal(b.kpis[0].prior, null);
    await assert.rejects(tx(mgr, (q) => dash.analyze(q, mgr, co, { codes: ['nope'] })), /unknown KPI/);
  });

  it('drills from a KPI to its trend, breakdowns and the records behind it', async () => {
    const d = await tx(mgr, (q) => dash.kpiDrill(q, mgr, co, 'revenue', { from: '2026-01-01', to: '2026-03-31', compare: 'previous_year' }));
    assert.equal(d.value, 21000);
    assert.deepEqual(d.trend!.map((p) => [p.month, p.value, p.compare, p.inRange]), [['2026-01', 10000, 0, true], ['2026-02', 5000, 0, true], ['2026-03', 6000, 0, true]]);
    const byCustomer = d.breakdowns.find((b) => b.key === 'customer')!;
    assert.deepEqual(byCustomer.rows.map((r) => [r.label, r.value, r.share]), [['Gulf Retail', 16000, 76.2], ['Desert Foods', 5000, 23.8]]);
    assert.equal(d.breakdowns.find((b) => b.key === 'account')!.rows.reduce((x, r) => x + r.value, 0), d.value);
    assert.equal(d.records!.total, 3);
    assert.equal(d.records!.rows.reduce((x, r) => x + (r.amount as number), 0), 21000);

    // A one-month period shows six months up to it, marking the month itself.
    const m = await tx(mgr, (q) => dash.kpiDrill(q, mgr, co, 'revenue', { from: '2026-03-01', to: '2026-03-31', compare: 'previous_period' }));
    assert.equal(m.trend!.length, 6);
    assert.deepEqual(m.trend!.filter((p) => p.inRange).map((p) => p.month), ['2026-03']);
    assert.equal(m.trend!.at(-1)!.compare, 5000);

    // Receivables break down to the open invoices; overdue ones by how late.
    const r = await tx(mgr, (q) => dash.kpiDrill(q, mgr, co, 'receivables', { from: '2026-03-01', to: '2026-03-31' }));
    assert.equal(r.records!.rows.reduce((x, row) => x + (row.open as number), 0), r.value);
    const o = await tx(mgr, (q) => dash.kpiDrill(q, mgr, co, 'overdue_receivables', { from: '2026-03-01', to: '2026-03-31' }));
    assert.deepEqual(o.breakdowns.find((b) => b.key === 'age')!.rows.map((x) => [x.label, x.value]), [['1 to 30 days', 5250]]);
    assert.equal(o.records!.rows[0].days_overdue, 19);
  });

  it('shows each person only the KPIs their permissions allow', async () => {
    const a = await tx(rep1, (q) => dash.analyze(q, rep1, co, { from: '2026-01-01', to: '2026-03-31' }));
    assert.ok(!a.kpis.some((k) => k.code === 'revenue'));
    assert.ok(a.kpis.some((k) => k.code === 'pipeline'));
    await assert.rejects(tx(rep1, (q) => dash.kpiDrill(q, rep1, co, 'revenue', { from: '2026-01-01', to: '2026-03-31' })), ForbiddenError);
  });

  it('keeps each person their own layout', async () => {
    const first = await tx(rep1, (q) => dash.getLayout(q, rep1, co));
    assert.equal(first.saved, false);
    assert.ok(first.tiles.length > 0 && first.tiles.every((c) => first.available.some((k) => k.code === c)));
    assert.ok(!first.tiles.includes('revenue'));
    const mine = await tx(mgr, (q) => dash.saveLayout(q, mgr, co, { tiles: ['cash', 'revenue'], period: 'custom', compare: 'previous_year', from: '2026-01-01', to: '2026-03-31' }));
    assert.deepEqual([mine.tiles, mine.period, mine.compare, mine.from, mine.saved], [['cash', 'revenue'], 'custom', 'previous_year', '2026-01-01', true]);
    assert.equal((await tx(rep1, (q) => dash.getLayout(q, rep1, co))).saved, false);
    await assert.rejects(tx(mgr, (q) => dash.saveLayout(q, mgr, co, { tiles: ['cash', 'cash'], period: 'this_month', compare: 'none' })), /twice/);
    await assert.rejects(tx(mgr, (q) => dash.saveLayout(q, mgr, co, { tiles: ['bogus'], period: 'this_month', compare: 'none' })), /unknown KPI/);
    await assert.rejects(tx(mgr, (q) => dash.saveLayout(q, mgr, co, { tiles: [], period: 'custom', compare: 'none' })), /custom period/);
    assert.equal((await tx(mgr, (q) => dash.resetLayout(q, mgr, co))).saved, false);
  });

  it('serves the dashboard over the API', async () => {
    const app = buildServer({ db: t.db, platformAdminKey: 'k' });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `finmgr@${s.code}.test`, password: PASSWORD } });
    const h = { authorization: `Bearer ${login.json().token}` };
    const a = await app.inject({ method: 'GET', url: `/v1/bi/companies/${co}/analysis?from=2026-01-01&to=2026-03-31&compare=none&codes=revenue&spark=1`, headers: h });
    assert.equal(a.statusCode, 200);
    assert.equal(a.json().kpis[0].value, 21000);
    const d = await app.inject({ method: 'GET', url: `/v1/bi/companies/${co}/kpis/cash/drill?period=custom&from=2026-01-01&to=2026-03-31`, headers: h });
    assert.equal(d.statusCode, 200);
    assert.equal(d.json().breakdowns[0].key, 'account');
    const put = await app.inject({ method: 'PUT', url: `/v1/bi/companies/${co}/dashboard/layout`, headers: h, payload: { tiles: ['revenue'], period: 'this_year', compare: 'previous_year' } });
    assert.equal(put.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/bi/companies/${co}/dashboard/layout`, headers: h })).json().period, 'this_year');
    assert.equal((await app.inject({ method: 'GET', url: `/v1/bi/companies/${co}/analysis?from=2026-13-01&to=2026-03-31`, headers: h })).statusCode, 422);
    await app.close();
  });
});

describe('country packs', () => {
  it('lists the packs and refuses a country without one', async () => {
    assert.deepEqual(country.packSummary().map((p) => p.country), ['AE', 'SA']);
    await assert.rejects(tx(admin, (q) => setup.setupCompany(q, admin, { unitId: s.units.uk, legalName: 'Acme UK Ltd', openFrom: '2026-01-01' })), /GB localisation pack is not available/);
  });

  it('sets up Saudi books: chart, 15% VAT codes with exemption reasons, and GOSI rules', async () => {
    await assert.rejects(tx(admin, (q) => setup.setupCompany(q, admin, { unitId: ksa, legalName: 'Acme Arabia LLC', taxRegistrationNo: '100000000000003', openFrom: '2026-01-01' })), /starts and ends with 3/);
    const c = await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: ksa, legalName: 'Acme Arabia LLC', taxRegistrationNo: '310000000000003', openFrom: '2026-01-01' }));
    assert.equal(c.base_currency, 'SAR');
    const accounts = new Map((await tx(admin, (q) => setup.listAccounts(q, admin, ksa))).map((a: any) => [a.code, a]));
    assert.equal(accounts.get('2110').name, 'VAT Settlement Payable to ZATCA');
    assert.equal(accounts.get('2220').system_role, 'social_insurance_payable');
    const codes = await tx(admin, (q) => setup.listTaxCodes(q, 'SA'));
    assert.deepEqual(codes.map((x: any) => [x.code, Number(x.rate), x.exemption_reason_code]),
      [['EX', 0, 'VATEX-SA-29'], ['OS', 0, 'VATEX-SA-OOS'], ['RC', 15, null], ['SR', 15, null], ['ZR', 0, 'VATEX-SA-32'], ['ZS', 0, 'VATEX-SA-33']]);
    const rules = await tx(admin, (q) => hr.listContributionRules(q, admin, ksa));
    assert.deepEqual(rules.rules.map((r: any) => [r.code, r.applies_to, r.employee_pct, r.employer_pct, r.monthly_cap]),
      [['GOSI_ANNUITY', 'nationals', 9, 9, 45000], ['GOSI_HAZARDS', 'all', 0, 2, 45000], ['GOSI_SANED', 'nationals', 0.75, 0.75, 45000]]);
    await assert.rejects(tx(admin, (q) => tax.provideCorporateTax(q, admin, ksa, 2026)), /zakat and income tax/);
    // The UAE books are as before.
    assert.equal((await tx(admin, (q) => tax.computeVatReturn(q, admin, co, '2026-01-01', '2026-03-31'))).form, 'AE-VAT201');
  });
});

describe('Saudi VAT and ZATCA e-invoices', () => {
  let riyadh: string, walkin: string, importer: string, local: string, foreign: string;
  let inv1: any, inv2: any, inv3: any, inv4: any;

  before(async () => {
    const addr = { street: 'Olaya Street', building_no: '2345', district: 'Al Olaya', city: 'Riyadh', postal_code: '12611', cr_no: '1010123456' };
    riyadh = await party('Riyadh Trading', true, ksa, 'SA', 'SAR', { trn: '300000000000003', attributes: addr });
    walkin = await party('Walk-in customer', true, ksa, 'SA', 'SAR');
    importer = await party('Gulf Importer', true, ksa, 'AE', 'SAR', { attributes: { street: 'Port Road', city: 'Dubai' } });
    local = await party('Jeddah Supplies', false, ksa, 'SA', 'SAR');
    foreign = await party('Cloud Inc', false, ksa, 'US', 'SAR');
    inv1 = await invoice(ksa, { kind: 'sales_invoice', partyId: riyadh, date: '2026-02-01', dueDate: '2026-03-01', lines: [{ description: 'Consulting', quantity: 2, unitPrice: 1000, taxCode: 'SR' }] });
    inv2 = await invoice(ksa, { kind: 'sales_invoice', partyId: walkin, date: '2026-02-02', dueDate: '2026-02-02', lines: [{ description: 'Training seat', quantity: 1, unitPrice: 500, taxCode: 'SR' }] });
    inv3 = await invoice(ksa, { kind: 'sales_invoice', partyId: importer, date: '2026-02-03', dueDate: '2026-03-03', lines: [{ description: 'Steel', quantity: 1, unitPrice: 3000, taxCode: 'ZR' }] });
    inv4 = await invoice(ksa, { kind: 'sales_invoice', partyId: riyadh, date: '2026-02-04', dueDate: '2026-03-04', lines: [{ description: 'Loan arrangement', quantity: 1, unitPrice: 1000, taxCode: 'EX' }] });
    await invoice(ksa, { kind: 'purchase_invoice', partyId: local, supplierRef: 'JS-1', date: '2026-02-05', lines: [{ description: 'Office fit-out', quantity: 1, unitPrice: 4000, taxCode: 'SR' }] });
    await invoice(ksa, { kind: 'purchase_invoice', partyId: foreign, supplierRef: 'CI-9', date: '2026-02-06', lines: [{ description: 'Cloud hosting', quantity: 1, unitPrice: 2000, taxCode: 'RC' }] });
  });

  it('charges 15% and fills the ZATCA VAT return from the books', async () => {
    assert.equal(Number(inv1.tax_total), 300);
    const r = await tx(admin, (q) => tax.computeVatReturn(q, admin, ksa, '2026-01-01', '2026-03-31'));
    assert.equal(r.form, 'SA-VAT');
    const b = (k: string) => [r.boxes[k].amount, r.boxes[k].vat];
    assert.deepEqual(b('1'), [2500, 375]);
    assert.deepEqual(b('3'), [0, 0]);
    assert.deepEqual(b('4'), [3000, 0]);
    assert.deepEqual(b('5'), [1000, 0]);
    assert.deepEqual(b('6'), [6500, 375]);
    assert.deepEqual(b('7'), [4000, 600]);
    assert.deepEqual(b('9'), [2000, 300]);
    assert.deepEqual(b('12'), [6000, 900]);
    // Due: 375 on sales + 300 reverse charge - 900 recoverable = a 225 refund.
    assert.equal(r.boxes['13'].vat, -225);
    assert.equal(r.netPayable, -225);
    assert.equal(r.labels['4'], 'Exports');
    const filed = await tx(admin, (q) => tax.fileVatReturn(q, admin, ksa, '2026-01-01', '2026-03-31', 'ZATCA-Q1'));
    assert.equal(filed.form, 'SA-VAT');
    assert.equal(await balance(ksa, ['2110']), 225);
    assert.equal(await balance(ksa, ['2100', '1200']), 0);
  });

  it('will not issue an e-invoice until the seller details ZATCA needs are complete', async () => {
    const check = await tx(admin, (q) => einv.preview(q, admin, inv1.id));
    assert.equal(check.ready, false);
    assert.ok(['BR-KSA-08', 'BR-KSA-09', 'BR-KSA-37', 'BR-KSA-66'].every((r) => check.problems.some((p: any) => p.rule === r)));
    await assert.rejects(tx(admin, (q) => einv.issue(q, admin, inv1.id)), /fix before issuing/);
    await assert.rejects(tx(admin, (q) => einv.updateCompanyDetails(q, admin, ksa, { emirate: 'DXB' })), /UAE companies/);
    await assert.rejects(tx(admin, (q) => einv.updateCompanyDetails(q, admin, ksa, { buildingNo: '12' })), /4 digits/);
    await assert.rejects(tx(admin, (q) => einv.updateCompanyDetails(q, admin, ksa, { iban: 'AE070331234567890123456' })), /Saudi IBAN/);
    await tx(admin, (q) => einv.updateCompanyDetails(q, admin, ksa, { street: 'King Fahd Road', buildingNo: '1234', district: 'Al Malqa', city: 'Riyadh',
      postalCode: '13521', tradeLicenceNo: '1010999999', iban: 'SA03 8000 0000 6080 1016 7519' }));
    assert.equal((await tx(admin, (q) => einv.preview(q, admin, inv1.id))).ready, true);
  });

  it('chains each e-invoice to the one before, with a counter and a QR code carrying the hash', async () => {
    const e1 = await tx(admin, (q) => einv.issue(q, admin, inv1.id));
    assert.equal(e1.counter, 1);
    assert.equal(e1.previous_hash, FIRST_PIH);
    assert.equal(FIRST_PIH, 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==');
    assert.equal(e1.invoice_type, 'standard');
    const qr = readQr(e1.qr);
    assert.deepEqual([qr[0], qr[1], qr[3], qr[4], qr[5]], ['Acme Arabia LLC', '310000000000003', '2300.00', '300.00', e1.invoice_hash]);
    assert.match(qr[2], /^2026-02-01T\d{2}:\d{2}:\d{2}$/);
    const x1 = (await tx(admin, (q) => einv.getEinvoice(q, admin, e1.id))).xml as string;
    assert.match(x1, /<cbc:ProfileID>reporting:1\.0<\/cbc:ProfileID>/);
    assert.match(x1, /<cbc:InvoiceTypeCode name="0100000">388<\/cbc:InvoiceTypeCode>/);
    assert.match(x1, /<cbc:ID>ICV<\/cbc:ID>\n\s*<cbc:UUID>1<\/cbc:UUID>/);
    assert.match(x1, /<cbc:BuildingNumber>1234<\/cbc:BuildingNumber>/);
    assert.match(x1, /<cbc:ActualDeliveryDate>2026-02-01<\/cbc:ActualDeliveryDate>/);
    assert.equal(invoiceHash(withoutQr(x1)), e1.invoice_hash);

    const e2 = await tx(admin, (q) => einv.issue(q, admin, inv2.id));
    assert.deepEqual([e2.counter, e2.previous_hash, e2.invoice_type], [2, e1.invoice_hash, 'simplified']);
    assert.match((await tx(admin, (q) => einv.getEinvoice(q, admin, e2.id))).xml, /name="0200000">388</);
    const e3 = await tx(admin, (q) => einv.issue(q, admin, inv3.id));
    const x3 = (await tx(admin, (q) => einv.getEinvoice(q, admin, e3.id))).xml as string;
    assert.match(x3, /name="0100100">388</);
    assert.match(x3, /<cbc:TaxExemptionReasonCode>VATEX-SA-32<\/cbc:TaxExemptionReasonCode>/);
    const e4 = await tx(admin, (q) => einv.issue(q, admin, inv4.id));
    assert.match((await tx(admin, (q) => einv.getEinvoice(q, admin, e4.id))).xml, /VATEX-SA-29/);

    // A credit note refers to its invoice and gives the reason.
    const cn = await invoice(ksa, { kind: 'sales_credit', partyId: riyadh, date: '2026-02-10', creditOf: inv1.id, notes: 'Price adjustment agreed',
      lines: [{ description: 'Discount', quantity: 1, unitPrice: 200, taxCode: 'SR' }] });
    const e5 = await tx(admin, (q) => einv.issue(q, admin, cn.id));
    const x5 = (await tx(admin, (q) => einv.getEinvoice(q, admin, e5.id))).xml as string;
    assert.match(x5, /<cbc:InvoiceTypeCode name="0100000">381<\/cbc:InvoiceTypeCode>/);
    assert.match(x5, new RegExp(`<cac:InvoiceDocumentReference>\\n\\s*<cbc:ID>${inv1.no}</cbc:ID>`));
    assert.match(x5, /<cbc:InstructionNote>Price adjustment agreed<\/cbc:InstructionNote>/);

    const chain = await tx(admin, (q) => einv.checkChain(q, admin, ksa));
    assert.deepEqual([chain.invoices, chain.lastCounter, chain.intact, chain.lastHash], [5, 5, true, e5.invoice_hash]);
    await assert.rejects(tx(admin, (q) => q.query(`UPDATE fin.einvoices SET qr = 'x' WHERE id = $1`, [e1.id])), /cannot change/);
    await assert.rejects(tx(admin, (q) => einv.checkChain(q, admin, co)), /Saudi/);
  });
});

describe('Saudi payroll: GOSI and end-of-service', () => {
  let saudi: string, expat: string, director: string;

  before(async () => {
    const emp = (no: string, nationality?: string) => tx(admin, async (q) => (await org.createEmployee(q, admin, { employeeNo: no, firstName: no, lastName: 'Test', unitId: ksa, nationality })).id as string);
    saudi = await emp('S001', 'SA');
    expat = await emp('S002', 'IN');
    director = await emp('S003');
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: saudi, companyId: ksa, startDate: '2020-01-01', basic: 10000, housing: 2500, transport: 500 }));
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: expat, companyId: ksa, startDate: '2025-06-01', basic: 8000, housing: 2000, iban: 'SA0380000000608010167519' }));
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: director, companyId: ksa, startDate: '2024-01-01', basic: 50000 }));
  });

  it('works out the Saudi end-of-service award, reduced on resignation', () => {
    const pay = { basic: 10000, housing: 2500 };
    assert.equal(country.saudiEndOfService(pay, '2020-01-01', '2024-01-01'), 25000);
    assert.equal(country.saudiEndOfService(pay, '2020-01-01', '2024-01-01', 'resignation'), 8333.33);
    assert.equal(country.saudiEndOfService(pay, '2022-01-01', '2024-01-01', 'resignation'), 0);
    assert.equal(country.saudiEndOfService(pay, '2016-01-01', '2024-01-01'), 68750);
    assert.equal(country.saudiEndOfService(pay, '2016-01-01', '2024-01-01', 'resignation'), 45833.33);
    assert.equal(country.saudiEndOfService(pay, '2016-01-01', '2024-01-01', 'termination'), 68750);
    // The UAE rule is unchanged.
    assert.equal(hr.gratuity(10000, '2020-01-01', '2024-01-01'), country.uaeGratuity(10000, '2020-01-01', '2024-01-01'));
  });

  it('needs every nationality before it can work out GOSI', async () => {
    await assert.rejects(tx(admin, (q) => hr.runPayroll(q, admin, { companyId: ksa, period: '2026-03' })), /nationality of S003/);
    await tx(admin, (q) => org.updateEmployee(q, admin, director, { nationality: 'SA' }));
  });

  it('deducts GOSI from Saudi employees, charges the employer share and posts both', async () => {
    let run = await tx(admin, (q) => hr.runPayroll(q, admin, { companyId: ksa, period: '2026-03' }));
    const slip = (id: string) => run.payslips.find((p: any) => p.employee_id === id);
    // Saudi: base 12,500; employee 9.75%, employer 11.75%.
    assert.deepEqual([Number(slip(saudi).employee_contributions), Number(slip(saudi).employer_contributions), Number(slip(saudi).net)], [1218.75, 1468.75, 11781.25]);
    // Non-Saudi: occupational hazards only, paid by the employer.
    assert.deepEqual([Number(slip(expat).employee_contributions), Number(slip(expat).employer_contributions), Number(slip(expat).net)], [0, 200, 10000]);
    // Base capped at 45,000.
    assert.deepEqual([Number(slip(director).employee_contributions), Number(slip(director).employer_contributions)], [4387.5, 5287.5]);
    assert.deepEqual(slip(saudi).contributions.map((c: any) => c.code), ['GOSI_ANNUITY', 'GOSI_HAZARDS', 'GOSI_SANED']);
    // End-of-service at the end of March on basic plus housing.
    assert.equal(Number(slip(saudi).gratuity_balance), country.saudiEndOfService({ basic: 10000, housing: 2500 }, '2020-01-01', '2026-03-31'));
    run = await tx(admin, (q) => hr.postPayroll(q, admin, run.id));
    assert.equal(await balance(ksa, ['2220']), -(5606.25 + 6956.25));
    assert.equal(await balance(ksa, ['5930']), 6956.25);
    assert.equal(await balance(ksa, ['2210']), -Number(run.net_total));
    // No WPS file in Saudi Arabia.
    const paid = await tx(admin, (q) => hr.payPayroll(q, admin, run.id, { date: '2026-04-01' }));
    assert.equal(paid.fileName, null);
  });

  it('lets HR correct a rate when the law changes', async () => {
    const r = await tx(admin, (q) => hr.saveContributionRule(q, admin, ksa, { code: 'GOSI_ANNUITY', employeePct: 9.5, employerPct: 9.5 }));
    assert.deepEqual([r.employee_pct, r.employer_pct, r.applies_to], [9.5, 9.5, 'nationals']);
    await assert.rejects(tx(admin, (q) => hr.saveContributionRule(q, admin, ksa, { code: 'NEW_ONE' })), /needs a name/);
    await assert.rejects(tx(rep1, (q) => hr.saveContributionRule(q, rep1, ksa, { code: 'GOSI_ANNUITY', employeePct: 0 })), ForbiddenError);
  });

  it('pays a resigning employee the reduced award', async () => {
    const k = await tx(admin, async (q) => (await one(q, 'SELECT id FROM hr.contracts WHERE employee_id = $1', [saudi])).id);
    const ended = await tx(admin, (q) => hr.endContract(q, admin, k, '2026-04-30', 'resignation'));
    // About 6.3 years: the full award, two thirds of it on resignation.
    const full = country.saudiEndOfService({ basic: 10000, housing: 2500 }, '2020-01-01', '2026-04-30');
    assert.equal(ended.finalGratuity, Math.round(full * 2 / 3 * 100) / 100);
    const paid = await tx(admin, (q) => hr.paySettlement(q, admin, k, { date: '2026-05-05' }));
    assert.equal(paid.amount, ended.finalGratuity);
    await assert.rejects(tx(admin, (q) => hr.endContract(q, admin, k, '2026-04-30')), /already ended/);
    const ke = await tx(admin, async (q) => (await one(q, 'SELECT id FROM hr.contracts WHERE employee_id = $1', [expat])).id);
    await assert.rejects(tx(admin, (q) => hr.endContract(q, admin, ke, '2026-04-30', 'fired' as any)), ValidationError);
  });
});
