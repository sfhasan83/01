import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { one, type Ctx } from '../src/core/db.ts';
import * as setup from '../src/fin/setup.ts';
import * as docs from '../src/fin/documents.ts';
import * as reports from '../src/fin/reports.ts';
import * as assets from '../src/fin/assets.ts';
import * as tax from '../src/fin/tax.ts';
import * as mdm from '../src/mdm/service.ts';
import * as inv from '../src/inv/service.ts';
import * as hr from '../src/hr/service.ts';
import * as prj from '../src/prj/service.ts';
import * as mfg from '../src/mfg/service.ts';
import * as mnt from '../src/mnt/service.ts';
import * as flt from '../src/flt/service.ts';
import { buildServer } from '../src/api/server.ts';
import { createTestDb, giveRole, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

let t: TestDb;
let s: Seed;
let co: string;
let admin: Ctx, manager: Ctx, rep: Ctx, accountant: Ctx;
let customer: string, supplier: string, main: string;

const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);
const balance = (code: string) => tx(admin, async (q) =>
  Number((await one(q, `SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM fin.journal_lines l
     JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
    WHERE a.company_id = $1 AND a.code = $2`, [co, code])).b));
const item = (code: string, name: string) => tx(admin, async (q) => (await mdm.createItem(q, admin, { code, name, itemType: 'stock', baseUom: 'EA' })).id as string);

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  co = s.units.uae;
  admin = s.adminCtx;
  manager = s.ctxOf(s.people.finMgr.userId);
  rep = s.ctxOf(s.people.salesRep.userId);
  accountant = s.ctxOf(s.people.accountant.userId);
  await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: co, legalName: 'Acme UAE LLC', openFrom: '2026-01-01' }));
  await giveRole(t.db, s, s.people.finMgr.userId, 'PROJECT_MANAGER', { 'prj.manage': {}, 'prj.time.approve': {} }, co);
  await giveRole(t.db, s, s.people.accountant.userId, 'OPERATIONS', {
    'prj.manage': {}, 'prj.time.approve': {}, 'mfg.manage': {}, 'mfg.produce': {}, 'mnt.manage': {}, 'flt.manage': {}, 'fin.report.read': {},
  }, co);
  await tx(admin, async (q) => {
    await mdm.createUom(q, admin, { code: 'EA', name: 'Each' });
    const party = (code: string, name: string, cust: boolean) => one(q, `INSERT INTO mdm.parties (tenant_id, code, name, normalized_name, is_customer, is_supplier,
        country_code, currency_code, owner_unit_id, status) VALUES (app.tenant(), $1, $2, lower($2), $3, $4, 'AE', 'AED', $5, 'active') RETURNING id`, [code, name, cust, !cust, co]);
    customer = (await party('C-1', 'Emirates Builders', true)).id;
    supplier = (await party('S-1', 'Dubai Subcontracting', false)).id;
    main = (await inv.createWarehouse(q, admin, { companyId: co, code: 'MAIN', name: 'Main warehouse' })).id;
    // Monthly gross 15,000 -> 62.50 an hour; 6,000 -> 25.00 an hour.
    await hr.createContract(q, admin, { employeeId: s.people.accountant.employeeId, companyId: co, startDate: '2020-01-01', basic: 10000, housing: 4000, transport: 1000 });
    await hr.createContract(q, admin, { employeeId: s.people.salesRep.employeeId, companyId: co, startDate: '2025-01-01', basic: 6000 });
  });
});
after(async () => { await t.drop(); });

