import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { one, type Ctx } from '../src/core/db.ts';
import { ForbiddenError } from '../src/core/errors.ts';
import * as setup from '../src/fin/setup.ts';
import * as docs from '../src/fin/documents.ts';
import * as reports from '../src/fin/reports.ts';
import * as assets from '../src/fin/assets.ts';
import * as mdm from '../src/mdm/service.ts';
import * as inv from '../src/inv/service.ts';
import * as pur from '../src/pur/service.ts';
import * as hr from '../src/hr/service.ts';
import * as mnt from '../src/mnt/service.ts';
import * as wf from '../src/workflow/engine.ts';
import * as dms from '../src/corp/dms.ts';
import * as lgl from '../src/corp/legal.ts';
import * as grc from '../src/corp/grc.ts';
import * as svc from '../src/corp/svc.ts';
import * as qms from '../src/corp/qms.ts';
import * as hse from '../src/corp/hse.ts';
import * as fac from '../src/corp/fac.ts';
import { buildServer } from '../src/api/server.ts';
import { createTestDb, giveRole, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

let t: TestDb;
let s: Seed;
let co: string;
let admin: Ctx, mgr: Ctx, acct: Ctx, rep: Ctx;
let supplier: string, main: string, widget: string;

const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);
const balance = (code: string) => tx(admin, async (q) =>
  Number((await one(q, `SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM fin.journal_lines l
     JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
    WHERE a.company_id = $1 AND a.code = $2`, [co, code])).b));
const b64 = (text: string) => Buffer.from(text).toString('base64');
const taskFor = async (ctx: Ctx, entityId: string) => (await tx(ctx, (q) => wf.inbox(q, ctx))).find((x: any) => x.entity_id === entityId)?.task_id;

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  co = s.units.uae;
  admin = s.adminCtx;
  mgr = s.ctxOf(s.people.finMgr.userId);
  acct = s.ctxOf(s.people.accountant.userId);
  rep = s.ctxOf(s.people.salesRep.userId);
  await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: co, legalName: 'Acme UAE LLC', openFrom: '2026-01-01' }));
  // The finance manager reviews contracts, audits, verifies actions and approves purchases; the accountant documents, owns controls and works the desk.
  await giveRole(t.db, s, s.people.finMgr.userId, 'LEGAL_COUNSEL', { 'lgl.contract.approve': { amount: { lte: 500000 } }, 'lgl.contract.manage': {} }, s.units.root);
  await giveRole(t.db, s, s.people.finMgr.userId, 'AUDITOR', { 'grc.audit': {}, 'grc.action.verify': {}, 'grc.manage': {}, 'dms.read': {}, 'dms.confidential': {}, 'hse.manage': {} }, s.units.root);
  await giveRole(t.db, s, s.people.finMgr.userId, 'PROCUREMENT_MANAGER', { 'pur.order.approve': {} }, co);
  await giveRole(t.db, s, s.people.accountant.userId, 'OFFICE', { 'dms.manage': {}, 'dms.read': {}, 'lgl.contract.manage': {}, 'svc.agent': {}, 'qms.manage': {},
    'inv.manage': {}, 'mnt.manage': {}, 'fin.invoice.manage': {}, 'grc.manage': {}, 'fac.manage': {} }, s.units.root);
  await tx(admin, async (q) => {
    await mdm.createUom(q, admin, { code: 'EA', name: 'Each' });
    widget = (await mdm.createItem(q, admin, { code: 'WGT', name: 'Widget', itemType: 'stock', baseUom: 'EA' })).id;
    supplier = (await one(q, `INSERT INTO mdm.parties (tenant_id, code, name, normalized_name, is_supplier, country_code, currency_code, owner_unit_id, status)
      VALUES (app.tenant(), 'S-1', 'Gulf Parts', 'gulf parts', true, 'AE', 'AED', $1, 'active') RETURNING id`, [co])).id;
    main = (await inv.createWarehouse(q, admin, { companyId: co, code: 'MAIN', name: 'Main' })).id;
    await hr.createContract(q, admin, { employeeId: s.people.accountant.employeeId, companyId: co, startDate: '2024-01-01', basic: 9000 });
  });
});
after(async () => { await t.drop(); });

