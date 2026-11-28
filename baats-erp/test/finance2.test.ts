import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { one, type Ctx } from '../src/core/db.ts';
import { ConflictError } from '../src/core/errors.ts';
import * as setup from '../src/fin/setup.ts';
import * as ledger from '../src/fin/ledger.ts';
import * as docs from '../src/fin/documents.ts';
import * as reports from '../src/fin/reports.ts';
import * as einv from '../src/fin/einvoice.ts';
import * as bank from '../src/fin/bank.ts';
import * as assets from '../src/fin/assets.ts';
import { createTestDb, seedOrg, type Seed, type TestDb } from './helpers.ts';

let t: TestDb;
let s: Seed;
let co: string;
let admin: Ctx;
let customer: string, exporter: string, supplier: string;

const tx = <T>(fn: (q: any) => Promise<T>) => t.db.withTenant(admin, fn);
const balance = (code: string) => tx(async (q) =>
  Number((await one(q, `SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM fin.journal_lines l
     JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
    WHERE a.company_id = $1 AND a.code = $2`, [co, code])).b));

async function party(code: string, opts: { customer?: boolean; supplier?: boolean; country?: string; currency?: string; trn?: string; attributes?: object }) {
  return tx(async (q) => (await one(q, `INSERT INTO mdm.parties (tenant_id, code, name, normalized_name, is_customer, is_supplier, country_code, currency_code,
      tax_registration_no, owner_unit_id, status, attributes) VALUES (app.tenant(), $1, $1, lower($1), $2, $3, $4, $5, $6, $7, 'active', $8) RETURNING id`,
    [code, opts.customer ?? false, opts.supplier ?? false, opts.country ?? 'AE', opts.currency ?? 'AED', opts.trn ?? null, s.units.uae, JSON.stringify(opts.attributes ?? {})])).id as string);
}
async function invoice(input: Omit<docs.InvoiceInput, 'companyId'>) {
  const d = await tx((q) => docs.createInvoice(q, admin, { companyId: co, ...input }));
  return tx((q) => docs.postInvoice(q, admin, d.id));
}

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  co = s.units.uae;
  admin = s.adminCtx;
  await tx((q) => setup.setupCompany(q, admin, { unitId: co, legalName: 'Acme UAE LLC', taxRegistrationNo: '100000000000003', openFrom: '2026-01-01' }));
  customer = await party('Marina Clinics', { customer: true, trn: '100000000000103' });
  exporter = await party('Boston Labs', { customer: true, country: 'US', currency: 'USD', attributes: { street: '1 Main St', city: 'Boston', peppol_endpoint: '0088:123' } });
  supplier = await party('Gulf Tech', { supplier: true });
});
after(async () => { await t.drop(); });

