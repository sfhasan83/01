import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { one, type Ctx } from '../src/core/db.ts';
import { ForbiddenError } from '../src/core/errors.ts';
import { minorUnits, moneyScope, roundIn, roundMoney, useBaseCurrency } from '../src/core/money.ts';
import * as setup from '../src/fin/setup.ts';
import * as docs from '../src/fin/documents.ts';
import * as tax from '../src/fin/tax.ts';
import * as reports from '../src/fin/reports.ts';
import * as einv from '../src/fin/einvoice.ts';
import * as country from '../src/fin/country.ts';
import * as hr from '../src/hr/service.ts';
import * as org from '../src/org/service.ts';
import { buildServer } from '../src/api/server.ts';
import { createTestDb, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

/**
 * Phase 6b: Oman, Bahrain, Qatar and Kuwait, and money in three decimals.
 */

let t: TestDb;
let s: Seed;
let admin: Ctx, rep1: Ctx;
let om: string, bh: string, qa: string, kw: string;

const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);
const balance = (company: string, codes: string[], to = '2026-12-31') => tx(admin, async (q) =>
  Number((await one(q, `SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM fin.journal_lines l
     JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
    WHERE a.company_id = $1 AND a.code = ANY($2) AND j.date <= $3`, [company, codes, to])).b));
async function party(code: string, isCustomer: boolean, owner: string, ctry: string, cur: string) {
  return tx(admin, async (q) => (await one(q, `INSERT INTO mdm.parties (tenant_id, code, name, normalized_name, is_customer, is_supplier, country_code, currency_code,
      owner_unit_id, status) VALUES (app.tenant(), $1, $1, lower($1), $2, $3, $4, $5, $6, 'active') RETURNING id`,
  [code, isCustomer, !isCustomer, ctry, cur, owner])).id as string);
}
async function invoice(companyId: string, input: Omit<docs.InvoiceInput, 'companyId'>) {
  const d = await tx(admin, (q) => docs.createInvoice(q, admin, { companyId, ...input }));
  return tx(admin, (q) => docs.postInvoice(q, admin, d.id));
}
const unit = (code: string, name: string, countryCode: string, currencyCode: string) =>
  tx(admin, async (q) => (await org.createUnit(q, admin, { typeCode: 'company', parentId: s.units.root, code, name, countryCode, currencyCode })).id as string);

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  admin = s.adminCtx;
  rep1 = s.ctxOf(s.people.salesRep.userId);
  om = await unit('OM01', 'Acme Oman', 'OM', 'OMR');
  bh = await unit('BH01', 'Acme Bahrain', 'BH', 'BHD');
  qa = await unit('QA01', 'Acme Qatar', 'QA', 'QAR');
  kw = await unit('KW01', 'Acme Kuwait', 'KW', 'KWD');
});
after(async () => { await t.drop(); });

describe('money in three decimals', () => {
  it('rounds to the currency in hand, and to the base currency of the books loaded', () => {
    assert.deepEqual([minorUnits('KWD'), minorUnits('BHD'), minorUnits('OMR'), minorUnits('QAR'), minorUnits('JPY'), minorUnits('AED')], [3, 3, 3, 2, 0, 2]);
    assert.equal(roundIn('KWD', 1.23456), 1.235);
    assert.equal(roundIn('AED', 1.23456), 1.23);
    assert.equal(roundIn('JPY', 1234.4), 1234);
    // Outside a transaction, two decimals; a scope follows the books it loads.
    assert.equal(roundMoney(2 / 3), 0.67);
    moneyScope(() => {
      assert.equal(roundMoney(2 / 3), 0.67);
      useBaseCurrency('BHD');
      assert.equal(roundMoney(2 / 3), 0.667);
    });
    assert.equal(roundMoney(2 / 3), 0.67);
  });

  it('keeps fils on Kuwaiti invoices, conversions and payments', async () => {
    await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: kw, legalName: 'Acme Kuwait WLL', openFrom: '2026-01-01' }));
    const cust = await party('Souq Sharq', true, kw, 'KW', 'KWD');
    const usCust = await party('Boston Labs', true, kw, 'US', 'USD');
    const inv = await invoice(kw, { kind: 'sales_invoice', partyId: cust, date: '2026-01-10', dueDate: '2026-02-09',
      lines: [{ description: 'Filters', quantity: 3, unitPrice: 1.2345, taxCode: 'NV' }] });
    assert.equal(inv.gross_total, '3.704');
    assert.equal(await balance(kw, ['1100']), 3.704);
    // A dollar invoice converts to dinars at three decimals.
    await invoice(kw, { kind: 'sales_invoice', partyId: usCust, date: '2026-01-12', dueDate: '2026-02-11', currency: 'USD', fxRate: 0.30712,
      lines: [{ description: 'Survey', quantity: 1, unitPrice: 333.33, taxCode: 'NV' }] });
    assert.equal(await balance(kw, ['1100']), 3.704 + 102.372);
    const line = await tx(admin, (q) => one(q, `SELECT l.debit, l.txn_amount FROM fin.journal_lines l JOIN fin.accounts a ON a.id = l.account_id
                                                WHERE a.company_id = $1 AND a.code = '1100' AND l.txn_amount = 333.33`, [kw]));
    assert.deepEqual([line.debit, line.txn_amount], ['102.372', '333.330']);
    await tx(admin, (q) => docs.recordPayment(q, admin, { companyId: kw, kind: 'receipt', partyId: cust, date: '2026-01-20', bankAccount: '1010',
      amount: 3.704, allocations: [{ invoiceId: inv.id, amount: 3.704 }] }));
    assert.equal(await tx(admin, (q) => docs.outstanding(q, inv.id)), 0);
    await assert.rejects(tx(admin, (q) => docs.recordPayment(q, admin, { companyId: kw, kind: 'receipt', partyId: cust, date: '2026-01-21', bankAccount: '1010',
      amount: 0.001, allocations: [{ invoiceId: inv.id, amount: 0.001 }] })), /more than is open/);
  });
});

