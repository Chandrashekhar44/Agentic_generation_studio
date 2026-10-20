
import { HttpError } from './db.js';
import { appendAudit } from './audit.js';

export async function lockWallet(c, ws) {
  const { rows } = await c.query('SELECT available, held FROM wallets WHERE workspace_id=$1 FOR UPDATE', [ws]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'wallet not found');
  return rows[0];
}

const DELTAS = { grant: n => [n, 0], reserve: n => [-n, n], commit: n => [0, -n], release: n => [n, -n] };

async function post(c, { ws, type, amount, genId = null, stepId = null, key, meta = {} }) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('ledger amount must be a positive integer');
  const [dAvail, dHeld] = DELTAS[type](amount);
  const ins = await c.query(
    `INSERT INTO ledger (workspace_id, entry_type, amount, available_delta, held_delta, generation_id, step_id, idempotency_key, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING id`,
    [ws, type, amount, dAvail, dHeld, genId, stepId, key, JSON.stringify(meta)]);
  if (!ins.rowCount) return { applied: false };
  await c.query('UPDATE wallets SET available=available+$2, held=held+$3, updated_at=now() WHERE workspace_id=$1', [ws, dAvail, dHeld]);
  await appendAudit(c, ws, `ledger.${type}`, { ledger_id: ins.rows[0].id, amount, generation_id: genId, step_id: stepId, key });
  return { applied: true, id: ins.rows[0].id };
}

export async function grant(c, ws, amount, key, meta) {
  await lockWallet(c, ws);
  return post(c, { ws, type: 'grant', amount, key, meta });
}


export async function reserve(c, ws, amount, genId, key) {
  const w = await lockWallet(c, ws);
  if (w.available < amount) {
    throw new HttpError(402, 'insufficient_credits', 'not enough credits', {
      available: w.available,
      required: amount,
    });
  }
  return post(c, { ws, type: 'reserve', amount, genId, key });
}

export async function reserveLocked(c, ws, amount, genId, key) {
  return post(c, {
    ws,
    type: 'reserve',
    amount,
    genId,
    key,
  });
}


export async function commit(c, ws, amount, genId, stepId, key) {
  await lockWallet(c, ws);
  const r = await post(c, { ws, type: 'commit', amount, genId, stepId, key });
  if (r.applied) await c.query('UPDATE generations SET cost_committed = cost_committed + $2 WHERE id=$1', [genId, amount]);
  return r;
}

export async function releaseRemaining(c, ws, gen) {
  const { rows: [g] } = await c.query('SELECT cost_reserved, cost_committed, cost_released FROM generations WHERE id=$1', [gen.id]);
  const remaining = g.cost_reserved - g.cost_committed - g.cost_released;
  if (remaining <= 0) return 0;
  await lockWallet(c, ws);
  const r = await post(c, { ws, type: 'release', amount: remaining, genId: gen.id, key: `release:${gen.id}` });
  if (r.applied) await c.query('UPDATE generations SET cost_released = cost_released + $2 WHERE id=$1', [gen.id, remaining]);
  return r.applied ? remaining : 0;
}

export async function verifyWallet(c, ws) {
  const { rows: [w] } = await c.query('SELECT available, held FROM wallets WHERE workspace_id=$1', [ws]);
  const { rows: [s] } = await c.query(
    'SELECT COALESCE(SUM(available_delta),0)::bigint AS available, COALESCE(SUM(held_delta),0)::bigint AS held FROM ledger WHERE workspace_id=$1', [ws]);
  return { available: w.available, held: w.held, derived: { available: s.available, held: s.held },
           verified: w.available === s.available && w.held === s.held };
}