describe('e-invoicing (PINT AE)', () => {
  let inv: any;
  it('lists in plain language what is missing before an e-invoice can be issued', async () => {
    inv = await invoice({ kind: 'sales_invoice', partyId: customer, date: '2026-02-01', lines: [
      { description: 'Laptop setup', quantity: 2, unitPrice: 1000, discount: 100, taxCode: 'SR' }, { description: 'Export docs', quantity: 1, unitPrice: 500, taxCode: 'ZR' }] });
    const p = await tx((q) => einv.preview(q, admin, inv.id));
    assert.equal(p.ready, false);
    const rules = p.problems.map((x) => x.rule);
    assert.ok(rules.includes('ibr-143-ae') && rules.includes('ibr-144-ae') && rules.includes('ibr-192-ae'));
    await assert.rejects(tx((q) => einv.issue(q, admin, inv.id)), /fix before issuing/);
  });
  it('issues the UBL XML once, with the UAE values, and keeps it unchanged', async () => {
    await tx((q) => einv.updateCompanyDetails(q, admin, co, { street: 'Sheikh Zayed Road', city: 'Dubai', emirate: 'DXB', iban: 'AE07 0331 2345 6789 0123 456',
      tradeLicenceNo: 'TL-12345', licenceAuthority: 'Dubai DET' }));
    await tx((q) => q.query(`UPDATE mdm.parties SET attributes = '{"street":"Al Wasl Rd","city":"Dubai","emirate":"DXB"}' WHERE id = $1`, [customer]));
    const e = await tx((q) => einv.issue(q, admin, inv.id));
    const full = await tx((q) => einv.getEinvoice(q, admin, e.id));
    const x = full.xml as string;
    assert.match(x, /<cbc:CustomizationID>urn:peppol:pint:billing-1@ae-1<\/cbc:CustomizationID>/);
    assert.match(x, /<cbc:InvoiceTypeCode>380<\/cbc:InvoiceTypeCode>/);
    assert.match(x, /<cbc:EndpointID schemeID="0235">1000000000<\/cbc:EndpointID>/);
    assert.match(x, /<cbc:CompanyID>100000000000003<\/cbc:CompanyID>/);
    assert.match(x, /<cbc:PayableAmount currencyID="AED">2495.00<\/cbc:PayableAmount>/);
    assert.match(x, /<cbc:ID>S<\/cbc:ID>\s*<cbc:Percent>5.00<\/cbc:Percent>/);
    assert.match(x, /<cbc:PayeeFinancialAccount>|<cac:PayeeFinancialAccount>/);
    assert.equal(full.uuid, x.match(/<cbc:UUID>([^<]+)</)![1]);
    await assert.rejects(tx((q) => einv.issue(q, admin, inv.id)), ConflictError);
    await assert.rejects(tx((q) => q.query(`UPDATE fin.einvoices SET xml = 'x' WHERE id = $1`, [e.id])), /cannot change/);
    const r = await tx((q) => einv.recordAspResponse(q, admin, e.id, { status: 'accepted', reference: 'ASP-778' }));
    assert.equal(r.status, 'accepted');
  });
  it('adds the AED values and export flag for a foreign-currency export', async () => {
    const usd = await invoice({ kind: 'sales_invoice', partyId: exporter, date: '2026-02-02', fxRate: 3.6725, lines: [{ description: 'Consulting', quantity: 1, unitPrice: 1000, taxCode: 'ZR' }] });
    const e = await tx((q) => einv.issue(q, admin, usd.id));
    const x = (await tx((q) => einv.getEinvoice(q, admin, e.id))).xml as string;
    assert.match(x, /<cbc:ProfileExecutionID>00000001</);
    assert.match(x, /<cbc:TaxCurrencyCode>AED</);
    assert.match(x, /<cbc:DocumentDescription>3672.50</);
    assert.match(x, /<cbc:CalculationRate>3.6725</);
  });
  it('issues a credit note that refers to the original', async () => {
    const cn = await invoice({ kind: 'sales_credit', partyId: customer, date: '2026-02-03', creditOf: inv.id, lines: [{ description: 'Export docs', quantity: 1, unitPrice: 500, taxCode: 'ZR' }] });
    const e = await tx((q) => einv.issue(q, admin, cn.id));
    const x = (await tx((q) => einv.getEinvoice(q, admin, e.id))).xml as string;
    assert.match(x, /^<\?xml[^>]*>\n<CreditNote /);
    assert.match(x, /<cbc:CreditNoteTypeCode>381</);
    assert.match(x, new RegExp(`<cac:InvoiceDocumentReference>\\s*<cbc:ID>${inv.no}<`));
  });
});

describe('bank reconciliation', () => {
  it('reads common CSV layouts', () => {
    const a = bank.parseCsv('Date,Description,Debit,Credit,Reference\n05/02/2026,"Card fee, Feb",25.00,,FEE1\n2026-02-06,Transfer in,,1000,TT9\n');
    assert.deepEqual(a.map((l) => [l.date, l.amount]), [['2026-02-05', -25], ['2026-02-06', 1000]]);
    const b = bank.parseCsv('Value Date;Narration;Amount\n07 Feb 2026;Cheque;(300.50)\n');
    assert.deepEqual(b[0], { date: '2026-02-07', description: 'Cheque', amount: -300.5, reference: undefined });
    assert.throws(() => bank.parseCsv('Foo,Bar\n1,2\n'), /header row/);
  });
  it('imports a statement, matches it to the ledger, skips re-imports, and posts bank charges', async () => {
    await tx((q) => ledger.post(q, admin, { companyId: co, type: 'opening', date: '2026-02-01', memo: 'Capital', lines: [{ account: '1010', debit: 50000 }, { account: '3000', credit: 50000 }] }));
    const bill = await invoice({ kind: 'purchase_invoice', partyId: supplier, date: '2026-02-02', supplierRef: 'GT-1', lines: [{ description: 'Desk', quantity: 1, unitPrice: 1000, taxCode: 'SR' }] });
    await tx((q) => docs.recordPayment(q, admin, { companyId: co, kind: 'payment', partyId: supplier, date: '2026-02-04', bankAccount: '1010', amount: 1050,
      reference: 'CHQ-77', allocations: [{ invoiceId: bill.id, amount: 1050 }] }));
    const csv = 'Date,Description,Amount,Reference\n01/02/2026,Capital injection,50000,\n05/02/2026,Cheque 77 Gulf Tech,-1050,CHQ-77\n06/02/2026,Account fee,-26.25,\n';
    const r = await tx((q) => bank.importStatement(q, admin, { companyId: co, bankAccount: '1010', csv, closingBalance: 48923.75 }));
    assert.deepEqual([r.added, r.skipped, r.autoMatched], [3, 0, 2]);
    const again = await tx((q) => bank.importStatement(q, admin, { companyId: co, bankAccount: '1010', csv }));
    assert.deepEqual([again.added, again.skipped], [0, 3]);
    let rec = await tx((q) => bank.reconciliation(q, admin, co, '1010', '2026-02-28'));
    assert.equal(rec.notYetInLedger, -26.25);
    assert.equal(rec.adjustedBalance, 48923.75);
    const fee = rec.onStatementOnly[0];
    await assert.rejects(tx((q) => bank.postStatementLine(q, admin, fee.id, { account: '1100' })), /receipts and payments/);
    await tx((q) => bank.postStatementLine(q, admin, fee.id, { account: '5900', memo: 'Bank charges February' }));
    rec = await tx((q) => bank.reconciliation(q, admin, co, '1010', '2026-02-28'));
    assert.equal(rec.onStatementOnly.length, 0);
    assert.equal(rec.inLedgerOnly.length, 0);
    assert.equal(rec.ledgerBalance, 48923.75);
    assert.equal(rec.statementClosingBalance, 48923.75);
  });
  it('refuses a manual match with a different amount', async () => {
    await tx((q) => ledger.post(q, admin, { companyId: co, type: 'opening', date: '2026-02-10', memo: 'More capital', lines: [{ account: '1010', debit: 700 }, { account: '3000', credit: 700 }] }));
    await tx((q) => bank.importStatement(q, admin, { companyId: co, bankAccount: '1010', csv: 'Date,Description,Amount\n20/02/2026,Deposit,690\n' }));
    const st = (await tx((q) => bank.reconciliation(q, admin, co, '1010', '2026-02-28')));
    await assert.rejects(tx((q) => bank.matchLine(q, admin, st.onStatementOnly[0].id, st.inLedgerOnly[0].id)), /amounts differ/);
  });
});

