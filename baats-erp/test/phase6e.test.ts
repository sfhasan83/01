import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { one, type Ctx } from '../src/core/db.ts';
import * as setup from '../src/fin/setup.ts';
import * as docs from '../src/fin/documents.ts';
import * as tax from '../src/fin/tax.ts';
import * as einv from '../src/fin/einvoice.ts';
import * as bankfiles from '../src/fin/bankfiles.ts';
import * as country from '../src/fin/country.ts';
import { franceEndOfService, italyEndOfService, netherlandsEndOfService, spainEndOfService, ukCorporationTax, FRANCE, NETHERLANDS } from '../src/fin/europe.ts';
import { irelandPaye, parseUkTaxCode, ukPaye, ukTaxMonth } from '../src/hr/incometax.ts';
import * as hr from '../src/hr/service.ts';
import * as org from '../src/org/service.ts';
import { buildServer } from '../src/api/server.ts';
import { createTestDb, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

/**
 * Phase 6e: the UK and EU country packs.
 */

let t: TestDb;
let s: Seed;
let admin: Ctx;
let uk: string, ie: string, de: string, fr: string;

const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);
const balance = (company: string, codes: string[]) => tx(admin, async (q) =>
  Number((await one(q, `SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM fin.journal_lines l
     JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
    WHERE a.company_id = $1 AND a.code = ANY($2)`, [company, codes])).b));
async function party(code: string, isCustomer: boolean, owner: string, ctry: string, cur: string, vat: string | null = null, attributes: object = {}) {
  return tx(admin, async (q) => (await one(q, `INSERT INTO mdm.parties (tenant_id, code, name, normalized_name, is_customer, is_supplier, country_code, currency_code,
      owner_unit_id, status, tax_registration_no, attributes) VALUES (app.tenant(), $1, $1, lower($1), $2, $3, $4, $5, $6, 'active', $7, $8) RETURNING id`,
  [code, isCustomer, !isCustomer, ctry, cur, owner, vat, JSON.stringify(attributes)])).id as string);
}
async function invoice(companyId: string, input: Omit<docs.InvoiceInput, 'companyId'>) {
  const d = await tx(admin, (q) => docs.createInvoice(q, admin, { companyId, ...input }));
  return tx(admin, (q) => docs.postInvoice(q, admin, d.id));
}
const line = (amount: number, taxCode: string, account?: string) => ({ description: `Line ${taxCode}`, quantity: 1, unitPrice: amount, taxCode, ...(account ? { account } : {}) });
const unit = (code: string, name: string, countryCode: string, currencyCode: string) =>
  tx(admin, async (q) => (await org.createUnit(q, admin, { typeCode: 'company', parentId: s.units.root, code, name, countryCode, currencyCode })).id as string);
const person = (no: string, unitId: string) =>
  tx(admin, async (q) => (await org.createEmployee(q, admin, { employeeNo: no, firstName: no, lastName: 'Test', unitId, nationality: 'GB' })).id as string);
const near = (a: number, b: number, why = '') => assert.ok(Math.abs(a - b) < 0.011, `${a} is not ${b} ${why}`);

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  admin = s.adminCtx;
  uk = s.units.uk;
  ie = await unit('IE01', 'Acme Ireland', 'IE', 'EUR');
  de = await unit('DE01', 'Acme Germany', 'DE', 'EUR');
  fr = await unit('FR01', 'Acme France', 'FR', 'EUR');
});
after(async () => { await t.drop(); });