describe('documents', () => {
  it('keeps every version with its hash and guards confidential files', async () => {
    const doc = await tx(acct, (q) => dms.uploadDocument(q, acct, { unitId: s.units.finance, title: 'Board minutes', category: 'governance', confidential: true,
      fileName: 'minutes-v1.txt', contentType: 'text/plain', contentBase64: b64('first draft') }));
    const v2 = await tx(acct, (q) => dms.addVersion(q, acct, doc.id, { fileName: 'minutes-v2.txt', contentType: 'text/plain', contentBase64: b64('signed'), note: 'Signed copy' }));
    assert.equal(v2.current_version, 2);
    assert.equal(v2.versions.length, 2);
    // The accountant can file it but cannot read confidential documents; the finance manager can.
    await assert.rejects(tx(acct, (q) => dms.download(q, acct, doc.id)), ForbiddenError);
    const file = await tx(mgr, (q) => dms.download(q, mgr, doc.id, 1));
    assert.equal(file.content.toString(), 'first draft');
    assert.equal((await tx(acct, (q) => dms.listDocuments(q, acct))).length, 0);
    assert.equal((await tx(mgr, (q) => dms.listDocuments(q, mgr))).length, 1);
    await assert.rejects(tx(admin, (q) => q.query(`UPDATE dms.versions SET note = 'x'`)), /append-only/);
  });
});

describe('contracts', () => {
  let k: any;
  it('needs the document attached and someone else to approve', async () => {
    k = await tx(acct, (q) => lgl.createContract(q, acct, { companyId: co, title: 'Parts supply agreement', kind: 'purchase', partyId: supplier, value: 120000,
      startDate: '2026-01-01', endDate: '2026-06-30', autoRenew: true, renewalMonths: 12, noticeDays: 60 }));
    await assert.rejects(tx(acct, (q) => lgl.submitContract(q, acct, k.id)), /attach the contract document/);
    await tx(acct, (q) => dms.uploadDocument(q, acct, { unitId: co, title: 'Supply agreement (signed)', entityType: 'lgl.contract', entityId: k.id,
      fileName: 'supply.pdf', contentType: 'application/pdf', contentBase64: b64('%PDF-1.4 demo') }));
    const sub = await tx(acct, (q) => lgl.submitContract(q, acct, k.id));
    assert.equal(sub.status, 'pending_approval');
    assert.match(sub.no, /^CT-2026-\d{5}$/);
    await tx(mgr, async (q) => wf.act(q, mgr, (await taskFor(mgr, k.id))!, 'approve'));
    assert.equal((await tx(acct, (q) => lgl.getContract(q, acct, k.id))).status, 'active');
  });
  it('warns before the notice deadline and renews or expires contracts at their end', async () => {
    await tx(acct, (q) => lgl.addObligation(q, acct, k.id, { description: 'Quarterly price review', dueDate: '2026-04-15' }));
    const al = await tx(acct, (q) => lgl.contractAlerts(q, acct, co, '2026-04-10'));
    assert.equal(al.notice[0].noticeBy, '2026-05-01');   // 60 days before 30 June
    assert.equal(al.obligations.length, 1);
    const nda = await tx(acct, (q) => lgl.createContract(q, acct, { companyId: co, title: 'NDA', kind: 'nda', partyId: supplier, startDate: '2026-01-01', endDate: '2026-03-31' }));
    await tx(admin, (q) => q.query(`UPDATE lgl.contracts SET status = 'active', no = 'CT-TEST' WHERE id = $1`, [nda.id]));
    const r = await tx(acct, (q) => lgl.runRenewals(q, acct, co, '2026-07-02'));
    assert.deepEqual(r.expired, ['CT-TEST']);
    assert.equal(r.renewed.length, 1);
    assert.equal((await tx(acct, (q) => lgl.getContract(q, acct, k.id))).end_date.toISOString().slice(0, 10), '2027-06-30');
  });
});

