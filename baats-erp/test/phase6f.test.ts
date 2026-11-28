import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { one, type Ctx } from '../src/core/db.ts';
import * as setup from '../src/fin/setup.ts';
import * as docs from '../src/fin/documents.ts';
import * as tax from '../src/fin/tax.ts';
import * as einv from '../src/fin/einvoice.ts';
import * as country from '../src/fin/country.ts';
import * as mdm from '../src/mdm/service.ts';
import { indiaGratuity, pakistanGratuity, validGstin, INDIA, PAKISTAN } from '../src/fin/southasia.ts';
import { annualSlabWithholding, fiscalMonth, indiaAnnualTax, pakistanAnnualTax } from '../src/hr/incometax.ts';
import * as hr from '../src/hr/service.ts';
import * as org from '../src/org/service.ts';
import { buildServer } from '../src/api/server.ts';
import { createTestDb, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

/**
 * Phase 6f: the India and Pakistan country packs.
 */

let t: TestDb;
let s: Seed;
let admin: Ctx;
let ind: string, pak: string;
let hsnItem: string;

const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);
const balance = (company: string, codes: string[]) => tx(admin, async (q) =>
  Number((await one(q, `SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM fin.journal_lines l
     JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
    WHERE a.company_id = $1 AND a.code = ANY($2)`, [company, codes])).b));
async function party(code: string, isCustomer: boolean, owner: string, ctry: string, cur: string, taxNo: string | null = null, attributes: object = {}) {
  return tx(admin, async (q) => (await one(q, `INSERT INTO mdm.parties (tenant_id, code, name, normalized_name, is_customer, is_supplier, country_code, currency_code,
      owner_unit_id, status, tax_registration_no, attributes) VALUES (app.tenant(), $1, $1, lower($1), $2, $3, $4, $5, $6, 'active', $7, $8) RETURNING id`,
  [code, isCustomer, !isCustomer, ctry, cur, owner, taxNo, JSON.stringify(attributes)])).id as string);
}
async function invoice(companyId: string, input: Omit<docs.InvoiceInput, 'companyId'>) {
  const d = await tx(admin, (q) => docs.createInvoice(q, admin, { companyId, ...input }));
  return tx(admin, (q) => docs.postInvoice(q, admin, d.id));
}
const line = (amount: number, taxCode: string, extra: object = {}) => ({ description: `Line ${taxCode}`, quantity: 1, unitPrice: amount, taxCode, ...extra });
const unit = (code: string, name: string, countryCode: string, currencyCode: string) =>
  tx(admin, async (q) => (await org.createUnit(q, admin, { typeCode: 'company', parentId: s.units.root, code, name, countryCode, currencyCode })).id as string);
const person = (no: string, unitId: string, nationality: string) =>
  tx(admin, async (q) => (await org.createEmployee(q, admin, { employeeNo: no, firstName: no, lastName: 'Test', unitId, nationality })).id as string);
const near = (a: number, b: number, why = '') => assert.ok(Math.abs(a - b) < 0.011, `${a} is not ${b} ${why}`);

const MAHARASHTRA = '27AAPFU0939F1ZV', KARNATAKA = '29AABCU9603R1ZJ';

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  admin = s.adminCtx;
  ind = await unit('IN01', 'Acme India', 'IN', 'INR');
  pak = await unit('PK01', 'Acme Pakistan', 'PK', 'PKR');
  await tx(admin, (q) => mdm.createUom(q, admin, { code: 'PCS', name: 'Pieces' }));
  hsnItem = (await tx(admin, (q) => mdm.createItem(q, admin, { code: 'LAPTOP', name: 'Laptop', itemType: 'non_stock', baseUom: 'PCS', attributes: { hsn: '84713010', hs_code: '8471.3010' } }))).id;
});
after(async () => { await t.drop(); });

