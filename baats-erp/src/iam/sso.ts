import { createHash, createPublicKey, createVerify, randomBytes, type JsonWebKey } from 'node:crypto';
import { ConflictError, NotFoundError, UnauthenticatedError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Db, type Tx } from '../core/db.ts';
import { authorize } from './authz.ts';
import { newToken, sha256 } from './crypto.ts';
import { open, seal } from '../ai/secrets.ts';
import type { Session } from './auth.ts';

/**
 * Sign-in with Microsoft 365 (Entra ID), Google Workspace or any OpenID Connect
 * provider: the authorization code flow with PKCE, a state and a nonce. The ID
 * token is checked here (RS256 signature against the provider's published keys,
 * issuer, audience, expiry, nonce). A user signs in only if a BAATS user with
 * the same email already exists and is active: nobody is created by signing in,
 * and the email's domain must be one the administrator allowed.
 */

export interface SsoOptions {
  secretKey: Buffer | null;
  /** Lets an issuer be http:// (a provider on this computer or network), for on-premises use and tests. */
  allowHttp?: boolean;
  fetchImpl?: typeof fetch;
}
type Kind = 'microsoft' | 'google' | 'oidc';

const SESSION_HOURS = 8;
const ATTEMPT_MINUTES = 10;
const SKEW_SECONDS = 120;

export function issuerFor(kind: Kind, input: { issuer?: string; msTenant?: string }): string {
  if (kind === 'google') return 'https://accounts.google.com';
  if (kind === 'microsoft') {
    const t = (input.msTenant ?? '').trim();
    // A single organisation: its directory id or one of its domains, never "common" (anyone with a Microsoft account).
    if (!/^[0-9a-f-]{36}$/i.test(t) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t)) throw new ValidationError('give the Microsoft 365 directory (tenant) id or its domain, for example contoso.onmicrosoft.com');
    return `https://login.microsoftonline.com/${t.toLowerCase()}/v2.0`;
  }
  const i = (input.issuer ?? '').trim().replace(/\/$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(i)) throw new ValidationError('give the provider\'s issuer address, for example https://id.example.com');
  return i;
}

// --- Provider metadata and keys, cached for an hour ---------------------------------------

const cache = new Map<string, { at: number; value: any }>();
async function getJson(opts: SsoOptions, url: string, ttlMs = 3_600_000): Promise<any> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  if (!url.startsWith('https://') && !(opts.allowHttp && url.startsWith('http://'))) throw new ValidationError(`the provider address must be https: ${url}`);
  const r = await (opts.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!r.ok) throw new ValidationError(`the sign-in provider answered ${r.status} for ${url}`);
  const value = await r.json();
  cache.set(url, { at: Date.now(), value });
  return value;
}
async function discovery(opts: SsoOptions, issuer: string) {
  const d = await getJson(opts, `${issuer}/.well-known/openid-configuration`);
  // Microsoft's multi-tenant metadata has "{tenantid}" in its issuer; a single directory's matches exactly.
  if (d.issuer !== issuer) throw new ValidationError(`the provider says its issuer is ${d.issuer}, not ${issuer}`);
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (typeof d[k] !== 'string') throw new ValidationError(`the provider's metadata has no ${k}`);
  return d as { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
}

const b64url = (b: Buffer) => b.toString('base64url');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');

/** Check an ID token and return its claims. */
export async function verifyIdToken(opts: SsoOptions, idToken: string, expect: { issuer: string; clientId: string; nonce: string; jwksUri: string }) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new UnauthenticatedError('the sign-in provider sent an unreadable token');
  let header: any, claims: any;
  try { header = JSON.parse(fromB64url(parts[0]).toString()); claims = JSON.parse(fromB64url(parts[1]).toString()); } catch { throw new UnauthenticatedError('the sign-in provider sent an unreadable token'); }
  if (header.alg !== 'RS256') throw new UnauthenticatedError(`the sign-in token is signed with ${header.alg}; BAATS accepts RS256`);
  const findKey = async (fresh: boolean) => {
    if (fresh) cache.delete(expect.jwksUri);
    const jwks = await getJson(opts, expect.jwksUri);
    return (jwks.keys ?? []).find((k: any) => k.kty === 'RSA' && (!header.kid || k.kid === header.kid));
  };
  // Providers rotate keys: an unknown key id fetches the keys again once.
  const jwk = (await findKey(false)) ?? (await findKey(true));
  if (!jwk) throw new UnauthenticatedError('the sign-in token is signed with a key the provider does not publish');
  const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e } as JsonWebKey, format: 'jwk' });
  const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(key, fromB64url(parts[2]));
  if (!ok) throw new UnauthenticatedError('the sign-in token signature is not valid');
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== expect.issuer) throw new UnauthenticatedError('the sign-in token is from another issuer');
  if (!aud.includes(expect.clientId)) throw new UnauthenticatedError('the sign-in token is for another application');
  if (aud.length > 1 && claims.azp !== expect.clientId) throw new UnauthenticatedError('the sign-in token is for another application');
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < now) throw new UnauthenticatedError('the sign-in token has expired; sign in again');
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > now) throw new UnauthenticatedError('the sign-in token is not valid yet; check this computer\'s clock');
  if (claims.nonce !== expect.nonce) throw new UnauthenticatedError('the sign-in token does not belong to this sign-in');
  return claims as Record<string, any>;
}