describe('risk, audit and actions', () => {
  let risk: any, ctl: any, eng: any;
  it('scores risk, keeps testers independent and raises a finding and action when a control fails', async () => {
    risk = await tx(mgr, (q) => grc.createRisk(q, mgr, { unitId: s.units.finance, code: 'R-FIN-01', title: 'Payments to fictitious suppliers', category: 'financial',
      likelihood: 4, impact: 5, ownerEmployeeId: s.people.finMgr.employeeId, appetite: 10 }));
    ctl = await tx(mgr, (q) => grc.addControl(q, mgr, risk.id, { code: 'C-AP-01', title: 'New suppliers approved by a second person', ownerEmployeeId: s.people.accountant.employeeId }));
    await assert.rejects(tx(acct, (q) => grc.testControl(q, acct, ctl.id, { testedOn: '2026-03-01', result: 'effective' })), ForbiddenError);
    eng = await tx(mgr, (q) => grc.createEngagement(q, mgr, { unitId: s.units.finance, title: 'Payables audit Q1', periodFrom: '2026-01-01', periodTo: '2026-03-31' }));
    eng = await tx(mgr, (q) => grc.advanceEngagement(q, mgr, eng.id));
    const r = await tx(mgr, (q) => grc.testControl(q, mgr, ctl.id, { testedOn: '2026-04-05', result: 'ineffective', sampleSize: 25, exceptions: 3,
      notes: '3 of 25 suppliers activated by their requester', engagementId: eng.id }));
    assert.equal(r.finding.title, 'Control C-AP-01 not effective');
    assert.equal(r.action.owner_employee_id, s.people.accountant.employeeId);
    const reg = await tx(mgr, (q) => grc.riskRegister(q, mgr));
    const x = reg.risks.find((y: any) => y.code === 'R-FIN-01');
    assert.deepEqual([x.inherent, x.residual, x.overAppetite], [20, 20, true]);
  });
  it('closes findings only through verified actions, by someone other than the doer', async () => {
    await tx(mgr, (q) => grc.advanceEngagement(q, mgr, eng.id));   // reporting
    await assert.rejects(tx(mgr, (q) => grc.advanceEngagement(q, mgr, eng.id, { opinion: 'needs_improvement' })), /management response/);
    const e = await tx(mgr, (q) => grc.getEngagement(q, mgr, eng.id));
    await tx(acct, (q) => grc.respondToFinding(q, acct, e.findings[0].id, { response: 'Agreed. Workflow now blocks self-approval.', actions: [] }).catch(() => null));
    await tx(acct, (q) => grc.respondToFinding(q, acct, e.findings[0].id, { response: 'Agreed. Workflow now blocks self-approval.',
      actions: [{ title: 'Review all suppliers activated this year', ownerEmployeeId: s.people.accountant.employeeId, dueDate: '2026-05-31' }] }));
    const acts = (await tx(acct, (q) => grc.listActions(q, acct, { mine: true }))).filter((a: any) => a.status === 'open');
    assert.equal(acts.length, 2);
    for (const a of acts) await tx(acct, (q) => grc.completeAction(q, acct, a.id, { note: 'Done and evidenced', date: '2026-05-20' }));
    await assert.rejects(tx(acct, (q) => grc.verifyAction(q, acct, acts[0].id, { date: '2026-05-21', accepted: true })), ForbiddenError);
    for (const a of acts) await tx(mgr, (q) => grc.verifyAction(q, mgr, a.id, { date: '2026-05-21', accepted: true }));
    const done = await tx(mgr, (q) => grc.getEngagement(q, mgr, eng.id));
    assert.equal(done.findings[0].status, 'closed');
    const closed = await tx(mgr, (q) => grc.advanceEngagement(q, mgr, eng.id, { opinion: 'needs_improvement' }));
    assert.equal(closed.status, 'closed');
    // A later effective test brings the residual score down.
    await tx(mgr, (q) => grc.testControl(q, mgr, ctl.id, { testedOn: '2026-06-01', result: 'effective', sampleSize: 25, exceptions: 0 }));
    const x = (await tx(mgr, (q) => grc.riskRegister(q, mgr))).risks.find((y: any) => y.code === 'R-FIN-01');
    assert.deepEqual([x.residual, x.overAppetite], [15, true]);
  });
  it('rolls recurring compliance obligations forward', async () => {
    const o = await tx(mgr, (q) => grc.addObligation(q, mgr, { unitId: co, regulation: 'UAE VAT (Federal Decree-Law 8/2017)', requirement: 'File the VAT 201 return',
      frequency: 'quarterly', nextDue: '2026-04-28' }));
    const cal = await tx(mgr, (q) => grc.complianceCalendar(q, mgr, '2026-05-01'));
    assert.equal(cal.find((c: any) => c.id === o.id).overdue, true);
    const met = await tx(mgr, (q) => grc.meetObligation(q, mgr, o.id, '2026-04-27'));
    assert.equal(met.next_due.toISOString().slice(0, 10), '2026-07-28');
  });
});

