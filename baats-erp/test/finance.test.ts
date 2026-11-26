import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { one, type Ctx } from '../src/core/db.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../src/core/errors.ts';
import * as ledger from '../src/fin/ledger.ts';
import * as setup from '../src/fin/setup.ts';
import * as docs from '../src/fin/documents.ts';
import * as tax from '../src/fin/tax.ts';
import * as reports from '../src/fin/reports.ts';
import * as wf from '../src/workflow/engine.ts';
import { buildServer } from '../src/api/server.ts';
import { createTestDb, giveRole, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

let t: TestDb;
let s: Seed;
let co: string;          // the UAE company's org unit = its books
let admin: Ctx, acct: Ctx, ctrl: Ctx, clerk: Ctx;
let customer: string, usCustomer: string, supplier: string, foreignSupplier: string, draftParty: string;

const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);
const balance = (code: string, to = '2026-12-31') => tx(admin, async (q) =>
  Number((await one(q, `SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM fin.journal_lines l
     JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
    WHERE a.company_id = $1 AND a.code = $2 AND j.date <= $3`, [co, code, to])).b));

async function party(name: string, opts: { customer?: boolean; supplier?: boolean; currency?: string; country?: string; status?: string }) {
  return tx(admin, async (q) => (await one(q, `INSERT INTO mdm.parties (tenant_id, code, name, normalized_name, is_customer, is_supplier,
      country_code, currency_code, owner_unit_id, status) VALUES (app.tenant(), $1, $1, lower($1), $2, $3, $4, $5, $6, $7) RETURNING id`,
    [name, opts.customer ?? false, opts.supplier ?? false, opts.country ?? 'AE', opts.currency ?? 'AED', s.units.uae, opts.status ?? 'active'])).id as string);
}

async function invoice(ctx: Ctx, input: Omit<docs.InvoiceInput, 'companyId'>, postIt = true) {
  const d = await tx(ctx, (q) => docs.createInvoice(q, ctx, { companyId: co, ...input }));
  return postIt ? tx(ctx, (q) => docs.postInvoice(q, ctx, d.id)) : d;
}

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  co = s.units.uae;
  admin = s.adminCtx;
  acct = s.ctxOf(s.people.accountant.userId);
  ctrl = s.ctxOf(s.people.finMgr.userId);
  clerk = s.ctxOf(s.people.salesRep.userId);
  await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: co, legalName: 'Acme UAE LLC', taxRegistrationNo: '100000000000003', openFrom: '2026-01-01' }));
  // Accountant: prepares and posts documents up to AED 100k, prepares journals. Controller: approves journals up to 50k.
  await giveRole(t.db, s, s.people.accountant.userId, 'ACCOUNTANT', {
    'fin.invoice.manage': {}, 'fin.invoice.post': { amount: { lte: 100000 } }, 'fin.payment.post': {}, 'fin.journal.create': {}, 'fin.report.read': {},
  }, co);
  await giveRole(t.db, s, s.people.finMgr.userId, 'FIN_CONTROLLER', { 'fin.journal.approve': { amount: { lte: 50000 } }, 'fin.report.read': {} }, co);
  customer = await party('Gulf Retail', { customer: true });
  usCustomer = await party('Boston Labs', { customer: true, country: 'US', currency: 'USD' });
  supplier = await party('Dubai Office Supplies', { supplier: true });
  foreignSupplier = await party('Cloud Software Inc', { supplier: true, country: 'US', currency: 'USD' });
  draftParty = await party('Not Approved Yet', { customer: true, status: 'draft' });
});
after(async () => { await t.drop(); });

