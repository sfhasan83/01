/**
 * A load test of a running BAATS: many people at once reading the busiest
 * pages and, with --writes, posting sales invoices, for a fixed time.
 *
 *   node scripts/loadtest.ts --url http://127.0.0.1:3000 --tenant demo \
 *     --email admin@demo.test --password '...' --workers 20 --seconds 60 [--writes] [--company <unit id>]
 *
 * Each worker signs in once and then sends one request after another. It
 * reports requests a second, the time the slowest 50%, 5% and 1% took, and
 * every error. The books need a company (and for --writes an active customer:
 * the console's Load demo data makes both). BAATS limits one sign-in to 1,200
 * requests a minute: for a load test start it with API_REQUESTS_PER_MINUTE
 * higher (or apiRequestsPerMinute in the trial's config.json), otherwise the
 * extra requests come back as 429 and are counted as limited, not as errors.
 * --writes posts real invoices into the books: use a test company.
 */
const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? 'true' : v;
};
const URL_ = (arg('url', 'http://127.0.0.1:3000') as string).replace(/\/$/, '');
const tenant = arg('tenant'), email = arg('email'), password = arg('password'), totp = arg('totp');
const workers = Number(arg('workers', '20')), seconds = Number(arg('seconds', '30')), writes = arg('writes') === 'true';
if (!tenant || !email || !password) { console.error('usage: node scripts/loadtest.ts --tenant <code> --email <email> --password <password> [--url] [--workers 20] [--seconds 30] [--writes]'); process.exit(2); }

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(URL_ + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, data: text && r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}
const signIn = async () => {
  const r = await call(null, 'POST', '/v1/auth/login', { tenant, email, password, ...(totp ? { totp } : {}) });
  if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${JSON.stringify(r.data)}`);
  return (r.data.session ?? r.data).token as string;
};

const token0 = await signIn();
// The first unit with books, unless --company names one.
let co = arg('company'), country = 'AE';
for (const u of (await call(token0, 'GET', '/v1/org/units')).data as any[]) {
  if (co && u.id !== co) continue;
  if ((await call(token0, 'GET', `/v1/fin/companies/${u.id}/accounts`)).status === 200) { co = u.id; country = u.country_code; break; }
}
if (!co) { console.error('this company has no books; set them up first (Load demo data in the console)'); process.exit(2); }
const today = new Date().toISOString().slice(0, 10);
const year = today.slice(0, 4);
let customer: string | undefined;
if (writes) {
  const ps = (await call(token0, 'GET', '/v1/mdm/parties')).data as any[];
  customer = ps.find((p) => p.is_customer && p.status === 'active')?.id;
  if (!customer) { console.error('--writes needs an active customer'); process.exit(2); }
}

// What people do most: open the dashboard, look at lists and balances, check their inbox.
const READS: [string, string, number][] = [
  ['dashboard', `/v1/bi/companies/${co}/dashboard?from=${year}-01-01&to=${today}`, 3],
  ['trial balance', `/v1/fin/companies/${co}/trial-balance?from=${year}-01-01&to=${today}`, 2],
  ['invoices', `/v1/fin/companies/${co}/invoices`, 3],
  ['stock', `/v1/inv/companies/${co}/stock`, 2],
  ['parties', '/v1/mdm/parties', 2],
  ['items', '/v1/mdm/items', 1],
  ['inbox', '/v1/wf/inbox', 2],
  ['me', '/v1/me', 1],
];
const bag = READS.flatMap(([name, path, w]) => Array.from({ length: w }, () => [name, path] as const));

type Stat = { times: number[]; errors: Map<string, number>; limited: number };
const stats = new Map<string, Stat>();
const record = (name: string, ms: number, status: number, detail = '') => {
  const s = stats.get(name) ?? { times: [], errors: new Map(), limited: 0 };
  stats.set(name, s);
  if (status === 429) { s.limited++; return; }
  if (status >= 400 || status === 0) { const k = `${status} ${detail}`.slice(0, 120); s.errors.set(k, (s.errors.get(k) ?? 0) + 1); return; }
  s.times.push(ms);
};
const timed = async (name: string, fn: () => Promise<{ status: number; data: any }>) => {
  const t = performance.now();
  try { const r = await fn(); record(name, performance.now() - t, r.status, r.status >= 400 ? (r.data?.message ?? '') : ''); return r; }
  catch (err) { record(name, performance.now() - t, 0, (err as Error).message); return null; }
};

const end = Date.now() + seconds * 1000;
console.log(`BAATS load test: ${workers} workers for ${seconds} s against ${URL_}${writes ? ', with invoice posting' : ''}...`);
let n = 0;
async function worker(i: number) {
  const token = await signIn();
  while (Date.now() < end) {
    n++;
    if (writes && n % 10 === 0) {
      const inv = await timed('post invoice', () => call(token, 'POST', `/v1/fin/companies/${co}/invoices`, { kind: 'sales_invoice', partyId: customer, date: today,
        lines: [{ description: `Load test ${i}-${n}`, quantity: 1 + (n % 5), unitPrice: 100, taxCode: ['QA', 'KW'].includes(country) ? 'NV' : 'SR' }] }));
      if (inv?.status === 200 || inv?.status === 201) await timed('post invoice', () => call(token, 'POST', `/v1/fin/invoices/${inv.data.id}/post`));
      continue;
    }
    const [name, path] = bag[Math.floor(Math.random() * bag.length)];
    await timed(name, () => call(token, 'GET', path));
  }
}
const t0 = performance.now();
// Sign-ins are limited too, so workers start a little apart.
await Promise.all(Array.from({ length: workers }, (_, i) => new Promise((r) => setTimeout(r, i * 50)).then(() => worker(i))));
const took = (performance.now() - t0) / 1000;

const pct = (xs: number[], p: number) => xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : NaN;
let ok = 0, bad = 0, limited = 0;
const all: number[] = [];
console.log('\nrequest           count   per s   50%     95%     99%    errors  limited');
for (const [name, s] of [...stats.entries()].sort()) {
  s.times.sort((a, b) => a - b); all.push(...s.times);
  const e = [...s.errors.values()].reduce((a, b) => a + b, 0);
  ok += s.times.length; bad += e; limited += s.limited;
  console.log(`${name.padEnd(16)} ${String(s.times.length).padStart(6)} ${(s.times.length / took).toFixed(1).padStart(7)} ${pct(s.times, 50).toFixed(0).padStart(5)} ms ${pct(s.times, 95).toFixed(0).padStart(5)} ms ${pct(s.times, 99).toFixed(0).padStart(5)} ms ${String(e).padStart(6)} ${String(s.limited).padStart(8)}`);
}
all.sort((a, b) => a - b);
console.log(`${'all'.padEnd(16)} ${String(ok).padStart(6)} ${(ok / took).toFixed(1).padStart(7)} ${pct(all, 50).toFixed(0).padStart(5)} ms ${pct(all, 95).toFixed(0).padStart(5)} ms ${pct(all, 99).toFixed(0).padStart(5)} ms ${String(bad).padStart(6)} ${String(limited).padStart(8)}`);
for (const [name, s] of stats) for (const [k, c] of s.errors) console.log(`  error in ${name}: ${k} (x${c})`);
if (limited) console.log('  Some requests were limited (429): start BAATS with API_REQUESTS_PER_MINUTE higher to measure beyond the limit.');
process.exit(bad ? 1 : 0);