describe('GCC country packs', () => {
  it('sets up books for each country with its currency, tax number, chart and codes', async () => {
    assert.deepEqual(country.packSummary().map((p) => [p.country, p.currency, p.decimals, p.vat]),
      [['AE', 'AED', 2, '5%'], ['SA', 'SAR', 2, '15%'], ['OM', 'OMR', 3, '5%'], ['BH', 'BHD', 3, '10%'], ['QA', 'QAR', 2, 'none'], ['KW', 'KWD', 3, 'none']]);
    await assert.rejects(tx(admin, (q) => setup.setupCompany(q, admin, { unitId: bh, legalName: 'Acme Bahrain WLL', taxRegistrationNo: 'BH123', openFrom: '2026-01-01' })), /15 digits/);
    await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: bh, legalName: 'Acme Bahrain WLL', taxRegistrationNo: '200000000000003', openFrom: '2026-01-01' }));
    await assert.rejects(tx(admin, (q) => setup.setupCompany(q, admin, { unitId: om, legalName: 'Acme Oman LLC', taxRegistrationNo: '1234567890', openFrom: '2026-01-01' })), /OM followed by 10 digits/);
    const o = await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: om, legalName: 'Acme Oman LLC', taxRegistrationNo: 'OM1234567890', openFrom: '2026-01-01' }));
    assert.deepEqual([o.base_currency, Number(o.corporate_tax_rate)], ['OMR', 15]);
    await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: qa, legalName: 'Acme Qatar WLL', openFrom: '2026-01-01' }));
    const name = async (co: string, code: string) => (await tx(admin, (q) => setup.listAccounts(q, admin, co))).find((a: any) => a.code === code).name;
    assert.equal(await name(bh, '2110'), 'VAT Payable to the NBR');
    assert.equal(await name(om, '2220'), 'Social Protection Fund Contributions Payable');
    assert.equal(await name(kw, '2220'), 'PIFSS Contributions Payable');
    const codes = async (c: string) => (await tx(admin, (q) => setup.listTaxCodes(q, c))).map((x: any) => `${x.code} ${Number(x.rate)}`);
    assert.deepEqual(await codes('BH'), ['EX 0', 'OS 0', 'RC 10', 'SR 10', 'ZD 0', 'ZR 0']);
    assert.deepEqual(await codes('OM'), ['EX 0', 'OS 0', 'RC 5', 'SR 5', 'ZD 0', 'ZR 0']);
    assert.deepEqual(await codes('QA'), ['NV 0']);
    // IBANs follow each country's format.
    await assert.rejects(tx(admin, (q) => einv.updateCompanyDetails(q, admin, bh, { iban: 'BH67BMAG0000129929' })), /Bahrain IBAN/);
    await tx(admin, (q) => einv.updateCompanyDetails(q, admin, bh, { iban: 'BH67BMAG00001299123456' }));
  });

  it('prepares the Bahrain NBR VAT return at 10%, in fils, and files it', async () => {
    const local = await party('Manama Trading', true, bh, 'BH', 'BHD');
    const saudi = await party('Khobar Retail', true, bh, 'SA', 'BHD');
    const supplier = await party('Sitra Supplies', false, bh, 'BH', 'BHD');
    const foreign = await party('London Cloud', false, bh, 'GB', 'BHD');
    const sale = (partyId: string, unitPrice: number, taxCode: string) =>
      invoice(bh, { kind: 'sales_invoice', partyId, date: '2026-02-01', dueDate: '2026-03-01', lines: [{ description: 'Goods', quantity: 1, unitPrice, taxCode }] });
    await sale(local, 1234.567, 'SR');
    await sale(local, 200, 'ZD');
    await sale(saudi, 500, 'ZR');
    await sale(local, 100, 'EX');
    await invoice(bh, { kind: 'purchase_invoice', partyId: supplier, date: '2026-02-05', lines: [{ description: 'Stock', quantity: 1, unitPrice: 300, taxCode: 'SR', account: '5500' }] });
    await invoice(bh, { kind: 'purchase_invoice', partyId: foreign, date: '2026-02-06', lines: [{ description: 'Hosting', quantity: 1, unitPrice: 400, taxCode: 'RC', account: '5500' }] });
    const r = await tx(admin, (q) => tax.computeVatReturn(q, admin, bh, '2026-01-01', '2026-03-31'));
    assert.deepEqual([r.form, r.authority], ['BH-VAT', 'NBR']);
    const b = (k: string) => [r.boxes[k].amount, r.boxes[k].vat];
    assert.deepEqual(b('1'), [1234.567, 123.457]);
    assert.deepEqual(b('4'), [200, 0]);
    assert.deepEqual(b('5'), [500, 0]);
    assert.deepEqual(b('6'), [100, 0]);
    assert.deepEqual(b('7'), [2034.567, 123.457]);
    assert.deepEqual(b('8'), [300, 30]);
    assert.deepEqual(b('10'), [400, 40]);
    assert.deepEqual(b('13'), [700, 70]);
    // Due: 123.457 on sales + 40 reverse charge - 70 recoverable.
    assert.deepEqual([r.outputTax, r.inputTax, r.netPayable, r.boxes['14'].vat, r.boxes['17'].vat], [163.457, 70, 93.457, 93.457, 93.457]);
    // Reports keep the fils too.
    const tb = await tx(admin, (q) => reports.trialBalance(q, admin, bh, '2026-03-31'));
    assert.equal(tb.balanced, true);
    assert.deepEqual(tb.lines.filter((l: any) => ['1100', '1200'].includes(l.code)).map((l: any) => l.closing), [2158.024, 70]);
    await tx(admin, (q) => tax.fileVatReturn(q, admin, bh, '2026-01-01', '2026-03-31', 'NBR-1'));
    assert.equal(await balance(bh, ['2110']), -93.457);
    assert.equal(await balance(bh, ['2100', '1200']), 0);
  });

  it('prepares the Oman VAT return, refuses e-invoices and provides 15% income tax', async () => {
    const cust = await party('Muscat Foods', true, om, 'OM', 'OMR');
    const supplier = await party('Sohar Packaging', false, om, 'OM', 'OMR');
    const foreign = await party('Delhi Software', false, om, 'IN', 'OMR');
    const sale = await invoice(om, { kind: 'sales_invoice', partyId: cust, date: '2026-01-15', dueDate: '2026-02-14', lines: [{ description: 'Dates', quantity: 1, unitPrice: 1000, taxCode: 'SR' }] });
    await invoice(om, { kind: 'purchase_invoice', partyId: supplier, date: '2026-01-16', lines: [{ description: 'Boxes', quantity: 1, unitPrice: 400, taxCode: 'SR', account: '5500' }] });
    await invoice(om, { kind: 'purchase_invoice', partyId: foreign, date: '2026-01-17', lines: [{ description: 'Licence', quantity: 1, unitPrice: 200, taxCode: 'RC', account: '5500' }] });
    const r = await tx(admin, (q) => tax.computeVatReturn(q, admin, om, '2026-01-01', '2026-03-31'));
    assert.equal(r.form, 'OM-VAT');
    const b = (k: string) => [r.boxes[k].amount, r.boxes[k].vat];
    assert.deepEqual(b('1a'), [1000, 50]);
    assert.deepEqual(b('2a'), [200, 10]);
    assert.deepEqual(b('5'), [0, 60]);
    assert.deepEqual(b('6a'), [400, 20]);
    assert.deepEqual(b('6b'), [200, 10]);
    assert.deepEqual(b('6e'), [600, 30]);
    assert.deepEqual([r.boxes['7'].vat, r.netPayable], [30, 30]);
    await assert.rejects(tx(admin, (q) => einv.preview(q, admin, sale.id)), /Fawtara/);
    await assert.rejects(tx(admin, (q) => einv.issue(q, admin, sale.id)), /Fawtara/);
    // Profit 1,000 - 400 - 200 = 400; 15% is 60.
    const ct = await tx(admin, (q) => tax.provideCorporateTax(q, admin, om, 2026));
    assert.deepEqual([ct.accountingProfit, ct.tax], [400, 60]);
    assert.equal(await balance(om, ['2400']), -60);
  });

  it('has no VAT return in Qatar or Kuwait, and says what is not covered', async () => {
    await assert.rejects(tx(admin, (q) => tax.computeVatReturn(q, admin, qa, '2026-01-01', '2026-03-31')), /Qatar has no VAT/);
    await assert.rejects(tx(admin, (q) => tax.fileVatReturn(q, admin, kw, '2026-01-01', '2026-03-31')), /Kuwait has no VAT/);
    await assert.rejects(tx(admin, (q) => tax.provideCorporateTax(q, admin, qa, 2026)), /Qatar income tax/);
    await assert.rejects(tx(admin, (q) => tax.provideCorporateTax(q, admin, bh, 2026)), /no general corporate income tax/);
    // The UAE rule is untouched by the new packs.
    assert.equal(country.packFor('AE').vatForm, 'AE-VAT201');
  });
});