describe('company books', () => {
  it('creates the BAATS UAE chart of accounts, VAT codes and periods', async () => {
    const accounts = await tx(admin, (q) => setup.listAccounts(q, admin, co));
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    assert.equal(byCode.get('1100').control, 'receivable');
    assert.equal(byCode.get('2100').name, 'Output VAT Payable');
    assert.equal(byCode.get('5950').parent_code, '53');
    assert.equal(byCode.get('11').is_group, true);
    const codes = await tx(admin, (q) => setup.listTaxCodes(q));
    assert.deepEqual(codes.map((c) => c.code), ['EX', 'OS', 'RC', 'SR', 'ZR']);
    const periods = await tx(admin, async (q) => (await q.query('SELECT count(*)::int AS n FROM fin.periods WHERE company_id = $1', [co])).rows[0].n);
    assert.equal(periods, 12);
  });
  it('only legal entities with a supported country keep books', async () => {
    await assert.rejects(tx(admin, (q) => setup.setupCompany(q, admin, { unitId: s.units.sales, legalName: 'x', openFrom: '2026-01-01' })), /legal-entity/);
    await assert.rejects(tx(admin, (q) => setup.setupCompany(q, admin, { unitId: s.units.uk, legalName: 'x', openFrom: '2026-01-01' })), /set the unit|localisation/);
    await assert.rejects(tx(admin, (q) => setup.setupCompany(q, admin, { unitId: co, legalName: 'x', openFrom: '2026-01-01' })), ConflictError);
  });
  it('lets the company add its own accounts under a group', async () => {
    const a = await tx(admin, (q) => setup.createAccount(q, admin, co, { code: '5150', name: 'Marketing', parentCode: '51' }));
    assert.equal(a.type, 'expense');
    await assert.rejects(tx(admin, (q) => setup.createAccount(q, admin, co, { code: '5151', name: 'X', parentCode: '5100' })), /group account/);
  });
});

