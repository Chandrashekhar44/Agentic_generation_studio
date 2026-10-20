
export async function emit(c, ws, genId, type, data = {}) {

  const { rows: [r] } = await c.query('UPDATE generations SET event_seq = event_seq + 1, updated_at = now() WHERE id=$1 RETURNING event_seq', [genId]);
  
  const payload = { ...data, seq: r.event_seq, generation_id: genId };
  await c.query('INSERT INTO generation_events (generation_id, seq, workspace_id, type, data) VALUES ($1,$2,$3,$4,$5)',
    [genId, r.event_seq, ws, type, JSON.stringify(payload)]);
  return r.event_seq;
}
