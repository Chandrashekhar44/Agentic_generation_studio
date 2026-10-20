import crypto from 'node:crypto';
export const BASE = process.env.BASE_URL || 'http://localhost:3000';
export const PROVIDER = process.env.PROVIDER_URL || 'http://localhost:4000';
export const SECRET = process.env.WEBHOOK_SECRET || 'dev-only-webhook-secret';
export const uuid = () => crypto.randomUUID();
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const sign = raw => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
export const TERMINAL = ['succeeded', 'partial', 'failed', 'canceled'];

export async function api(method, path, { token, ws, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (ws) h['x-workspace-id'] = ws;
  if (body !== undefined && !raw) h['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

export async function newUser(prefix = 'user') {
  const email = `${prefix}-${uuid().slice(0, 8)}@test.dev`;
  const r = await api('POST', '/auth/signup', { body: { email, password: 'correct-horse-battery' } });
  if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.body)}`);
  return { token: r.body.token, id: r.body.user.id, email };
}
export async function newWorkspace(user, name = 'Test WS') {
  const r = await api('POST', '/workspaces', { token: user.token, body: { name } });
  if (r.status !== 201) throw new Error(`workspace failed: ${JSON.stringify(r.body)}`);
  return r.body.id;
}
export async function grantCredits(ws, credits, id = `evt_${uuid()}`) {
  const raw = JSON.stringify({ id, type: 'payment.succeeded', workspace_id: ws, credits });
  return api('POST', '/webhooks/payments', { raw, headers: { 'x-signature': sign(raw), 'content-type': 'application/json' } });
}
export async function chaos(cfg) {
  const r = await fetch(PROVIDER + '/chaos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) });
  return r.json();
}
export const fast = (extra = {}) => chaos({ provider: '*', reset: true, latency_min_ms: 30, latency_max_ms: 120, error_rate: 0, rate_limit_rate: 0, hang_rate: 0, ...extra });
export const slow = (min, max) => chaos({ provider: '*', reset: true, latency_min_ms: min, latency_max_ms: max, error_rate: 0, rate_limit_rate: 0, hang_rate: 0 });

export const wallet = (u, ws, limit = 200) => api('GET', `/wallet?limit=${limit}`, { token: u.token, ws }).then(r => r.body);
export const startRun = (u, ws, { prompt = `a lighthouse at dawn ${uuid().slice(0, 8)}`, style_id, image_count = 1, seed, key = uuid() } = {}) =>
  api('POST', '/generations', { token: u.token, ws, headers: { 'idempotency-key': key }, body: { prompt, style_id, image_count, seed } });
export const getRun = (u, ws, id) => api('GET', `/generations/${id}`, { token: u.token, ws }).then(r => r.body);
export async function waitRun(u, ws, id, { timeout = 90000, until = r => TERMINAL.includes(r.status) } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(u, ws, id);
    if (until(r)) return r;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for run ${id}; last status ${r.status}`);
    await sleep(150);
  }
}
export async function styles(u, ws) { return (await api('GET', '/styles', { token: u.token, ws })).body; }

export async function readSSE(path, { token, ws, lastEventId, stopAfter, timeout = 60000 }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const events = [];
  const headers = { authorization: `Bearer ${token}`, 'x-workspace-id': ws, accept: 'text/event-stream' };
  if (lastEventId) headers['last-event-id'] = String(lastEventId);
  const res = await fetch(BASE + path, { headers, signal: ac.signal });
  if (res.status !== 200) { clearTimeout(timer); throw new Error(`SSE status ${res.status}`); }
  const dec = new TextDecoder(); let buf = ''; let ended = false;
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = { id: null, type: 'message', data: '' };
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) ev.id = parseInt(line.slice(4), 10);
          else if (line.startsWith('event: ')) ev.type = line.slice(7);
          else if (line.startsWith('data: ')) ev.data += line.slice(6);
        }
        if (ev.type === 'end') { ended = true; continue; }
        if (ev.id !== null) { ev.data = JSON.parse(ev.data); events.push(ev); }
        if (stopAfter && events.length >= stopAfter) { ac.abort(); return { events, ended }; }
      }
    }
  } catch (e) { if (e.name !== 'AbortError' && !String(e).includes('abort')) throw e; }
  finally { clearTimeout(timer); }
  return { events, ended };
}
