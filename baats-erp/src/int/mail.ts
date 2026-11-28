import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Db, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { open, seal } from '../ai/secrets.ts';

/**
 * Email through the company's own mail service: any SMTP server (Gmail and Google
 * Workspace with an app password, a hosting provider, an office relay) or
 * Microsoft 365 through Microsoft Graph with an app registration (Mail.Send),
 * since Microsoft no longer accepts passwords over SMTP. Mail is written to an
 * outbox in the same transaction as the change it reports and sent in the
 * background, with retries.
 */

export interface MailOptions {
  secretKey: Buffer | null;
  fetchImpl?: typeof fetch;
  /** For tests: where Microsoft's sign-in and Graph are. */
  msLoginBase?: string; graphBase?: string;
  now?: () => Date;
}
export interface Attachment { name: string; contentType: string; base64: string }
export interface Outgoing { to: string[]; cc?: string[]; subject: string; text: string; html?: string; attachments?: Attachment[] }
type Settings = Record<string, any>;

export const MAX_MAIL_ATTEMPTS = 6;
const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function checkAddress(a: string, what = 'email address'): string {
  const s = a.trim();
  if (!ADDRESS.test(s) || s.length > 254) throw new ValidationError(`${a} is not a valid ${what}`);
  return s;
}

// --- Settings ------------------------------------------------------------------------------

export async function getSettings(tx: Tx, ctx: Ctx) {
  await authorize(tx, ctx, 'int.mail.manage');
  const s = await one(tx, `SELECT transport, host, port, security, username, ms_tenant, ms_client_id, from_address, from_name, reply_to, notify_approvals, active, updated_at,
      EXISTS (SELECT 1 FROM int.mail_secrets) AS has_secret FROM int.mail_settings`);
  return s ?? null;
}

