import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream, mkdtempSync, writeFileSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { many, one, type Ctx } from '../src/core/db.ts';
import { ForbiddenError } from '../src/core/errors.ts';
import * as setup from '../src/fin/setup.ts';
import * as docs from '../src/fin/documents.ts';
import * as reports from '../src/fin/reports.ts';
import * as auditSvc from '../src/audit/service.ts';
import * as mig from '../src/mig/import.ts';
import { backupDatabase, readBackupHeader, restoreDatabase } from '../src/platform/backup.ts';
import { buildServer } from '../src/api/server.ts';
import { ADMIN_URL, createTestDb, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

/**
 * Phase 7a: data import, backup and restore, sessions and passwords, rate limits.
 */

let t: TestDb;
let s: Seed;
let admin: Ctx, rep: Ctx;
let co: string;
const AS_OF = '2026-01-01';
const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);
const imp = (kind: mig.ImportKind, csv: string, dryRun = false) => tx(admin, (q) => mig.runImport(q, admin, { kind, companyId: co, asOf: AS_OF, csv, dryRun, fileName: `${kind}.csv` }));
const balance = (codes: string[]) => tx(admin, async (q) =>
  Number((await one(q, `SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM fin.journal_lines l
     JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
    WHERE a.company_id = $1 AND a.code = ANY($2)`, [co, codes])).b));