describe('GCC end of service', () => {
  it('pays non-nationals under each labour law, and nationals nothing where a pension replaces it', () => {
    const pay = { basic: 1000, housing: 200 };
    // Oman: a month of basic a year.
    assert.equal(country.omanEndOfService(pay, '2020-01-01', '2024-01-01'), 4000);
    assert.equal(country.omanEndOfService(pay, '2020-01-01', '2024-01-01', null, true), 0);
    // Qatar: three weeks of basic a year, after the first year.
    assert.equal(country.qatarEndOfService({ basic: 3000, housing: 0 }, '2020-01-01', '2024-01-01'), 8400);
    assert.equal(country.qatarEndOfService({ basic: 3000, housing: 0 }, '2023-06-01', '2024-01-01'), 0);
    // Kuwait: 15 days a year for 5 years, a month after, at most 18 months; less on resignation.
    assert.equal(country.kuwaitEndOfService(pay, '2020-01-01', '2024-01-01'), 2400);
    assert.equal(country.kuwaitEndOfService(pay, '2020-01-01', '2024-01-01', 'resignation'), 1200);
    assert.equal(country.kuwaitEndOfService(pay, '2016-01-01', '2024-01-01'), 6600);
    assert.equal(country.kuwaitEndOfService(pay, '2016-01-01', '2024-01-01', 'resignation'), 4400);
    assert.equal(country.kuwaitEndOfService(pay, '2022-01-01', '2024-01-01', 'resignation'), 0);
    assert.equal(country.kuwaitEndOfService(pay, '2000-01-01', '2024-01-01'), 21600);
    assert.equal(country.kuwaitEndOfService(pay, '2016-01-01', '2024-01-01', null, true), 0);
    // Bahrain: half a month for 3 years, a month after, only for service before March 2024.
    const wage = { basic: 800, housing: 200 };
    assert.equal(country.bahrainEndOfService(wage, '2016-03-01', '2024-03-01'), 6500);
    assert.equal(country.bahrainEndOfService(wage, '2016-03-01', '2026-01-01'), 6500);
    assert.equal(country.bahrainEndOfService(wage, '2024-06-01', '2026-01-01'), 0);
    assert.equal(country.bahrainEndOfService(wage, '2016-03-01', '2026-01-01', null, true), 0);
  });
});

