import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { many, one, type Ctx } from '../src/core/db.ts';
import * as setup from '../src/fin/setup.ts';
import * as docs from '../src/fin/documents.ts';
import * as bankfiles from '../src/fin/bankfiles.ts';
import * as paylinks from '../src/fin/paylinks.ts';
import { invoicePdf } from '../src/fin/invoicepdf.ts';
import { emailInvoice } from '../src/fin/send.ts';
import * as mail from '../src/int/mail.ts';
import * as sso from '../src/iam/sso.ts';
import * as auth from '../src/iam/auth.ts';
import * as mdm from '../src/mdm/service.ts';
import * as mig from '../src/mig/import.ts';
import { openXlsx, rowsToCsv, excelDate } from '../src/mig/xlsx.ts';
import { buildServer } from '../src/api/server.ts';
import * as wf from '../src/workflow/engine.ts';
import { createTestDb, giveRole, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

/**
 * Phase 6d: connectors. Bank statement and payment files, invoice PDF and email,
 * sign-in with an OpenID Connect provider, card payment links, Excel workbooks.
 * The outside services (identity provider, mail server, Microsoft Graph, Stripe)
 * are played by small fakes here.
 */

let t: TestDb;
let s: Seed;
let admin: Ctx;
let co: string;
const SECRET = randomBytes(32);
const D = '2026-03-02';
const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);
// Real IBANs need correct check digits: this makes one from a country and account part.
const iban = (cc: string, bban: string) => {
  const digits = (bban + cc + '00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let r = 0; for (const d of digits) r = (r * 10 + Number(d)) % 97;
  return `${cc}${String(98 - r).padStart(2, '0')}${bban}`;
};
const OUR_IBAN = iban('AE', '0260001015000000001');
const SUP_IBAN = iban('AE', '0330000019100000002');
let customer: string, supplier: string, noIbanSupplier: string;

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  admin = s.adminCtx;
  co = s.units.uae;
  await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: co, legalName: 'Acme UAE LLC', openFrom: '2026-01-01' }));
  await tx(admin, (q) => q.query(`UPDATE fin.companies SET iban = $2, tax_registration_no = '100000000000003', street = 'Sheikh Zayed Road', city = 'Dubai' WHERE unit_id = $1`, [co, OUR_IBAN]));
  await tx(admin, (q) => mig.runImport(q, admin, { kind: 'customers', companyId: co, csv: 'code,name,email,city\nC1,Gulf Retail LLC,ap@gulfretail.test,Dubai\nC2,شركة الخليج,,Abu Dhabi\n' }));
  await tx(admin, (q) => mig.runImport(q, admin, { kind: 'suppliers', companyId: co, csv: `code,name,iban\nS1,Dubai Office Supplies,${SUP_IBAN}\nS2,No Bank Details LLC,\n` }));
  const ps = await tx(admin, (q) => many(q, 'SELECT id, code FROM mdm.parties'));
  customer = ps.find((p) => p.code === 'C1')!.id; supplier = ps.find((p) => p.code === 'S1')!.id; noIbanSupplier = ps.find((p) => p.code === 'S2')!.id;
  await tx(admin, (q) => mdm.updateParty(q, admin, supplier, { attributes: { iban: SUP_IBAN, bic: 'EBILAEAD' } }));
});
after(async () => { await t.drop(); });

const sale = async (amount: number, party = customer) => tx(admin, async (q) => {
  const inv = await docs.createInvoice(q, admin, { companyId: co, kind: 'sales_invoice', partyId: party, date: D, dueDate: '2026-04-01',
    lines: [{ description: 'Consulting services, March', quantity: 1, unitPrice: amount, taxCode: 'SR' }] });
  return docs.postInvoice(q, admin, inv.id);
});

describe('bank details and IBANs', () => {
  it('checks IBAN check digits and keeps the bank details of a bank account', async () => {
    assert.equal(bankfiles.normalizeIban(OUR_IBAN.replace(/(.{4})/g, '$1 ').toLowerCase()), OUR_IBAN);
    assert.throws(() => bankfiles.normalizeIban(OUR_IBAN.slice(0, -1) + '9'), /check digits/);
    assert.throws(() => bankfiles.normalizeIban('hello'), /not an IBAN/);
    const d = await tx(admin, (q) => bankfiles.setBankDetails(q, admin, co, { bankAccount: '1010', bankName: 'Emirates NBD', iban: OUR_IBAN, bic: 'ebiluaeadxxx'.replace('u', '') }));
    assert.equal(d.iban, OUR_IBAN);
    await assert.rejects(tx(admin, (q) => bankfiles.setBankDetails(q, admin, co, { bankAccount: '4000', bankName: 'X', iban: OUR_IBAN })), /not a bank account/);
    const list = await tx(admin, (q) => bankfiles.listBankDetails(q, admin, co));
    assert.equal(list.find((x) => x.code === '1010')?.bank_name, 'Emirates NBD');
  });
});