describe('sales and purchases', () => {
  let si1: any;

  it('posts a sales invoice: AR gross, revenue net, output VAT by tax code', async () => {
    si1 = await invoice(acct, { kind: 'sales_invoice', partyId: customer, date: '2026-01-10', lines: [
      { description: 'Consulting', quantity: 10, unitPrice: 100, taxCode: 'SR' },
      { description: 'Export service', quantity: 1, unitPrice: 500, taxCode: 'ZR', account: '4100' },
    ] });
    assert.equal(si1.no, 'SI-2026-00001');
    assert.equal(Number(si1.gross_total), 1550);
    assert.equal(si1.outstanding, 1550);
    assert.equal(await balance('1100'), 1550);
    assert.equal(await balance('4000'), -1000);
    assert.equal(await balance('4100'), -500);
    assert.equal(await balance('2100'), -50);
  });

  it('posts a purchase invoice and rejects the same supplier number twice', async () => {
    const pi = await invoice(acct, { kind: 'purchase_invoice', partyId: supplier, supplierRef: 'DOS-778', date: '2026-01-15',
      lines: [{ description: 'Paper and toner', quantity: 4, unitPrice: 500, taxCode: 'SR', account: '5500' }] });
    assert.equal(pi.no, 'PI-2026-00001');
    assert.equal(await balance('5500'), 2000);
    assert.equal(await balance('1200'), 100);
    assert.equal(await balance('2000'), -2100);
    await assert.rejects(invoice(acct, { kind: 'purchase_invoice', partyId: supplier, supplierRef: 'DOS-778', date: '2026-01-16',
      lines: [{ description: 'x', quantity: 1, unitPrice: 1, taxCode: 'SR' }] }, false), ConflictError);
  });

  it('self-assesses reverse-charge VAT on imported services', async () => {
    const before2000 = await balance('2000');
    await invoice(acct, { kind: 'purchase_invoice', partyId: foreignSupplier, supplierRef: 'CS-1', date: '2026-02-01', currency: 'AED',
      lines: [{ description: 'Cloud subscription', quantity: 1, unitPrice: 1000, taxCode: 'RC', account: '5300' }] });
    assert.equal(await balance('2000') - before2000, -1000, 'supplier is owed net only');
    assert.equal(await balance('1200'), 150);
    assert.equal(await balance('2100'), -100);
  });

  it('rejects unapproved partners, wrong partner roles and reverse charge on sales', async () => {
    await assert.rejects(invoice(acct, { kind: 'sales_invoice', partyId: draftParty, date: '2026-01-10', lines: [{ description: 'x', quantity: 1, unitPrice: 1, taxCode: 'SR' }] }, false), /only approved/);
    await assert.rejects(invoice(acct, { kind: 'sales_invoice', partyId: supplier, date: '2026-01-10', lines: [{ description: 'x', quantity: 1, unitPrice: 1, taxCode: 'SR' }] }, false), /not a customer/);
    await assert.rejects(invoice(acct, { kind: 'sales_invoice', partyId: customer, date: '2026-01-10', lines: [{ description: 'x', quantity: 1, unitPrice: 1, taxCode: 'RC' }] }, false), /purchases only/);
  });

  it('credit notes reduce what is open and cannot exceed it', async () => {
    await invoice(acct, { kind: 'sales_credit', partyId: customer, creditOf: si1.id, date: '2026-01-20',
      lines: [{ description: 'Discount agreed', quantity: 1, unitPrice: 200, taxCode: 'SR' }] });
    const after = await tx(acct, (q) => docs.getInvoice(q, acct, si1.id));
    assert.equal(after.outstanding, 1340);
    assert.equal(await balance('2100'), -90);
    const big = await invoice(acct, { kind: 'sales_credit', partyId: customer, creditOf: si1.id, date: '2026-01-21',
      lines: [{ description: 'Too much', quantity: 1, unitPrice: 2000, taxCode: 'SR' }] }, false);
    await assert.rejects(tx(acct, (q) => docs.postInvoice(q, acct, big.id)), /exceeds/);
    await tx(acct, (q) => docs.deleteDraft(q, acct, big.id));
  });

  it('receipts settle invoices and clear the customer balance', async () => {
    const r = await tx(acct, (q) => docs.recordPayment(q, acct, { companyId: co, kind: 'receipt', partyId: customer, date: '2026-01-25',
      bankAccount: '1010', amount: 1340, allocations: [{ invoiceId: si1.id, amount: 1340 }] }));
    assert.equal(r.no, 'RV-2026-00001');
    assert.equal(r.unallocated, 0);
    const st = await tx(acct, (q) => reports.partyStatement(q, acct, co, customer, '2026-01-01', '2026-12-31'));
    assert.equal(st.closing, 0);
    assert.equal(st.lines.length, 3);
    await assert.rejects(tx(acct, (q) => docs.recordPayment(q, acct, { companyId: co, kind: 'receipt', partyId: customer, date: '2026-01-26',
      bankAccount: '1010', amount: 10, allocations: [{ invoiceId: si1.id, amount: 10 }] })), /more than is open/);
    await assert.rejects(tx(acct, (q) => docs.recordPayment(q, acct, { companyId: co, kind: 'receipt', partyId: customer, date: '2026-01-26',
      bankAccount: '1100', amount: 10 })), /cash or bank/);
  });

  it('books realised exchange differences on foreign-currency receipts', async () => {
    const inv = await invoice(acct, { kind: 'sales_invoice', partyId: usCustomer, date: '2026-02-05', fxRate: 3.6725,
      lines: [{ description: 'Export consulting', quantity: 1, unitPrice: 1000, taxCode: 'ZR' }] });
    assert.equal(inv.currency, 'USD', 'currency defaults from the customer');
    const ar = await balance('1100');
    await tx(acct, (q) => docs.recordPayment(q, acct, { companyId: co, kind: 'receipt', partyId: usCustomer, date: '2026-02-20',
      bankAccount: '1010', currency: 'USD', fxRate: 3.70, amount: 1000, allocations: [{ invoiceId: inv.id, amount: 1000 }] }));
    assert.equal(await balance('1100') - ar, -3672.5, 'AR relieved at the invoice rate');
    assert.equal(await balance('4450'), -27.5, 'gain of 27.50 at the higher receipt rate');
  });

  it('applies an advance later and clears the rate difference', async () => {
    const adv = await tx(acct, (q) => docs.recordPayment(q, acct, { companyId: co, kind: 'payment', partyId: foreignSupplier, date: '2026-02-10',
      bankAccount: '1010', currency: 'USD', fxRate: 3.67, amount: 500 }));
    assert.equal(adv.unallocated, 500);
    const inv = await invoice(acct, { kind: 'purchase_invoice', partyId: foreignSupplier, supplierRef: 'CS-2', date: '2026-02-12', fxRate: 3.68,
      lines: [{ description: 'Licences', quantity: 1, unitPrice: 500, taxCode: 'OS', account: '5300' }] });
    const fxBefore = await balance('4450');
    await tx(acct, (q) => docs.allocateAdvance(q, acct, { paymentId: adv.id, invoiceId: inv.id, amount: 500, date: '2026-02-12' }));
    // Paid USD 500 at 3.67 (AED 1,835) for a bill booked at 3.68 (AED 1,840): a gain of AED 5.
    assert.equal(Math.round((await balance('4450') - fxBefore) * 100) / 100, -5);
    const ap = await tx(acct, (q) => reports.partyStatement(q, acct, co, foreignSupplier, '2026-01-01', '2026-12-31'));
    assert.equal(ap.closing, -1000, 'only the reverse-charge bill remains owed');
  });

  it('shows open items by age, with advances', async () => {
    await invoice(acct, { kind: 'sales_invoice', partyId: customer, date: '2026-01-01', dueDate: '2026-01-31',
      lines: [{ description: 'Old work', quantity: 1, unitPrice: 1000, taxCode: 'SR' }] });
    const ag = await tx(acct, (q) => reports.ageing(q, acct, co, 'receivable', '2026-03-15'));
    const row = ag.partners.find((p: any) => p.party === 'Gulf Retail');
    assert.equal(row['31-60'], 1050);
    assert.equal(row.total, 1050);
  });
});