describe('the UK and EU packs', () => {
  it('sets up books with the country\'s currency, VAT number format, chart names and codes', async () => {
    const packs = country.packSummary();
    assert.deepEqual(packs.slice(6).map((p) => [p.country, p.currency, p.vat, p.region]),
      [['GB', 'GBP', '20%', 'UK'], ['IE', 'EUR', '23%', 'EU'], ['DE', 'EUR', '19%', 'EU'], ['FR', 'EUR', '20%', 'EU'], ['NL', 'EUR', '21%', 'EU'], ['ES', 'EUR', '21%', 'EU'], ['IT', 'EUR', '22%', 'EU']]);
    assert.match(packs.find((p) => p.country === 'DE')!.einvoice, /XRechnung/);
    assert.match(packs.find((p) => p.country === 'IT')!.einvoice, /FatturaPA is not produced/);
    await assert.rejects(tx(admin, (q) => setup.setupCompany(q, admin, { unitId: uk, legalName: 'Acme UK Ltd', taxRegistrationNo: '12345', openFrom: '2026-01-01' })), /9 digits/);
    const c = await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: uk, legalName: 'Acme UK Ltd', taxRegistrationNo: 'GB123456789', openFrom: '2026-01-01' }));
    assert.deepEqual([c.base_currency, Number(c.corporate_tax_rate), Number(c.corporate_tax_threshold)], ['GBP', 25, 50000]);
    await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: ie, legalName: 'Acme Ireland Ltd', taxRegistrationNo: 'IE1234567T', openFrom: '2026-01-01' }));
    await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: de, legalName: 'Acme GmbH', taxRegistrationNo: 'DE123456789', openFrom: '2026-01-01' }));
    await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: fr, legalName: 'Acme SAS', taxRegistrationNo: 'FR12123456789', openFrom: '2026-01-01' }));
    const name = async (co: string, code: string) => (await tx(admin, (q) => setup.listAccounts(q, admin, co))).find((a: any) => a.code === code)?.name;
    assert.equal(await name(uk, '2110'), 'VAT Payable to HMRC');
    assert.equal(await name(uk, '2240'), 'PAYE Income Tax Payable to HMRC');
    assert.equal(await name(de, '2240'), 'Lohnsteuer (wage tax payable)');
    const codes = async (ctry: string) => (await tx(admin, (q) => setup.listTaxCodes(q, ctry))).map((x: any) => `${x.code} ${Number(x.rate)}`);
    assert.deepEqual(await codes('GB'), ['EX 0', 'EXP 0', 'OS 0', 'PVA 20', 'RCS 20', 'RR 5', 'SR 20', 'ZR 0']);
    assert.deepEqual(await codes('FR'), ['EX 0', 'EXP 0', 'IC 0', 'ICA 20', 'ICS 0', 'OS 0', 'RCS 20', 'RR 10', 'RR2 5.5', 'RR3 2.1', 'SR 20', 'ZR 0']);
    await assert.rejects(tx(admin, (q) => einv.updateCompanyDetails(q, admin, de, { iban: 'DE8937040044053201300' })), /German IBAN/);
  });

  it('prepares the HMRC nine-box return, with reverse charge and postponed import VAT, and its Making Tax Digital body', async () => {
    const local = await party('London Retail', true, uk, 'GB', 'GBP');
    const us = await party('Austin Labs', true, uk, 'US', 'GBP');
    const fr1 = await party('Lyon Clients', true, uk, 'FR', 'GBP');
    const sup = await party('Leeds Supplies', false, uk, 'GB', 'GBP');
    const usSup = await party('Seattle Cloud', false, uk, 'US', 'GBP');
    const cnSup = await party('Shenzhen Parts', false, uk, 'CN', 'GBP');
    await invoice(uk, { kind: 'sales_invoice', partyId: local, date: '2026-01-10', dueDate: '2026-02-09', lines: [line(1000, 'SR'), line(100, 'RR'), line(50, 'ZR')] });
    await invoice(uk, { kind: 'sales_invoice', partyId: us, date: '2026-01-11', dueDate: '2026-02-10', lines: [line(400, 'EXP')] });
    await invoice(uk, { kind: 'sales_invoice', partyId: fr1, date: '2026-01-12', dueDate: '2026-02-11', lines: [line(300, 'OS')] });
    await invoice(uk, { kind: 'purchase_invoice', partyId: sup, date: '2026-02-01', lines: [line(500, 'SR', '5500')] });
    await invoice(uk, { kind: 'purchase_invoice', partyId: usSup, date: '2026-02-02', lines: [line(200, 'RCS', '5500')] });
    await invoice(uk, { kind: 'purchase_invoice', partyId: cnSup, date: '2026-02-03', lines: [line(1000, 'PVA', '5500')] });
    const r = await tx(admin, (q) => tax.computeVatReturn(q, admin, uk, '2026-01-01', '2026-03-31'));
    assert.equal(r.form, 'GB-VAT100');
    const v = (k: string) => r.boxes[k].vat, a = (k: string) => r.boxes[k].amount;
    assert.deepEqual([v('1'), v('3'), v('4'), v('5'), a('6'), a('7')], [445, 445, 340, 105, 1750, 1700]);
    assert.equal(r.netPayable, 105);
    const mtd = await tx(admin, (q) => tax.mtdVatReturn(q, admin, uk, '2026-01-01', '2026-03-31', '26A1'));
    assert.deepEqual(mtd.body, { periodKey: '26A1', vatDueSales: 445, vatDueAcquisitions: 0, totalVatDue: 445, vatReclaimedCurrPeriod: 340, netVatDue: 105,
      totalValueSalesExVAT: 1750, totalValuePurchasesExVAT: 1700, totalValueGoodsSuppliedExVAT: 0, totalAcquisitionsExVAT: 0, finalised: true });
    await assert.rejects(tx(admin, (q) => tax.mtdVatReturn(q, admin, uk, '2026-01-01', '2026-03-31', 'x')), /period key/);
    await assert.rejects(tx(admin, (q) => tax.ecSalesList(q, admin, uk, '2026-01-01', '2026-03-31')), /in the EU/);
    const filed = await tx(admin, (q) => tax.fileVatReturn(q, admin, uk, '2026-01-01', '2026-03-31', 'MTD 26A1'));
    assert.equal(Number(filed.net_payable), 105);
    assert.equal(await balance(uk, ['2110']), -105);
  });

  it('works out UK corporation tax with marginal relief between the limits', async () => {
    assert.equal(ukCorporationTax(40000, 25, 50000), 7600);
    assert.equal(ukCorporationTax(100000, 25, 50000), 22750);
    assert.equal(ukCorporationTax(300000, 25, 50000), 75000);
    assert.equal(ukCorporationTax(-5, 25, 50000), 0);
    assert.equal(FRANCE.corporateTax!(100000, 25, 42500), 20750);
    assert.equal(NETHERLANDS.corporateTax!(300000, 25.8, 200000), 63800);
    // Through the books: the UK company's profit so far (1,850 of sales less 1,700 of costs) is under the lower limit, so 19%.
    const ct = await tx(admin, (q) => tax.provideCorporateTax(q, admin, uk, 2026));
    assert.equal(ct.accountingProfit, 150);
    assert.equal(ct.tax, 28.5);
    assert.match(ct.rule!, /marginal relief/);
  });

  it('prepares the German UStVA by Kennzahl, the EC sales list and XRechnung e-invoices', async () => {
    const local = await party('Berlin Handel', true, de, 'DE', 'EUR');
    const frC = await party('Paris Distribution', true, de, 'FR', 'EUR', 'FR98765432109', { street: '1 rue de Rivoli', city: 'Paris', postal_code: '75001', email: 'ap@paris.test' });
    const nlC = await party('Utrecht Software', true, de, 'NL', 'EUR');
    const usC = await party('Denver Retail', true, de, 'US', 'EUR');
    const sup = await party('Hamburg Bedarf', false, de, 'DE', 'EUR');
    const frS = await party('Lille Composants', false, de, 'FR', 'EUR');
    const usS = await party('Austin Hosting', false, de, 'US', 'EUR');
    const atS = await party('Wien Beratung', false, de, 'AT', 'EUR');
    await invoice(de, { kind: 'sales_invoice', partyId: local, date: '2026-01-05', dueDate: '2026-02-04', lines: [line(1000, 'SR'), line(200, 'RR')] });
    const ic = await invoice(de, { kind: 'sales_invoice', partyId: frC, date: '2026-01-06', dueDate: '2026-02-05', lines: [line(500, 'IC')] });
    await invoice(de, { kind: 'sales_invoice', partyId: nlC, date: '2026-01-07', dueDate: '2026-02-06', lines: [line(300, 'ICS')] });
    await invoice(de, { kind: 'sales_invoice', partyId: usC, date: '2026-01-08', dueDate: '2026-02-07', lines: [line(100, 'EXP')] });
    await invoice(de, { kind: 'purchase_invoice', partyId: sup, date: '2026-01-10', lines: [line(400, 'SR', '5500')] });
    await invoice(de, { kind: 'purchase_invoice', partyId: frS, date: '2026-01-11', lines: [line(1000, 'ICA', '5500')] });
    await invoice(de, { kind: 'purchase_invoice', partyId: usS, date: '2026-01-12', lines: [line(200, 'RCS', '5500')] });
    await invoice(de, { kind: 'purchase_invoice', partyId: atS, date: '2026-01-13', lines: [line(100, 'RCS', '5500')] });
    const r = await tx(admin, (q) => tax.computeVatReturn(q, admin, de, '2026-01-01', '2026-01-31'));
    assert.equal(r.form, 'DE-UStVA');
    const b = r.boxes;
    assert.deepEqual([b['81'], b['86'], b['89'], b['46'], b['84']].map((x) => [x.amount, x.vat]), [[1000, 190], [200, 14], [1000, 190], [100, 19], [200, 38]]);
    assert.deepEqual([b['41'].amount, b['21'].amount, b['43'].amount], [500, 300, 100]);
    assert.deepEqual([b['66'].vat, b['61'].vat, b['67'].vat, b['83'].vat], [76, 190, 57, 128]);
    assert.equal(r.netPayable, 128);

    const ecsl = await tx(admin, (q) => tax.ecSalesList(q, admin, de, '2026-01-01', '2026-01-31'));
    assert.deepEqual(ecsl.rows.map((x: any) => [x.country, x.vat_number, x.goods, x.services]), [['FR', 'FR98765432109', 500, 0], ['NL', null, 0, 300]]);
    assert.match(ecsl.problems[0], /Utrecht Software/);
    assert.match(ecsl.csv, /^Country,VAT number,Customer,Goods,Services\r\nFR,FR98765432109,"Paris Distribution",500\.00,0\.00\r\n/);

    // XRechnung: the company's address, contact and IBAN come first.
    const check = await tx(admin, (q) => einv.preview(q, admin, ic.id));
    assert.equal(check.ready, false);
    assert.ok(check.problems.some((p: any) => /BR-DE-6/.test(p.rule)));
    await tx(admin, (q) => einv.updateCompanyDetails(q, admin, de, { street: 'Friedrichstr. 1', city: 'Berlin', postalCode: '10117', email: 'rechnung@acme.test',
      phone: '+49 30 1234567', iban: 'DE89370400440532013000' }));
    const ok = await tx(admin, (q) => einv.preview(q, admin, ic.id));
    assert.equal(ok.ready, true, JSON.stringify(ok.problems));
    const issued = await tx(admin, (q) => einv.issue(q, admin, ic.id));
    assert.equal(issued.profile, 'xrechnung-3.0');
    const xml = (await tx(admin, (q) => einv.getEinvoice(q, admin, issued.id))).xml as string;
    for (const want of ['urn:xeinkauf.de:kosit:xrechnung_3.0', '<cbc:BuyerReference>Paris Distribution</cbc:BuyerReference>', '<cbc:ID>K</cbc:ID>',
      '<cbc:TaxExemptionReasonCode>VATEX-EU-IC</cbc:TaxExemptionReasonCode>', '<cbc:EndpointID schemeID="9957">FR98765432109</cbc:EndpointID>',
      '<cbc:CompanyID>DE123456789</cbc:CompanyID>', '<cbc:PayableAmount currencyID="EUR">500.00</cbc:PayableAmount>']) assert.ok(xml.includes(want), want);
    await assert.rejects(tx(admin, (q) => einv.issue(q, admin, ic.id)), /already issued/);
  });

  it('prepares the French CA3 with self-assessed acquisitions in line 08', async () => {
    const c = await party('Nantes Commerce', true, fr, 'FR', 'EUR');
    const itC = await party('Milano Moda', true, fr, 'IT', 'EUR', 'IT12345678901');
    const s1 = await party('Rennes Fournitures', false, fr, 'FR', 'EUR');
    const s2 = await party('Gent Onderdelen', false, fr, 'BE', 'EUR');
    await invoice(fr, { kind: 'sales_invoice', partyId: c, date: '2026-02-05', dueDate: '2026-03-05', lines: [line(1000, 'SR'), line(100, 'RR2')] });
    await invoice(fr, { kind: 'sales_invoice', partyId: itC, date: '2026-02-06', dueDate: '2026-03-06', lines: [line(300, 'IC')] });
    await invoice(fr, { kind: 'purchase_invoice', partyId: s1, date: '2026-02-07', lines: [line(500, 'SR', '5500')] });
    await invoice(fr, { kind: 'purchase_invoice', partyId: s2, date: '2026-02-08', lines: [line(200, 'ICA', '5500')] });
    const r = await tx(admin, (q) => tax.computeVatReturn(q, admin, fr, '2026-02-01', '2026-02-28'));
    const b = r.boxes;
    assert.deepEqual([b['08'].amount, b['08'].vat, b['09'].amount, b['09'].vat, b.F2.amount, b.B2.amount, b['17'].vat, b['16'].vat, b['20'].vat, b['28'].vat],
      [1200, 240, 100, 5.5, 300, 200, 40, 245.5, 140, 105.5]);
  });

  it('applies each country\'s end-of-service rule', () => {
    near(franceEndOfService({ basic: 3000, housing: 0 }, '2014-01-01', '2026-01-01', 'termination'), 9500, 'France 12 years');
    assert.equal(franceEndOfService({ basic: 3000, housing: 0 }, '2014-01-01', '2026-01-01', 'resignation'), 0);
    assert.equal(franceEndOfService({ basic: 3000, housing: 0 }, '2025-09-01', '2026-01-01', 'termination'), 0);
    assert.ok(Math.abs(netherlandsEndOfService({ basic: 3000, housing: 0 }, '2020-01-01', '2026-01-01', 'termination') - 6000) < 5);
    assert.equal(netherlandsEndOfService({ basic: 3000, housing: 0 }, '2020-01-01', '2026-01-01', 'resignation'), 0);
    assert.ok(Math.abs(spainEndOfService({ basic: 2000, housing: 0 }, '2023-01-01', '2026-01-01', 'termination') - 3945.2) < 3);
    assert.ok(Math.abs(italyEndOfService({ basic: 2000, housing: 0 }, '2024-01-01', '2026-01-01') - 3851.85) < 3);
  });
});