describe('statement files', () => {
  const mt940 = (ibanNo: string) => `{1:F01EBILAEADAXXX0000000000}{2:O9401200260302EBILAEADXXXX00000000002603021200N}{4:
:20:STMT260302
:25:EBILAEAD/${ibanNo}
:28C:61/1
:60F:C260301AED1000,00
:61:2603020302C10500,00NTRFINV-REF-1//BNK1
:86:RECEIPT FROM GULF RETAIL LLC
:61:2603020302D52,50NCHGNONREF//BNK2
:86:?20MONTHLY FEE?32BANK CHARGES
:62F:C260302AED11447,50
-}`;
  it('reads MT940: balances, credit and debit lines, references and :86: details', () => {
    const st = bankfiles.parseMt940(mt940(OUR_IBAN));
    assert.equal(st.account, OUR_IBAN);
    assert.equal(st.currency, 'AED');
    assert.equal(st.openingBalance, 1000);
    assert.equal(st.closingBalance, 11447.5);
    assert.deepEqual(st.lines.map((l) => [l.date, l.amount, l.reference]), [['2026-03-02', 10500, 'INV-REF-1'], ['2026-03-02', -52.5, 'BNK2']]);
    assert.match(st.lines[0].description, /GULF RETAIL/);
    assert.match(st.lines[1].description, /MONTHLY FEE BANK CHARGES/);
  });

  const camt = (ibanNo: string, ccy = 'AED') => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr><MsgId>M1</MsgId></GrpHdr>
<Stmt><Id>STMT-0303</Id><Acct><Id><IBAN>${ibanNo}</IBAN></Id><Ccy>${ccy}</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="${ccy}">11447.50</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-03-03</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="${ccy}">9347.50</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-03-03</Dt></Dt></Bal>
<Ntry><Amt Ccy="${ccy}">2100.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-03-03</Dt></BookgDt><AcctSvcrRef>B-77</AcctSvcrRef>
  <NtryDtls><TxDtls><Refs><EndToEndId>PF-2026-00001-1</EndToEndId></Refs><RltdPties><Cdtr><Nm>Dubai Office Supplies</Nm></Cdtr></RltdPties><RmtInf><Ustrd>PV-2026-00001</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="${ccy}">300.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>PDNG</Sts><BookgDt><Dt>2026-03-03</Dt></BookgDt></Ntry>
<Ntry><Amt Ccy="${ccy}">40.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><RvslInd>true</RvslInd><Sts>BOOK</Sts><BookgDt><Dt>2026-03-03</Dt></BookgDt><AddtlNtryInf>Reversal of fee &amp; charge</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
  it('reads CAMT.053: booked entries only, reversals, end-to-end references and party names', () => {
    const st = bankfiles.parseCamt053(camt(OUR_IBAN));
    assert.equal(st.account, OUR_IBAN);
    assert.equal(st.openingBalance, 11447.5);
    assert.equal(st.closingBalance, 9347.5);
    assert.deepEqual(st.lines.map((l) => [l.amount, l.reference]), [[-2100, 'PF-2026-00001-1'], [-40, undefined]]);
    assert.match(st.lines[0].description, /Dubai Office Supplies · PV-2026-00001/);
    assert.match(st.lines[1].description, /Reversal of fee & charge/);
    assert.equal(bankfiles.parseStatementFile(camt(OUR_IBAN)).format, 'camt053');
    assert.equal(bankfiles.parseStatementFile(mt940(OUR_IBAN)).format, 'mt940');
    assert.equal(bankfiles.parseStatementFile('Date,Description,Amount\n02/03/2026,Fee,-5\n').format, 'csv');
  });

  it('imports a statement file into the account with that IBAN and matches it to the receipt', async () => {
    const inv = await sale(10000);
    await tx(admin, (q) => docs.recordPayment(q, admin, { companyId: co, kind: 'receipt', partyId: customer, date: D, bankAccount: '1010', amount: 10500,
      reference: 'INV-REF-1', allocations: [{ invoiceId: inv.id, amount: 10500 }] }));
    const r = await tx(admin, (q) => bankfiles.importStatementFile(q, admin, { companyId: co, fileName: 'stmt.mt940', text: mt940(OUR_IBAN) }));
    assert.equal(r.format, 'mt940');
    assert.equal(r.added, 2);
    assert.equal(r.autoMatched, 1);
    assert.equal(r.closingBalance, 11447.5);
    const again = await tx(admin, (q) => bankfiles.importStatementFile(q, admin, { companyId: co, text: mt940(OUR_IBAN) }));
    assert.equal(again.added, 0);
    assert.equal(again.skipped, 2);
    const st = await tx(admin, (q) => one(q, 'SELECT format, opening_balance::float AS o, statement_ref FROM fin.bank_statements WHERE id = $1', [r.statementId]));
    assert.deepEqual(st, { format: 'mt940', o: 1000, statement_ref: 'STMT260302' });
  });

  it('refuses a statement for an account it does not know, or in another currency', async () => {
    await assert.rejects(tx(admin, (q) => bankfiles.importStatementFile(q, admin, { companyId: co, text: mt940(SUP_IBAN) })), /no bank account in these books has the IBAN/);
    await assert.rejects(tx(admin, (q) => bankfiles.importStatementFile(q, admin, { companyId: co, text: camt(OUR_IBAN, 'USD') })), /in USD but the bank account is in AED/);
    await assert.rejects(tx(admin, (q) => bankfiles.importStatementFile(q, admin, { companyId: co, bankAccount: '1000', text: mt940(OUR_IBAN) })), /which is bank account 1010, not 1000/);
  });
});