describe('service desk', () => {
  it('runs SLA clocks, hands asset repairs to maintenance and closes with the requester', async () => {
    const printer = await tx(admin, (q) => assets.registerAsset(q, admin, { companyId: co, code: 'FA-PRN', name: 'Office printer', category: 'IT', acquisitionDate: '2025-01-01',
      usefulLifeMonths: 36, cost: 6000, unitId: s.units.sales }));
    const t0 = new Date('2026-05-04T08:00:00Z');
    const tk = await tx(rep, (q) => svc.createTicket(q, rep, { queue: 'it', category: 'printer', priority: 2, title: 'Printer jams', description: 'Every page jams', assetId: printer.id, now: t0 }));
    assert.match(tk.no, /^TKT-2026-00001$/);
    await assert.rejects(tx(rep, (q) => svc.addComment(q, rep, tk.id, { body: 'x', internal: true })), /only agents/);
    await tx(acct, (q) => svc.assignTicket(q, acct, tk.id, {}));
    await tx(acct, (q) => svc.addComment(q, acct, tk.id, { body: 'Looking at it', now: new Date('2026-05-04T13:00:00Z') }));   // 5 h: response SLA (4 h) missed
    const w = await tx(acct, (q) => svc.raiseMaintenance(q, acct, tk.id, { scheduledDate: '2026-05-04' }));
    assert.equal(w.kind, 'breakdown');
    await assert.rejects(tx(acct, (q) => svc.setTicketStatus(q, acct, tk.id, { status: 'resolved', resolution: 'Fixed' })), /still open/);
    await tx(acct, (q) => mnt.completeWorkOrder(q, acct, w.id, { date: '2026-05-04', resolution: 'Roller replaced' }));
    await tx(acct, (q) => svc.setTicketStatus(q, acct, tk.id, { status: 'resolved', resolution: 'Roller replaced', now: new Date('2026-05-04T15:00:00Z') }));
    await assert.rejects(tx(acct, (q) => svc.confirmTicket(q, acct, tk.id, { accepted: true })), ForbiddenError);
    await tx(rep, (q) => svc.confirmTicket(q, rep, tk.id, { accepted: true, satisfaction: 4 }));
    const got = await tx(rep, (q) => svc.getTicket(q, rep, tk.id, new Date('2026-05-05T00:00:00Z')));
    assert.deepEqual([got.status, got.response_breached, got.resolution_breached], ['closed', true, false]);
    // The requester sees only their own tickets; the agent sees the queue.
    assert.equal((await tx(rep, (q) => svc.listTickets(q, rep))).length, 1);
    await tx(admin, (q) => svc.createTicket(q, admin, { queue: 'facilities', category: 'aircon', priority: 3, title: 'Too warm', description: 'Meeting room 2' }));
    assert.equal((await tx(rep, (q) => svc.listTickets(q, rep))).length, 1);
  });
});

