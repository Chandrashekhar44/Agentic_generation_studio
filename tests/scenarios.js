import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import pg from 'pg';
import * as L from './lib.js';
const { api, newUser, newWorkspace, grantCredits, startRun, waitRun, getRun, wallet, fast, slow, chaos, sleep, uuid, sign, readSSE } = L;

async function setup(credits = 1000, prefix = 'u') {
  const u = await newUser(prefix);
  const ws = await newWorkspace(u);
  if (credits) await grantCredits(ws, credits);
  return { u, ws };
}

export async function t1() {
  const { u, ws } = await setup(0);
  const raw = JSON.stringify({ id: `evt_${uuid()}`, type: 'payment.succeeded', workspace_id: ws, credits: 50 });
  const send = () => api('POST', '/webhooks/payments', { raw, headers: { 'x-signature': sign(raw), 'content-type': 'application/json' } });
  const rs = await Promise.all(Array.from({ length: 5 }, send));
  assert.ok(rs.every(r => r.status === 200), 'all deliveries acknowledged with 200');
  assert.equal(rs.filter(r => r.body.status === 'processed').length, 1, 'exactly one delivery processed');
  assert.equal(rs.filter(r => r.body.status === 'duplicate').length, 4);
  assert.equal((await send()).body.status, 'duplicate', 'late replay is a no-op');
  assert.equal((await wallet(u, ws)).available, 50, 'credited exactly once');
  const e = c => JSON.stringify({ id: `evt_${uuid()}`, type: 'payment.succeeded', workspace_id: ws, credits: c });
  const [e1, e2] = [e(10), e(20)];
  const post = raw => api('POST', '/webhooks/payments', { raw, headers: { 'x-signature': sign(raw) } });
  await Promise.all([post(e2), post(e1), post(e2), post(e1)]);
  const w = await wallet(u, ws);
  assert.equal(w.available, 80); assert.ok(w.verified, 'wallet projection matches ledger');
  const bad = await api('POST', '/webhooks/payments', { raw: e1, headers: { 'x-signature': 'sha256=' + '0'.repeat(64) } });
  assert.equal(bad.status, 401, 'bad signature rejected');
  assert.equal((await api('POST', '/webhooks/payments', { raw: e1 })).status, 401, 'missing signature rejected');
}

export async function t2() {
  await fast();
  const { u, ws } = await setup(60);
  let min = Infinity;
  let stop = false;
  const monitor = (async () => {
    while (!stop) {
      try {
        const w = await wallet(u, ws, 1);
        if (typeof w?.available === 'number') min = Math.min(min, w.available);
      } catch {}
      if (!stop) await sleep(40);
    }
  })();
  try {
    const rs = await Promise.all(Array.from({ length: 50 }, () => startRun(u, ws, { image_count: 1 })));
    const created = rs.filter(r => r.status === 201);
    const poor = rs.filter(r => r.status === 402);
    assert.equal(created.length, 10, `exactly 10 accepted (got ${created.length}; statuses ${[...new Set(rs.map(r => r.status))]})`);
    assert.equal(poor.length, 40, 'the other 40 rejected with 402');
    const runs = await Promise.all(created.map(r => waitRun(u, ws, r.body.id)));
    assert.ok(runs.every(r => r.status === 'succeeded'));
    const w = await wallet(u, ws);
    assert.equal(w.available, 0);
    assert.equal(w.held, 0);
    assert.ok(w.verified);
    assert.ok(min >= 0, `balance never negative (min observed ${min})`);
  } finally {
    stop = true;
    await monitor;
  }
}