describe('payment files', () => {
  let pay1: string, pay2: string, payNoIban: string, fileId: string;
  it('lists supplier payments for a file, with what is missing', async () => {
    const mk = (party: string, amount: number) => tx(admin, (q) => docs.recordPayment(q, admin, { companyId: co, kind: 'payment', partyId: party, date: D, bankAccount: '1010', amount, reference: 'Advance' }));
    pay1 = (await mk(supplier, 2100)).id; pay2 = (await mk(supplier, 75.25)).id; payNoIban = (await mk(noIbanSupplier, 10)).id;
    const list = await tx(admin, (q) => bankfiles.payableForFile(q, admin, co, '1010'));
    assert.equal(list.length, 3);
    assert.equal(list.find((p) => p.id === payNoIban)?.problem, 'the supplier has no IBAN');
    await assert.rejects(tx(admin, (q) => bankfiles.createPaymentFile(q, admin, { companyId: co, bankAccount: '1010', paymentIds: [pay1, payNoIban], executionDate: '2026-03-03' })), /has no IBAN/);
  });

  it('makes an ISO 20022 pain.001 file, and a payment goes into one live file only', async () => {
    const f = await tx(admin, (q) => bankfiles.createPaymentFile(q, admin, { companyId: co, bankAccount: '1010', paymentIds: [pay1, pay2], executionDate: '2026-03-03' }));
    fileId = f.id;
    assert.match(f.no, /^PF-2026-\d{5}$/);
    assert.equal(Number(f.total), 2175.25);
    const { xml } = await tx(admin, (q) => bankfiles.paymentFileXml(q, admin, f.id));
    assert.match(xml, /urn:iso:std:iso:20022:tech:xsd:pain\.001\.001\.03/);
    assert.match(xml, /<NbOfTxs>2<\/NbOfTxs>\s*<CtrlSum>2175\.25<\/CtrlSum>/);
    assert.match(xml, new RegExp(`<DbtrAcct><Id><IBAN>${OUR_IBAN}</IBAN>`));
    assert.match(xml, new RegExp(`<CdtrAcct><Id><IBAN>${SUP_IBAN}</IBAN>`));
    assert.match(xml, /<InstdAmt Ccy="AED">75\.25<\/InstdAmt>/);
    assert.match(xml, /<ReqdExctnDt>2026-03-03<\/ReqdExctnDt>/);
    assert.match(xml, /<BIC>EBILAEAD<\/BIC>/);
    await assert.rejects(tx(admin, (q) => bankfiles.createPaymentFile(q, admin, { companyId: co, bankAccount: '1010', paymentIds: [pay1], executionDate: '2026-03-04' })), /already in a payment file/);
  });

  it('cancelling a file frees its payments; a sent file stays', async () => {
    await tx(admin, (q) => bankfiles.setPaymentFileStatus(q, admin, fileId, 'cancelled'));
    const f2 = await tx(admin, (q) => bankfiles.createPaymentFile(q, admin, { companyId: co, bankAccount: '1010', paymentIds: [pay1], executionDate: '2026-03-04' }));
    await tx(admin, (q) => bankfiles.setPaymentFileStatus(q, admin, f2.id, 'sent'));
    await assert.rejects(tx(admin, (q) => bankfiles.setPaymentFileStatus(q, admin, f2.id, 'cancelled')), /already sent/);
    const files = await tx(admin, (q) => bankfiles.listPaymentFiles(q, admin, co));
    assert.deepEqual(files.map((f) => f.status).sort(), ['cancelled', 'sent']);
  });

  it('needs the payment file permission', async () => {
    const rep = s.ctxOf(s.people.salesRep.userId);
    await assert.rejects(tx(rep, (q) => bankfiles.payableForFile(q, rep, co, '1010')), /forbidden|not allowed|permission/i);
  });
});

describe('invoice PDF', () => {
  it('writes a PDF with the invoice, its lines, totals and how to pay', async () => {
    const inv = await sale(1234.5);
    const { name, pdf } = await tx(admin, (q) => invoicePdf(q, admin, inv.id));
    assert.equal(name, `${inv.no}.pdf`);
    const text = pdf.toString('latin1');
    assert.match(text, /^%PDF-1\.4/);
    assert.match(text, /%%EOF\n$/);
    assert.match(text, /\(Tax Invoice\)/);
    assert.ok(text.includes(`(${inv.no})`));
    assert.match(text, /\(1,296\.23\)/);           // 1,234.50 + 5% VAT
    assert.ok(text.includes(OUR_IBAN));
    // The cross-reference table points at each object.
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    assert.equal(text.slice(xref, xref + 4), 'xref');
    for (const m of text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)) assert.match(text.slice(Number(m[1]), Number(m[1]) + 12), /^\d+ 0 obj/);
  });
  it('shows names in other scripts as question marks rather than breaking', async () => {
    const c2 = (await tx(admin, (q) => one(q, `SELECT id FROM mdm.parties WHERE code = 'C2'`))).id;
    const inv = await sale(100, c2);
    const { pdf } = await tx(admin, (q) => invoicePdf(q, admin, inv.id));
    assert.match(pdf.toString('latin1'), /\(\?\?\?\? \?\?\?\?\?\?\)/);
  });
});

