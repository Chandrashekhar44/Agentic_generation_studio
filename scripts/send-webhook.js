
import crypto from 'node:crypto';
const [ws, credits, ...rest] = process.argv.slice(2);
if (!ws || !credits) { console.error('usage: send-webhook.js <workspace_id> <credits> [--times N] [--id ID]'); process.exit(1); }
const arg = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
const times = +arg('--times', 5), id = arg('--id', `evt_${crypto.randomUUID()}`);
const BASE = process.env.BASE_URL || 'http://localhost:3000', SECRET = process.env.WEBHOOK_SECRET || 'dev-only-webhook-secret';
const raw = JSON.stringify({ id, type: 'payment.succeeded', workspace_id: ws, credits: +credits });
const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
const out = await Promise.all(Array.from({ length: times }, () => fetch(BASE + '/webhooks/payments', { method: 'POST', body: raw, headers: { 'x-signature': sig, 'content-type': 'application/json' } }).then(r => r.json())));
console.log(`event ${id} sent ${times}x concurrently:`, out.map(o => o.status).join(', '));