describe('controls', () => {
  it('posted journals and documents are immutable', async () => {
    await assert.rejects(tx(admin, (q) => q.query(`UPDATE fin.journals SET memo = 'changed' WHERE status = 'posted'`)), /immutable/);
    await assert.rejects(tx(admin, (q) => q.query(`DELETE FROM fin.journal_lines`)), /cannot change/);
    await assert.rejects(tx(admin, (q) => q.query(`UPDATE fin.invoices SET net_total = 1 WHERE status = 'posted'`)), /immutable/);
  });

  it('the database refuses unbalanced or misdirected postings', async () => {
    await assert.rejects(tx(admin, (q) => ledger.post(q, admin, { companyId: co, type: 'manual', date: '2026-03-01', memo: 'x',
      lines: [{ account: '5100', debit: 100 }, { account: '1010', credit: 90 }] })), /not balanced/);
    await assert.rejects(tx(admin, (q) => ledger.post(q, admin, { companyId: co, type: 'manual', date: '2026-03-01', memo: 'x',
      lines: [{ account: '51', debit: 100 }, { account: '1010', credit: 100 }] })), /cannot be posted/);
    await assert.rejects(tx(admin, (q) => ledger.post(q, admin, { companyId: co, type: 'sales_invoice', date: '2026-03-01', memo: 'x',
      lines: [{ account: '1100', debit: 100 }, { account: '4000', credit: 100 }] })), /needs a customer or supplier/);
    await assert.rejects(tx(admin, (q) => ledger.post(q, admin, { companyId: co, type: 'manual', date: '2027-06-01', memo: 'x',
      lines: [{ account: '5100', debit: 100 }, { account: '1010', credit: 100 }] })), /not open/);
  });

  it('manual journals need approval within the approver’s limit', async () => {
    const small = await tx(acct, (q) => ledger.createManualJournal(q, acct, { companyId: co, date: '2026-03-31', memo: 'March rent accrual',
      lines: [{ account: '5100', debit: 12000 }, { account: '2200', credit: 12000 }] }));
    assert.equal(small.journal.status, 'pending_approval');
    assert.equal(small.journal.no, null);
    const task = async (ctx: Ctx, id: string) => (await tx(ctx, (q) => wf.inbox(q, ctx))).find((x) => x.entity_id === id).task_id;
    await tx(ctrl, async (q) => wf.act(q, ctrl, await task(ctrl, small.journal.id), 'approve'));
    const posted = await tx(acct, (q) => ledger.getJournal(q, acct, small.journal.id));
    assert.equal(posted.status, 'posted');
    assert.equal(posted.no, 'JV-2026-00001');

    const big = await tx(acct, (q) => ledger.createManualJournal(q, acct, { companyId: co, date: '2026-03-31', memo: 'Big accrual',
      lines: [{ account: '5100', debit: 80000 }, { account: '2200', credit: 80000 }] }));
    await assert.rejects(tx(ctrl, async (q) => wf.act(q, ctrl, await task(ctrl, big.journal.id), 'approve')), ForbiddenError);
    await tx(ctrl, async (q) => wf.act(q, ctrl, await task(ctrl, big.journal.id), 'reject', 'Needs CFO sign-off'));
    assert.equal((await tx(acct, (q) => ledger.getJournal(q, acct, big.journal.id))).status, 'rejected');
  });

  it('manual journals cannot touch control or VAT accounts', async () => {
    await assert.rejects(tx(acct, (q) => ledger.createManualJournal(q, acct, { companyId: co, date: '2026-03-31', memo: 'x',
      lines: [{ account: '2100', debit: 10 }, { account: '1010', credit: 10 }] })), /documents only/);
  });

  it('reversal posts an equal and opposite journal; document journals cannot be reversed', async () => {
    const j = await tx(admin, async (q) => one(q, `SELECT id FROM fin.journals WHERE no = 'JV-2026-00001'`));
    const rent = await balance('5100');
    const rev = await tx(admin, (q) => ledger.reverseJournal(q, admin, j.id, '2026-04-01', 'Accrued twice'));
    assert.equal(rev.no, 'REV-2026-00001');
    assert.equal(await balance('5100') - rent, -12000);
    await assert.rejects(tx(admin, (q) => ledger.reverseJournal(q, admin, j.id, '2026-04-01', 'again')), /already reversed/);
    const sj = await tx(admin, async (q) => one(q, `SELECT id FROM fin.journals WHERE type = 'sales_invoice' LIMIT 1`));
    await assert.rejects(tx(admin, (q) => ledger.reverseJournal(q, admin, sj.id, '2026-04-01', 'x')), /credit note/);
  });

  it('enforces posting limits and scope', async () => {
    await assert.rejects(invoice(acct, { kind: 'sales_invoice', partyId: customer, date: '2026-03-01',
      lines: [{ description: 'Big project', quantity: 1, unitPrice: 200000, taxCode: 'SR' }] }), (e: Error) => e instanceof ForbiddenError && /limit/.test(e.message));
    await assert.rejects(tx(clerk, (q) => reports.trialBalance(q, clerk, co, '2026-12-31')), ForbiddenError);
  });
});

