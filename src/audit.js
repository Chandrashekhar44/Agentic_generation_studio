
import { sha256, canonical } from './util.js';

const GENESIS = '0'.repeat(64);
const digest = (prev, ws, seq, type, data, ts) => sha256(`${prev}|${canonical({ workspace_id: ws, seq, type, data, ts })}`);

export async function appendAudit(c, ws, type, data) {
  await c.query('INSERT INTO audit_heads (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING', [ws]);
  const { rows: [h] } = await c.query('SELECT last_seq, last_hash FROM audit_heads WHERE workspace_id=$1 FOR UPDATE', [ws]);
  const seq = h.last_seq + 1;
  const ts = new Date().toISOString();
  const hash = digest(h.last_hash, ws, seq, type, data, ts);
  await c.query('INSERT INTO audit_log (workspace_id, seq, type, data, ts, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [ws, seq, type, JSON.stringify(data), ts, h.last_hash, hash]);
  await c.query('UPDATE audit_heads SET last_seq=$2, last_hash=$3 WHERE workspace_id=$1', [ws, seq, hash]);
}

export async function verifyAudit(c, ws) {
  const { rows } = await c.query('SELECT * FROM audit_log WHERE workspace_id=$1 ORDER BY seq', [ws]);
  const head = (await c.query('SELECT last_seq, last_hash FROM audit_heads WHERE workspace_id=$1', [ws])).rows[0];
  let prev = GENESIS, expectSeq = 1;
  for (const r of rows) {
    if (r.seq !== expectSeq) return { ok: false, entries: rows.length, broken_at_seq: expectSeq, reason: 'missing or reordered entry' };
    if (r.prev_hash !== prev) return { ok: false, entries: rows.length, broken_at_seq: r.seq, reason: 'prev_hash mismatch' };
    if (digest(prev, ws, r.seq, r.type, r.data, r.ts) !== r.hash) return { ok: false, entries: rows.length, broken_at_seq: r.seq, reason: 'hash mismatch (entry modified)' };
    prev = r.hash; expectSeq++;
  }
  if (head && (head.last_seq !== rows.length || head.last_hash !== prev))
    return { ok: false, entries: rows.length, broken_at_seq: rows.length, reason: 'head does not match chain tail (truncated?)' };
  return { ok: true, entries: rows.length, head_hash: prev };
}
