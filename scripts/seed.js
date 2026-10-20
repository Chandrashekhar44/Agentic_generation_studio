import crypto from 'node:crypto';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SECRET = process.env.WEBHOOK_SECRET || 'dev-only-webhook-secret';
const PASSWORD = 'demo-password';

async function call(method, path, { token, ws, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (ws) h['x-workspace-id'] = ws;
  if (body) h['content-type'] = 'application/json';
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(BASE + path, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined) });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } catch (e) { if (i > 20) throw e; await new Promise(r => setTimeout(r, 1000)); }
  }
}
async function user(email, name) {
  let r = await call('POST', '/auth/signup', { body: { email, password: PASSWORD, name } });
  if (r.status === 409) r = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
  return { token: r.body.token, id: r.body.user.id, email };
}
async function workspace(u, name) {
  const list = (await call('GET', '/workspaces', { token: u.token })).body;
  return list.find(w => w.name === name)?.id ?? (await call('POST', '/workspaces', { token: u.token, body: { name } })).body.id;
}
async function credit(ws, credits) {
  const raw = JSON.stringify({ id: `evt_seed_${ws}`, type: 'payment.succeeded', workspace_id: ws, credits });  
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return (await call('POST', '/webhooks/payments', { raw, headers: { 'x-signature': sig, 'content-type': 'application/json' } })).body.status;
}

const alice = await user('alice@demo.test', 'Alice');
const bob = await user('bob@demo.test', 'Bob');
const acme = await workspace(alice, 'Acme Studio');
await call('POST', `/workspaces/${acme}/invites`, { token: alice.token, body: { email: bob.email, role: 'member' } });
const globex = await workspace(bob, 'Globex (Bob only)');
console.log('acme credits:', await credit(acme, 200), '| globex credits:', await credit(globex, 200));
console.log(`
Demo accounts (password: ${PASSWORD})
  alice@demo.test  owner of "Acme Studio"            (workspace ${acme})
  bob@demo.test    member of "Acme Studio", owner of "Globex (Bob only)"  (workspace ${globex})
Open http://localhost:3000 — use two browsers to watch isolation and live progress.
`);