export async function saveSettings(tx: Tx, ctx: Ctx, opts: MailOptions, input: {
  transport: 'smtp' | 'microsoft365'; host?: string; port?: number; security?: 'starttls' | 'tls' | 'none'; username?: string; password?: string;
  msTenant?: string; msClientId?: string; msClientSecret?: string; fromAddress: string; fromName: string; replyTo?: string; notifyApprovals?: boolean; active?: boolean;
}) {
  await authorize(tx, ctx, 'int.mail.manage');
  const from = checkAddress(input.fromAddress, 'sender address');
  const replyTo = input.replyTo ? checkAddress(input.replyTo, 'reply-to address') : null;
  if (/[\r\n]/.test(input.fromName)) throw new ValidationError('the sender name must be one line');
  const existing = await one(tx, 'SELECT 1 FROM int.mail_secrets');
  let secret: string | undefined;
  if (input.transport === 'smtp') {
    if (!input.host || !/^[A-Za-z0-9.-]+$/.test(input.host)) throw new ValidationError('give the mail server name, for example smtp.gmail.com');
    if (!input.port || input.port < 1 || input.port > 65535) throw new ValidationError('give the mail server port: 587 (STARTTLS) or 465 (TLS)');
    if (input.username && !input.password && !existing) throw new ValidationError('give the password for the mail account');
    secret = input.password;
  } else {
    if (!input.msTenant || !input.msClientId) throw new ValidationError('give the Microsoft 365 directory (tenant) id and the application (client) id');
    if (!input.msClientSecret && !existing) throw new ValidationError('give the application\'s client secret');
    secret = input.msClientSecret;
  }
  await tx.query(`INSERT INTO int.mail_settings (tenant_id, transport, host, port, security, username, ms_tenant, ms_client_id, from_address, from_name, reply_to, notify_approvals, active, updated_by)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (tenant_id) DO UPDATE SET transport = EXCLUDED.transport, host = EXCLUDED.host, port = EXCLUDED.port, security = EXCLUDED.security,
        username = EXCLUDED.username, ms_tenant = EXCLUDED.ms_tenant, ms_client_id = EXCLUDED.ms_client_id, from_address = EXCLUDED.from_address,
        from_name = EXCLUDED.from_name, reply_to = EXCLUDED.reply_to, notify_approvals = EXCLUDED.notify_approvals, active = EXCLUDED.active,
        updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [input.transport, input.transport === 'smtp' ? input.host : null, input.transport === 'smtp' ? input.port : null,
    input.transport === 'smtp' ? (input.security ?? (input.port === 465 ? 'tls' : 'starttls')) : null, input.transport === 'smtp' ? input.username?.trim() || null : null,
    input.transport === 'microsoft365' ? input.msTenant!.trim() : null, input.transport === 'microsoft365' ? input.msClientId!.trim() : null,
    from, input.fromName.trim(), replyTo, input.notifyApprovals ?? true, input.active ?? true, ctx.userId]);
  if (secret) {
    await tx.query(`INSERT INTO int.mail_secrets (tenant_id, sealed) VALUES (app.tenant(), $1) ON CONFLICT (tenant_id) DO UPDATE SET sealed = EXCLUDED.sealed`, [seal(opts.secretKey, secret)]);
  } else if (input.transport === 'smtp' && !input.username) {
    await tx.query('DELETE FROM int.mail_secrets');
  }
  return getSettings(tx, ctx);
}

async function loadSettings(tx: Tx): Promise<Settings | null> {
  const s = await one(tx, 'SELECT s.*, x.sealed FROM int.mail_settings s LEFT JOIN int.mail_secrets x ON x.tenant_id = s.tenant_id WHERE s.active');
  return s ?? null;
}

/** Whether this tenant can send mail at all. */
export async function mailReady(tx: Tx): Promise<boolean> { return !!(await one(tx, 'SELECT 1 FROM int.mail_settings WHERE active')); }

// --- Outbox --------------------------------------------------------------------------------

/** Put a message in the outbox; it is sent if and when the transaction commits. */
export async function queue(tx: Tx, userId: string | null, m: Outgoing & { kind: string; entityType?: string; entityId?: string }) {
  const to = m.to.map((a) => checkAddress(a));
  const cc = (m.cc ?? []).map((a) => checkAddress(a));
  if (!to.length) throw new ValidationError('give at least one address to send to');
  if (/[\r\n]/.test(m.subject)) throw new ValidationError('the subject must be one line');
  const size = (m.attachments ?? []).reduce((s, a) => s + a.base64.length * 0.75, 0);
  if (size > 10 * 1_048_576) throw new ValidationError('the attachments are larger than 10 MB');
  return one(tx, `INSERT INTO int.mails (tenant_id, kind, entity_type, entity_id, to_addresses, cc_addresses, subject, body_text, body_html, attachments, created_by)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, status, created_at`,
  [m.kind, m.entityType ?? null, m.entityId ?? null, to, cc, m.subject.slice(0, 250), m.text, m.html ?? null, JSON.stringify(m.attachments ?? []), userId]);
}

export async function listMails(tx: Tx, ctx: Ctx, filter: { entityType?: string; entityId?: string } = {}) {
  if (filter.entityId) await authorize(tx, ctx, 'int.mail.send');
  else await authorize(tx, ctx, 'int.mail.manage');
  return many(tx, `SELECT id, kind, entity_type, entity_id, to_addresses, cc_addresses, subject, status, attempts, last_error, sent_at, created_at,
      jsonb_array_length(attachments) AS attachments
      FROM int.mails WHERE ($1::text IS NULL OR entity_type = $1) AND ($2::uuid IS NULL OR entity_id = $2) ORDER BY created_at DESC LIMIT 100`,
  [filter.entityType ?? null, filter.entityId ?? null]);
}

export async function resend(tx: Tx, ctx: Ctx, id: string) {
  await authorize(tx, ctx, 'int.mail.manage');
  const r = await one(tx, `UPDATE int.mails SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL WHERE id = $1 AND status = 'failed' RETURNING id`, [id]);
  if (!r) throw new ValidationError('only a message that failed can be sent again');
  return r;
}

// --- MIME ----------------------------------------------------------------------------------

const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const fold = (b64: string) => b64.replace(/.{1,76}/g, '$&\r\n');
const quoteName = (n: string) => (/^[\x20-\x7e]*$/.test(n) ? `"${n.replace(/["\\]/g, '')}"` : encodeWord(n));