// --- A fake SMTP server -------------------------------------------------------------------
interface Received { from: string; to: string[]; data: string; auth?: string }
function fakeSmtp(opts: { refuseRcpt?: boolean; requireAuth?: boolean } = {}) {
  const got: Received[] = [];
  const server = createServer((sock: Socket) => {
    let mode: 'cmd' | 'data' = 'cmd', buf = '', cur: Received = { from: '', to: [], data: '' };
    const say = (l: string) => sock.write(l + '\r\n');
    say('220 fake.test ESMTP');
    sock.on('data', (d) => {
      buf += d.toString();
      for (;;) {
        if (mode === 'data') {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          cur.data = buf.slice(0, end).replace(/\r\n\.\./g, '\r\n.'); buf = buf.slice(end + 5);
          got.push(cur); cur = { from: '', to: [], data: '' }; mode = 'cmd'; say('250 2.0.0 queued as F4KE'); continue;
        }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) { sock.write('250-fake.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n'); }
        else if (/^AUTH PLAIN/i.test(line)) { cur.auth = Buffer.from(line.slice(11), 'base64').toString(); say('235 ok'); }
        else if (/^MAIL FROM:/i.test(line)) { if (opts.requireAuth && !cur.auth) say('530 authentication required'); else { cur.from = line.slice(10); say('250 ok'); } }
        else if (/^RCPT TO:/i.test(line)) { if (opts.refuseRcpt) say('550 5.1.1 no such user'); else { cur.to.push(line.slice(8)); say('250 ok'); } }
        else if (/^DATA/i.test(line)) { mode = 'data'; say('354 go ahead'); }
        else if (/^QUIT/i.test(line)) { say('221 bye'); sock.end(); }
        else say('500 what');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise<{ port: number; got: Received[]; close: () => void }>((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ port: (server.address() as any).port, got, close: () => server.close() })));
}

describe('email', () => {
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  before(async () => { smtp = await fakeSmtp(); });
  after(() => smtp.close());
  const opts = { secretKey: SECRET };

  it('keeps the settings with the password sealed, and checks addresses', async () => {
    await assert.rejects(tx(admin, (q) => mail.saveSettings(q, admin, opts, { transport: 'smtp', host: '127.0.0.1', port: smtp.port, fromAddress: 'not an address', fromName: 'Acme' })), /not a valid sender address/);
    const st = await tx(admin, (q) => mail.saveSettings(q, admin, opts, { transport: 'smtp', host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'accounts@acme.test', fromName: 'Acme Accounts', replyTo: 'ar@acme.test' }));
    assert.equal(st.from_address, 'accounts@acme.test');
    assert.equal(st.has_secret, false);
  });

  it('sends a test message through the mail server', async () => {
    const r = await mail.sendTest(t.db, admin, opts, 'me@acme.test');
    assert.equal(r.sent, true, r.answer);
    assert.match(r.answer, /queued as F4KE/);
    const m = smtp.got.at(-1)!;
    assert.equal(m.from, '<accounts@acme.test>');
    assert.deepEqual(m.to, ['<me@acme.test>']);
    assert.match(m.data, /^From: "Acme Accounts" <accounts@acme\.test>/m);
    assert.match(m.data, /^Reply-To: ar@acme\.test/m);
  });

  it('refuses to send a password unencrypted', async () => {
    await tx(admin, (q) => mail.saveSettings(q, admin, opts, { transport: 'smtp', host: '127.0.0.1', port: smtp.port, security: 'none', username: 'u', password: 'p', fromAddress: 'accounts@acme.test', fromName: 'Acme' }));
    const r = await mail.sendTest(t.db, admin, opts, 'me@acme.test');
    assert.equal(r.sent, false);
    assert.match(r.answer, /unencrypted/);
    await tx(admin, (q) => mail.saveSettings(q, admin, opts, { transport: 'smtp', host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'accounts@acme.test', fromName: 'Acme Accounts' }));
  });

  it('emails an invoice with its PDF to the customer, through the outbox', async () => {
    const inv = await sale(2000);
    const q1 = await tx(admin, (q) => emailInvoice(q, admin, inv.id, { message: 'Thank you for your business.' }));
    assert.deepEqual(q1.to, ['ap@gulfretail.test']);
    assert.deepEqual(q1.attachments, [`${inv.no}.pdf`]);
    const before = smtp.got.length;
    const n = await mail.dispatchMailTenant(t.db, s.tenantId, opts);
    assert.equal(n, 1);
    const m = smtp.got[before];
    assert.match(m.data, new RegExp(`^Subject: Invoice ${inv.no} from Acme UAE LLC`, 'm'));
    assert.match(m.data, /Content-Type: application\/pdf; name="[^"]+\.pdf"/);
    const pdfPart = /filename="[^"]+\.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(m.data)![1];
    assert.match(Buffer.from(pdfPart.replace(/\r\n/g, ''), 'base64').toString('latin1'), /^%PDF/);
    const text = Buffer.from(/text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(m.data)![1].replace(/\r\n/g, ''), 'base64').toString();
    assert.match(text, /Thank you for your business\./);
    assert.match(text, /Amount due: AED 2,100\.00/);
    const sent = await tx(admin, (q) => mail.listMails(q, admin, { entityType: 'fin.invoice', entityId: inv.id }));
    assert.equal(sent[0].status, 'sent');
  });

  it('a customer without an email needs an address', async () => {
    const c2 = (await tx(admin, (q) => one(q, `SELECT id FROM mdm.parties WHERE code = 'C2'`))).id;
    const inv = await sale(50, c2);
    await assert.rejects(tx(admin, (q) => emailInvoice(q, admin, inv.id, {})), /has no email address/);
    await assert.rejects(tx(admin, (q) => emailInvoice(q, admin, inv.id, { to: ['x@y'] })), /not a valid email address/);
  });

  it('retries a refused message, then gives up and can be sent again', async () => {
    const bad = await fakeSmtp({ refuseRcpt: true });
    await tx(admin, (q) => mail.saveSettings(q, admin, opts, { transport: 'smtp', host: '127.0.0.1', port: bad.port, security: 'none', fromAddress: 'accounts@acme.test', fromName: 'Acme' }));
    const m = await tx(admin, (q) => mail.queue(q, admin.userId, { kind: 'test', to: ['gone@acme.test'], subject: 'Hello', text: 'x' }));
    for (let i = 0; i < mail.MAX_MAIL_ATTEMPTS; i++) {
      await tx(admin, (q) => q.query('UPDATE int.mails SET next_attempt_at = now() WHERE id = $1', [m.id]));
      await mail.dispatchMailTenant(t.db, s.tenantId, opts);
    }
    const row = await tx(admin, (q) => one(q, 'SELECT status, attempts, last_error FROM int.mails WHERE id = $1', [m.id]));
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, mail.MAX_MAIL_ATTEMPTS);
    assert.match(row.last_error, /gone@acme\.test was refused: 550 5\.1\.1/);
    await tx(admin, (q) => mail.resend(q, admin, m.id));
    assert.equal((await tx(admin, (q) => one(q, 'SELECT status FROM int.mails WHERE id = $1', [m.id]))).status, 'pending');
    bad.close();
    await tx(admin, (q) => mail.saveSettings(q, admin, opts, { transport: 'smtp', host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'accounts@acme.test', fromName: 'Acme Accounts' }));
    await tx(admin, (q) => q.query(`UPDATE int.mails SET status = 'sent' WHERE id = $1`, [m.id]));
  });

  it('tells approvers by email when something waits for them', async () => {
    await giveRole(t.db, s, s.people.cfo.userId, 'CFO', { 'mdm.party.approve': {} }, s.units.root);
    await tx(admin, (q) => wf.publishDefinition(q, admin, { code: mdm.PARTY_WORKFLOW, name: 'Partner approval', entityType: 'mdm.party',
      definition: { steps: [{ key: 'cfo', approvers: [{ type: 'role', role: 'CFO' }] }] } as any }));
    const p = await tx(admin, (q) => mdm.createParty(q, admin, { code: 'C9', name: 'Needs Approval LLC', isCustomer: true, isSupplier: false, countryCode: 'AE', ownerUnitId: co }));
    await tx(admin, (q) => mdm.submitParty(q, admin, p.party.id));
    const notes = await tx(admin, (q) => many(q, `SELECT to_addresses, subject FROM int.mails WHERE kind = 'approval'`));
    assert.deepEqual(notes.map((n) => n.to_addresses), [[`cfo@${s.code}.test`]]);
    assert.match(notes[0].subject, /^Waiting for your approval: Partner approval/);
  });

  it('sends through Microsoft 365 with an app token and Graph', async () => {
    const calls: { url: string; init: any }[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.includes('/oauth2/v2.0/token')) return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
      if (url.includes('/sendMail')) return new Response(null, { status: 202 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const o = { secretKey: SECRET, fetchImpl, msLoginBase: 'https://login.test', graphBase: 'https://graph.test' };
    await tx(admin, (q) => mail.saveSettings(q, admin, o, { transport: 'microsoft365', msTenant: 'acme.onmicrosoft.com', msClientId: 'app-1', msClientSecret: 'shh', fromAddress: 'accounts@acme.test', fromName: 'Acme' }));
    const r = await mail.sendTest(t.db, admin, o, 'me@acme.test');
    assert.equal(r.sent, true, r.answer);
    assert.equal(calls[0].url, 'https://login.test/acme.onmicrosoft.com/oauth2/v2.0/token');
    assert.match(calls[0].init.body, /grant_type=client_credentials/);
    assert.match(calls[0].init.body, /client_secret=shh/);
    assert.equal(calls[1].url, 'https://graph.test/v1.0/users/accounts%40acme.test/sendMail');
    assert.equal(calls[1].init.headers.authorization, 'Bearer tok-1');
    assert.deepEqual(JSON.parse(calls[1].init.body).message.toRecipients, [{ emailAddress: { address: 'me@acme.test' } }]);
    await tx(admin, (q) => mail.saveSettings(q, admin, opts, { transport: 'smtp', host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'accounts@acme.test', fromName: 'Acme Accounts' }));
  });
});

// --- A fake OpenID Connect provider -------------------------------------------------------
function fakeIdp(issuer: string, clientId: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as any;
  const codes = new Map<string, { challenge: string; nonce: string }>();
  let claims: Record<string, unknown> = {};
  let signWith = privateKey;
  const sign = (payload: object) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(signWith).toString('base64url')}`;
  };
  const fetchImpl = (async (url: string, init?: any) => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url === `${issuer}/.well-known/openid-configuration`) return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (url === `${issuer}/jwks`) return json({ keys: [{ ...jwk, kid: 'k1', use: 'sig', alg: 'RS256' }] });
    if (url === `${issuer}/token`) {
      const b = new URLSearchParams(init.body);
      const c = codes.get(b.get('code')!);
      if (!c || b.get('client_id') !== clientId || b.get('client_secret') !== 'idp-secret') return json({ error: 'invalid_grant' }, 400);
      if (createHash('sha256').update(b.get('code_verifier')!).digest('base64url') !== c.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
      const now = Math.floor(Date.now() / 1000);
      return json({ id_token: sign({ iss: issuer, aud: clientId, iat: now, exp: now + 300, nonce: c.nonce, ...claims }), access_token: 'x' });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  /** The provider's answer to an authorization URL: a code for the redirect. */
  const authorize = (authUrl: string) => {
    const u = new URL(authUrl);
    const code = randomBytes(8).toString('hex');
    codes.set(code, { challenge: u.searchParams.get('code_challenge')!, nonce: u.searchParams.get('nonce')! });
    return { code, state: u.searchParams.get('state')! };
  };
  return { fetchImpl, authorize, setClaims: (c: Record<string, unknown>) => { claims = c; }, useOtherKey: () => { signWith = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey; } };
}

describe('sign-in with an identity provider', () => {
  const issuer = 'http://idp.test';
  const idp = fakeIdp(issuer, 'baats-app');
  const o = { secretKey: SECRET, allowHttp: true, fetchImpl: idp.fetchImpl };
  let providerId: string;
  const signIn = async (claims: Record<string, unknown>) => {
    idp.setClaims(claims);
    const { url } = await sso.startSignIn(t.db, o, { tenant: s.code, providerId, redirectUri: 'http://localhost:3000/v1/auth/sso/callback', returnTo: '/' });
    const { code, state } = idp.authorize(url);
    return sso.finishSignIn(t.db, o, { state, code, ip: '10.0.0.5' });
  };

  it('is set up by an administrator, for named email domains', async () => {
    await assert.rejects(tx(admin, (q) => sso.createProvider(q, admin, o, { kind: 'oidc', issuer, clientId: 'baats-app', clientSecret: 'idp-secret' })), /name the email domains/);
    await assert.rejects(tx(admin, (q) => sso.createProvider(q, admin, o, { kind: 'oidc', issuer: 'http://wrong.test', clientId: 'baats-app', clientSecret: 'idp-secret', allowedDomains: ['x.test'] })), /answered 404/);
    const p = await tx(admin, (q) => sso.createProvider(q, admin, o, { kind: 'oidc', name: 'Acme ID', issuer, clientId: 'baats-app', clientSecret: 'idp-secret', allowedDomains: [`${s.code}.test`] }));
    providerId = p.id;
    assert.deepEqual((await sso.publicProviders(t.db, s.code)).map((x) => x.name), ['Acme ID']);
    assert.match(sso.issuerFor('microsoft', { msTenant: 'contoso.onmicrosoft.com' }), /^https:\/\/login\.microsoftonline\.com\/contoso\.onmicrosoft\.com\/v2\.0$/);
    assert.throws(() => sso.issuerFor('microsoft', { msTenant: 'common' }), /directory/);
  });

  it('signs in an existing user by their verified email, with PKCE, state and nonce', async () => {
    const r = await signIn({ email: `cfo@${s.code}.test`, email_verified: true, sub: 'u-1' });
    const ctx = await auth.authenticate(t.db, r.token);
    assert.equal(ctx.userId, s.people.cfo.userId);
    assert.equal(r.tenantCode, s.code);
    const sess = await tx(admin, (q) => one(q, 'SELECT ip, sso_provider_id FROM iam.sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [s.people.cfo.userId]));
    assert.deepEqual(sess, { ip: '10.0.0.5', sso_provider_id: providerId });
  });

  it('refuses unverified emails, other domains, unknown users, reused states and forged tokens', async () => {
    await assert.rejects(signIn({ email: `cfo@${s.code}.test`, email_verified: false }), /did not confirm the email/);
    await assert.rejects(signIn({ email: 'boss@elsewhere.test', email_verified: true }), /may not sign in this way/);
    await assert.rejects(signIn({ email: `nobody@${s.code}.test`, email_verified: true }), /no BAATS user/);
    idp.setClaims({ email: `cfo@${s.code}.test`, email_verified: true });
    const { url } = await sso.startSignIn(t.db, o, { tenant: s.code, providerId, redirectUri: 'http://localhost/cb' });
    const { code, state } = idp.authorize(url);
    await sso.finishSignIn(t.db, o, { state, code });
    await assert.rejects(sso.finishSignIn(t.db, o, { state, code }), /expired or was already used/);
    await assert.rejects(signIn({ email: `cfo@${s.code}.test`, email_verified: true, aud: 'someone-else' }), /another application/);
    await assert.rejects(signIn({ email: `cfo@${s.code}.test`, email_verified: true, nonce: 'replayed' }), /does not belong to this sign-in/);
    idp.useOtherKey();
    await assert.rejects(signIn({ email: `cfo@${s.code}.test`, email_verified: true }), /signature is not valid/);
  });

  it('keeps open redirects out', async () => {
    await assert.rejects(sso.startSignIn(t.db, o, { tenant: s.code, providerId, redirectUri: 'http://x/cb', returnTo: '//evil.test/' }), /path on this server/);
    await assert.rejects(sso.startSignIn(t.db, o, { tenant: s.code, providerId, redirectUri: 'http://x/cb', returnTo: 'https://evil.test/' }), /path on this server/);
  });

  it('works through the HTTP routes: start redirects to the provider, the callback hands the session to the page', async () => {
    const idp2 = fakeIdp('http://idp2.test', 'app-2');
    const app = buildServer({ db: t.db, platformAdminKey: 'k', ai: { secretKey: SECRET.toString('base64') }, connectors: { ssoAllowHttp: true, fetchImpl: idp2.fetchImpl } });
    const p = await tx(admin, (q) => sso.createProvider(q, admin, { ...o, fetchImpl: idp2.fetchImpl }, { kind: 'oidc', issuer: 'http://idp2.test', clientId: 'app-2', clientSecret: 'idp-secret', allowedDomains: [`${s.code}.test`] }));
    const start = await app.inject({ method: 'GET', url: `/v1/auth/sso/start?tenant=${s.code}&provider=${p.id}&returnTo=/console`, headers: { host: 'erp.acme.test' } });
    assert.equal(start.statusCode, 302);
    const loc = new URL(start.headers.location as string);
    assert.equal(loc.origin + loc.pathname, 'http://idp2.test/authorize');
    assert.equal(loc.searchParams.get('redirect_uri'), 'http://erp.acme.test/v1/auth/sso/callback');
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    idp2.setClaims({ email: `ceo@${s.code}.test`, email_verified: true });
    const { code, state } = idp2.authorize(loc.toString());
    const cb = await app.inject({ method: 'GET', url: `/v1/auth/sso/callback?code=${code}&state=${encodeURIComponent(state)}`, headers: { host: 'erp.acme.test' } });
    assert.equal(cb.statusCode, 302);
    const frag = new URLSearchParams((cb.headers.location as string).split('#')[1]);
    assert.equal((cb.headers.location as string).split('#')[0], '/console');
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${frag.get('sso_token')}` } });
    assert.equal(me.json().user.email, `ceo@${s.code}.test`);
    const bad = await app.inject({ method: 'GET', url: '/v1/auth/sso/callback?code=x&state=nonsense' });
    assert.match(new URLSearchParams((bad.headers.location as string).split('#')[1]).get('sso_error')!, /this sign-in link is not valid/);
    await app.close();
  });
});