/** The email a provider vouches for. */
export function emailOf(kind: Kind, claims: Record<string, any>): string {
  if (kind === 'microsoft') {
    // Within one organisation's directory, the sign-in name is managed by its administrators.
    const e = claims.email ?? claims.preferred_username ?? claims.upn;
    if (typeof e !== 'string' || !e.includes('@')) throw new UnauthenticatedError('the Microsoft account has no email address');
    return e.toLowerCase();
  }
  if (typeof claims.email !== 'string' || claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new UnauthenticatedError('the provider did not confirm the email address of this account');
  }
  return claims.email.toLowerCase();
}

// --- Administration ------------------------------------------------------------------------

export async function listProviders(tx: Tx, ctx: Ctx) {
  await authorize(tx, ctx, 'iam.sso.manage');
  return many(tx, `SELECT p.id, p.kind, p.name, p.issuer, p.client_id, p.allowed_domains, p.active, p.created_at,
      (SELECT count(*)::int FROM iam.sessions s WHERE s.sso_provider_id = p.id) AS sign_ins
      FROM iam.sso_providers p ORDER BY p.created_at`);
}

export async function createProvider(tx: Tx, ctx: Ctx, opts: SsoOptions, input: { kind: Kind; name?: string; issuer?: string; msTenant?: string; clientId: string; clientSecret: string; allowedDomains?: string[] }) {
  await authorize(tx, ctx, 'iam.sso.manage');
  const issuer = issuerFor(input.kind, input);
  if (!input.clientId.trim() || !input.clientSecret.trim()) throw new ValidationError('the application (client) id and secret are both needed');
  const domains = [...new Set((input.allowedDomains ?? []).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  for (const d of domains) if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new ValidationError(`${d} is not an email domain`);
  if (input.kind !== 'microsoft' && !domains.length) throw new ValidationError('name the email domains that may sign in this way, for example yourcompany.com');
  await assertNotDuplicate(tx, issuer, input.clientId.trim());
  await discovery(opts, issuer);   // fails now, not at the first sign-in, if the issuer is wrong
  const sealed = seal(opts.secretKey, input.clientSecret.trim());
  const name = input.name?.trim() || ({ microsoft: 'Microsoft 365', google: 'Google', oidc: 'Single sign-on' } as const)[input.kind];
  const p = await one(tx, `INSERT INTO iam.sso_providers (tenant_id, kind, name, issuer, client_id, allowed_domains, created_by)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING id, kind, name, issuer, client_id, allowed_domains, active`,
  [input.kind, name, issuer, input.clientId.trim(), domains, ctx.userId]);
  await tx.query('INSERT INTO iam.sso_secrets (tenant_id, provider_id, sealed) VALUES (app.tenant(), $1, $2)', [p.id, sealed]);
  return p;
}

export async function updateProvider(tx: Tx, ctx: Ctx, opts: SsoOptions, id: string, input: { active?: boolean; allowedDomains?: string[]; clientSecret?: string; name?: string }) {
  await authorize(tx, ctx, 'iam.sso.manage');
  const p = await one(tx, 'SELECT * FROM iam.sso_providers WHERE id = $1', [id]);
  if (!p) throw new NotFoundError('sign-in provider');
  const domains = input.allowedDomains?.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (domains && p.kind !== 'microsoft' && !domains.length) throw new ValidationError('name the email domains that may sign in this way');
  await tx.query(`UPDATE iam.sso_providers SET active = coalesce($2, active), allowed_domains = coalesce($3, allowed_domains), name = coalesce($4, name) WHERE id = $1`,
    [id, input.active ?? null, domains ?? null, input.name?.trim() || null]);
  if (input.clientSecret) await tx.query('UPDATE iam.sso_secrets SET sealed = $2 WHERE provider_id = $1', [id, seal(opts.secretKey, input.clientSecret.trim())]);
  return one(tx, 'SELECT id, kind, name, issuer, client_id, allowed_domains, active FROM iam.sso_providers WHERE id = $1', [id]);
}

export async function deleteProvider(tx: Tx, ctx: Ctx, id: string) {
  await authorize(tx, ctx, 'iam.sso.manage');
  const r = await tx.query('DELETE FROM iam.sso_providers WHERE id = $1', [id]);
  if (!r.rowCount) throw new NotFoundError('sign-in provider');
  return { deleted: true };
}

// --- Signing in ----------------------------------------------------------------------------

const NOBODY = { tenantId: '00000000-0000-0000-0000-000000000000', userId: null };
async function tenantByCode(db: Db, code: string): Promise<string | null> {
  return db.withTenant(NOBODY, async (tx) => (await one(tx, 'SELECT platform.tenant_id_by_code($1) AS id', [code]))?.id ?? null);
}

/** The buttons for a company's sign-in page (no sign-in needed). */
export async function publicProviders(db: Db, tenantCode: string) {
  const tenantId = await tenantByCode(db, tenantCode);
  if (!tenantId) return [];
  return db.withTenant({ tenantId, userId: null }, (tx) => many(tx, 'SELECT id, kind, name FROM iam.sso_providers WHERE active ORDER BY created_at'));
}

/** Where to send the browser to sign in. returnTo is a path on this server. */
export async function startSignIn(db: Db, opts: SsoOptions, input: { tenant: string; providerId: string; redirectUri: string; returnTo?: string }) {
  const returnTo = input.returnTo ?? '/';
  if (!returnTo.startsWith('/') || returnTo.startsWith('//') || /[\\\r\n]/.test(returnTo)) throw new ValidationError('returnTo must be a path on this server');
  const tenantId = await tenantByCode(db, input.tenant);
  if (!tenantId) throw new NotFoundError('company');
  return db.withTenant({ tenantId, userId: null }, async (tx) => {
    const p = await one(tx, 'SELECT * FROM iam.sso_providers WHERE id = $1 AND active', [input.providerId]);
    if (!p) throw new NotFoundError('sign-in provider');
    const d = await discovery(opts, p.issuer);
    const state = `${tenantId}.${b64url(randomBytes(24))}`;
    const nonce = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    await tx.query('DELETE FROM iam.sso_attempts WHERE expires_at < now()');
    await tx.query(`INSERT INTO iam.sso_attempts (tenant_id, state_hash, provider_id, nonce, verifier, redirect_uri, return_to, expires_at)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7::int))`, [sha256(state), p.id, nonce, verifier, input.redirectUri, returnTo, ATTEMPT_MINUTES]);
    const u = new URL(d.authorization_endpoint);
    const q = { client_id: p.client_id, response_type: 'code', scope: 'openid email profile', redirect_uri: input.redirectUri, state, nonce,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', prompt: 'select_account' };
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return { url: u.toString() };
  });
}

/** The provider sent the browser back: exchange the code, check the token, open a session. */
export async function finishSignIn(db: Db, opts: SsoOptions, input: { state: string; code: string; ip?: string; userAgent?: string }): Promise<Session & { returnTo: string; tenantCode: string }> {
  const tenantId = input.state.split('.')[0];
  if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new UnauthenticatedError('this sign-in link is not valid; start again');
  type Out = { ok: true; s: Session & { returnTo: string; tenantCode: string } } | { ok: false; message: string };
  const out = await db.withTenant<Out>({ tenantId, userId: null }, async (tx) => {
    const a = await one(tx, 'DELETE FROM iam.sso_attempts WHERE state_hash = $1 RETURNING *', [sha256(input.state)]);
    if (!a || new Date(a.expires_at) < new Date()) return { ok: false, message: 'this sign-in has expired or was already used; start again' };
    const p = await one(tx, 'SELECT * FROM iam.sso_providers WHERE id = $1 AND active', [a.provider_id]);
    if (!p) return { ok: false, message: 'this way of signing in has been switched off' };
    const secret = open(opts.secretKey, (await one(tx, 'SELECT sealed FROM iam.sso_secrets WHERE provider_id = $1', [p.id])).sealed);
    const d = await discovery(opts, p.issuer);
    const r = await (opts.fetchImpl ?? fetch)(d.token_endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: a.redirect_uri, client_id: p.client_id,
        client_secret: secret, code_verifier: a.verifier }).toString(),
    });
    const tok = await r.json().catch(() => ({}));
    if (!r.ok || typeof tok.id_token !== 'string') {
      return { ok: false, message: `the sign-in provider refused: ${String(tok.error_description ?? tok.error ?? r.status).slice(0, 200)}` };
    }
    let claims: Record<string, any>, email: string;
    try {
      claims = await verifyIdToken(opts, tok.id_token, { issuer: p.issuer, clientId: p.client_id, nonce: a.nonce, jwksUri: d.jwks_uri });
      email = emailOf(p.kind, claims);
    } catch (err) { return { ok: false, message: (err as Error).message }; }
    const domain = email.split('@')[1];
    const audit = (action: string, userId: string | null, detail: object) =>
      tx.query(`SELECT audit.append('security', $1, 'iam.users', $2, NULL, $3)`, [action, userId, JSON.stringify({ provider: p.name, email, ip: input.ip ?? null, ...detail })]);
    if (p.allowed_domains.length && !p.allowed_domains.includes(domain)) {
      await audit('login_failed', null, { reason: 'domain not allowed' });
      return { ok: false, message: `${email} may not sign in this way; ask your administrator` };
    }
    const u = await one(tx, `SELECT id, status, mfa_enabled FROM iam.users WHERE lower(email) = $1`, [email]);
    if (!u || u.status !== 'active') {
      await audit('login_failed', u?.id ?? null, { reason: 'no active user with this email' });
      return { ok: false, message: `there is no BAATS user ${email} in this company; ask your administrator to add you` };
    }
    // Someone who has the BAATS authenticator on needs the provider to have asked for a second factor too.
    const mfa = Array.isArray(claims.amr) && claims.amr.some((m: string) => ['mfa', 'otp', 'hwk', 'swk', 'fido'].includes(m));
    if (u.mfa_enabled && !mfa) {
      await audit('login_failed', u.id, { reason: 'provider did not use a second factor' });
      return { ok: false, message: 'your account needs a second factor: sign in with your password and authenticator code, or ask for multi-factor sign-in at the provider' };
    }
    const token = `${tenantId}.${newToken()}`;
    const s = await one(tx, `INSERT INTO iam.sessions (tenant_id, user_id, token_hash, mfa_verified, expires_at, ip, user_agent, sso_provider_id)
      VALUES (app.tenant(), $1, $2, $3, now() + make_interval(hours => $4::int), $5, $6, $7) RETURNING expires_at`,
    [u.id, sha256(token), mfa, SESSION_HOURS, input.ip?.slice(0, 64) ?? null, input.userAgent?.slice(0, 300) ?? null, p.id]);
    await tx.query('UPDATE iam.users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
    await audit('login', u.id, { mfa, via: p.kind });
    const code = (await one(tx, 'SELECT code FROM platform.tenants WHERE id = app.tenant()'))?.code ?? '';
    return { ok: true, s: { token, userId: u.id, tenantId, expiresAt: s.expires_at.toISOString(), returnTo: a.return_to, tenantCode: code } };
  });
  if (!out.ok) throw new UnauthenticatedError(out.message);
  return out.s;
}

/** Guard so two administrators do not set up the same provider twice. */
async function assertNotDuplicate(tx: Tx, issuer: string, clientId: string) {
  if (await one(tx, 'SELECT 1 FROM iam.sso_providers WHERE issuer = $1 AND client_id = $2', [issuer, clientId])) throw new ConflictError('this provider is already set up');
}