export function buildMime(s: Settings, m: Outgoing, now = new Date()): string {
  const boundary = () => `=_baats_${randomBytes(12).toString('hex')}`;
  const mixed = boundary(), alt = boundary();
  const domain = s.from_address.split('@')[1];
  const head = [
    `From: ${quoteName(s.from_name)} <${s.from_address}>`,
    `To: ${m.to.join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.join(', ')}`] : []),
    ...(s.reply_to ? [`Reply-To: ${s.reply_to}`] : []),
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'X-Mailer: BAATS ERP',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  const part = (type: string, body: string) => `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${fold(Buffer.from(body).toString('base64'))}`;
  const body = [
    `--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`, part('text/plain', m.text),
    ...(m.html ? [`--${alt}`, part('text/html', m.html)] : []),
    `--${alt}--`, '',
    ...(m.attachments ?? []).flatMap((a) => [`--${mixed}`,
      `Content-Type: ${a.contentType}; name="${encodeWord(a.name)}"\r\nContent-Disposition: attachment; filename="${encodeWord(a.name)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${fold(a.base64.replace(/\s+/g, ''))}`]),
    `--${mixed}--`, '',
  ];
  return head.join('\r\n') + '\r\n\r\n' + body.join('\r\n');
}

// --- Transports ----------------------------------------------------------------------------

/** A small SMTP client: EHLO, STARTTLS or TLS, AUTH PLAIN or LOGIN, one message. */
export async function sendSmtp(s: Settings, password: string | null, m: Outgoing, opts: { timeoutMs?: number } = {}): Promise<string> {
  const timeout = opts.timeoutMs ?? 30_000;
  let sock: Socket | TLSSocket = s.security === 'tls'
    ? tlsConnect({ host: s.host, port: s.port, servername: s.host })
    : netConnect({ host: s.host, port: s.port });
  let buf = '';
  let waiting: ((line: string) => void) | null = null;
  let failed: Error | null = null;
  const onData = (d: Buffer) => {
    buf += d.toString('utf8');
    // A reply is complete at a line "NNN " (multi-line replies use "NNN-").
    const m = /(^|\r\n)(\d{3}) [^\r\n]*\r\n$/.exec(buf);
    if (m && waiting) { const all = buf; buf = ''; const w = waiting; waiting = null; w(all); }
  };
  const attach = (x: Socket | TLSSocket) => {
    x.setTimeout(timeout, () => x.destroy(new Error('the mail server stopped answering')));
    x.on('data', onData);
    x.on('error', (e) => { failed = e; if (waiting) { const w = waiting; waiting = null; w(`999 ${e.message}\r\n`); } });
  };
  attach(sock);
  const reply = () => new Promise<string>((resolve) => { if (failed) return resolve(`999 ${failed.message}\r\n`); waiting = resolve; });
  const code = (r: string) => Number(r.trimEnd().split('\r\n').pop()!.slice(0, 3));
  const expect = async (cmd: string | null, ok: number[], what: string) => {
    if (cmd !== null) sock.write(cmd + '\r\n');
    const r = await reply();
    if (!ok.includes(code(r))) throw new Error(`${what}: ${r.trim().split('\r\n').pop()!.replace(/^999 /, '')}`);
    return r;
  };
  try {
    await expect(null, [220], 'the mail server did not greet');
    const host = 'baats.local';
    let ehlo = await expect(`EHLO ${host}`, [250], 'EHLO refused');
    if (s.security === 'starttls') {
      if (!/STARTTLS/i.test(ehlo)) throw new Error('the mail server does not offer STARTTLS; use port 465 with TLS');
      await expect('STARTTLS', [220], 'STARTTLS refused');
      sock.removeListener('data', onData);
      sock = await new Promise<TLSSocket>((resolve, reject) => {
        const t = tlsConnect({ socket: sock as Socket, servername: s.host }, () => resolve(t));
        t.once('error', reject);
      });
      attach(sock);
      ehlo = await expect(`EHLO ${host}`, [250], 'EHLO refused');
    }
    if (s.username) {
      if (s.security === 'none') throw new Error('the password would be sent unencrypted; use STARTTLS or TLS');
      if (/AUTH[ =][^\r\n]*PLAIN/i.test(ehlo)) {
        await expect(`AUTH PLAIN ${Buffer.from(`\0${s.username}\0${password ?? ''}`).toString('base64')}`, [235], 'the mail server refused the user name or password');
      } else if (/AUTH[ =][^\r\n]*LOGIN/i.test(ehlo)) {
        await expect('AUTH LOGIN', [334], 'AUTH LOGIN refused');
        await expect(Buffer.from(s.username).toString('base64'), [334], 'the mail server refused the user name');
        await expect(Buffer.from(password ?? '').toString('base64'), [235], 'the mail server refused the user name or password');
      } else throw new Error('the mail server offers no password sign-in this client supports');
    }
    await expect(`MAIL FROM:<${s.from_address}>`, [250], 'the sender was refused');
    for (const a of [...m.to, ...(m.cc ?? [])]) await expect(`RCPT TO:<${a}>`, [250, 251], `${a} was refused`);
    await expect('DATA', [354], 'DATA refused');
    const data = buildMime(s, m).replace(/\r\n\./g, '\r\n..');
    const r = await expect(data + '\r\n.', [250], 'the message was refused');
    sock.write('QUIT\r\n');
    return r.trim().split('\r\n').pop()!.slice(4, 200);
  } finally {
    setTimeout(() => sock.destroy(), 200).unref();
  }
}