// --- A fake Stripe ------------------------------------------------------------------------
function fakeStripe() {
  const sessions = new Map<string, any>();
  const calls: { method: string; path: string; form?: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    const u = new URL(url);
    const form = init.body ? new URLSearchParams(init.body) : undefined;
    calls.push({ method: init.method, path: u.pathname, form });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (init.headers.authorization !== 'Bearer sk_test_51Fake0000000000') return json({ error: { message: 'Invalid API Key provided' } }, 401);
    if (u.pathname === '/v1/balance') return json({ object: 'balance' });
    if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
      const id = `cs_test_${randomBytes(6).toString('hex')}`;
      const sObj = { id, object: 'checkout.session', url: `https://checkout.stripe.test/c/pay/${id}`, status: 'open', payment_status: 'unpaid',
        amount_total: Number(form!.get('line_items[0][price_data][unit_amount]')), currency: form!.get('line_items[0][price_data][currency]'), created: Math.floor(Date.now() / 1000), payment_intent: null };
      sessions.set(id, sObj);
      return json(sObj);
    }
    const m = /^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(u.pathname);
    if (m && sessions.has(m[1])) {
      const sObj = sessions.get(m[1]);
      if (m[2]) { if (sObj.status !== 'open') return json({ error: { message: 'not open' } }, 400); sObj.status = 'expired'; }
      return json(sObj);
    }
    return json({ error: { message: 'No such resource' } }, 404);
  }) as unknown as typeof fetch;
  const pay = (id: string) => Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid', payment_intent: 'pi_123' });
  return { fetchImpl, calls, pay, sessions };
}