describe('GCC payroll', () => {
  const emp = (unitId: string, no: string, nationality: string) =>
    tx(admin, async (q) => (await org.createEmployee(q, admin, { employeeNo: no, firstName: no, lastName: 'Test', unitId, nationality })).id as string);

  it('charges SIO in Bahrain, with the leaving indemnity stepping up after three years', async () => {
    const local = await emp(bh, 'B001', 'BH');
    const longExpat = await emp(bh, 'B002', 'IN');
    const newExpat = await emp(bh, 'B003', 'PK');
    const highPaid = await emp(bh, 'B004', 'BH');
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: local, companyId: bh, startDate: '2025-01-01', basic: 1500, housing: 300, transport: 100 }));
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: longExpat, companyId: bh, startDate: '2020-01-01', basic: 800, housing: 200 }));
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: newExpat, companyId: bh, startDate: '2025-06-01', basic: 600, housing: 100 }));
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: highPaid, companyId: bh, startDate: '2025-01-01', basic: 5000 }));
    let run = await tx(admin, (q) => hr.runPayroll(q, admin, { companyId: bh, period: '2026-03' }));
    const slip = (id: string) => run.payslips.find((p: any) => p.employee_id === id);
    const c = (id: string) => [Number(slip(id).employee_contributions), Number(slip(id).employer_contributions), Number(slip(id).net)];
    // Bahraini on gross 1,900: pension 7% + 12%, unemployment 1% + 1%, injury 3%.
    assert.deepEqual(c(local), [152, 304, 1748]);
    // Six years' service: unemployment 1% + 1%, injury 3%, indemnity 8.4% of basic plus housing.
    assert.deepEqual(c(longExpat), [10, 124, 990]);
    // Under three years: indemnity at 4.2%, in fils.
    assert.deepEqual(c(newExpat), [7, 57.4, 693]);
    // Wages above BHD 4,000 are capped.
    assert.deepEqual(c(highPaid), [320, 640, 4680]);
    // The employer still owes the end-of-service award for service before March 2024; Bahrainis have none.
    assert.equal(Number(slip(longExpat).gratuity_balance), 2664.271);
    assert.equal(Number(slip(local).gratuity_balance), 0);
    run = await tx(admin, (q) => hr.postPayroll(q, admin, run.id));
    assert.equal(await balance(bh, ['2220']), -1614.4);
    assert.equal(await balance(bh, ['5930']), 1125.4);
    const paid = await tx(admin, (q) => hr.payPayroll(q, admin, run.id, { date: '2026-04-01' }));
    assert.equal(paid.fileName, null);
    assert.match(paid.note ?? '', /Bahrain WPS salary file is not produced/);
  });

  it('checks stepped rates when HR changes them', async () => {
    await assert.rejects(tx(admin, (q) => hr.saveContributionRule(q, admin, bh, { code: 'SIO_INDEMNITY', afterYears: null })), /needs both/);
    const r = await tx(admin, (q) => hr.saveContributionRule(q, admin, bh, { code: 'SIO_INDEMNITY', afterYears: 5, employerPctAfter: 8.4 }));
    assert.deepEqual([r.after_years, r.employer_pct_after, r.employer_pct], [5, 8.4, 4.2]);
    await assert.rejects(tx(rep1, (q) => hr.saveContributionRule(q, rep1, bh, { code: 'SIO_INDEMNITY', afterYears: 3 })), ForbiddenError);
  });

  it('charges PIFSS for Kuwaitis only, in fils', async () => {
    const local = await emp(kw, 'K001', 'KW');
    const expat = await emp(kw, 'K002', 'EG');
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: local, companyId: kw, startDate: '2024-01-01', basic: 1034.567, housing: 200 }));
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: expat, companyId: kw, startDate: '2024-01-01', basic: 500 }));
    const run = await tx(admin, (q) => hr.runPayroll(q, admin, { companyId: kw, period: '2026-03' }));
    const slip = (id: string) => run.payslips.find((p: any) => p.employee_id === id);
    assert.deepEqual([slip(local).employee_contributions, slip(local).employer_contributions, slip(local).net], ['129.630', '141.975', '1104.937']);
    assert.deepEqual([Number(slip(expat).employee_contributions), Number(slip(expat).employer_contributions)], [0, 0]);
    // The expat's award after 820 days: 15 days of basic a year, in fils.
    assert.equal(slip(expat).gratuity_balance, '561.259');
    assert.equal(Number(slip(local).gratuity_balance), 0);
  });
});

describe('country packs over HTTP', () => {
  it('lists the six packs with their decimals and VAT', async () => {
    const app = buildServer({ db: t.db, platformAdminKey: 'k' });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `admin@${s.code}.test`, password: PASSWORD } });
    const h = { authorization: `Bearer ${login.json().token}` };
    const packs = (await app.inject({ method: 'GET', url: '/v1/fin/country-packs', headers: h })).json();
    const kwPack = packs.find((p: any) => p.country === 'KW');
    assert.deepEqual([packs.length, kwPack.decimals, kwPack.vat, kwPack.noVat], [6, 3, 'none', 'Kuwait has no VAT, so there is no VAT return']);
    const v = await app.inject({ method: 'GET', url: `/v1/fin/companies/${qa}/vat-return?from=2026-01-01&to=2026-03-31`, headers: h });
    assert.equal(v.statusCode, 422);
    await app.close();
  });
});
