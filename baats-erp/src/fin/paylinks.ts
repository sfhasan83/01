import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Db, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { open, seal } from '../ai/secrets.ts';
import { company, resolveAccount } from './ledger.ts';
import { outstanding, recordPayment } from './documents.ts';

/**
 * Card payments for sales invoices through Stripe Checkout. A link is a Stripe
 * Checkout page for what is still owed on the invoice (Stripe keeps one open for
 * up to 24 hours). When the customer has paid, BAATS records the receipt against
 * the invoice into a card clearing account (1040); Stripe's payout, net of its
 * fees, then arrives in the bank and is reconciled against that account. Payment
 * is confirmed by asking Stripe, either when Stripe's signed notice arrives or
 * by the regular check, so it works on a computer Stripe cannot reach too.
 */

export interface PayOptions {
  secretKey: Buffer | null;
  fetchImpl?: typeof fetch;
  /** For tests: where the Stripe API is. */
  stripeBase?: string;
  now?: () => Date;
}
const STRIPE = 'https://api.stripe.com';
const LINK_HOURS = 23;
/** Stripe's currencies with three decimals take amounts in thousandths ending in 0. */
const THREE_DECIMALS = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
const ZERO_DECIMALS = new Set(['JPY', 'KRW', 'VND', 'XOF', 'XAF', 'CLP', 'PYG', 'UGX', 'RWF']);

export function minorUnits(amount: number, currency: string): number {
  if (ZERO_DECIMALS.has(currency)) return Math.round(amount);
  if (THREE_DECIMALS.has(currency)) return Math.round(amount * 100) * 10;
  return Math.round(amount * 100);
}