const urlFor = (name: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${name}`; return u.toString(); };

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  admin = s.adminCtx;
  rep = s.ctxOf(s.people.salesRep.userId);
  co = s.units.uae;
  await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: co, legalName: 'Acme UAE LLC', openFrom: AS_OF }));
});
after(async () => { await t.drop(); });

describe('reading spreadsheets', () => {
  it('reads what Excel saves: quotes, commas and line breaks inside, semicolons, a byte order mark', () => {
    assert.deepEqual(mig.parseCsv('﻿code,name\r\nC1,"Gulf ""Best"" Trading, LLC"\r\n\r\nC2,"Two\nlines"\r\n'),
      [['code', 'name'], ['C1', 'Gulf "Best" Trading, LLC'], ['C2', 'Two\nlines']]);
    assert.deepEqual(mig.parseCsv('code;name;credit_limit\nC1;Souq;1.234,5'), [['code', 'name', 'credit_limit'], ['C1', 'Souq', '1.234,5']]);
    assert.throws(() => mig.readRows('customers', 'name\nX'), /needs the column code/);
    assert.throws(() => mig.readRows('customers', 'code,name,colour\nC,X,red'), /unknown column colour/);
    assert.match(mig.template('open_invoices'), /^﻿customer_code,number,date,due_date,currency,fx_rate,amount_due\r\n$/);
  });
});

describe('importing a company', () => {
  it('checks a file first, lists every problem by its spreadsheet row, and saves nothing', async () => {
    const r = await imp('customers', 'code,name,country,credit_limit\nC001,Gulf Retail,AE,50000\nC002,,AE,\nC003,Souq,ZZ,\nC004,Marina,AE,lots\n');
    assert.equal(r.saved, false);
    assert.deepEqual(r.errors.map((e) => e.row), [3, 4, 5]);
    assert.match(r.errors[0].message, /name is missing/);
    assert.match(r.errors[2].message, /"lots" is not a number/);
    assert.equal((await tx(admin, (q) => many(q, `SELECT 1 FROM mdm.parties WHERE code LIKE 'C00%'`))).length, 0);
  });

  it('imports customers and suppliers as active partners, and skips those already there', async () => {
    const csv = 'code,name,country,tax_no,credit_limit,email\nC001,Gulf Retail LLC,AE,100000000000103,"50,000",ap@gulf.example\nC002,Boston Labs,US,,,\n';
    const dry = await imp('customers', csv, true);
    assert.deepEqual([dry.saved, dry.created, dry.errors.length], [false, 2, 0]);
    const r = await imp('customers', csv);
    assert.deepEqual([r.saved, r.created, r.skipped], [true, 2, 0]);
    const p = await tx(admin, (q) => one(q, `SELECT * FROM mdm.parties WHERE code = 'C001'`));
    assert.deepEqual([p.status, p.is_customer, Number(p.credit_limit), p.currency_code, p.attributes.email], ['active', true, 50000, 'AED', 'ap@gulf.example']);
    assert.equal((await tx(admin, (q) => one(q, `SELECT currency_code FROM mdm.parties WHERE code = 'C002'`))).currency_code, 'USD');
    assert.deepEqual([(await imp('customers', csv)).skipped], [2]);
    const sup = await imp('suppliers', 'code,name,iban\nS001,Dubai Office Supplies,AE070331234567890123456\n');
    assert.equal(sup.created, 1);
    const runs = await tx(admin, (q) => mig.listImportRuns(q, admin, co));
    assert.equal(runs.length, 3);
    assert.equal(runs[0].kind, 'suppliers');
  });

  it('only lets people with mig.import import', async () => {
    await assert.rejects(tx(rep, (q) => mig.runImport(q, rep, { kind: 'customers', companyId: co, csv: 'code,name\nX,Y\n' })), ForbiddenError);
  });

  it('imports items with their opening stock, valued into the books', async () => {
    const r = await imp('items', 'code,name,type,uom,sale_price,warehouse,opening_qty,unit_cost\nLAP14,Laptop 14 inch,stock,PCS,3200,MAIN,10,2500\nTONER,Toner,stock,,,MAIN,40,"1,000.00"\nSETUP,Setup service,service,HR,500,,,\n');
    assert.deepEqual([r.saved, r.created], [true, 3], JSON.stringify(r.errors));
    assert.equal(await balance(['1300']), 10 * 2500 + 40 * 1000);
    assert.equal(await balance(['3200']), -(10 * 2500 + 40 * 1000));
    const bad = await imp('items', 'code,name,type,warehouse,opening_qty\nSETUP,Setup service,service,MAIN,3\nX1,Thing,stock,MAIN,2\n');
    assert.match(bad.errors[0].message, /only stock items/);
    assert.match(bad.errors[1].message, /unit_cost/);
  });

  it('imports employees with their managers and contracts', async () => {
    const r = await imp('employees', 'employee_no,first_name,last_name,manager_no,hire_date,nationality,basic,housing\nM100,Huda,Saleh,,01/03/2020,AE,30000,10000\nM101,Ravi,Kumar,M100,2022-07-15,IN,9000,3000\nM102,Ana,Cruz,M999,,PH,,\n');
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].message, /no employee M999/);
    const ok = await imp('employees', 'employee_no,first_name,last_name,manager_no,hire_date,nationality,basic,housing\nM100,Huda,Saleh,,01/03/2020,AE,30000,10000\nM101,Ravi,Kumar,M100,2022-07-15,IN,9000,3000\n');
    assert.equal(ok.created, 2);
    const k = await tx(admin, (q) => one(q, `SELECT k.start_date, k.basic, m.employee_no AS manager FROM hr.contracts k JOIN org.employees e ON e.id = k.employee_id
      JOIN org.employees m ON m.id = e.manager_id WHERE e.employee_no = 'M101'`));
    assert.deepEqual([k.start_date.toISOString().slice(0, 10), Number(k.basic), k.manager], ['2022-07-15', 9000, 'M100']);
  });

  it('brings open invoices and bills in as documents that can be paid, without VAT or revenue', async () => {
    const inv = await imp('open_invoices', 'customer_code,number,date,due_date,currency,fx_rate,amount_due\nC001,INV-0912,15/12/2025,14/01/2026,,,"10,500.00"\nC002,INV-0915,2025-12-20,,USD,3.6725,2000\nC999,INV-1,2025-12-01,,,,5\n');
    assert.match(inv.errors[0].message, /no customer with code C999/);
    const ok = await imp('open_invoices', 'customer_code,number,date,due_date,currency,fx_rate,amount_due\nC001,INV-0912,15/12/2025,14/01/2026,,,"10,500.00"\nC002,INV-0915,2025-12-20,,USD,3.6725,2000\n');
    assert.equal(ok.created, 2);
    const bills = await imp('open_bills', 'supplier_code,number,date,amount_due\nS001,DOS-77,2025-12-28,4200\n');
    assert.equal(bills.created, 1);
    assert.equal(await balance(['1100']), 10500 + 7345);
    assert.equal(await balance(['2000']), -4200);
    assert.equal(await balance(['2100', '1200', '4000', '5000']), 0);
    // A customer pays the old invoice in full.
    const open = await tx(admin, (q) => one(q, `SELECT i.id, i.party_id FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id WHERE p.code = 'C001'`));
    await tx(admin, (q) => docs.recordPayment(q, admin, { companyId: co, kind: 'receipt', partyId: open.party_id, date: '2026-01-10', bankAccount: '1010', amount: 10500,
      allocations: [{ invoiceId: open.id, amount: 10500 }] } as any));
    assert.equal(await balance(['1100']), 7345);
    // Importing the same file again changes nothing.
    assert.equal((await imp('open_bills', 'supplier_code,number,date,amount_due\nS001,DOS-77,2025-12-28,4200\n')).skipped, 1);
  });

  it('posts the opening trial balance, checked against the customers, suppliers and stock already imported', async () => {
    // 1100 was 17,845 before the receipt above; the trial balance is at the cut-over date, so it is the balance then.
    const tb = (ar: string) => `account,debit,credit\n1010,250000,\n1100,${ar},\n1300,65000,\n1500,40000,\n2000,,4200\n2100,,12000\n3000,,200000\n3100,,${Number(ar) + 250000 + 65000 + 40000 - 4200 - 12000 - 200000}\n`;
    const wrong = await imp('opening_balances', tb('17000'));
    assert.match(wrong.errors[0].message, /1100 is 17000 here but the imported open customer invoices come to 17845/);
    const unbalanced = await imp('opening_balances', 'account,debit,credit\n1010,100,\n3000,,90\n');
    assert.match(unbalanced.errors[0].message, /does not balance: debits are more than credits by 10/);
    const r = await imp('opening_balances', tb('17845'));
    assert.deepEqual([r.saved, r.errors.length], [true, 0], JSON.stringify(r.errors));
    assert.match(r.journalNo!, /^OB-2026-/);
    // Opening balance equity is back to zero: everything landed on its own account.
    assert.equal(await balance(['3200']), 0);
    const trial = await tx(admin, (q) => reports.trialBalance(q, admin, co, '2026-01-01'));
    const get = (code: string) => trial.lines.find((x: any) => x.code === code)!;
    assert.equal(get('1010').closing, 250000);
    assert.equal(get('3100').closing, -(17845 + 250000 + 65000 + 40000 - 4200 - 12000 - 200000));
    assert.equal(trial.balanced, true);
    assert.match((await imp('opening_balances', tb('17845'))).errors[0].message, /imported already/);
  });

  it('turns a BAATS Accounting book into import files', () => {
    const book = JSON.stringify({ cust: [{ id: 'a', name: 'Gulf Retail, LLC', trn: '100000000000103', email: 'x@y.ae', ctry: 'AE' }, { id: 'b', name: '' }],
      sup: [{ id: 'c', name: 'DEWA', ctry: 'AE', addr: 'Dubai' }], it: [{ id: 'd', code: 'P1', name: 'Paper', type: 'P', unit: 'BOX', price: 20 }, { id: 'e', name: 'Advice', type: 'S', price: 500 }],
      acc: [], inv: [], set: { vat: 5 } });
    const x = mig.fromBaatsAccounting(book);
    assert.deepEqual(x.counts, { customers: 1, suppliers: 1, items: 2 });
    assert.equal(mig.readRows('customers', x.customers)[0].name, 'Gulf Retail, LLC');
    assert.equal(mig.readRows('customers', x.customers)[0].code, 'C0001');
    assert.deepEqual(mig.readRows('items', x.items).map((r) => [r.code, r.type, r.uom]), [['P1', 'stock', 'BOX'], ['I0002', 'service', 'EA']]);
    assert.throws(() => mig.fromBaatsAccounting('{"hello":1}'), /not a BAATS Accounting book/);
  });
});

describe('backup and restore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baats-bk-'));
  let file: string;

  it('backs up the whole database while it runs', async () => {
    file = join(dir, 'b1.baatsbak');
    const r = await backupDatabase(t.ownerUrl, file, 'test');
    assert.ok(r.rows > 500 && r.tables > 50, JSON.stringify(r));
    const h = await readBackupHeader(file);
    assert.ok(h.migrations.includes('013_go_live.sql'));
    assert.ok(h.tables.includes('fin.journal_lines'));
  });

  it('restores it in place, exactly, keeping the replaced database', async () => {
    // A change after the backup, which the restore must undo.
    await tx(admin, (q) => mig.runImport(q, admin, { kind: 'customers', companyId: co, csv: 'code,name\nLATE,Added after the backup\n' }));
    const before = await tx(admin, (q) => auditSvc.verifyChain(q, admin));
    const r = await restoreDatabase({ adminUrl: ADMIN_URL, urlFor, database: t.name, file, migrationsDir: new URL('../db/migrations/', import.meta.url).pathname });
    assert.match(r.keptAs, new RegExp(`^${t.name}_before_restore_`));
    assert.deepEqual(r.newerMigrations, []);
    // The server's pool reconnects to the restored database by name.
    assert.equal((await tx(admin, (q) => many(q, `SELECT 1 FROM mdm.parties WHERE code = 'LATE'`))).length, 0);
    assert.equal((await tx(admin, (q) => many(q, `SELECT 1 FROM mdm.parties WHERE code = 'C001'`))).length, 1);
    const chain = await tx(admin, (q) => auditSvc.verifyChain(q, admin));
    assert.equal(chain.valid, true, JSON.stringify(chain));
    assert.ok(chain.entries < before.entries);
    assert.equal(await balance(['3200']), 0);
    // New rows still get fresh numbers after the restore.
    await tx(admin, (q) => mig.runImport(q, admin, { kind: 'customers', companyId: co, csv: 'code,name\nNEW1,After restore\n' }));
    const c = new pg.Client({ connectionString: ADMIN_URL });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${r.keptAs} WITH (FORCE)`);
    await c.end();
  });

  it('refuses files that are not backups, and backups from a newer version', async () => {
    const junk = join(dir, 'junk');
    writeFileSync(junk, 'hello');
    await assert.rejects(readBackupHeader(junk), /not a BAATS backup/);
    const newer = join(dir, 'newer.baatsbak');
    await new Promise<void>((res) => { const g = createGzip(); const out = createWriteStream(newer); g.pipe(out); out.on('close', () => res());
      g.end(JSON.stringify({ format: 'baats-backup/1', appVersion: '9.9.9', migrations: ['001_core.sql', '099_future.sql'], sequences: [], tables: [] }) + '\n'); });
    await assert.rejects(restoreDatabase({ adminUrl: ADMIN_URL, urlFor, database: t.name, file: newer, migrationsDir: new URL('../db/migrations/', import.meta.url).pathname }), /newer BAATS \(9\.9\.9\)/);
  });
});