describe('the India pack', () => {
  it('checks GSTINs and sets up books with GST codes and Indian account names', async () => {
    assert.equal(validGstin(MAHARASHTRA), true);
    assert.equal(validGstin('27AAPFU0939F1ZA'), false, 'wrong check character');
    assert.equal(validGstin('99AAPFU0939F1ZV'), false, 'no such state');
    const packs = country.packSummary();
    assert.deepEqual(packs.filter((p) => p.region === 'SA').map((p) => [p.country, p.currency, p.vat]), [['IN', 'INR', '5%'], ['PK', 'PKR', '18%']]);
    assert.match(packs.find((p) => p.country === 'IN')!.einvoice, /IRP schema 1.1/);
    assert.equal(packs.find((p) => p.country === 'IN')!.contributions.find((c) => c.code === 'ESI')!.eligibleUpTo, 21000);
    await assert.rejects(tx(admin, (q) => setup.setupCompany(q, admin, { unitId: ind, legalName: 'Acme India Pvt Ltd', taxRegistrationNo: '27AAPFU0939F1ZA', openFrom: '2026-04-01' })), /GSTIN/);
    const c = await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: ind, legalName: 'Acme India Pvt Ltd', taxRegistrationNo: MAHARASHTRA, openFrom: '2026-04-01' }));
    assert.deepEqual([c.base_currency, Number(c.corporate_tax_rate)], ['INR', 25.17]);
    const name = async (code: string) => (await tx(admin, (q) => setup.listAccounts(q, admin, ind))).find((a: any) => a.code === code)?.name;
    assert.equal(await name('2240'), 'TDS on Salaries Payable (section 192)');
    const codes = (await tx(admin, (q) => setup.listTaxCodes(q, 'IN'))).map((x: any) => x.code);
    assert.deepEqual(codes, ['EX', 'EXP', 'G18', 'G40', 'G5', 'I18', 'I40', 'I5', 'NG', 'NIL', 'RCM18', 'RCM5', 'RCMI18']);
  });

  it('refuses CGST and SGST across a state line and IGST within the state', async () => {
    const mumbai = await party('Mumbai Traders', true, ind, 'IN', 'INR', MAHARASHTRA.replace('1ZV', '2Z') + 'X');
    const bengaluru = await party('Bengaluru Systems', true, ind, 'IN', 'INR', '29AAACB4444D1Z4', { street: '12 MG Road', city: 'Bengaluru', postal_code: '560001' });
    const nobody = await party('Walk-in', true, ind, 'IN', 'INR');
    const us = await party('Austin Buyer', true, ind, 'US', 'INR');
    await assert.rejects(invoice(ind, { kind: 'sales_invoice', partyId: bengaluru, date: '2026-04-05', lines: [line(1000, 'G18')] }), /inter-state; use I18/);
    await assert.rejects(invoice(ind, { kind: 'sales_invoice', partyId: mumbai, date: '2026-04-05', lines: [line(1000, 'I18')] }), /within the state; use G18/);
    await assert.rejects(invoice(ind, { kind: 'sales_invoice', partyId: nobody, date: '2026-04-05', lines: [line(1000, 'G18')] }), /place of supply is unknown/);
    await assert.rejects(invoice(ind, { kind: 'sales_invoice', partyId: us, date: '2026-04-05', lines: [line(1000, 'G18')] }), /abroad is inter-state/);
  });

  it('prepares GSTR-3B by head and GSTR-1 by section', async () => {
    const mh = await party('Thane Wholesale', true, ind, 'IN', 'INR', '27AAACT1111A1Z1');
    const ka = await party('Mysuru Systems', true, ind, 'IN', 'INR', KARNATAKA, { street: '1 Palace Road', city: 'Mysuru', postal_code: '570001' });
    const dl = await party('Delhi Consumer', true, ind, 'IN', 'INR', null, { state_code: '07' });
    const pune = await party('Pune Consumer', true, ind, 'IN', 'INR', null, { state_code: '27' });
    const us = await party('Boston Buyer', true, ind, 'US', 'INR', null, { street: '1 Main St', city: 'Boston' });
    const sup = await party('Nagpur Supplies', false, ind, 'IN', 'INR', '27AAACN2222B1Z2');
    const adv = await party('Mumbai Advocates', false, ind, 'IN', 'INR', '27AAACM3333C1Z3');
    await invoice(ind, { kind: 'sales_invoice', partyId: mh, date: '2026-05-02', lines: [line(10000, 'G18'), line(500, 'EX')] });
    await invoice(ind, { kind: 'sales_invoice', partyId: ka, date: '2026-05-03', lines: [line(20000, 'I18', { itemId: hsnItem })] });
    await invoice(ind, { kind: 'sales_invoice', partyId: dl, date: '2026-05-04', lines: [line(200000, 'I5')] });
    await invoice(ind, { kind: 'sales_invoice', partyId: pune, date: '2026-05-05', lines: [line(1000, 'G5')] });
    await invoice(ind, { kind: 'sales_invoice', partyId: us, date: '2026-05-06', lines: [line(50000, 'EXP', { itemId: hsnItem })] });
    await invoice(ind, { kind: 'purchase_invoice', partyId: sup, date: '2026-05-07', lines: [line(5000, 'G18', { account: '5100' })] });
    await invoice(ind, { kind: 'purchase_invoice', partyId: adv, date: '2026-05-08', lines: [line(1000, 'RCM18', { account: '5100' })] });
    const r = await tx(admin, (q) => tax.computeVatReturn(q, admin, ind, '2026-05-01', '2026-05-31'));
    assert.equal(r.form, 'IN-GSTR3B');
    const b = (k: string) => [r.boxes[k].amount, r.boxes[k].vat, r.boxes[k].heads!.igst, r.boxes[k].heads!.cgst, r.boxes[k].heads!.sgst];
    assert.deepEqual(b('3.1a'), [231000, 15450, 13600, 925, 925]);
    assert.deepEqual(b('3.1b'), [50000, 0, 0, 0, 0]);
    assert.deepEqual(b('3.1c').slice(0, 2), [500, 0]);
    assert.deepEqual(b('3.1d'), [1000, 180, 0, 90, 90]);
    assert.deepEqual(b('4C'), [6000, 1080, 0, 540, 540]);
    assert.deepEqual(b('6.1').slice(1), [14550, 13600, 475, 475]);
    assert.deepEqual([r.outputTax, r.inputTax, r.netPayable], [15630, 1080, 14550]);
    const g1 = await tx(admin, (q) => tax.gstr1(q, admin, ind, '2026-05-01', '2026-05-31'));
    assert.deepEqual(g1.rows.map((x: any) => x.section).sort(), ['B2B', 'B2B', 'B2CL', 'B2CS', 'EXP']);
    const b2cl = g1.rows.find((x: any) => x.section === 'B2CL')!;
    assert.deepEqual([b2cl.placeOfSupply, b2cl.taxable, b2cl.igst], ['07-Delhi', 200000, 10000]);
    const b2cs = g1.rows.find((x: any) => x.section === 'B2CS')!;
    assert.deepEqual([b2cs.placeOfSupply, b2cs.cgst, b2cs.sgst], ['27-Maharashtra', 25, 25]);
    assert.match(g1.csv, /^Section,GSTIN of recipient/);
    await tx(admin, (q) => tax.fileVatReturn(q, admin, ind, '2026-05-01', '2026-05-31', 'GSTR-3B May'));
    assert.equal(await balance(ind, ['2110']), -14550);
  });

  it('writes the IRP e-invoice JSON for a B2B supply once its details are complete', async () => {
    const list = await tx(admin, (q) => einv.listEinvoices(q, admin, ind));
    const ka = list.find((x: any) => x.party_name === 'Mysuru Systems')!;
    let p = await tx(admin, (q) => einv.preview(q, admin, ka.invoice_id));
    assert.equal(p.ready, false);
    assert.ok(p.problems.some((x: any) => x.rule === 'SellerDtls.Pin'));
    await assert.rejects(tx(admin, (q) => einv.updateCompanyDetails(q, admin, ind, { postalCode: '4000' })), /6 digits/);
    await tx(admin, (q) => einv.updateCompanyDetails(q, admin, ind, { street: '5 Nariman Point', city: 'Mumbai', postalCode: '400021' }));
    p = await tx(admin, (q) => einv.preview(q, admin, ka.invoice_id));
    assert.deepEqual(p.problems, []);
    const j = JSON.parse(p.xml!);
    assert.deepEqual([j.Version, j.TranDtls.SupTyp, j.SellerDtls.Stcd, j.BuyerDtls.Pos, j.ItemList[0].HsnCd, j.ItemList[0].IgstAmt, j.ValDtls.TotInvVal],
      ['1.1', 'B2B', '27', '29', '84713010', 3600, 23600]);
    assert.match(j.DocDtls.Dt, /^03\/05\/2026$/);
    const e = await tx(admin, (q) => einv.issue(q, admin, ka.invoice_id));
    assert.equal(e.profile, 'in-irp-1.1');
    await tx(admin, (q) => einv.recordAspResponse(q, admin, e.id, { status: 'accepted', reference: 'a1b2c3-IRN' }));
    const exp = list.find((x: any) => x.party_name === 'Boston Buyer')!;
    const pe = await tx(admin, (q) => einv.preview(q, admin, exp.invoice_id));
    assert.equal(JSON.parse(pe.xml!).TranDtls.SupTyp, 'EXPWOP');
    const b2c = list.find((x: any) => x.party_name === 'Delhi Consumer')!;
    const pb = await tx(admin, (q) => einv.preview(q, admin, b2c.invoice_id));
    assert.ok(pb.problems.some((x: any) => x.rule === 'BuyerDtls.Gstin'));
  });

  it('works out salary TDS under the new regime and spreads it over the year', () => {
    assert.equal(indiaAnnualTax(1275000), 0, 'rebate up to 12 lakh after the standard deduction');
    assert.equal(indiaAnnualTax(1300000), 26000, 'marginal relief above 12 lakh');
    assert.equal(indiaAnnualTax(1500000), 97500);
    assert.equal(indiaAnnualTax(2475000), 312000);
    assert.equal(indiaAnnualTax(5100000), 1149200, 'marginal relief on the surcharge');
    assert.equal(indiaAnnualTax(6000000), 1552980);
    assert.deepEqual(fiscalMonth('2026-01', 4), { month: 10, yearFrom: '2025-04', yearTo: '2026-03' });
    assert.deepEqual(annualSlabWithholding(indiaAnnualTax, 150000, 150000, 11, 0, 0), { tax: 12566.67, projected: 1800000, yearTax: 150800 });
  });

  it('runs an Indian payroll: EPF on capped basic, ESI only up to the ceiling, TDS and gratuity', async () => {
    const high = await person('IN01', ind, 'IN');
    const low = await person('IN02', ind, 'IN');
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: high, companyId: ind, startDate: '2026-04-01', basic: 100000, housing: 40000, transport: 10000,
      iban: 'HDFC0001234-50100123456789' }));
    await assert.rejects(tx(admin, (q) => hr.createContract(q, admin, { employeeId: low, companyId: ind, startDate: '2026-04-01', basic: 12000, iban: 'IN12HDFC' })), /IFSC/);
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: low, companyId: ind, startDate: '2026-04-01', basic: 12000, housing: 6000 }));
    let run = await tx(admin, (q) => hr.runPayroll(q, admin, { companyId: ind, period: '2026-04' }));
    const slip = (no: string) => run.payslips.find((x: any) => x.employee_no === no);
    const c = (no: string) => Object.fromEntries((slip(no).contributions as any[]).map((x) => [x.code, [x.employee, x.employer]]));
    assert.deepEqual(c('IN01'), { EPF: [1800, 550.5], EPS: [0, 1249.5], EDLI: [0, 75], EPF_ADMIN: [0, 75] });
    assert.deepEqual(c('IN02').ESI, [135, 585], 'ESI on 18,000 gross');
    // 150,000 a month: 1,800,000 a year, tax 150,800, a twelfth this month.
    assert.equal(Number(slip('IN01').income_tax), 12566.67);
    assert.match(slip('IN01').taxes[0].name, /section 192/);
    assert.equal(Number(slip('IN02').income_tax), 0);
    run = await tx(admin, (q) => hr.postPayroll(q, admin, run.id));
    assert.equal(await balance(ind, ['2240']), -12566.67);
    // A rise in May raises the estimate; what was withheld in April counts.
    const rules = await tx(admin, (q) => hr.listContributionRules(q, admin, ind));
    assert.equal(rules.incomeTax.method, 'annual_slab');
    assert.equal(rules.rules.find((r: any) => r.code === 'ESI').eligible_up_to, 21000);
    await assert.rejects(tx(admin, (q) => hr.saveContributionRule(q, admin, ind, { code: 'ESI', eligibleUpTo: 0 })), /more than 0/);
    // Gratuity from five years, more than six months counting as a year.
    assert.equal(indiaGratuity({ basic: 26000, housing: 0 }, '2020-01-01', '2024-12-31'), 0);
    assert.equal(indiaGratuity({ basic: 26000, housing: 0 }, '2020-01-01', '2025-08-01'), 90000);
    assert.equal(indiaGratuity({ basic: 26000, housing: 0 }, '2023-01-01', '2024-01-01', 'death'), 15000);
    assert.equal(indiaGratuity({ basic: 10000000, housing: 0 }, '2000-01-01', '2026-01-01'), 2000000);
    assert.match(INDIA.incomeTax!.gap!, /old regime/);
  });
});

