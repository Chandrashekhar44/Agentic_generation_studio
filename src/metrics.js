
import { withSystem } from './db.js';

export const http = { total: new Map() };
export const countHttp = (method, status) => {
  const k = `${method}|${Math.floor(status / 100)}xx`;
  http.total.set(k, (http.total.get(k) || 0) + 1);
};

export async function renderMetrics() {
  return withSystem(async c => {
    const L = [];
    const g = (name, help, type = 'gauge') => { L.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`); };
    const q = async sql => (await c.query(sql)).rows;

    g('studio_queue_depth', 'Steps waiting to run, by kind');
    for (const r of await q(`SELECT kind, count(*)::int n FROM generation_steps WHERE status='pending' GROUP BY kind`)) L.push(`studio_queue_depth{kind="${r.kind}"} ${r.n}`);
    g('studio_steps_running', 'Steps currently leased by a worker');
    L.push(`studio_steps_running ${(await q(`SELECT count(*)::int n FROM generation_steps WHERE status='running' AND locked_until > now()`))[0].n}`);
    g('studio_steps_stale', 'Running steps whose lease expired (worker died); will be resumed');
    L.push(`studio_steps_stale ${(await q(`SELECT count(*)::int n FROM generation_steps WHERE status='running' AND locked_until <= now()`))[0].n}`);

    g('studio_runs', 'Generations by status');
    for (const r of await q(`SELECT status, count(*)::int n FROM generations GROUP BY status`)) L.push(`studio_runs{status="${r.status}"} ${r.n}`);

    g('studio_run_latency_seconds', 'End-to-end run latency (finished runs, non-cached)', 'histogram');
    const [h] = await q(`SELECT count(*)::int cnt, COALESCE(sum(extract(epoch from finished_at-created_at)),0)::float sum,
        count(*) FILTER (WHERE finished_at-created_at <= interval '10 s')::int b10, count(*) FILTER (WHERE finished_at-created_at <= interval '30 s')::int b30,
        count(*) FILTER (WHERE finished_at-created_at <= interval '60 s')::int b60, count(*) FILTER (WHERE finished_at-created_at <= interval '120 s')::int b120
        FROM generations WHERE finished_at IS NOT NULL AND NOT cached AND status IN ('succeeded','partial','failed')`);
    for (const [le, v] of [['10', h.b10], ['30', h.b30], ['60', h.b60], ['120', h.b120], ['+Inf', h.cnt]]) L.push(`studio_run_latency_seconds_bucket{le="${le}"} ${v}`);
    L.push(`studio_run_latency_seconds_sum ${h.sum}`, `studio_run_latency_seconds_count ${h.cnt}`);

    g('studio_provider_calls_total', 'Provider call outcomes (last 24h)', 'counter');
    for (const r of await q(`SELECT provider, kind, outcome, count(*)::int n FROM provider_calls WHERE created_at > now() - interval '24 hours' GROUP BY 1,2,3`))
      L.push(`studio_provider_calls_total{provider="${r.provider}",kind="${r.kind}",outcome="${r.outcome}"} ${r.n}`);
    g('studio_provider_failures_total', 'Failed provider calls by provider (last 24h)', 'counter');
    for (const r of await q(`SELECT provider, count(*)::int n FROM provider_calls WHERE created_at > now() - interval '24 hours' AND outcome IN ('http_5xx','timeout','network') GROUP BY 1`))
      L.push(`studio_provider_failures_total{provider="${r.provider}"} ${r.n}`);
    g('studio_provider_call_seconds_avg', 'Mean provider latency for successful calls (last 24h)');
    for (const r of await q(`SELECT provider, COALESCE(avg(duration_ms),0)::float/1000 s FROM provider_calls WHERE outcome='ok' AND created_at > now() - interval '24 hours' GROUP BY 1`))
      L.push(`studio_provider_call_seconds_avg{provider="${r.provider}"} ${r.s}`);

    g('studio_http_requests_total', 'API requests (this process)', 'counter');
    for (const [k, v] of http.total) { const [m, s] = k.split('|'); L.push(`studio_http_requests_total{method="${m}",status="${s}"} ${v}`); }
    return L.join('\n') + '\n';
  });
}

export async function adminTenants() {
  return withSystem(async c => {
    const { rows: tenants } = await c.query(`
      SELECT w.id, w.name, w.created_at,
        COALESCE((SELECT sum(amount) FROM ledger l WHERE l.workspace_id=w.id AND entry_type='grant'),0)::int  AS credits_granted,
        COALESCE((SELECT sum(amount) FROM ledger l WHERE l.workspace_id=w.id AND entry_type='commit'),0)::int AS credits_spent,
        wl.available, wl.held,
        count(g.*)::int AS runs,
        count(*) FILTER (WHERE g.status='succeeded')::int AS succeeded, count(*) FILTER (WHERE g.status='partial')::int AS partial,
        count(*) FILTER (WHERE g.status='failed')::int AS failed, count(*) FILTER (WHERE g.status='canceled')::int AS canceled,
        count(*) FILTER (WHERE g.status IN ('queued','planning','generating','composing'))::int AS active
      FROM workspaces w JOIN wallets wl ON wl.workspace_id=w.id LEFT JOIN generations g ON g.workspace_id=w.id
      GROUP BY w.id, wl.available, wl.held ORDER BY credits_spent DESC`);
    for (const t of tenants) {
      const finished = t.succeeded + t.partial + t.failed;
      t.failure_rate = finished ? +((t.failed + t.partial) / finished).toFixed(3) : 0;
    }
    const { rows: providers } = await c.query(`
      SELECT provider, count(*)::int AS calls,
             count(*) FILTER (WHERE outcome IN ('http_5xx','timeout','network'))::int AS failures,
             count(*) FILTER (WHERE outcome='http_429')::int AS rate_limited
        FROM provider_calls WHERE created_at > now() - interval '24 hours' AND outcome NOT LIKE 'breaker%' GROUP BY provider ORDER BY provider`);
    for (const p of providers) p.failure_rate = p.calls ? +(p.failures / p.calls).toFixed(3) : 0;
    return { tenants, providers };
  });
}
