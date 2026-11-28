import { Db } from './core/db.ts';
import { buildServer } from './api/server.ts';
import { runEscalations } from './workflow/engine.ts';
import { dispatchAll } from './int/webhooks.ts';
import { parseSecretKey } from './ai/secrets.ts';
import { dispatchMailAll } from './int/mail.ts';
import { checkOpenLinks } from './fin/paylinks.ts';
import { runBilling, sweepSubscriptions } from './platform/billing.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) { console.error('DATABASE_URL is required (connect as baats_app, never as the schema owner)'); process.exit(1); }

const db = new Db({ connectionString: databaseUrl });
const app = buildServer({ db, platformAdminKey: process.env.PLATFORM_ADMIN_KEY, logger: true,
  ai: { secretKey: process.env.BAATS_SECRET_KEY, allowPrivateUrls: process.env.AI_ALLOW_PRIVATE_URLS === 'true' },
  limits: { apiPerMinute: Number(process.env.API_REQUESTS_PER_MINUTE) || undefined, loginsPer5Min: Number(process.env.LOGINS_PER_5_MINUTES) || undefined },
  connectors: { publicUrl: process.env.PUBLIC_URL, ssoAllowHttp: process.env.SSO_ALLOW_HTTP === 'true' },
  trustProxy: process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY || false,
  defaultPlan: process.env.DEFAULT_PLAN || 'TRIAL', metricsToken: process.env.METRICS_TOKEN || undefined });

// Escalation sweep across all tenants. Each tenant runs in its own transaction.
const SWEEP_MS = Number(process.env.ESCALATION_SWEEP_SECONDS ?? 300) * 1000;
async function sweep(): Promise<void> {
  const ids = await db.withTenant({ tenantId: '00000000-0000-0000-0000-000000000000', userId: null },
    async (tx) => (await tx.query('SELECT platform.active_tenant_ids() AS id')).rows.map((r) => r.id as string));
  for (const tenantId of ids) {
    try {
      const n = await db.withTenant({ tenantId, userId: null }, (tx) => runEscalations(tx));
      if (n) app.log.info({ tenantId, escalated: n }, 'escalations');
    } catch (err) {
      app.log.error({ tenantId, err }, 'escalation sweep failed');
    }
  }
}
const timer = setInterval(() => { sweep().catch((err) => app.log.error(err)); }, SWEEP_MS);

// Webhook deliveries: every half minute, send what is due (new events and retries).
const hookOpts = { secretKey: parseSecretKey(process.env.BAATS_SECRET_KEY), allowPrivateUrls: process.env.WEBHOOK_ALLOW_PRIVATE_URLS === 'true' };
let dispatching = false;
const hookTimer = setInterval(() => {
  if (dispatching) return;
  dispatching = true;
  dispatchAll(db, hookOpts).then((n) => { if (n) app.log.info({ deliveries: n }, 'webhooks'); })
    .catch((err) => app.log.error(err)).finally(() => { dispatching = false; });
}, Number(process.env.WEBHOOK_DISPATCH_SECONDS ?? 30) * 1000);

// Email: every half minute, send what is due. Card payment links: every two minutes, ask Stripe about open ones.
const mailOpts = { secretKey: hookOpts.secretKey };
let mailing = false, checking = false;
const mailTimer = setInterval(() => {
  if (mailing) return;
  mailing = true;
  dispatchMailAll(db, mailOpts).then((n) => { if (n) app.log.info({ mails: n }, 'mail'); }).catch((err) => app.log.error(err)).finally(() => { mailing = false; });
}, 30_000);
const linkTimer = setInterval(() => {
  if (checking) return;
  checking = true;
  checkOpenLinks(db, mailOpts).then((n) => { if (n) app.log.info({ paid: n }, 'payment links'); }).catch((err) => app.log.error(err)).finally(() => { checking = false; });
}, 120_000);

// Subscriptions: every hour, follow unpaid invoices (past due, then suspended) and payments. With AUTO_BILLING=true,
// last month is billed on the first run of each month (billing a month twice adds nothing).
const billingTimer = setInterval(async () => {
  try {
    if (process.env.AUTO_BILLING === 'true') {
      const d = new Date(); d.setUTCDate(0);
      const r = await runBilling(db, d.toISOString().slice(0, 7));
      if (r.invoices.length) app.log.info({ period: r.period, invoices: r.invoices.length }, 'billing');
    }
    const changed = await sweepSubscriptions(db);
    if (changed.length) app.log.info({ changed }, 'subscriptions');
  } catch (err) { app.log.error(err); }
}, 3_600_000);

await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3000) });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => { clearInterval(timer); clearInterval(hookTimer); clearInterval(mailTimer); clearInterval(linkTimer); clearInterval(billingTimer); await app.close(); await db.close(); process.exit(0); });
}