describe('the Pakistan pack', () => {
  it('prepares the FBR and provincial sales tax returns separately', async () => {
    await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: pak, legalName: 'Acme Pakistan (Pvt) Ltd', taxRegistrationNo: '1234567-8', openFrom: '2026-07-01' }));
    const khi = await party('Karachi Retail', true, pak, 'PK', 'PKR', '7654321-0', { province: 'Sindh', street: 'Shahrah-e-Faisal', city: 'Karachi' });
    const lhr = await party('Lahore Services', true, pak, 'PK', 'PKR', null, { province: 'Punjab' });
    const sup = await party('Faisalabad Mills', false, pak, 'PK', 'PKR', '1111111-1');
    await invoice(pak, { kind: 'sales_invoice', partyId: khi, date: '2026-07-10', lines: [line(100000, 'ST18', { itemId: hsnItem }), line(5000, 'EX', { itemId: hsnItem })] });
    await invoice(pak, { kind: 'sales_invoice', partyId: khi, date: '2026-07-11', lines: [line(20000, 'SRB15')] });
    await invoice(pak, { kind: 'sales_invoice', partyId: lhr, date: '2026-07-12', lines: [line(10000, 'PRA16')] });
    await invoice(pak, { kind: 'purchase_invoice', partyId: sup, date: '2026-07-13', lines: [line(40000, 'ST18', { account: '5100' })] });
    const r = await tx(admin, (q) => tax.computeVatReturn(q, admin, pak, '2026-07-01', '2026-07-31'));
    assert.equal(r.form, 'PK-STR');
    const v = (k: string) => [r.boxes[k].amount, r.boxes[k].vat];
    assert.deepEqual(v('FBR-1'), [100000, 18000]);
    assert.deepEqual(v('FBR-2'), [40000, 7200]);
    assert.deepEqual(v('FBR-4'), [5000, 0]);
    assert.deepEqual(v('FBR-9'), [0, 10800]);
    assert.deepEqual(v('SRB-1'), [20000, 3000]);
    assert.deepEqual(v('PRA-9'), [0, 1600]);
    assert.equal(r.boxes['KPRA-1'], undefined, 'authorities with nothing to declare are left out');
    assert.equal(r.netPayable, 15400);
  });

  it('writes the FBR digital invoice for goods and leaves provincial services out', async () => {
    const list = await tx(admin, (q) => einv.listEinvoices(q, admin, pak));
    const goods = list.find((x: any) => x.party_name === 'Karachi Retail' && Number(x.gross_total) > 110000)!;
    let p = await tx(admin, (q) => einv.preview(q, admin, goods.invoice_id));
    assert.ok(p.problems.some((x: any) => x.rule === 'sellerProvince'));
    await assert.rejects(tx(admin, (q) => einv.updateCompanyDetails(q, admin, pak, { province: 'Dubai' })), /province is Punjab/);
    await tx(admin, (q) => einv.updateCompanyDetails(q, admin, pak, { province: 'Sindh', street: 'I.I. Chundrigar Road', city: 'Karachi' }));
    p = await tx(admin, (q) => einv.preview(q, admin, goods.invoice_id));
    assert.deepEqual(p.problems, []);
    const j = JSON.parse(p.xml!);
    assert.deepEqual([j.invoiceType, j.sellerNTNCNIC, j.buyerRegistrationType, j.items.length, j.items[0].rate, j.items[0].salesTaxApplicable, j.items[1].saleType],
      ['Sale Invoice', '12345678', 'Registered', 2, '18%', 18000, 'Exempt goods']);
    const e = await tx(admin, (q) => einv.issue(q, admin, goods.invoice_id));
    assert.equal(e.profile, 'pk-fbr-di-1.12');
    const svc = list.find((x: any) => x.party_name === 'Lahore Services')!;
    const ps = await tx(admin, (q) => einv.preview(q, admin, svc.invoice_id));
    assert.ok(ps.problems.some((x: any) => /provincial sales tax on services/.test(x.message)));
  });

  it('withholds salary tax over the July to June year, with EOBI and social security on the minimum wage', async () => {
    assert.equal(pakistanAnnualTax(600000), 0);
    assert.equal(pakistanAnnualTax(1200000), 6000);
    assert.equal(pakistanAnnualTax(2400000), 162000);
    assert.equal(pakistanAnnualTax(12000000), 3685290, '9% surcharge above 10 million');
    const e = await person('PK01', pak, 'PK');
    await assert.rejects(tx(admin, (q) => hr.createContract(q, admin, { employeeId: e, companyId: pak, startDate: '2026-07-01', basic: 150000, iban: 'PK00' })), /Pakistani IBAN/);
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: e, companyId: pak, startDate: '2026-07-01', basic: 150000, housing: 50000,
      iban: 'PK36SCBL0000001123456702' }));
    const run = await tx(admin, (q) => hr.runPayroll(q, admin, { companyId: pak, period: '2026-07' }));
    const p = run.payslips[0];
    const c = Object.fromEntries((p.contributions as any[]).map((x) => [x.code, [x.employee, x.employer]]));
    assert.deepEqual(c, { EOBI: [370, 1850], PK_SOCIAL_SECURITY: [0, 2220] });
    // 200,000 a month: 2,400,000 a year, tax 162,000, a twelfth in July.
    assert.equal(Number(p.income_tax), 13500);
    assert.match(p.taxes[0].name, /section 149/);
    near(Number(p.net), 200000 - 370 - 13500);
    assert.equal(pakistanGratuity({ basic: 100000, housing: 0 }, '2020-01-01', '2026-08-01'), 700000);
    assert.equal(PAKISTAN.incomeTax!.yearStartMonth, 7);
  });
});

describe('the API', () => {
  it('serves GSTR-1 and sets a Pakistani company\'s province', async () => {
    const app = buildServer({ db: t.db });
    await app.ready();
    const tok = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `admin@${s.code}.test`, password: PASSWORD } })).json().token;
    const auth = { authorization: `Bearer ${tok}` };
    const g = await app.inject({ method: 'GET', url: `/v1/fin/companies/${ind}/gstr1?from=2026-05-01&to=2026-05-31`, headers: auth });
    assert.equal(g.statusCode, 200);
    assert.equal(g.json().rows.length, 5);
    const bad = await app.inject({ method: 'GET', url: `/v1/fin/companies/${pak}/gstr1?from=2026-05-01&to=2026-05-31`, headers: auth });
    assert.equal(bad.statusCode, 422);
    const pr = await app.inject({ method: 'PATCH', url: `/v1/fin/companies/${pak}`, headers: auth, payload: { province: 'Punjab' } });
    assert.equal(pr.statusCode, 200);
    assert.equal(pr.json().province, 'Punjab');
    await app.close();
  });
});