describe('quality', () => {
  it('turns rejects at goods receipt into an NCR and returns them to the supplier against the bill', async () => {
    let po = await tx(admin, (q) => pur.createOrder(q, admin, { companyId: co, supplierId: supplier, date: '2026-03-01', warehouseId: main,
      lines: [{ itemId: widget, description: 'Widgets', quantity: 100, unitPrice: 10, taxCode: 'SR' }] }));
    await tx(admin, (q) => pur.submitOrder(q, admin, po.id));
    await tx(mgr, async (q) => wf.act(q, mgr, (await taskFor(mgr, po.id))!, 'approve'));
    po = await tx(admin, (q) => pur.getOrder(q, admin, po.id));
    const grn = await tx(admin, (q) => pur.receive(q, admin, po.id, { date: '2026-03-05', lines: [{ orderLineId: po.lines[0].id, quantity: 100 }] }));
    const bill = await tx(admin, (q) => pur.billOrder(q, admin, po.id, { date: '2026-03-06', supplierRef: 'GP-77' }));
    await tx(admin, (q) => docs.postInvoice(q, admin, bill.id));
    const r = await tx(acct, (q) => qms.inspect(q, acct, { companyId: co, sourceType: 'pur.receipt', sourceId: grn.id, itemId: widget, warehouseId: main,
      inspectedOn: '2026-03-06', qtyInspected: 20, qtyRejected: 4, notes: 'Cracked housings' }));
    assert.equal(r.inspection.result, 'fail');
    assert.equal(r.ncr.severity, 'major');                 // 20% rejected
    assert.equal(r.ncr.supplier_id, supplier);
    const n = await tx(acct, (q) => qms.dispositionNcr(q, acct, r.ncr.id, { disposition: 'return_to_supplier', rootCause: 'Moulding defect at supplier', date: '2026-03-07',
      actions: [{ title: 'Supplier to send 8D report', ownerEmployeeId: s.people.accountant.employeeId, dueDate: '2026-04-07' }] }));
    assert.equal(n.status, 'dispositioned');
    assert.equal(Number(n.creditNote.net_total), 40);
    assert.equal(await balance('5070'), 40);                // written off, until the claim is posted
    await tx(admin, (q) => docs.postInvoice(q, admin, n.creditNote.id));
    assert.equal(await balance('5070'), 0);
    assert.equal((await tx(admin, (q) => inv.valuation(q, admin, co))).difference, 0);
    await assert.rejects(tx(acct, (q) => qms.closeNcr(q, acct, r.ncr.id)), /not verified/);
    const sq = await tx(acct, (q) => qms.supplierQuality(q, acct, co, '2026-01-01', '2026-12-31'));
    assert.deepEqual([sq[0].rejectionPct, sq[0].ncrs], [20, 1]);
  });
});

describe('health and safety', () => {
  it('lets anyone report, and closes only investigated incidents with verified actions', async () => {
    const inc = await tx(rep, (q) => hse.reportIncident(q, rep, { unitId: s.units.sales, occurredAt: '2026-04-02T07:30:00Z', kind: 'injury', severity: 'serious',
      location: 'Warehouse loading bay', description: 'Hand caught in pallet jack', employeeId: s.people.salesRep.employeeId, lostDays: 3 }));
    assert.match(inc.no, /^INC-2026-\d{5}$/);
    await tx(rep, (q) => hse.reportIncident(q, rep, { unitId: s.units.sales, occurredAt: '2026-04-10T10:00:00Z', kind: 'near_miss', severity: 'minor', location: 'Yard', description: 'Forklift reversed without spotter' }));
    await assert.rejects(tx(mgr, (q) => hse.closeIncident(q, mgr, inc.id, '2026-04-05')), /root cause/);
    await tx(mgr, (q) => hse.investigate(q, mgr, inc.id, { rootCause: 'No guard on the jack handle',
      actions: [{ title: 'Fit guards to all pallet jacks', ownerEmployeeId: s.people.accountant.employeeId, dueDate: '2026-04-30' }] }));
    await assert.rejects(tx(mgr, (q) => hse.closeIncident(q, mgr, inc.id, '2026-04-05')), /not verified/);
    const a = (await tx(acct, (q) => grc.listActions(q, acct, { mine: true }))).find((x: any) => x.source_id === inc.id);
    await tx(acct, (q) => grc.completeAction(q, acct, a.id, { note: 'Guards fitted', date: '2026-04-20' }));
    await tx(mgr, (q) => grc.verifyAction(q, mgr, a.id, { date: '2026-04-21', accepted: true }));
    assert.equal((await tx(mgr, (q) => hse.closeIncident(q, mgr, inc.id, '2026-04-21'))).status, 'closed');
    const st = await tx(mgr, (q) => hse.safetyStats(q, mgr, s.units.root, '2026-04-01', '2026-04-30', 200000));
    assert.deepEqual([st.incidents, st.near_misses, st.lost_time_injuries, st.lost_days, st.ltifr], [2, 1, 1, 3, 5]);
    assert.equal(st.daysSinceLastLti, 28);
  });
});