describe('UK and Irish payroll', () => {
  it('reads UK tax codes and works out PAYE on the cumulative basis', () => {
    assert.deepEqual(ukTaxMonth('2026-04'), { month: 1, taxYear: 2026, yearFrom: '2026-04', yearTo: '2027-03' });
    assert.equal(ukTaxMonth('2027-03').month, 12);
    assert.equal(parseUkTaxCode('s1257l').region, 'S');
    assert.equal(parseUkTaxCode('1257L M1').cumulative, false);
    assert.throws(() => parseUkTaxCode('12X'), /not a UK tax code/);
    assert.equal(ukPaye('1257L', 1, 3000, 0, 0), 390.2);
    assert.equal(ukPaye('1257L', 2, 3000, 3000, 390.2), 390.4);
    assert.equal(ukPaye('1257L M1', 6, 3000, 15000, 2000), 390.2);
    assert.equal(ukPaye('BR', 5, 1000, 0, 0), 200);
    assert.equal(ukPaye('K100', 1, 500, 0, 0), 116.8);
    assert.equal(ukPaye('K1000', 1, 500, 0, 0), 250, 'K codes take at most half the pay');
    assert.equal(ukPaye('NT', 1, 5000, 0, 0), 0);
    near(ukPaye('S1257L', 1, 3000, 0, 0), 394.91, 'Scottish bands');
  });

  it('runs a UK payroll: PAYE after pension, National Insurance between thresholds, and posts the tax to HMRC', async () => {
    const e = await person('UK01', uk);
    const k = await tx(admin, (q) => hr.createContract(q, admin, { employeeId: e, companyId: uk, startDate: '2026-01-01', basic: 3000 }));
    await assert.rejects(tx(admin, (q) => hr.runPayroll(q, admin, { companyId: uk, period: '2026-04' })), /tax code of UK01/);
    await assert.rejects(tx(admin, (q) => hr.setContractTax(q, admin, k.id, { withholdingPct: 20 })), /tax code/);
    await assert.rejects(tx(admin, (q) => hr.setContractTax(q, admin, k.id, { taxCode: 'ABC' })), /not a UK tax code/);
    await tx(admin, (q) => hr.setContractTax(q, admin, k.id, { taxCode: '1257L' }));
    let run = await tx(admin, (q) => hr.runPayroll(q, admin, { companyId: uk, period: '2026-04' }));
    const p = run.payslips[0];
    const c = Object.fromEntries((p.contributions as any[]).map((x) => [x.code, [x.employee, x.employer]]));
    assert.deepEqual(c, { NI_EE_MAIN: [156.16, 0], NI_ER: [0, 387.45], PENSION_AE: [124, 74.4] });
    assert.deepEqual([Number(p.taxable_pay), Number(p.income_tax), Number(p.net)], [2876, 365.4, 2354.44]);
    assert.match(p.taxes[0].name, /1257L, month 1/);
    await tx(admin, (q) => hr.postPayroll(q, admin, run.id));
    assert.equal(await balance(uk, ['2240']), -365.4);
    near(await balance(uk, ['2220']), -742.01);
    // Month 2 carries the year to date.
    run = await tx(admin, (q) => hr.runPayroll(q, admin, { companyId: uk, period: '2026-05' }));
    assert.equal(Number(run.payslips[0].income_tax), 365.6);
    // Pay brought forward from before BAATS counts in the first tax year only.
    const e2 = await person('UK02', uk);
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: e2, companyId: uk, startDate: '2025-01-01', basic: 3000, taxCode: '1257L', previousPay: 3000, previousTax: 390.2 }));
    run = await tx(admin, (q) => hr.runPayroll(q, admin, { companyId: uk, period: '2026-05' }));
    // 2,876 this month on top of 3,000 brought forward; without it the tax would be 155.80.
    assert.equal(Number(run.payslips.find((x: any) => x.employee_no === 'UK02').income_tax), 365.6);
    const rules = await tx(admin, (q) => hr.listContributionRules(q, admin, uk));
    assert.equal(rules.incomeTax.method, 'uk_paye');
    assert.equal(rules.rules.find((r: any) => r.code === 'NI_ER').monthly_threshold, 417);
    await assert.rejects(tx(admin, (q) => hr.saveContributionRule(q, admin, uk, { code: 'NI_EE_MAIN', monthlyThreshold: 5000 })), /below the cap/);
  });

  it('runs an Irish payroll with PAYE, USC and PRSI, and pays it by SEPA transfer', async () => {
    assert.deepEqual(irelandPaye(1, 4000, 0, 0, 0, { credits: 4000, cutOff: 44000 }, 48000).paye, 533.33);
    assert.equal(irelandPaye(1, 1000, 0, 0, 0, { credits: 4000, cutOff: 44000 }, 12000).usc, 0);
    const e = await person('IE01', ie);
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: e, companyId: ie, startDate: '2025-06-01', basic: 4000,
      taxCredits: 4000, rateCutOff: 44000, iban: 'IE64IRCE92050112345678' }));
    let run = await tx(admin, (q) => hr.runPayroll(q, admin, { companyId: ie, period: '2026-01' }));
    const p = run.payslips[0];
    const tx2 = Object.fromEntries((p.taxes as any[]).map((x) => [x.code, x.amount]));
    assert.equal(tx2.PAYE, 533.33);
    near(tx2.USC, 81.07);
    assert.deepEqual([p.contributions[0].employee, p.contributions[0].employer], [168, 450]);
    near(Number(p.net), 3217.6);
    run = await tx(admin, (q) => hr.postPayroll(q, admin, run.id));
    await assert.rejects(tx(admin, (q) => hr.payPayroll(q, admin, run.id, { date: '2026-01-31' })), /IBAN in its bank details/);
    await tx(admin, (q) => bankfiles.setBankDetails(q, admin, ie, { bankAccount: '1010', bankName: 'AIB', iban: 'IE29AIBK93115212345678', bic: 'AIBKIE2D' }));
    const paid = await tx(admin, (q) => hr.payPayroll(q, admin, run.id, { date: '2026-01-31' }));
    assert.equal(paid.records, 1);
    for (const want of ['<CtgyPurp><Cd>SALA</Cd></CtgyPurp>', '<IBAN>IE64IRCE92050112345678</IBAN>', '<IBAN>IE29AIBK93115212345678</IBAN>', '<BIC>AIBKIE2D</BIC>',
      '<ReqdExctnDt>2026-01-31</ReqdExctnDt>']) assert.ok(paid.content!.includes(want), want);
    assert.match(paid.note!, /ROS/);
  });

  it('withholds at the employee\'s rate in Germany, and refuses a run until every rate is set', async () => {
    const e = await person('DE01', de);
    const k = await tx(admin, (q) => hr.createContract(q, admin, { employeeId: e, companyId: de, startDate: '2026-01-01', basic: 5000 }));
    await assert.rejects(tx(admin, (q) => hr.runPayroll(q, admin, { companyId: de, period: '2026-02' })), /withholding rate of DE01/);
    await assert.rejects(tx(admin, (q) => hr.setContractTax(q, admin, k.id, { taxCode: '1257L' })), /UK PAYE/);
    await tx(admin, (q) => hr.setContractTax(q, admin, k.id, { withholdingPct: 18.5 }));
    const run = await tx(admin, (q) => hr.runPayroll(q, admin, { companyId: de, period: '2026-02' }));
    const p = run.payslips[0];
    assert.equal(Number(p.income_tax), 925);
    const kv = (p.contributions as any[]).find((x) => x.code === 'DE_KV');
    assert.deepEqual([kv.base, kv.employee], [5000, 437.5]);
  });
});