describe('projects', () => {
  let p: any;
  it('logs time for team members only, within the day and the project dates', async () => {
    p = await tx(manager, (q) => prj.createProject(q, manager, { companyId: co, code: 'P-100', name: 'Tower fit-out', customerId: customer,
      billing: 'time_material', budgetCost: 1500, budgetHours: 40, defaultBillRate: 200, startDate: '2026-01-01', unitId: s.units.dubai }));
    await tx(manager, (q) => prj.addMember(q, manager, p.id, { employeeId: s.people.accountant.employeeId, role: 'Engineer', billRate: 300 }));
    // The rep is not on the team yet, and has no project rights: they may only log their own time.
    await assert.rejects(tx(rep, (q) => prj.logTime(q, rep, { projectId: p.id, employeeId: s.people.salesRep.employeeId, date: '2026-02-02', hours: 4, description: 'Site survey' })), /not on the project team/);
    await tx(manager, (q) => prj.addMember(q, manager, p.id, { employeeId: s.people.salesRep.employeeId }));
    await tx(rep, (q) => prj.logTime(q, rep, { projectId: p.id, employeeId: s.people.salesRep.employeeId, date: '2026-02-02', hours: 4, description: 'Site survey' }));
    await assert.rejects(tx(rep, (q) => prj.logTime(q, rep, { projectId: p.id, employeeId: s.people.accountant.employeeId, date: '2026-02-02', hours: 1, description: 'x' })), /permission|not allowed|forbidden/i);
    await tx(manager, (q) => prj.logTime(q, manager, { projectId: p.id, employeeId: s.people.accountant.employeeId, date: '2026-02-03', hours: 8, description: 'Design' }));
    await assert.rejects(tx(manager, (q) => prj.logTime(q, manager, { projectId: p.id, employeeId: s.people.accountant.employeeId, date: '2026-02-03', hours: 17, description: 'x' })), /25 hours/);
    await assert.rejects(tx(manager, (q) => prj.logTime(q, manager, { projectId: p.id, employeeId: s.people.accountant.employeeId, date: '2025-12-31', hours: 1, description: 'x' })), /outside the project dates/);
  });
  it('costs approved time from the contract and moves it from salaries onto the project', async () => {
    const list = await tx(manager, (q) => prj.listTimesheets(q, manager, co, { projectId: p.id, status: 'submitted' }));
    assert.equal(list.length, 2);
    const own = list.find((x: any) => x.employee_id === s.people.accountant.employeeId);
    await assert.rejects(tx(accountant, (q) => prj.approveTimesheets(q, accountant, [own.id])), /your own time/);
    const r = await tx(manager, (q) => prj.approveTimesheets(q, manager, list.map((x: any) => x.id)));
    assert.equal(r.approved, 2);
    assert.equal(await balance('5015'), 600);     // 8 x 62.50 + 4 x 25.00
    assert.equal(await balance('5000'), -600);
    await assert.rejects(tx(manager, (q) => prj.approveTimesheets(q, manager, [own.id])), /already approved/);
  });
  it('collects purchases on the project and bills hours at the team rates', async () => {
    const bill = await tx(admin, (q) => docs.createInvoice(q, admin, { companyId: co, kind: 'purchase_invoice', partyId: supplier, date: '2026-02-10', supplierRef: 'DS-1',
      lines: [{ description: 'Scaffolding', quantity: 1, unitPrice: 1000, taxCode: 'SR', account: '5020', projectId: p.id }] }));
    await tx(admin, (q) => docs.postInvoice(q, admin, bill.id));
    const draft = await tx(admin, (q) => prj.invoiceProject(q, admin, p.id, { date: '2026-02-28' }));
    assert.equal(Number(draft.net_total), 3200);   // 8 x 300 + 4 x 200 (project default)
    // Deleting the draft frees the hours to be billed again.
    await tx(admin, (q) => docs.deleteDraft(q, admin, draft.id));
    const again = await tx(admin, (q) => prj.invoiceProject(q, admin, p.id, { date: '2026-02-28' }));
    assert.equal(Number(again.net_total), 3200);
    await tx(admin, (q) => docs.postInvoice(q, admin, again.id));
    await assert.rejects(tx(admin, (q) => prj.invoiceProject(q, admin, p.id, { date: '2026-03-01' })), /nothing to invoice/);
    const st = await tx(manager, (q) => prj.projectStatus(q, manager, p.id));
    assert.equal(st.revenue, 3200);
    assert.equal(st.cost, 1600);
    assert.equal(st.margin, 1600);
    assert.equal(st.overBudget, true);
    assert.equal(st.hours.approved, 12);
    assert.equal(st.unbilled, 0);
  });
  it('bills fixed price projects by milestone, within the contract value', async () => {
    const fp = await tx(manager, (q) => prj.createProject(q, manager, { companyId: co, code: 'P-200', name: 'ERP rollout', customerId: customer,
      billing: 'fixed_price', contractValue: 10000, startDate: '2026-01-01' }));
    const m1 = await tx(manager, (q) => prj.addMilestone(q, manager, fp.id, { name: 'Design signed off', amount: 4000 }));
    await tx(manager, (q) => prj.addMilestone(q, manager, fp.id, { name: 'Go-live', amount: 6000 }));
    await assert.rejects(tx(manager, (q) => prj.addMilestone(q, manager, fp.id, { name: 'Extra', amount: 1 })), /contract value/);
    await assert.rejects(tx(admin, (q) => prj.invoiceProject(q, admin, fp.id, { date: '2026-02-28' })), /nothing to invoice/);
    await tx(manager, (q) => prj.reachMilestone(q, manager, m1.id, '2026-02-20'));
    const i = await tx(admin, (q) => prj.invoiceProject(q, admin, fp.id, { date: '2026-02-28' }));
    assert.equal(Number(i.net_total), 4000);
    assert.equal(Number(i.tax_total), 200);
    await assert.rejects(tx(manager, (q) => prj.createProject(q, manager, { companyId: co, code: 'P-300', name: 'x', startDate: '2026-01-01' })), /needs a customer/);
  });
});

