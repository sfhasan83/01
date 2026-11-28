import { many, one, type Ctx, type Db, type Tx } from '../core/db.ts';
import { AppError, NotFoundError, ValidationError } from '../core/errors.ts';
import { roundIn } from '../core/money.ts';
import { authorize } from '../iam/authz.ts';

/**
 * BAATS as a service: each customer organization (tenant) has a subscription to
 * a plan. The plan limits users and companies; the platform bills each month
 * for the plan and for users above what it includes. An ended trial, or a
 * subscription suspended for an unpaid invoice or by the operator, keeps the
 * data readable and exportable but stops changes.
 *
 * Tenant-side calls run inside the tenant's own transaction. Operator calls
 * (the platform administrator) go through every tenant, one transaction each.
 */

export class PaymentRequiredError extends AppError {
  constructor(message: string) { super(402, 'subscription_inactive', message); }
}

export interface Plan {
  code: string; name: string; monthly_price: number; currency: string; included_users: number; extra_user_price: number;
  max_users: number | null; max_companies: number | null; trial_days: number; billable: boolean; active: boolean;
}
const PLAN_COLS = `code, name, monthly_price::float AS monthly_price, currency, included_users, extra_user_price::float AS extra_user_price,
  max_users, max_companies, trial_days, billable, active`;

/** Days after an invoice's due date before the subscription is suspended. */
export const GRACE_DAYS = 14;
/** Days to pay a platform invoice. */
export const PAYMENT_DAYS = 14;

export async function plan(tx: Tx, code: string): Promise<Plan> {
  const p = await one<Plan>(tx, `SELECT ${PLAN_COLS} FROM platform.plans WHERE code = $1`, [code]);
  if (!p) throw new ValidationError(`there is no plan ${code}`);
  return p;
}

/** The subscription a new tenant starts with (inside the onboarding transaction). */
export async function startSubscription(tx: Tx, planCode: string, billingEmail?: string) {
  const p = await plan(tx, planCode);
  if (!p.active) throw new ValidationError(`the plan ${p.name} is not offered any more`);
  await tx.query(`INSERT INTO platform.subscriptions (tenant_id, plan_code, status, trial_ends_at, billing_email)
      VALUES (app.tenant(), $1, $2, CASE WHEN $3::int > 0 THEN now() + make_interval(days => $3::int) END, $4)`,
  [p.code, p.trial_days > 0 ? 'trial' : 'active', p.trial_days, billingEmail ?? null]);
}

export interface SubscriptionState {
  plan: Plan; status: string; statusReason: string | null; trialEndsAt: string | null; billingEmail: string | null;
  /** False when changes are stopped; reason says why. */
  writable: boolean; reason: string | null;
}

export async function subscriptionState(tx: Tx): Promise<SubscriptionState | null> {
  const s = await one(tx, 'SELECT * FROM platform.subscriptions');
  if (!s) return null;
  const p = await plan(tx, s.plan_code);
  let reason: string | null = null;
  if (s.status === 'trial' && new Date(s.trial_ends_at) <= new Date()) reason = `the free trial ended on ${new Date(s.trial_ends_at).toISOString().slice(0, 10)}; choose a plan to keep working`;
  else if (s.status === 'suspended') reason = s.status_reason === 'unpaid' ? 'the subscription is suspended because an invoice from BAATS is unpaid; once it is paid, work can go on' : 'the subscription is suspended; contact BAATS';
  else if (s.status === 'cancelled') reason = 'the subscription was cancelled; the data can still be read and exported';
  return { plan: p, status: s.status, statusReason: s.status_reason, trialEndsAt: s.trial_ends_at ? new Date(s.trial_ends_at).toISOString() : null,
    billingEmail: s.billing_email, writable: reason === null, reason };
}