async function stripe(opts: PayOptions, key: string, method: 'GET' | 'POST', path: string, form?: Record<string, string>) {
  const r = await (opts.fetchImpl ?? fetch)(`${opts.stripeBase ?? STRIPE}${path}`, {
    method, signal: AbortSignal.timeout(20_000), redirect: 'error',
    headers: { authorization: `Bearer ${key}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), 'stripe-version': '2024-06-20' },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ValidationError(`Stripe refused: ${String(body?.error?.message ?? r.status).slice(0, 300)}`);
  return body;
}

// --- Gateway set-up ------------------------------------------------------------------------

/** The card clearing account (1040), made under the bank's heading if the chart has none. */
async function clearingAccount(tx: Tx, companyId: string): Promise<string> {
  const existing = await one(tx, `SELECT id FROM fin.accounts WHERE company_id = $1 AND code = '1040'`, [companyId]);
  if (existing) return existing.id;
  const bank = await one(tx, `SELECT parent_id FROM fin.accounts WHERE company_id = $1 AND system_role = 'bank'`, [companyId]);
  const a = await one(tx, `INSERT INTO fin.accounts (tenant_id, company_id, code, name, type, parent_id)
      VALUES (app.tenant(), $1, '1040', 'Card Payments Clearing', 'asset', $2) RETURNING id`, [companyId, bank?.parent_id ?? null]);
  return a.id;
}

export async function getGateway(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'fin.payment.link', { unitId: companyId });
  return (await one(tx, `SELECT g.provider, g.live, g.active, g.updated_at, a.code AS clearing_account, s.sealed_webhook IS NOT NULL AS has_webhook_secret
      FROM int.payment_gateways g JOIN fin.accounts a ON a.id = g.clearing_account_id LEFT JOIN int.payment_gateway_secrets s ON s.company_id = g.company_id
      WHERE g.company_id = $1`, [companyId])) ?? null;
}

export async function setGateway(tx: Tx, ctx: Ctx, opts: PayOptions, companyId: string, input: { secretKey?: string; webhookSecret?: string; active?: boolean; clearingAccount?: string }) {
  await authorize(tx, ctx, 'fin.payment.link', { unitId: companyId });
  await company(tx, companyId);
  const existing = await one(tx, 'SELECT * FROM int.payment_gateways WHERE company_id = $1', [companyId]);
  const key = input.secretKey?.trim();
  if (!existing && !key) throw new ValidationError('give the Stripe secret key (it starts with sk_live_ or sk_test_, or rk_ for a restricted key)');
  if (key && !/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(key)) throw new ValidationError('a Stripe secret key starts with sk_live_ or sk_test_ (or rk_live_ / rk_test_ for a restricted key)');
  if (input.webhookSecret && !/^whsec_[A-Za-z0-9+/=]{10,}$/.test(input.webhookSecret.trim())) throw new ValidationError('a Stripe webhook signing secret starts with whsec_');
  if (key) await stripe(opts, key, 'GET', '/v1/balance');   // the key works, now rather than at the first link
  const clearing = input.clearingAccount ? (await resolveAccount(tx, companyId, input.clearingAccount)).id : existing?.clearing_account_id ?? await clearingAccount(tx, companyId);
  const live = key ? key.includes('_live_') : existing.live;
  await tx.query(`INSERT INTO int.payment_gateways (tenant_id, company_id, provider, clearing_account_id, live, active, updated_by)
      VALUES (app.tenant(), $1, 'stripe', $2, $3, $4, $5)
      ON CONFLICT (company_id) DO UPDATE SET clearing_account_id = EXCLUDED.clearing_account_id, live = EXCLUDED.live, active = EXCLUDED.active,
        updated_by = EXCLUDED.updated_by, updated_at = now()`, [companyId, clearing, live, input.active ?? true, ctx.userId]);
  if (key || input.webhookSecret) {
    await tx.query(`INSERT INTO int.payment_gateway_secrets (tenant_id, company_id, sealed_key, sealed_webhook) VALUES (app.tenant(), $1, $2, $3)
        ON CONFLICT (company_id) DO UPDATE SET sealed_key = coalesce($2, int.payment_gateway_secrets.sealed_key), sealed_webhook = coalesce($3, int.payment_gateway_secrets.sealed_webhook)`,
    [companyId, key ? seal(opts.secretKey, key) : null, input.webhookSecret ? seal(opts.secretKey, input.webhookSecret.trim()) : null]);
  }
  return getGateway(tx, ctx, companyId);
}

async function gatewayKey(tx: Tx, opts: PayOptions, companyId: string) {
  const g = await one(tx, `SELECT g.*, s.sealed_key, s.sealed_webhook FROM int.payment_gateways g JOIN int.payment_gateway_secrets s ON s.company_id = g.company_id WHERE g.company_id = $1`, [companyId]);
  if (!g) throw new ValidationError('card payments are not set up for this company');
  return { ...g, key: open(opts.secretKey, g.sealed_key) as string };
}

// --- Links ---------------------------------------------------------------------------------

/** A Stripe Checkout page for what is still owed on a posted sales invoice. */
export async function createLink(tx: Tx, ctx: Ctx, opts: PayOptions, invoiceId: string, input: { returnUrl: string }) {
  const inv = await one(tx, `SELECT i.*, p.name AS party_name, p.attributes->>'email' AS email FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id WHERE i.id = $1 FOR UPDATE OF i`, [invoiceId]);
  if (!inv) throw new NotFoundError('invoice');
  await authorize(tx, ctx, 'fin.payment.link', { unitId: inv.company_id });
  // The receipt is recorded in this person's name when the customer pays.
  await authorize(tx, ctx, 'fin.payment.post', { unitId: inv.company_id, attrs: { kind: 'receipt' } });
  if (inv.kind !== 'sales_invoice' || inv.status !== 'posted') throw new ValidationError('a payment link is for a posted sales invoice');
  if (!/^https?:\/\/[^\s]+$/.test(input.returnUrl)) throw new ValidationError('returnUrl must be an address');
  const g = await gatewayKey(tx, opts, inv.company_id);
  if (!g.active) throw new ValidationError('card payments are switched off for this company');
  const due = await outstanding(tx, invoiceId);
  if (!(due > 0.0005)) throw new ConflictError(`${inv.no} is already paid`);
  const current = await one(tx, `SELECT * FROM fin.payment_links WHERE invoice_id = $1 AND status = 'open'`, [invoiceId]);
  if (current) {
    if (new Date(current.expires_at) > new Date() && Math.abs(Number(current.amount) - due) < 0.0005) return current;
    await expireAtStripe(opts, g.key, current.provider_ref);
    await tx.query(`UPDATE fin.payment_links SET status = 'expired' WHERE id = $1`, [current.id]);
  }
  const c = await company(tx, inv.company_id);
  const expires = Math.floor(Date.now() / 1000) + LINK_HOURS * 3600;
  const s = await stripe(opts, g.key, 'POST', '/v1/checkout/sessions', {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': inv.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(minorUnits(due, inv.currency)),
    'line_items[0][price_data][product_data][name]': `${c.legal_name}: invoice ${inv.no}`.slice(0, 250),
    client_reference_id: inv.id,
    'metadata[baats_invoice]': inv.no,
    'metadata[baats_invoice_id]': inv.id,
    'payment_intent_data[description]': `${c.legal_name} invoice ${inv.no}`.slice(0, 250),
    ...(inv.email ? { customer_email: inv.email } : {}),
    expires_at: String(expires),
    success_url: `${input.returnUrl}${input.returnUrl.includes('?') ? '&' : '?'}paid=${encodeURIComponent(inv.no)}`,
    cancel_url: input.returnUrl,
  });
  if (typeof s.id !== 'string' || typeof s.url !== 'string') throw new ValidationError('Stripe did not return a payment page');
  return one(tx, `INSERT INTO fin.payment_links (tenant_id, company_id, invoice_id, provider, provider_ref, url, amount, currency, expires_at, created_by)
      VALUES (app.tenant(), $1, $2, 'stripe', $3, $4, $5, $6, to_timestamp($7), $8) RETURNING *`,
  [inv.company_id, inv.id, s.id, s.url, due, inv.currency, expires, ctx.userId]);
}

async function expireAtStripe(opts: PayOptions, key: string, ref: string) {
  try { await stripe(opts, key, 'POST', `/v1/checkout/sessions/${encodeURIComponent(ref)}/expire`); } catch { /* already expired or paid; the check below finds out */ }
}

export async function listLinks(tx: Tx, ctx: Ctx, companyId: string, invoiceId?: string) {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  return many(tx, `SELECT l.id, l.invoice_id, i.no AS invoice_no, l.url, l.amount::float AS amount, l.currency, l.status, l.expires_at, l.paid_at, p.no AS receipt_no, l.created_at
      FROM fin.payment_links l JOIN fin.invoices i ON i.id = l.invoice_id LEFT JOIN fin.payments p ON p.id = l.payment_id
      WHERE l.company_id = $1 AND ($2::uuid IS NULL OR l.invoice_id = $2) ORDER BY l.created_at DESC LIMIT 200`, [companyId, invoiceId ?? null]);
}

export async function cancelLink(tx: Tx, ctx: Ctx, opts: PayOptions, id: string) {
  const l = await one(tx, 'SELECT * FROM fin.payment_links WHERE id = $1 FOR UPDATE', [id]);
  if (!l) throw new NotFoundError('payment link');
  await authorize(tx, ctx, 'fin.payment.link', { unitId: l.company_id });
  if (l.status !== 'open') throw new ConflictError(`this link is ${l.status}`);
  const r = await confirmLink(tx, opts, l, ctx.userId!);
  if (r.status === 'paid') throw new ConflictError('the customer has already paid this link; the receipt is recorded');
  const g = await gatewayKey(tx, opts, l.company_id);
  await expireAtStripe(opts, g.key, l.provider_ref);
  await tx.query(`UPDATE fin.payment_links SET status = 'cancelled' WHERE id = $1`, [id]);
  return { id, status: 'cancelled' };
}

/**
 * Ask Stripe about an open link. Paid: record the receipt (as the person who made
 * the link) and allocate it to the invoice. Expired: mark it so.
 */
async function confirmLink(tx: Tx, opts: PayOptions, l: Record<string, any>, actorId: string): Promise<{ status: string; receiptNo?: string }> {
  if (l.status !== 'open') return { status: l.status };
  const g = await gatewayKey(tx, opts, l.company_id);
  const s = await stripe(opts, g.key, 'GET', `/v1/checkout/sessions/${encodeURIComponent(l.provider_ref)}`);
  if (s.payment_status === 'paid' && s.status === 'complete') {
    const paid = Number(s.amount_total);
    if (paid !== minorUnits(Number(l.amount), l.currency) || String(s.currency).toUpperCase() !== l.currency) {
      throw new ValidationError(`Stripe reports ${paid} ${s.currency} for a link of ${l.amount} ${l.currency}; check it in Stripe`);
    }
    const inv = await one(tx, 'SELECT * FROM fin.invoices WHERE id = $1', [l.invoice_id]);
    const due = await outstanding(tx, l.invoice_id);
    const amount = Number(l.amount);
    // Paid by card after part was paid another way: the card amount still goes in; any excess stays as the customer's advance.
    const allocate = Math.min(amount, due);
    const ctx = { tenantId: l.tenant_id, userId: actorId };
    const p = await recordPayment(tx, ctx, { companyId: l.company_id, kind: 'receipt', partyId: inv.party_id, date: new Date((s.created ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10),
      bankAccount: g.clearing_account_id, currency: l.currency, fxRate: Number(inv.fx_rate), amount, reference: `Card ${String(s.payment_intent ?? s.id).slice(0, 60)}`,
      allocations: allocate > 0.0005 ? [{ invoiceId: inv.id, amount: allocate }] : [] });
    await tx.query(`UPDATE fin.payment_links SET status = 'paid', paid_at = now(), payment_id = $2 WHERE id = $1`, [l.id, p.id]);
    return { status: 'paid', receiptNo: p.no };
  }
  if (s.status === 'expired' || new Date(l.expires_at).getTime() < Date.now() - 3_600_000) {
    await tx.query(`UPDATE fin.payment_links SET status = 'expired' WHERE id = $1`, [l.id]);
    return { status: 'expired' };
  }
  return { status: 'open' };
}

/** Check one link now (the person pressed "Check payment"). */
export async function checkLink(tx: Tx, ctx: Ctx, opts: PayOptions, id: string) {
  const l = await one(tx, 'SELECT * FROM fin.payment_links WHERE id = $1 FOR UPDATE', [id]);
  if (!l) throw new NotFoundError('payment link');
  await authorize(tx, ctx, 'fin.payment.link', { unitId: l.company_id });
  return confirmLink(tx, opts, l, l.created_by ?? ctx.userId!);
}

/** The background check: every open link of every tenant. */
export async function checkOpenLinks(db: Db, opts: PayOptions): Promise<number> {
  const tenants = await db.withTenant({ tenantId: '00000000-0000-0000-0000-000000000000', userId: null },
    async (tx) => (await tx.query('SELECT fin.open_payment_link_tenants() AS id')).rows.map((r) => r.id as string));
  let paid = 0;
  for (const tenantId of tenants) {
    const ids = await db.withTenant({ tenantId, userId: null }, async (tx) => (await many(tx, `SELECT id FROM fin.payment_links WHERE status = 'open'`)).map((r) => r.id as string));
    for (const id of ids) {
      try {
        const r = await db.withTenant({ tenantId, userId: null }, async (tx) => {
          const l = await one(tx, `SELECT * FROM fin.payment_links WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`, [id]);
          return l ? confirmLink(tx, opts, l, l.created_by) : { status: 'busy' };
        });
        if (r.status === 'paid') paid++;
      } catch { /* tried again at the next check */ }
    }
  }
  return paid;
}

/** Stripe-Signature: t=<unix time>,v1=<HMAC-SHA256 of "t.body" with the webhook secret>; at most five minutes old. */
export function verifyStripeSignature(header: string, body: string, secret: string, now = Date.now()): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=').map((x) => x.trim())).filter((p) => p.length === 2)) as Record<string, string>;
  const sigs = header.split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > 300 || !sigs.length) return false;
  const expect = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  return sigs.some((s) => { const b = Buffer.from(s, 'hex'); return b.length === expect.length && timingSafeEqual(b, expect); });
}

/** Stripe's notice that a checkout finished: check the signature with the company's secret, then confirm with Stripe. */
export async function stripeNotice(db: Db, opts: PayOptions, signature: string, raw: string): Promise<{ handled: boolean; status?: string }> {
  let event: any;
  try { event = JSON.parse(raw); } catch { throw new ValidationError('not JSON'); }
  const obj = event?.data?.object;
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired'].includes(event?.type) || obj?.object !== 'checkout.session') return { handled: false };
  const tenantId = await db.withTenant({ tenantId: '00000000-0000-0000-0000-000000000000', userId: null },
    async (tx) => (await one(tx, 'SELECT fin.payment_link_tenant($1, $2) AS t', ['stripe', String(obj.id)]))?.t as string | null);
  if (!tenantId) return { handled: false };
  return db.withTenant({ tenantId, userId: null }, async (tx) => {
    const l = await one(tx, `SELECT * FROM fin.payment_links WHERE provider = 'stripe' AND provider_ref = $1 FOR UPDATE`, [String(obj.id)]);
    const g = await one(tx, 'SELECT sealed_webhook FROM int.payment_gateway_secrets WHERE company_id = $1', [l.company_id]);
    if (!g?.sealed_webhook || !verifyStripeSignature(signature, raw, open(opts.secretKey, g.sealed_webhook))) throw new ValidationError('the Stripe signature does not match');
    const r = await confirmLink(tx, opts, l, l.created_by);
    return { handled: true, status: r.status };
  });
}