describe('card payment links', () => {
  const stripe = fakeStripe();
  const o = { secretKey: SECRET, fetchImpl: stripe.fetchImpl, stripeBase: 'https://stripe.test' };
  let inv: any, link: any;

  it('works out amounts in Stripe minor units, three-decimal currencies included', () => {
    assert.equal(paylinks.minorUnits(2100.5, 'AED'), 210050);
    assert.equal(paylinks.minorUnits(12.345, 'KWD'), 12350);
    assert.equal(paylinks.minorUnits(1500, 'JPY'), 1500);
  });

  it('is set up with a working key, and makes the card clearing account', async () => {
    await assert.rejects(tx(admin, (q) => paylinks.setGateway(q, admin, o, co, { secretKey: 'pk_test_abc' })), /secret key starts with/);
    await assert.rejects(tx(admin, (q) => paylinks.setGateway(q, admin, o, co, { secretKey: 'sk_test_51Wrong000000000' })), /Invalid API Key/);
    const g = await tx(admin, (q) => paylinks.setGateway(q, admin, o, co, { secretKey: 'sk_test_51Fake0000000000', webhookSecret: 'whsec_testsecret123' }));
    assert.deepEqual([g.provider, g.live, g.clearing_account, g.has_webhook_secret], ['stripe', false, '1040', true]);
  });

  it('makes a Stripe Checkout page for what is still owed, and reuses it', async () => {
    inv = await sale(1000);
    await tx(admin, (q) => docs.recordPayment(q, admin, { companyId: co, kind: 'receipt', partyId: customer, date: D, bankAccount: '1010', amount: 50, allocations: [{ invoiceId: inv.id, amount: 50 }] }));
    link = await tx(admin, (q) => paylinks.createLink(q, admin, o, inv.id, { returnUrl: 'http://localhost:3000/' }));
    assert.equal(Number(link.amount), 1000);
    assert.match(link.url, /^https:\/\/checkout\.stripe\.test\//);
    const form = stripe.calls.find((c) => c.path === '/v1/checkout/sessions')!.form!;
    assert.equal(form.get('line_items[0][price_data][unit_amount]'), '100000');
    assert.equal(form.get('line_items[0][price_data][currency]'), 'aed');
    assert.equal(form.get('client_reference_id'), inv.id);
    assert.equal(form.get('customer_email'), 'ap@gulfretail.test');
    assert.match(form.get('success_url')!, /^http:\/\/localhost:3000\/\?paid=SI-/);
    const again = await tx(admin, (q) => paylinks.createLink(q, admin, o, inv.id, { returnUrl: 'http://localhost:3000/' }));
    assert.equal(again.id, link.id);
    const { pdf } = await tx(admin, (q) => invoicePdf(q, admin, inv.id));
    assert.ok(pdf.toString('latin1').includes(link.url.slice(0, 40)));
  });

  it('records the receipt into the clearing account once Stripe says it is paid', async () => {
    assert.equal((await tx(admin, (q) => paylinks.checkLink(q, admin, o, link.id))).status, 'open');
    stripe.pay(link.provider_ref);
    const n = await paylinks.checkOpenLinks(t.db, o);
    assert.equal(n, 1);
    const l = await tx(admin, (q) => one(q, 'SELECT status, payment_id FROM fin.payment_links WHERE id = $1', [link.id]));
    assert.equal(l.status, 'paid');
    const p = await tx(admin, (q) => one(q, `SELECT p.no, p.amount::float AS amount, a.code, p.reference FROM fin.payments p JOIN fin.accounts a ON a.id = p.bank_account_id WHERE p.id = $1`, [l.payment_id]));
    assert.deepEqual([p.amount, p.code, p.reference], [1000, '1040', 'Card pi_123']);
    assert.equal(await tx(admin, (q) => docs.outstanding(q, inv.id)), 0);
    assert.equal((await tx(admin, (q) => paylinks.checkLink(q, admin, o, link.id))).status, 'paid');
    await assert.rejects(tx(admin, (q) => paylinks.createLink(q, admin, o, inv.id, { returnUrl: 'http://localhost:3000/' })), /already paid/);
  });

  it('accepts Stripe notices only with the right signature', async () => {
    const inv2 = await sale(200);
    const l2 = await tx(admin, (q) => paylinks.createLink(q, admin, o, inv2.id, { returnUrl: 'http://localhost:3000/' }));
    stripe.pay(l2.provider_ref);
    const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: l2.provider_ref, object: 'checkout.session' } } });
    const ts = Math.floor(Date.now() / 1000);
    const good = `t=${ts},v1=${createHmac('sha256', 'whsec_testsecret123').update(`${ts}.${raw}`).digest('hex')}`;
    assert.equal(paylinks.verifyStripeSignature(good, raw, 'whsec_testsecret123'), true);
    assert.equal(paylinks.verifyStripeSignature(good, raw + ' ', 'whsec_testsecret123'), false);
    assert.equal(paylinks.verifyStripeSignature(`t=${ts - 600},v1=00`, raw, 'whsec_testsecret123'), false);
    const app = buildServer({ db: t.db, platformAdminKey: 'k', ai: { secretKey: SECRET.toString('base64') }, connectors: { fetchImpl: stripe.fetchImpl, stripeBase: 'https://stripe.test' } });
    const forged = await app.inject({ method: 'POST', url: '/v1/pay/stripe/notice', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)}` }, payload: raw });
    assert.equal(forged.statusCode, 422);
    const ok = await app.inject({ method: 'POST', url: '/v1/pay/stripe/notice', headers: { 'content-type': 'application/json', 'stripe-signature': good }, payload: raw });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { received: true, handled: true, status: 'paid' });
    await app.close();
  });

  it('a cancelled link stops working at Stripe', async () => {
    const inv3 = await sale(300);
    const l3 = await tx(admin, (q) => paylinks.createLink(q, admin, o, inv3.id, { returnUrl: 'http://localhost:3000/' }));
    await tx(admin, (q) => paylinks.cancelLink(q, admin, o, l3.id));
    assert.equal(stripe.sessions.get(l3.provider_ref).status, 'expired');
    const links = await tx(admin, (q) => paylinks.listLinks(q, admin, co, inv3.id));
    assert.equal(links[0].status, 'cancelled');
  });
});

describe('Excel workbooks', () => {
  const buf = readFileSync(new URL('./fixtures/import.xlsx', import.meta.url));
  it('reads the visible sheets, shared and inline text, numbers and dates', () => {
    const wb = openXlsx(buf);
    assert.deepEqual(wb.sheets, ['Customers', 'Open invoices']);
    const rows = wb.read();
    assert.deepEqual(rows[0], ['code', 'name', 'city', 'credit_limit', 'tax_no']);
    assert.deepEqual(rows[2], ['X-C2', 'Gulf "Star" & Co, LLC', 'Sharjah', '1234.5', '']);
    assert.equal(rows[3][1], 'شركة الخليج');
    assert.deepEqual(wb.read('Open invoices')[1], ['X-C1', 'OLD-1', '2026-01-15', '12600']);
    assert.equal(excelDate(46037), '2026-01-15');
    assert.throws(() => wb.read('Nope'), /no sheet "Nope"/);
    assert.throws(() => openXlsx(Buffer.from('code,name\n')), /not an Excel workbook/);
    assert.throws(() => openXlsx(Buffer.from('d0cf11e0a1b11ae1', 'hex')), /old Excel file \(\.xls\)/);
  });
  it('goes through the same import checks as CSV', async () => {
    const csv = rowsToCsv(openXlsx(buf).read());
    const r = await tx(admin, (q) => mig.runImport(q, admin, { kind: 'customers', companyId: co, csv, dryRun: true }));
    assert.deepEqual([r.errors, r.created], [[], 3]);
    const app = buildServer({ db: t.db, platformAdminKey: 'k' });
    const tok = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `admin@${s.code}.test`, password: PASSWORD } })).json().token;
    const x = await app.inject({ method: 'POST', url: '/v1/mig/xlsx', headers: { authorization: `Bearer ${tok}` }, payload: { fileBase64: buf.toString('base64'), sheet: 'Open invoices' } });
    assert.equal(x.statusCode, 200);
    assert.deepEqual([x.json().sheet, x.json().rows], ['Open invoices', 1]);
    assert.match(x.json().csv, /^customer_code,number,date,amount_due\r\nX-C1,OLD-1,2026-01-15,12600\r\n$/);
    await app.close();
  });
});