export async function t3() {
  await slow(400, 800);
  const { u, ws } = await setup(100);
  const key = uuid();
  const rs = await Promise.all(Array.from({ length: 5 }, () => startRun(u, ws, { key, image_count: 1, prompt: 'same payload' })));
  assert.equal(new Set(rs.map(r => r.body.id)).size, 1, 'one run for one key');
  assert.equal(rs.filter(r => r.status === 201).length, 1, 'one creation');
  assert.ok(rs.filter(r => r.status === 200).every(r => r.headers.get('idempotent-replayed') === 'true'));
  const again = await startRun(u, ws, { key, image_count: 1, prompt: 'same payload' });
  assert.equal(again.status, 200); assert.equal(again.body.id, rs[0].body.id);
  const conflict = await startRun(u, ws, { key, image_count: 2, prompt: 'different payload' });
  assert.equal(conflict.status, 422, 'same key + different body is rejected');
  assert.equal((await api('POST', '/generations', { token: u.token, ws, body: { prompt: 'x' } })).status, 400, 'key is required');
  const run = await waitRun(u, ws, rs[0].body.id);
  assert.equal(run.status, 'succeeded');
  const w = await wallet(u, ws);
  assert.equal(w.available, 100 - 6, 'charged exactly once');
  assert.equal(w.recent.filter(e => e.generation_id === run.id && e.entry_type === 'reserve').length, 1);
  await fast();
}


export async function cancel() {
  await slow(3000, 4000);
  const { u, ws } = await setup(100);
  const r = await startRun(u, ws, { image_count: 3 });
  await waitRun(u, ws, r.body.id, { until: x => x.steps.some(s => s.status === 'running') });
  const c = await api('POST', `/generations/${r.body.id}/cancel`, { token: u.token, ws });
  assert.equal(c.body.status, 'canceled');
  assert.equal(c.body.credits.committed + c.body.credits.released, c.body.credits.reserved, 'everything reserved is accounted for');
  const w1 = await wallet(u, ws);
  assert.equal(w1.held, 0); assert.equal(w1.available, 100 - c.body.credits.committed); assert.ok(w1.verified);
  await sleep(4500);
  const w2 = await wallet(u, ws);
  assert.equal(w2.available, w1.available, 'late results are not charged');
  assert.equal((await api('POST', `/generations/${r.body.id}/cancel`, { token: u.token, ws })).status, 200, 'cancel is idempotent');
  await fast();
}

export async function cache() {
  await fast();
  const { u, ws } = await setup(100);
  const body = { prompt: 'cached forest', image_count: 1, seed: 7 };
  const a = await startRun(u, ws, body); await waitRun(u, ws, a.body.id);
  const b = await startRun(u, ws, body);
  assert.equal(b.status, 201); assert.equal(b.body.cached, true); assert.equal(b.body.status, 'succeeded');
  assert.equal(b.body.credits.reserved, 0);
  assert.equal((await wallet(u, ws)).available, 94, 'charged once');
  assert.equal((await api('GET', '/generations', { token: u.token, ws })).body.length, 2, 'cached run still appears in history');
}

export async function audit() {
  await fast();
  const { u, ws } = await setup(100);
  const r = await startRun(u, ws, { image_count: 1 }); await waitRun(u, ws, r.body.id);
  const ok = (await api('GET', '/audit/verify', { token: u.token, ws })).body;
  assert.equal(ok.ok, true); assert.ok(ok.entries >= 6);
  if (!process.env.ADMIN_DATABASE_URL) return;
  const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL }); await c.connect();
  try {
    await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_append_only');
    await c.query(`UPDATE audit_log SET data = jsonb_set(data, '{amount}', '999999') WHERE workspace_id=$1 AND seq=2`, [ws]);
    await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_append_only');
  } finally { await c.end(); }
  const bad = (await api('GET', '/audit/verify', { token: u.token, ws })).body;
  assert.equal(bad.ok, false); assert.equal(bad.broken_at_seq, 2);
}

const clean = fn => async () => {
  await fast();
  try { return await fn(); } finally { await fast().catch(() => {}); }
};
const raw = { t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, cancel, cache, audit };
export const ALL = Object.fromEntries(Object.entries(raw).map(([k, f]) => [k, clean(f)]));
