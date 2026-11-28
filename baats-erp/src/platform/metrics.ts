import type { Db } from '../core/db.ts';

/**
 * Counters for monitoring, in the Prometheus text format: requests by route
 * and status class, how long they took, the database connection pool, the
 * process, and work waiting in the outboxes. Kept in memory per server process.
 */

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Metrics {
  private requests = new Map<string, number>();
  private durations = new Map<string, { buckets: number[]; sum: number; count: number }>();
  private started = Date.now();
  private errors5xx = 0;

  record(method: string, route: string, status: number, seconds: number) {
    const cls = `${Math.floor(status / 100)}xx`;
    const key = `${method}\u0000${route}\u0000${cls}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    if (status >= 500) this.errors5xx++;
    const dk = `${method}\u0000${route}`;
    let d = this.durations.get(dk);
    if (!d) { d = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }; this.durations.set(dk, d); }
    BUCKETS.forEach((b, i) => { if (seconds <= b) d!.buckets[i]++; });
    d.sum += seconds; d.count++;
  }

  /** The whole page, with gauges read now. */
  async render(db: Db): Promise<string> {
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const out: string[] = [];
    out.push('# HELP baats_http_requests_total Requests answered, by route and status class.', '# TYPE baats_http_requests_total counter');
    for (const [k, n] of this.requests) {
      const [m, r, c] = k.split('\u0000');
      out.push(`baats_http_requests_total{method="${m}",route="${esc(r)}",status="${c}"} ${n}`);
    }
    out.push('# HELP baats_http_request_duration_seconds Time to answer, by route.', '# TYPE baats_http_request_duration_seconds histogram');
    for (const [k, d] of this.durations) {
      const [m, r] = k.split('\u0000');
      const l = `method="${m}",route="${esc(r)}"`;
      BUCKETS.forEach((b, i) => out.push(`baats_http_request_duration_seconds_bucket{${l},le="${b}"} ${d.buckets[i]}`));
      out.push(`baats_http_request_duration_seconds_bucket{${l},le="+Inf"} ${d.count}`, `baats_http_request_duration_seconds_sum{${l}} ${d.sum.toFixed(6)}`,
        `baats_http_request_duration_seconds_count{${l}} ${d.count}`);
    }
    out.push('# HELP baats_http_server_errors_total Answers with a 5xx status.', '# TYPE baats_http_server_errors_total counter', `baats_http_server_errors_total ${this.errors5xx}`);
    const p = db.pool;
    out.push('# HELP baats_db_pool_connections Database connections, by state.', '# TYPE baats_db_pool_connections gauge',
      `baats_db_pool_connections{state="total"} ${p.totalCount}`, `baats_db_pool_connections{state="idle"} ${p.idleCount}`,
      `baats_db_pool_connections{state="waiting"} ${p.waitingCount}`);
    const mem = process.memoryUsage();
    out.push('# HELP baats_process_resident_memory_bytes Memory in use.', '# TYPE baats_process_resident_memory_bytes gauge', `baats_process_resident_memory_bytes ${mem.rss}`,
      '# HELP baats_process_uptime_seconds Seconds since the server started.', '# TYPE baats_process_uptime_seconds gauge', `baats_process_uptime_seconds ${((Date.now() - this.started) / 1000).toFixed(0)}`);
    let dbUp = 1, dbSeconds = 0, mailTenants = 0;
    const t0 = process.hrtime.bigint();
    try {
      const c = await p.connect();
      try {
        await c.query('SELECT 1');
        dbSeconds = Number(process.hrtime.bigint() - t0) / 1e9;
        mailTenants = (await c.query('SELECT count(*)::int AS n FROM int.pending_mail_tenants()')).rows[0].n;
      } finally { c.release(); }
    } catch { dbUp = 0; }
    out.push('# HELP baats_db_up Whether the database answers.', '# TYPE baats_db_up gauge', `baats_db_up ${dbUp}`,
      '# HELP baats_db_ping_seconds Time for the database to answer SELECT 1.', '# TYPE baats_db_ping_seconds gauge', `baats_db_ping_seconds ${dbSeconds.toFixed(6)}`,
      '# HELP baats_mail_tenants_waiting Organizations with email due to be sent.', '# TYPE baats_mail_tenants_waiting gauge', `baats_mail_tenants_waiting ${mailTenants}`);
    return out.join('\n') + '\n';
  }
}