describe('manufacturing', () => {
  let chair: string, frame: string, wood: string, screw: string, wc: string;
  it('keeps bills of materials free of cycles and rolls up a standard cost', async () => {
    [chair, frame, wood, screw] = [await item('CHAIR', 'Office chair'), await item('FRAME', 'Chair frame'), await item('WOOD', 'Beech plank'), await item('SCREW', 'Screw M6')];
    await tx(admin, (q) => inv.openingStock(q, admin, { companyId: co, warehouseId: main, date: '2026-01-01',
      lines: [{ itemId: wood, qty: 100, unitCost: 5 }, { itemId: screw, qty: 1000, unitCost: 0.1 }] }));
    wc = (await tx(accountant, (q) => mfg.createWorkCenter(q, accountant, { companyId: co, code: 'ASM', name: 'Assembly', hourlyRate: 60 }))).id;
    await tx(accountant, (q) => mfg.createBom(q, accountant, { companyId: co, itemId: frame, code: 'BOM-FRAME',
      lines: [{ itemId: wood, qty: 4 }, { itemId: screw, qty: 10 }], operations: [{ seq: 10, name: 'Join frame', workCenterId: wc, runMinutes: 30 }] }));
    await tx(accountant, (q) => mfg.createBom(q, accountant, { companyId: co, itemId: chair, code: 'BOM-CHAIR',
      lines: [{ itemId: frame, qty: 1 }, { itemId: wood, qty: 2 }, { itemId: screw, qty: 8 }],
      operations: [{ seq: 10, name: 'Assemble', workCenterId: wc, setupMinutes: 30, runMinutes: 15 }] }));
    await assert.rejects(tx(accountant, (q) => mfg.createBom(q, accountant, { companyId: co, itemId: wood, code: 'BOM-BAD', lines: [{ itemId: chair, qty: 1 }] })), /made from itself/);
    const cost = await tx(accountant, (q) => mfg.costRollup(q, accountant, co, chair));
    // frame 4 x 5 + 10 x 0.10 + 30 min at 60/h = 51; chair 51 + 2 x 5 + 8 x 0.10 = 61.80 material, (30 + 15) min = 45 conversion
    assert.deepEqual(cost, { material: 61.8, conversion: 45, total: 106.8 });
  });
  it('plans what to make and buy through the BOM levels', async () => {
    await tx(admin, (q) => mfg.setReorderRule(q, admin, { companyId: co, warehouseId: main, itemId: chair, minQty: 10 }));
    await tx(admin, (q) => mfg.setReorderRule(q, admin, { companyId: co, warehouseId: main, itemId: wood, minQty: 50, reorderQty: 40 }));
    const plan = await tx(accountant, (q) => mfg.runMrp(q, accountant, co));
    const by = (id: string) => plan.find((r) => r.itemId === id)!;
    assert.deepEqual([by(chair).action, by(chair).suggestedQty, by(chair).level], ['make', 10, 0]);
    assert.deepEqual([by(frame).action, by(frame).suggestedQty, by(frame).level], ['make', 10, 1]);
    // wood: 10 chairs x 2 + 10 frames x 4 + minimum 50 = 110 against 100 on hand: short 10, ordered in lots of 40.
    assert.deepEqual([by(wood).shortage, by(wood).action, by(wood).suggestedQty], [10, 'buy', 40]);
    assert.equal(by(screw).action, null);
  });
  it('costs a work order with materials, backflush and routing, and empties WIP into stock', async () => {
    let wo = await tx(accountant, (q) => mfg.createWorkOrder(q, accountant, { companyId: co, itemId: frame, qty: 10, warehouseId: main, date: '2026-02-01' }));
    await assert.rejects(tx(accountant, (q) => mfg.issueMaterials(q, accountant, wo.id, { date: '2026-02-01' })), /released/);
    wo = await tx(accountant, (q) => mfg.releaseWorkOrder(q, accountant, wo.id));
    assert.equal(Number(wo.materials.find((m: any) => m.item_id === wood).required_qty), 40);
    await tx(accountant, (q) => mfg.issueMaterials(q, accountant, wo.id, { date: '2026-02-01', lines: [{ itemId: wood, qty: 40 }] }));
    assert.equal(await balance('1350'), 200);
    await assert.rejects(tx(accountant, (q) => mfg.cancelWorkOrder(q, accountant, wo.id)), /materials were issued/);
    const done = await tx(accountant, (q) => mfg.completeWorkOrder(q, accountant, wo.id, { date: '2026-02-02', operations: [{ seq: 10, minutes: 330 }] }));
    assert.equal(Number(done.material_cost), 210);     // 200 wood + 100 screws backflushed at 0.10
    assert.equal(Number(done.conversion_cost), 330);
    assert.equal(done.unit_cost, 54);
    assert.equal(await balance('1350'), 0);
    assert.equal(await balance('5060'), -330);

    let chairs = await tx(accountant, (q) => mfg.createWorkOrder(q, accountant, { companyId: co, itemId: chair, qty: 5, warehouseId: main, date: '2026-02-03' }));
    chairs = await tx(accountant, (q) => mfg.releaseWorkOrder(q, accountant, chairs.id));
    // Only 4 good chairs: materials are backflushed for 4 and the routing absorbed for 80% of its planned time.
    const made = await tx(accountant, (q) => mfg.completeWorkOrder(q, accountant, chairs.id, { date: '2026-02-04', qty: 4 }));
    assert.equal(Number(made.material_cost), 259.2);   // 4 frames x 54 + 8 wood x 5 + 32 screws x 0.10
    assert.equal(Number(made.conversion_cost), 84);    // (30 + 5 x 15) min x 0.8 at 60/h
    assert.equal(made.unit_cost, 85.8);
    const stock = await tx(admin, (q) => inv.stockLevels(q, admin, co, main));
    assert.equal(Number(stock.find((r: any) => r.item_id === chair).qty), 4);
    assert.equal(Number(stock.find((r: any) => r.item_id === frame).qty), 6);
    const v = await tx(admin, (q) => inv.valuation(q, admin, co));
    assert.equal(v.difference, 0);
  });
});