describe('the API', () => {
  it('serves the EC sales list and the Making Tax Digital body, and changes a contract\'s tax details', async () => {
    const app = buildServer({ db: t.db });
    await app.ready();
    const tok = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `admin@${s.code}.test`, password: PASSWORD } })).json().token;
    const h = { authorization: `Bearer ${tok}` };
    const ec = await app.inject({ method: 'GET', url: `/v1/fin/companies/${de}/ec-sales-list?from=2026-01-01&to=2026-01-31`, headers: h });
    assert.equal(ec.statusCode, 200);
    assert.equal(ec.json().rows.length, 2);
    const mtd = await app.inject({ method: 'GET', url: `/v1/fin/companies/${uk}/vat-return/mtd?from=2026-01-01&to=2026-03-31&periodKey=26A1`, headers: h });
    assert.equal(mtd.json().body.netVatDue, 105);
    const k = (await app.inject({ method: 'GET', url: `/v1/hr/companies/${uk}/contracts`, headers: h })).json()[0];
    const ch = await app.inject({ method: 'PATCH', url: `/v1/hr/contracts/${k.id}/tax`, headers: h, payload: { taxCode: 'BR' } });
    assert.equal(ch.statusCode, 200, ch.body);
    assert.equal(ch.json().tax_code, 'BR');
    await app.close();
  });
});