describe('tax', () => {
  it('computes the VAT 201 return from tax-coded ledger lines', async () => {
    const r = await tx(acct, (q) => tax.computeVatReturn(q, acct, co, '2026-01-01', '2026-03-31'));
    // Standard rated supplies: 1000 + 1000 (old work) - 200 credit note.
    assert.deepEqual(r.boxes['1'], { amount: 1800, vat: 90 });
    assert.deepEqual(r.boxes['3'], { amount: 1000, vat: 50 });
    assert.equal(r.boxes['4'].amount, 500 + 3672.5);
    assert.deepEqual(r.boxes['9'], { amount: 2000, vat: 100 });
    assert.deepEqual(r.boxes['10'], { amount: 1000, vat: 50 });
    assert.equal(r.outputTax, 140);
    assert.equal(r.inputTax, 150);
    assert.equal(r.netPayable, -10);
  });

  it('filing clears output and input VAT into the FTA settlement account', async () => {
    const f = await tx(admin, (q) => tax.fileVatReturn(q, admin, co, '2026-01-01', '2026-03-31', 'FTA-Q1'));
    assert.equal(f.journal_no, 'VAT-2026-00001');
    assert.equal(await balance('2100', '2026-03-31'), 0);
    assert.equal(await balance('1200', '2026-03-31'), 0);
    assert.equal(await balance('2110'), 10, 'refund due from the FTA');
    await assert.rejects(tx(admin, (q) => tax.fileVatReturn(q, admin, co, '2026-03-01', '2026-05-31')), /already covers/);
  });

  it('provides corporate tax at 9% of profit above AED 375,000', async () => {
    const low = await tx(admin, (q) => tax.provideCorporateTax(q, admin, co, 2026));
    assert.equal(low.tax, 0);
    assert.ok(low.accountingProfit < 375000);
    const big = await invoice(admin, { kind: 'sales_invoice', partyId: customer, date: '2026-06-30',
      lines: [{ description: 'Annual programme', quantity: 1, unitPrice: 500000, taxCode: 'SR' }] });
    assert.equal(big.status, 'posted');
    const ct = await tx(admin, (q) => tax.provideCorporateTax(q, admin, co, 2026));
    assert.equal(ct.tax, Math.round((ct.accountingProfit - 375000) * 9) / 100);
    assert.equal(await balance('2400'), -ct.tax);
    const again = await tx(admin, (q) => tax.provideCorporateTax(q, admin, co, 2026));
    assert.equal(again.posted, 0, 'idempotent');
  });
});