describe('fleet and maintenance', () => {
  let van: any, gen: any, filter: string;
  it('posts fuel with its VAT and keeps the odometer moving forward', async () => {
    filter = await item('FILTER', 'Oil filter');
    await tx(admin, (q) => inv.openingStock(q, admin, { companyId: co, warehouseId: main, date: '2026-01-01', lines: [{ itemId: filter, qty: 10, unitCost: 20 }] }));
    gen = await tx(admin, (q) => assets.registerAsset(q, admin, { companyId: co, code: 'FA-GEN', name: 'Generator', category: 'Plant', acquisitionDate: '2025-06-01',
      usefulLifeMonths: 60, cost: 30000, openingAccumulated: 3000, unitId: s.units.dubai }));
    van = await tx(accountant, (q) => flt.createVehicle(q, accountant, { companyId: co, code: 'V-01', plateNo: 'dxb a 12345', make: 'Toyota', model: 'Hiace',
      fuelType: 'diesel', odometer: 20000, unitId: s.units.sales, driverEmployeeId: s.people.salesRep.employeeId,
      registrationExpiry: '2026-09-30', insuranceExpiry: '2026-03-10' }));
    assert.equal(van.plate_no, 'DXB A 12345');
    await tx(accountant, (q) => flt.logFuel(q, accountant, { vehicleId: van.id, date: '2026-02-10', odometer: 29600, litres: 50, amount: 105, vatAmount: 5, station: 'ENOC' }));
    assert.equal(await balance('5610'), 100);
    assert.equal(await balance('1200'), 5 + 50);  // fuel VAT + scaffolding bill VAT from the project test
    await assert.rejects(tx(accountant, (q) => flt.logFuel(q, accountant, { vehicleId: van.id, date: '2026-02-11', odometer: 29000, litres: 10, amount: 21 })), /below the last fill-up/);
    await assert.rejects(tx(accountant, (q) => flt.logFuel(q, accountant, { vehicleId: van.id, date: '2026-02-11', odometer: 29700, litres: 10, amount: 21, vatAmount: 5 })), /more than 5%/);
    await assert.rejects(tx(accountant, (q) => flt.logTrip(q, accountant, { vehicleId: van.id, date: '2026-02-12', startKm: 29600, endKm: 29500, purpose: 'x' })), /higher odometer/);
    await tx(accountant, (q) => flt.logTrip(q, accountant, { vehicleId: van.id, date: '2026-02-12', endKm: 30100, purpose: 'Site deliveries' }));
    await tx(accountant, (q) => flt.logFuel(q, accountant, { vehicleId: van.id, date: '2026-02-13', odometer: 30100, litres: 40, amount: 84, vatAmount: 4 }));
    const sum = await tx(accountant, (q) => flt.vehicleSummary(q, accountant, van.id));
    assert.equal(Number(sum.vehicle.odometer), 30100);
    assert.equal(sum.litresPer100km, 8);   // 40 L over 500 km
    // Fuel VAT is reclaimed in the VAT return like a purchase invoice (box 9 also has the scaffolding bill).
    const vat = await tx(admin, (q) => tax.computeVatReturn(q, admin, co, '2026-02-01', '2026-02-28'));
    assert.deepEqual(vat.boxes['9'], { amount: 1000 + 100 + 80, vat: 50 + 5 + 4 });
  });
  it('raises preventive work by date and by distance, once per plan', async () => {
    await tx(accountant, (q) => mnt.createPlan(q, accountant, { companyId: co, assetId: gen.id, name: 'Generator service', intervalDays: 90, firstDueDate: '2026-03-01' }));
    await assert.rejects(tx(accountant, (q) => mnt.createPlan(q, accountant, { companyId: co, assetId: gen.id, name: 'x', intervalKm: 100 })), /for vehicles/);
    const vp = await tx(accountant, (q) => mnt.createPlan(q, accountant, { companyId: co, vehicleId: van.id, name: 'Oil change', intervalKm: 10000 }));
    assert.equal(Number(vp.last_done_km), 30100);
    // The van has 30,100 km: due at 40,100. The generator is due within the week.
    let due = await tx(accountant, (q) => mnt.duePlans(q, accountant, co, '2026-02-25'));
    assert.deepEqual(due.map((p: any) => p.name), ['Generator service']);
    await tx(accountant, (q) => flt.logTrip(q, accountant, { vehicleId: van.id, date: '2026-02-26', endKm: 39800, purpose: 'Long haul' }));
    due = await tx(accountant, (q) => mnt.duePlans(q, accountant, co, '2026-02-25'));
    assert.equal(due.length, 2);
    const made = await tx(accountant, (q) => mnt.generateDue(q, accountant, co, '2026-02-25'));
    assert.equal(made.length, 2);
    assert.equal((await tx(accountant, (q) => mnt.generateDue(q, accountant, co, '2026-02-25'))).length, 0);
    const alerts = await tx(accountant, (q) => flt.complianceAlerts(q, accountant, co, '2026-02-25'));
    assert.deepEqual(alerts.documents.map((d: any) => d.kind), ['insurance']);
    assert.equal(alerts.maintenance.length, 1);
  });
  it('charges spare parts to the asset cost center and rolls the plan forward', async () => {
    const orders = await tx(accountant, (q) => mnt.listWorkOrders(q, accountant, co, { status: 'open' }));
    const vanWo = orders.find((w: any) => w.vehicle_id === van.id);
    const genWo = orders.find((w: any) => w.asset_id === gen.id);
    assert.equal(genWo.unit_id, s.units.dubai);
    await tx(accountant, (q) => mnt.issueParts(q, accountant, vanWo.id, { warehouseId: main, date: '2026-02-27', lines: [{ itemId: filter, qty: 2 }] }));
    assert.equal(await balance('5250'), 40);
    await assert.rejects(tx(accountant, (q) => mnt.cancelWorkOrder(q, accountant, vanWo.id, 'x')), /parts were used/);
    await tx(accountant, (q) => mnt.completeWorkOrder(q, accountant, vanWo.id, { date: '2026-02-27', resolution: 'Oil and filter changed', odometer: 39850 }));
    await tx(accountant, (q) => mnt.completeWorkOrder(q, accountant, genWo.id, { date: '2026-03-02', resolution: 'Serviced', downtimeHours: 3 }));
    const plans = await tx(accountant, (q) => mnt.listPlans(q, accountant, co));
    const oil = plans.find((p: any) => p.name === 'Oil change');
    const gs = plans.find((p: any) => p.name === 'Generator service');
    assert.equal(Number(oil.next_due_km), 49850);
    assert.equal(gs.next_due_date.toISOString().slice(0, 10), '2026-05-31');
    const sum = await tx(accountant, (q) => flt.vehicleSummary(q, accountant, van.id));
    assert.equal(sum.maintenanceCost, 40);
  });
});