/** Microsoft 365: an app-only token (client credentials), then Graph sendMail as the sender mailbox. */
export async function sendGraph(s: Settings, clientSecret: string, m: Outgoing, opts: MailOptions): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const login = opts.msLoginBase ?? 'https://login.microsoftonline.com';
  const graph = opts.graphBase ?? 'https://graph.microsoft.com';
  const t = await f(`${login}/${encodeURIComponent(s.ms_tenant)}/oauth2/v2.0/token`, {
    method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: s.ms_client_id, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default' }).toString(),
  });
  const tok = await t.json().catch(() => ({}));
  if (!t.ok || !tok.access_token) throw new Error(`Microsoft sign-in refused: ${String(tok.error_description ?? tok.error ?? t.status).split('\r\n')[0].slice(0, 200)}`);
  const rcpt = (list: string[] = []) => list.map((address) => ({ emailAddress: { address } }));
  const r = await f(`${graph}/v1.0/users/${encodeURIComponent(s.from_address)}/sendMail`, {
    method: 'POST', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      saveToSentItems: true,
      message: {
        subject: m.subject, body: m.html ? { contentType: 'HTML', content: m.html } : { contentType: 'Text', content: m.text },
        toRecipients: rcpt(m.to), ccRecipients: rcpt(m.cc), ...(s.reply_to ? { replyTo: rcpt([s.reply_to]) } : {}),
        attachments: (m.attachments ?? []).map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.contentType, contentBytes: a.base64 })),
      },
    }),
  });
  if (r.status !== 202) {
    const e = await r.json().catch(() => ({}));
    throw new Error(`Microsoft 365 refused the message: ${String(e?.error?.message ?? r.status).slice(0, 200)}`);
  }
  return 'accepted by Microsoft 365';
}

async function deliver(s: Settings, m: Outgoing, opts: MailOptions): Promise<string> {
  const secret = s.sealed ? open(opts.secretKey, s.sealed) : null;
  if (s.transport === 'microsoft365') return sendGraph(s, secret ?? '', m, opts);
  return sendSmtp(s, secret, m);
}

/** Send a test message now, with the settings as saved, and say what the server answered. */
export async function sendTest(db: Db, ctx: Ctx, opts: MailOptions, to: string) {
  const s = await db.withTenant(ctx, async (tx) => { await authorize(tx, ctx, 'int.mail.manage'); return loadSettings(tx); });
  if (!s) throw new ValidationError('save the mail settings first');
  const m: Outgoing = { to: [checkAddress(to)], subject: 'BAATS ERP test message', text: 'This message shows that BAATS ERP can send email with these settings.',
    html: '<p>This message shows that <b>BAATS ERP</b> can send email with these settings.</p>' };
  try {
    const answer = await deliver(s, m, opts);
    return { sent: true, answer };
  } catch (err) {
    return { sent: false, answer: (err as Error).message };
  }
}

export const mailBackoffMs = (attempts: number) => Math.min(60_000 * 4 ** Math.max(0, attempts - 1), 6 * 3_600_000);