describe('sessions, passwords and limits over HTTP', () => {
  let app: ReturnType<typeof buildServer>;
  const login = (email: string, password = PASSWORD) => app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email, password }, headers: { 'user-agent': 'TestPhone/1' } });
  before(async () => { app = buildServer({ db: t.db, platformAdminKey: 'k', limits: { loginsPer5Min: 12, apiPerMinute: 1000 } }); });
  after(async () => { await app.close(); });

  it('shows where I am signed in and signs out the other devices', async () => {
    const email = `salesrep@${s.code}.test`;
    const a = (await login(email)).json().token, b = (await login(email)).json().token;
    const list = (await app.inject({ method: 'GET', url: '/v1/me/sessions', headers: { authorization: `Bearer ${a}` } })).json();
    assert.ok(list.length >= 2);
    assert.equal(list.filter((x: any) => x.current).length, 1);
    assert.equal(list[0].user_agent, 'TestPhone/1');
    const r = await app.inject({ method: 'POST', url: '/v1/me/sessions/revoke-others', headers: { authorization: `Bearer ${a}` } });
    assert.ok(r.json().revoked >= 1);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${b}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${a}` } })).statusCode, 200);
  });

  it('changes my password only with the current one, and lets an administrator set one', async () => {
    const email = `accountant@${s.code}.test`;
    const tok = (await login(email)).json().token;
    const h = { authorization: `Bearer ${tok}` };
    assert.equal((await app.inject({ method: 'POST', url: '/v1/me/password', headers: h, payload: { current: 'wrong', next: 'New-Passw0rd-2026' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/me/password', headers: h, payload: { current: PASSWORD, next: 'short' } })).statusCode, 422);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/me/password', headers: h, payload: { current: PASSWORD, next: 'New-Passw0rd-2026' } })).statusCode, 200);
    assert.equal((await login(email)).statusCode, 401);
    assert.equal((await login(email, 'New-Passw0rd-2026')).statusCode, 200);
    // The administrator puts it back; the user's sessions end.
    const adm = (await login(`admin@${s.code}.test`)).json().token;
    const set = await app.inject({ method: 'POST', url: `/v1/iam/users/${s.people.accountant.userId}/password`, headers: { authorization: `Bearer ${adm}` }, payload: { password: PASSWORD } });
    assert.equal(set.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: h })).statusCode, 401);
    const repTok = (await login(`salesrep@${s.code}.test`)).json().token;
    assert.equal((await app.inject({ method: 'POST', url: `/v1/iam/users/${s.people.accountant.userId}/password`, headers: { authorization: `Bearer ${repTok}` }, payload: { password: PASSWORD } })).statusCode, 403);
  });

  it('sends security headers and keeps API answers out of caches', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${(await login(`admin@${s.code}.test`)).json().token}` } });
    assert.equal(me.headers['cache-control'], 'no-store');
  });

  it('slows down password guessing and runaway clients', async () => {
    const limited = buildServer({ db: t.db, platformAdminKey: 'k', limits: { loginsPer5Min: 3, apiPerMinute: 4 } });
    const tryLogin = (email: string, remoteAddress = '10.0.0.1') => limited.inject({ method: 'POST', url: '/v1/auth/login', remoteAddress, payload: { tenant: s.code, email, password: PASSWORD } });
    // Good sign-ins are not counted: an office behind one address signs in freely.
    const good = [];
    for (let i = 0; i < 5; i++) good.push((await tryLogin(`ceo@${s.code}.test`)).statusCode);
    assert.deepEqual(good, [200, 200, 200, 200, 200]);
    // Failures are: after 3 from one address, even the right password is refused there for a while.
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await tryLogin(`nobody${i}@${s.code}.test`)).statusCode);
    codes.push((await tryLogin(`ceo@${s.code}.test`)).statusCode);
    assert.deepEqual(codes, [401, 401, 401, 429]);
    const r = await tryLogin(`ceo@${s.code}.test`);
    assert.ok(Number(r.headers['retry-after']) > 0);
    assert.match(r.json().message, /too many failed sign-ins from this address/);
    assert.equal((await tryLogin(`ceo@${s.code}.test`, '10.0.0.2')).statusCode, 200);
    // And per account, from any number of addresses (10 failures).
    const acct = [];
    for (let i = 0; i < 11; i++) acct.push((await tryLogin(`ghost@${s.code}.test`, `10.1.0.${i}`)).statusCode);
    assert.deepEqual(acct.slice(-2), [401, 429]);
    const other = buildServer({ db: t.db, platformAdminKey: 'k', limits: { apiPerMinute: 4 } });
    const tok = (await other.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `ceo@${s.code}.test`, password: PASSWORD } })).json().token;
    const got = [];
    for (let i = 0; i < 5; i++) got.push((await other.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${tok}` } })).statusCode);
    assert.deepEqual(got, [200, 200, 200, 200, 429]);
    await limited.close(); await other.close();
  });
});