describe('Phase 3 books and API', () => {
  it('keep the books balanced and stock equal to the ledger', async () => {
    const tb = await tx(admin, (q) => reports.trialBalance(q, admin, co, '2026-12-31'));
    assert.equal(tb.balanced, true);
    assert.equal((await tx(admin, (q) => inv.valuation(q, admin, co))).difference, 0);
  });
  it('serves the projects, manufacturing, maintenance and fleet API', async () => {
    const app = buildServer({ db: t.db, platformAdminKey: 'k' });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `accountant@${s.code}.test`, password: PASSWORD } });
    const h = { authorization: `Bearer ${login.json().token}` };
    for (const url of [`/v1/prj/companies/${co}/projects`, `/v1/mfg/companies/${co}/mrp`, `/v1/mfg/companies/${co}/work-orders`,
      `/v1/flt/companies/${co}/vehicles`, `/v1/flt/companies/${co}/alerts?asOf=2026-02-25`, `/v1/mnt/companies/${co}/plans`, `/v1/mnt/companies/${co}/work-orders`]) {
      const r = await app.inject({ method: 'GET', url, headers: h });
      assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
    }
    const v = (await app.inject({ method: 'GET', url: `/v1/flt/companies/${co}/vehicles`, headers: h })).json()[0];
    const patched = await app.inject({ method: 'PATCH', url: `/v1/flt/vehicles/${v.id}`, headers: h, payload: { driverEmployeeId: null, insuranceExpiry: '2027-03-10' } });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json().driver_employee_id, null);
    const bad = await app.inject({ method: 'POST', url: `/v1/mfg/companies/${co}/boms`, headers: h, payload: { code: 'X', lines: [] } });
    assert.equal(bad.statusCode, 400);
    await app.close();
  });
});