/** Send what is due for one tenant. Each message is claimed in its own short transaction. */
export async function dispatchMailTenant(db: Db, tenantId: string, opts: MailOptions): Promise<number> {
  const sys = { tenantId, userId: null };
  const due = await db.withTenant(sys, async (tx) => {
    const s = await loadSettings(tx);
    if (!s) return { s: null, ids: [] as string[] };
    return { s, ids: (await many(tx, `SELECT id FROM int.mails WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY created_at LIMIT 20`)).map((r) => r.id as string) };
  });
  if (!due.s) return 0;
  let sent = 0;
  for (const id of due.ids) {
    // Claim: push the next attempt out so a second dispatcher leaves it alone.
    const m = await db.withTenant(sys, (tx) => one(tx, `UPDATE int.mails SET next_attempt_at = now() + interval '10 minutes', attempts = attempts + 1
        WHERE id = $1 AND status = 'pending' AND next_attempt_at <= now() RETURNING *`, [id]));
    if (!m) continue;
    let error: string | null = null;
    try {
      await deliver(due.s, { to: m.to_addresses, cc: m.cc_addresses, subject: m.subject, text: m.body_text, html: m.body_html ?? undefined, attachments: m.attachments }, opts);
    } catch (err) { error = (err as Error).message.slice(0, 500); }
    await db.withTenant(sys, (tx) => tx.query(error
      ? `UPDATE int.mails SET last_error = $2, status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
           next_attempt_at = now() + make_interval(secs => $4::float / 1000) WHERE id = $1`
      : `UPDATE int.mails SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`,
    error ? [id, error, MAX_MAIL_ATTEMPTS, mailBackoffMs(m.attempts)] : [id]));
    if (!error) sent++;
  }
  return sent;
}

export async function dispatchMailAll(db: Db, opts: MailOptions): Promise<number> {
  const ids = await db.withTenant({ tenantId: '00000000-0000-0000-0000-000000000000', userId: null },
    async (tx) => (await tx.query('SELECT int.pending_mail_tenants() AS id')).rows.map((r) => r.id as string));
  let n = 0;
  for (const t of ids) n += await dispatchMailTenant(db, t, opts).catch(() => 0);
  return n;
}

// --- Approval notices ----------------------------------------------------------------------

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Tell approvers that something waits for them (when the mail service is set up and approval notices are on). */
export async function notifyApprovers(tx: Tx, instanceId: string, userIds: string[]) {
  const s = await one(tx, 'SELECT notify_approvals FROM int.mail_settings WHERE active');
  if (!s?.notify_approvals || !userIds.length) return;
  const inst = await one(tx, `SELECT i.entity_type, i.entity_id, i.payload AS context, d.name AS process, u.display_name AS requester
      FROM wf.instances i JOIN wf.definitions d ON d.id = i.definition_id LEFT JOIN iam.users u ON u.id = i.requester_user_id WHERE i.id = $1`, [instanceId]);
  if (!inst) return;
  const entityId = /^[0-9a-f-]{36}$/.test(inst.entity_id) ? inst.entity_id : undefined;
  const users = await many(tx, `SELECT id, email, display_name FROM iam.users WHERE id = ANY($1) AND status = 'active'`, [userIds]);
  const what = inst.context?.title ?? inst.context?.no ?? inst.context?.name ?? null;
  for (const u of users) {
    try { checkAddress(u.email); } catch { continue; }
    await queue(tx, null, {
      kind: 'approval', entityType: inst.entity_type, entityId, to: [u.email],
      subject: `Waiting for your approval: ${inst.process}${what && what !== inst.entity_type ? ` (${what})` : ''}`.slice(0, 200),
      text: `Hello ${u.display_name},\n\n${inst.requester ?? 'Someone'} asks for your approval: ${inst.process}${what ? ` - ${what}` : ''}.\n\nOpen BAATS (Approvals) or BAATS Mobile to approve or reject it.\n`,
      html: `<p>Hello ${esc(u.display_name)},</p><p>${esc(inst.requester ?? 'Someone')} asks for your approval: <b>${esc(inst.process)}</b>${what ? ` - ${esc(what)}` : ''}.</p><p>Open BAATS (Approvals) or BAATS Mobile to approve or reject it.</p>`,
    });
  }
}