describe('fixed assets', () => {
  let asset: any;
  it('registers an asset from a purchase bill line and depreciates it monthly', async () => {
    const bill = await invoice({ kind: 'purchase_invoice', partyId: supplier, date: '2026-01-15', supplierRef: 'GT-SERVER', lines: [{ description: 'Server', quantity: 1, unitPrice: 12000, taxCode: 'SR', account: '1500' }] });
    const full = await tx((q) => docs.getInvoice(q, admin, bill.id));
    asset = await tx((q) => assets.registerAsset(q, admin, { companyId: co, code: 'FA-001', name: 'Server', category: 'IT equipment', unitId: s.units.finance,
      acquisitionDate: '2026-01-15', depreciationStart: '2026-01-01', usefulLifeMonths: 24, invoiceLineId: full.lines[0].id }));
    assert.equal(Number(asset.cost), 12000);
    await assert.rejects(tx((q) => assets.registerAsset(q, admin, { companyId: co, code: 'FA-002', name: 'x', category: 'x', acquisitionDate: '2026-01-15', usefulLifeMonths: 1, invoiceLineId: full.lines[0].id })), /already exists|duplicate|409|unique/i);
    await assert.rejects(tx((q) => assets.runDepreciation(q, admin, co, '2026-02')), /run that month first|2026-01/);
    const jan = await tx((q) => assets.runDepreciation(q, admin, co, '2026-01'));
    assert.equal(jan.total, 500);
    assert.equal((await tx((q) => assets.runDepreciation(q, admin, co, '2026-01'))).total, 0);
    await assert.rejects(tx((q) => assets.runDepreciation(q, admin, co, '2026-03')), /run 2026-02 first/);
    await tx((q) => assets.runDepreciation(q, admin, co, '2026-02'));
    await tx((q) => assets.runDepreciation(q, admin, co, '2026-03'));
    assert.equal(await balance('5800'), 1500);
    assert.equal(await balance('1590'), -1500);
  });
  it('brings in an existing asset with depreciation to date', async () => {
    const a = await tx((q) => assets.registerAsset(q, admin, { companyId: co, code: 'FA-OLD', name: 'Van', category: 'Vehicles', acquisitionDate: '2024-01-01',
      usefulLifeMonths: 60, cost: 60000, residualValue: 6000, openingAccumulated: 21600 }));
    assert.equal(a.net_book_value, 38400);
    assert.equal(await balance('1500'), 72000);
  });
  it('disposes an asset with the gain or loss to other income', async () => {
    await assert.rejects(tx((q) => assets.disposeAsset(q, admin, asset.id, { date: '2026-05-10', proceeds: 9000 })), /run depreciation up to 2026-04/);
    await tx((q) => assets.runDepreciation(q, admin, co, '2026-04'));
    const d = await tx((q) => assets.disposeAsset(q, admin, asset.id, { date: '2026-05-10', proceeds: 9000, bankAccount: '1010' }));
    assert.equal(d.gain, -1000);   // NBV 12000 - 2000 = 10000, sold for 9000
    assert.equal(await balance('4100'), 1000);
    assert.equal(await balance('1500'), 60000);
    await assert.rejects(tx((q) => assets.disposeAsset(q, admin, asset.id, { date: '2026-05-11' })), ConflictError);
    const tb = await tx((q) => reports.trialBalance(q, admin, co, '2026-12-31'));
    assert.equal(tb.balanced, true);
  });
});