describe('statements and year end', () => {
  it('trial balance balances; balance sheet equals liabilities plus equity; P&L ties to earnings', async () => {
    const tb = await tx(acct, (q) => reports.trialBalance(q, acct, co, '2026-12-31'));
    assert.equal(tb.balanced, true);
    const pl = await tx(acct, (q) => reports.profitAndLoss(q, acct, co, '2026-01-01', '2026-12-31'));
    const bs = await tx(acct, (q) => reports.balanceSheet(q, acct, co, '2026-12-31'));
    assert.equal(bs.balanced, true);
    assert.equal(bs.currentEarnings, pl.netProfit);
    assert.equal(pl.grossProfit, pl.totalRevenue - pl.totalDirectCosts);
  });

  it('closes the year into retained earnings and locks its periods', async () => {
    const pl = await tx(admin, (q) => reports.profitAndLoss(q, admin, co, '2026-01-01', '2026-12-31'));
    const c = await tx(admin, (q) => reports.closeYear(q, admin, co, 2026));
    assert.equal(c.profit, pl.netProfit);
    const bs = await tx(admin, (q) => reports.balanceSheet(q, admin, co, '2026-12-31'));
    assert.equal(bs.currentEarnings, 0);
    assert.equal(bs.balanced, true);
    assert.equal(-await balance('3100'), pl.netProfit);
    const plAfter = await tx(admin, (q) => reports.profitAndLoss(q, admin, co, '2026-01-01', '2026-12-31'));
    assert.equal(plAfter.netProfit, pl.netProfit, 'P&L ignores the closing journal');
    await assert.rejects(invoice(admin, { kind: 'sales_invoice', partyId: customer, date: '2026-12-01',
      lines: [{ description: 'Late', quantity: 1, unitPrice: 1, taxCode: 'SR' }] }), /not open/);
    await assert.rejects(tx(admin, (q) => reports.closeYear(q, admin, co, 2026)), ConflictError);
  });

  it('audit trail stays intact through all of it', async () => {
    const { verifyChain } = await import('../src/audit/service.ts');
    const v = await tx(admin, (q) => verifyChain(q, admin));
    assert.equal(v.valid, true);
  });
});

describe('finance API', () => {
  it('sets up books, posts an invoice and returns the trial balance over HTTP', async () => {
    const app = buildServer({ db: t.db });
    try {
      const call = async (method: string, url: string, token?: string, payload?: unknown) => {
        const r = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
        return { status: r.statusCode, body: r.json() };
      };
      const login = await call('POST', '/v1/auth/login', undefined, { tenant: s.code, email: `admin@${s.code}.test`, password: PASSWORD });
      const tok = login.body.token;
      // Give the UK company a GB country so the localisation check is what refuses it.
      const uk = await call('POST', '/v1/fin/companies', tok, { unitId: s.units.uk, legalName: 'Acme UK Ltd', openFrom: '2026-01-01' });
      assert.equal(uk.status, 422);
      const inv = await call('POST', `/v1/fin/companies/${co}/invoices`, tok, { kind: 'sales_invoice', partyId: customer, date: '2027-01-05',
        lines: [{ description: 'API work', quantity: 2, unitPrice: 250, taxCode: 'SR' }] });
      assert.equal(inv.status, 201, JSON.stringify(inv.body));
      const closed = await call('POST', `/v1/fin/invoices/${inv.body.id}/post`, tok);
      assert.equal(closed.status, 422, 'January 2027 is not open yet');
      assert.equal((await call('PUT', `/v1/fin/companies/${co}/periods/2027-01-01`, tok, { status: 'open' })).status, 200);
      const posted = await call('POST', `/v1/fin/invoices/${inv.body.id}/post`, tok);
      assert.equal(posted.body.no, 'SI-2027-00001');
      const tb = await call('GET', `/v1/fin/companies/${co}/trial-balance?to=2027-12-31`, tok);
      assert.equal(tb.body.balanced, true);
      const vat = await call('GET', `/v1/fin/companies/${co}/vat-return?from=2027-01-01&to=2027-03-31`, tok);
      assert.deepEqual(vat.body.boxes['1'], { amount: 500, vat: 25 });
    } finally {
      await app.close();
    }
  });
});