describe('facilities', () => {
  it('books spaces without double bookings or overfilling', async () => {
    const room = await tx(acct, (q) => fac.createSpace(q, acct, { unitId: s.units.dubai, code: 'DXB-MR1', name: 'Meeting room 1', kind: 'meeting_room', capacity: 6 }));
    await tx(rep, (q) => fac.book(q, rep, { spaceId: room.id, startsAt: '2026-05-10T06:00:00Z', endsAt: '2026-05-10T07:00:00Z', purpose: 'Client call', attendees: 4 }));
    await assert.rejects(tx(admin, (q) => fac.book(q, admin, { spaceId: room.id, startsAt: '2026-05-10T06:30:00Z', endsAt: '2026-05-10T08:00:00Z', purpose: 'x' })), /already booked by/);
    await assert.rejects(tx(admin, (q) => fac.book(q, admin, { spaceId: room.id, startsAt: '2026-05-10T08:00:00Z', endsAt: '2026-05-10T09:00:00Z', purpose: 'x', attendees: 9 })), /holds 6/);
    const b = await tx(admin, (q) => fac.book(q, admin, { spaceId: room.id, startsAt: '2026-05-10T07:00:00Z', endsAt: '2026-05-10T08:00:00Z', purpose: 'Team meeting' }));
    await assert.rejects(tx(rep, (q) => fac.cancelBooking(q, rep, b.id)), ForbiddenError);
    assert.equal((await tx(rep, (q) => fac.bookings(q, '2026-05-10'))).length, 2);
    const u = await tx(acct, (q) => fac.utilisation(q, acct, s.units.dubai, '2026-05-10', '2026-05-10'));
    assert.equal(u[0].booked_hours, 2);
  });
});

describe('Phase 4 books and API', () => {
  it('keep the books balanced', async () => {
    assert.equal((await tx(admin, (q) => reports.trialBalance(q, admin, co, '2026-12-31'))).balanced, true);
  });
  it('serves documents, contracts, GRC, the desk, quality, safety and facilities', async () => {
    const app = buildServer({ db: t.db, platformAdminKey: 'k' });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `finmgr@${s.code}.test`, password: PASSWORD } });
    const h = { authorization: `Bearer ${login.json().token}` };
    for (const url of ['/v1/dms/documents', `/v1/lgl/companies/${co}/contracts`, '/v1/grc/risks', '/v1/grc/engagements', '/v1/grc/actions', '/v1/svc/tickets',
      '/v1/hse/incidents', `/v1/hse/units/${s.units.root}/stats?from=2026-01-01&to=2026-12-31`, '/v1/fac/spaces', '/v1/fac/bookings?date=2026-05-10']) {
      const r = await app.inject({ method: 'GET', url, headers: h });
      assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
    }
    const up = await app.inject({ method: 'POST', url: '/v1/dms/documents', headers: h, payload: { unitId: co, title: 'Policy', fileName: 'p.txt', contentBase64: b64('hello') } });
    assert.equal(up.statusCode, 403);   // read-only on documents
    const doc = (await app.inject({ method: 'GET', url: '/v1/dms/documents', headers: h })).json()[0];
    const raw = await app.inject({ method: 'GET', url: `/v1/dms/documents/${doc.id}/content`, headers: h });
    assert.equal(raw.statusCode, 200);
    assert.ok(raw.headers['x-content-sha256']);
    const tk = await app.inject({ method: 'POST', url: '/v1/svc/tickets', headers: h, payload: { queue: 'it', category: 'laptop', priority: 5, title: 'x', description: 'y' } });
    assert.equal(tk.statusCode, 400);
    await app.close();
  });
});