/** Before adding or re-activating a user: is there a seat left on the plan? */
export async function checkSeat(tx: Tx): Promise<void> {
  const s = await subscriptionState(tx);
  if (!s || s.plan.max_users === null) return;
  const n = Number((await one(tx, `SELECT count(*) AS n FROM iam.users WHERE status = 'active'`)).n);
  if (n >= s.plan.max_users) throw new ValidationError(`the ${s.plan.name} plan allows ${s.plan.max_users} active users and ${n} are active; disable a user or move to a bigger plan`);
}

/** Before setting up books for another company. */
export async function checkCompanySlot(tx: Tx): Promise<void> {
  const s = await subscriptionState(tx);
  if (!s || s.plan.max_companies === null) return;
  const n = Number((await one(tx, 'SELECT count(*) AS n FROM fin.companies')).n);
  if (n >= s.plan.max_companies) throw new ValidationError(`the ${s.plan.name} plan allows ${s.plan.max_companies} ${s.plan.max_companies === 1 ? 'company' : 'companies'} with books; move to a bigger plan for more`);
}

const monthBounds = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return { from: `${period}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
};
const checkPeriod = (period: string) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new ValidationError('the month is written YYYY-MM, for example 2026-11');
  return period;
};

/** What a tenant uses: users and companies now, and documents in a month. */
export async function usage(tx: Tx, period = new Date().toISOString().slice(0, 7)) {
  const { from, to } = monthBounds(checkPeriod(period));
  const r = await one(tx, `SELECT
      (SELECT count(*) FROM iam.users WHERE status = 'active')::int AS users,
      (SELECT count(*) FROM fin.companies)::int AS companies,
      (SELECT count(*) FROM fin.invoices WHERE date BETWEEN $1 AND $2 AND status = 'posted')::int AS invoices,
      (SELECT count(*) FROM fin.journals WHERE date BETWEEN $1 AND $2 AND status = 'posted')::int AS journals,
      (SELECT count(DISTINCT user_id) FROM iam.sessions WHERE created_at >= $1::date AND created_at < $2::date + 1)::int AS users_signed_in,
      (SELECT coalesce(sum(size_bytes), 0) FROM dms.versions)::bigint AS document_bytes`, [from, to]);
  return { period, users: r.users, companies: r.companies, invoices: r.invoices, journals: r.journals, usersSignedIn: r.users_signed_in, documentBytes: Number(r.document_bytes) };
}

const INVOICE_COLS = `id, no, period, plan_code, users, companies, base_amount::float AS base_amount, extra_users, extra_amount::float AS extra_amount,
  total::float AS total, currency, status, issued_on, due_on, paid_at, payment_ref, created_at`;

/** The organization's own view: plan, state, usage this month and its invoices from BAATS. */
export async function mySubscription(tx: Tx, ctx: Ctx) {
  await authorize(tx, ctx, 'sys.subscription.read');
  const state = await subscriptionState(tx);
  if (!state) throw new NotFoundError('subscription');
  const plans = await many<Plan>(tx, `SELECT ${PLAN_COLS} FROM platform.plans WHERE active ORDER BY monthly_price, code`);
  return { ...state, usage: await usage(tx), invoices: await many(tx, `SELECT ${INVOICE_COLS} FROM platform.billing_invoices ORDER BY period DESC`), plans };
}

// --- Operator (platform administrator) --------------------------------------------------

const asTenant = <T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>) => db.withTenant({ tenantId, userId: null }, fn);
async function tenants(db: Db) {
  return db.withTenant({ tenantId: '00000000-0000-0000-0000-000000000000', userId: null },
    async (tx) => many(tx, 'SELECT * FROM platform.all_tenants()'));
}
async function tenantById(db: Db, id: string) {
  const t = (await tenants(db)).find((x) => x.id === id);
  if (!t) throw new NotFoundError('tenant');
  return t;
}

export async function listPlans(db: Db) {
  return asTenant(db, '00000000-0000-0000-0000-000000000000', (tx) => many<Plan>(tx, `SELECT ${PLAN_COLS} FROM platform.plans ORDER BY monthly_price, code`));
}

export async function savePlan(db: Db, code: string, input: Partial<{ name: string; monthlyPrice: number; currency: string; includedUsers: number; extraUserPrice: number;
  maxUsers: number | null; maxCompanies: number | null; trialDays: number; billable: boolean; active: boolean }>) {
  if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(code)) throw new ValidationError('a plan code is capital letters, digits and _, for example BUSINESS');
  return asTenant(db, '00000000-0000-0000-0000-000000000000', async (tx) => {
    const cur = await one(tx, 'SELECT * FROM platform.plans WHERE code = $1', [code]);
    if (!cur && (!input.name || input.monthlyPrice === undefined || !input.currency || input.includedUsers === undefined)) {
      throw new ValidationError('a new plan needs a name, a monthly price, a currency and the users it includes');
    }
    const v = {
      name: input.name ?? cur?.name, price: input.monthlyPrice ?? cur?.monthly_price, currency: (input.currency ?? cur?.currency)?.toUpperCase(),
      included: input.includedUsers ?? cur?.included_users, extra: input.extraUserPrice ?? cur?.extra_user_price ?? 0,
      maxUsers: input.maxUsers !== undefined ? input.maxUsers : cur?.max_users ?? null, maxCompanies: input.maxCompanies !== undefined ? input.maxCompanies : cur?.max_companies ?? null,
      trial: input.trialDays ?? cur?.trial_days ?? 0, billable: input.billable ?? cur?.billable ?? true, active: input.active ?? cur?.active ?? true,
    };
    await tx.query(`INSERT INTO platform.plans (code, name, monthly_price, currency, included_users, extra_user_price, max_users, max_companies, trial_days, billable, active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, monthly_price = EXCLUDED.monthly_price, currency = EXCLUDED.currency, included_users = EXCLUDED.included_users,
          extra_user_price = EXCLUDED.extra_user_price, max_users = EXCLUDED.max_users, max_companies = EXCLUDED.max_companies, trial_days = EXCLUDED.trial_days,
          billable = EXCLUDED.billable, active = EXCLUDED.active, updated_at = now()`,
    [code, v.name, v.price, v.currency, v.included, v.extra, v.maxUsers, v.maxCompanies, v.trial, v.billable, v.active]);
    return plan(tx, code);
  });
}

/** Every tenant with its subscription, usage this month and what it owes. */
export async function listTenants(db: Db) {
  const out = [];
  for (const t of await tenants(db)) {
    out.push(await asTenant(db, t.id, async (tx) => {
      const s = await subscriptionState(tx);
      const owed = await one(tx, `SELECT count(*)::int AS n, coalesce(sum(total), 0)::float AS total, min(due_on) AS oldest_due FROM platform.billing_invoices WHERE status = 'open'`);
      return { ...t, subscription: s && { plan: s.plan.code, planName: s.plan.name, status: s.status, statusReason: s.statusReason, trialEndsAt: s.trialEndsAt,
        billingEmail: s.billingEmail, writable: s.writable }, usage: await usage(tx), openInvoices: owed.n, owed: owed.total, oldestDue: owed.oldest_due };
    }));
  }
  return out;
}

/** The operator changes a tenant's plan or status. */
export async function setSubscription(db: Db, tenantId: string, input: { plan?: string; status?: 'trial' | 'active' | 'suspended' | 'cancelled'; trialEndsAt?: string; billingEmail?: string | null }) {
  await tenantById(db, tenantId);
  return asTenant(db, tenantId, async (tx) => {
    const cur = await one(tx, 'SELECT * FROM platform.subscriptions FOR UPDATE');
    if (!cur) throw new NotFoundError('subscription');
    const p = input.plan ? await plan(tx, input.plan) : await plan(tx, cur.plan_code);
    if (input.plan && !p.active) throw new ValidationError(`the plan ${p.name} is not offered any more`);
    if (input.plan && p.max_users !== null) {
      const n = Number((await one(tx, `SELECT count(*) AS n FROM iam.users WHERE status = 'active'`)).n);
      if (n > p.max_users) throw new ValidationError(`${n} users are active but the ${p.name} plan allows ${p.max_users}; disable users first`);
    }
    if (input.plan && p.max_companies !== null) {
      const n = Number((await one(tx, 'SELECT count(*) AS n FROM fin.companies')).n);
      if (n > p.max_companies) throw new ValidationError(`${n} companies have books but the ${p.name} plan allows ${p.max_companies}`);
    }
    const status = input.status ?? (input.plan && cur.status === 'trial' && p.trial_days === 0 ? 'active' : cur.status);
    let trialEnds = cur.trial_ends_at;
    if (input.trialEndsAt) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(input.trialEndsAt) || Number.isNaN(Date.parse(input.trialEndsAt))) throw new ValidationError('trialEndsAt is a date');
      trialEnds = new Date(input.trialEndsAt);
    }
    if (status === 'trial' && !trialEnds) throw new ValidationError('a trial needs the date it ends');
    if (input.billingEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.billingEmail)) throw new ValidationError('the billing email is not an email address');
    await tx.query(`UPDATE platform.subscriptions SET plan_code = $1, status = $2, status_reason = $3, trial_ends_at = $4,
        billing_email = CASE WHEN $5::boolean THEN $6 ELSE billing_email END, updated_at = now()`,
    [p.code, status, status === 'suspended' ? (input.status === 'suspended' ? 'manual' : cur.status_reason) : null, trialEnds,
      input.billingEmail !== undefined, input.billingEmail || null]);
    return subscriptionState(tx);
  });
}

/**
 * Bill one month: an invoice to every tenant whose plan is billed and whose
 * subscription is active or past due, for the plan and the users above what it
 * includes. A tenant is billed once per month; running it again adds nothing.
 */
export async function runBilling(db: Db, period: string, today = new Date().toISOString().slice(0, 10)) {
  checkPeriod(period);
  if (`${period}-01` > today) throw new ValidationError(`${period} has not started yet`);
  const made: any[] = []; let skipped = 0;
  for (const t of await tenants(db)) {
    const inv = await asTenant(db, t.id, async (tx) => {
      const s = await one(tx, 'SELECT * FROM platform.subscriptions FOR UPDATE');
      if (!s || !['active', 'past_due'].includes(s.status)) return null;
      const p = await plan(tx, s.plan_code);
      if (!p.billable) return null;
      if (await one(tx, 'SELECT 1 FROM platform.billing_invoices WHERE period = $1', [period])) return null;
      const u = await usage(tx, period);
      const extraUsers = Math.max(0, u.users - p.included_users);
      const base = roundIn(p.currency, p.monthly_price), extra = roundIn(p.currency, extraUsers * p.extra_user_price);
      const seq = Number((await one(tx, `SELECT nextval('platform.billing_invoice_seq') AS n`)).n);
      return one(tx, `INSERT INTO platform.billing_invoices (tenant_id, no, period, plan_code, users, companies, base_amount, extra_users, extra_amount, total, currency, issued_on, due_on)
          VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11::date + $12::int) RETURNING ${INVOICE_COLS}`,
      [`BAATS-${period.replace('-', '')}-${String(seq).padStart(5, '0')}`, period, p.code, u.users, u.companies, base, extraUsers, extra,
        roundIn(p.currency, base + extra), p.currency, today, PAYMENT_DAYS]);
    });
    if (inv) made.push({ ...inv, tenant: t.code, tenantName: t.name }); else skipped++;
  }
  return { period, invoices: made, skipped };
}

export async function listBillingInvoices(db: Db, period?: string) {
  if (period) checkPeriod(period);
  const out: any[] = [];
  for (const t of await tenants(db)) {
    const rows = await asTenant(db, t.id, (tx) => many(tx, `SELECT ${INVOICE_COLS} FROM platform.billing_invoices WHERE $1::text IS NULL OR period = $1 ORDER BY period DESC`, [period ?? null]));
    out.push(...rows.map((r) => ({ ...r, tenantId: t.id, tenant: t.code, tenantName: t.name })));
  }
  return out.sort((a, b) => String(b.period).localeCompare(String(a.period)) || String(a.no).localeCompare(String(b.no)));
}

/** Record that a platform invoice was paid (or void it); an unpaid suspension is lifted when nothing is overdue. */
export async function settleInvoice(db: Db, tenantId: string, invoiceId: string, input: { action: 'paid' | 'void'; reference?: string }) {
  await tenantById(db, tenantId);
  return asTenant(db, tenantId, async (tx) => {
    const inv = await one(tx, 'SELECT * FROM platform.billing_invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    if (!inv) throw new NotFoundError('invoice');
    if (inv.status !== 'open') throw new ValidationError(`${inv.no} is already ${inv.status}`);
    if (input.action === 'paid') await tx.query(`UPDATE platform.billing_invoices SET status = 'paid', paid_at = now(), payment_ref = $2 WHERE id = $1`, [invoiceId, input.reference?.slice(0, 100) ?? null]);
    else await tx.query(`UPDATE platform.billing_invoices SET status = 'void' WHERE id = $1`, [invoiceId]);
    await reviewStanding(tx, new Date().toISOString().slice(0, 10));
    return { ...(await one(tx, `SELECT ${INVOICE_COLS} FROM platform.billing_invoices WHERE id = $1`, [invoiceId])), subscription: await subscriptionState(tx) };
  });
}

/** Past due once an invoice is overdue, suspended GRACE_DAYS later, active again when paid. */
async function reviewStanding(tx: Tx, today: string): Promise<string | null> {
  const s = await one(tx, 'SELECT * FROM platform.subscriptions FOR UPDATE');
  if (!s) return null;
  const oldest = await one(tx, `SELECT min(due_on)::text AS d FROM platform.billing_invoices WHERE status = 'open' AND due_on < $1::date`, [today]);
  const overdueSince = oldest?.d as string | null;
  let next = s.status, reason = s.status_reason;
  if (overdueSince) {
    const days = Math.round((Date.parse(today) - Date.parse(overdueSince)) / 86_400_000);
    if (s.status === 'active' || (s.status === 'past_due' && days > GRACE_DAYS)) {
      next = days > GRACE_DAYS ? 'suspended' : 'past_due';
      reason = next === 'suspended' ? 'unpaid' : null;
    }
  } else if (s.status === 'past_due' || (s.status === 'suspended' && s.status_reason === 'unpaid')) {
    next = 'active'; reason = null;
  }
  if (next !== s.status) await tx.query('UPDATE platform.subscriptions SET status = $1, status_reason = $2, updated_at = now()', [next, reason]);
  return next !== s.status ? next : null;
}

/** The hourly sweep: subscriptions follow their invoices. Returns the tenants whose standing changed. */
export async function sweepSubscriptions(db: Db, today = new Date().toISOString().slice(0, 10)) {
  const changed: { tenant: string; status: string }[] = [];
  for (const t of await tenants(db)) {
    const next = await asTenant(db, t.id, (tx) => reviewStanding(tx, today));
    if (next) changed.push({ tenant: t.code, status: next });
  }
  return changed;
}

/** Whether a tenant may change data, cached briefly: asked on every change request. */
export class WriteGate {
  private cache = new Map<string, { at: number; reason: string | null }>();
  private db: Db; private ttlMs: number;
  constructor(db: Db, ttlMs = 30_000) { this.db = db; this.ttlMs = ttlMs; }
  async check(tenantId: string): Promise<void> {
    let c = this.cache.get(tenantId);
    if (!c || Date.now() - c.at > this.ttlMs) {
      const s = await this.db.withTenant({ tenantId, userId: null }, (tx) => subscriptionState(tx));
      c = { at: Date.now(), reason: s?.reason ?? null };
      this.cache.set(tenantId, c);
    }
    if (c.reason) throw new PaymentRequiredError(c.reason);
  }
  forget(tenantId?: string) { if (tenantId) this.cache.delete(tenantId); else this.cache.clear(); }
}
