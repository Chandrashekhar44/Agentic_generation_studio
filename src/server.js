import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { log } from './log.js';
import { withTenant, withSystem, HttpError } from './db.js';
import { authenticate, workspaceContext, hashPassword, verifyPassword, signToken } from './auth.js';
import { rateLimit } from './ratelimit.js';
import { isUuid, sleep } from './util.js';
import * as domain from './domain.js';
import * as pipeline from './pipeline.js';
import { renderMetrics, adminTenants, countHttp } from './metrics.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  req.id = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 64);
  res.set('X-Request-Id', req.id);
  const t0 = Date.now();
  res.on('finish', () => {
    countHttp(req.method, res.statusCode);
    if (req.path === '/healthz' || req.path === '/metrics') return;
    log.info('http', { req_id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0,
      user_id: req.user?.id, workspace_id: req.ws?.id, run_id: req.params?.id && isUuid(req.params.id) ? req.params.id : undefined });
  });
  next();
});

const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const auth = authenticate();
const wsHeader = workspaceContext({ source: 'header' });
const wsParam = workspaceContext({ source: 'param' });
const wsParamOwner = workspaceContext({ source: 'param', ownerOnly: true });
const authLimiter = rateLimit(config.authRateLimit, req => req.ip, 'auth');
const genLimiter = rateLimit(config.rateLimit, req => req.ws.id, 'per-workspace');

app.get('/healthz', h(async (_req, res) => { await withSystem(c => c.query('SELECT 1')); res.json({ ok: true }); }));
app.get('/metrics', h(async (_req, res) => { res.type('text/plain; version=0.0.4').send(await renderMetrics()); }));

app.post('/webhooks/payments', express.raw({ type: '*/*', limit: '100kb' }), h(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const out = await domain.handlePaymentWebhook(raw, req.headers['x-signature']);
  res.status(200).json(out);
}));

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')));

const bad = (msg) => new HttpError(400, 'validation_error', msg);
const str = (v, name, { min = 1, max = 200, optional = false } = {}) => {
  if (v === undefined || v === null) { if (optional) return undefined; throw bad(`${name} is required`); }
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw bad(`${name} must be a string of ${min}-${max} characters`);
  return v.trim();
};
const int = (v, name, { min, max, def }) => {
  if (v === undefined || v === null) { if (def !== undefined) return def; throw bad(`${name} is required`); }
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${name} must be an integer ${min}-${max}`);
  return v;
};
const idParam = (req) => { if (!isUuid(req.params.id)) throw new HttpError(404, 'not_found', 'not found'); return req.params.id; };

app.post('/auth/signup', authLimiter, h(async (req, res) => {
  const email = str(req.body.email, 'email', { max: 254 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('email is invalid');
  const password = str(req.body.password, 'password', { min: 8, max: 200 });
  const name = str(req.body.name, 'name', { max: 80, optional: true }) || email.split('@')[0];
  const user = await withSystem(async c => {
    try {
      const { rows: [u] } = await c.query('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id, email, name', [email, name, hashPassword(password)]);
      const inv = await c.query(`UPDATE invites SET accepted_at=now() WHERE email=$1 AND accepted_at IS NULL RETURNING workspace_id, role`, [email]);
      for (const i of inv.rows) await c.query('INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [i.workspace_id, u.id, i.role]);
      return u;
    } catch (e) { if (e.code === '23505') throw new HttpError(409, 'email_taken', 'an account with this email already exists'); throw e; }
  });
  res.status(201).json({ token: signToken(user), user });
}));

app.post('/auth/login', authLimiter, h(async (req, res) => {
  const email = str(req.body.email, 'email', { max: 254 }).toLowerCase();
  const password = str(req.body.password, 'password', { max: 200 });
  const { rows: [u] } = await withSystem(c => c.query('SELECT id, email, name, password_hash FROM users WHERE email=$1', [email]));
  if (!u || !verifyPassword(password, u.password_hash)) throw new HttpError(401, 'invalid_credentials', 'email or password is wrong');
  res.json({ token: signToken(u), user: { id: u.id, email: u.email, name: u.name } });
}));

app.get('/me', auth, h(async (req, res) => {
  res.json({ user: req.user, workspaces: await domain.listWorkspaces(req.user.id) });
}));

app.get('/workspaces', auth, h(async (req, res) => res.json(await domain.listWorkspaces(req.user.id))));
app.post('/workspaces', auth, h(async (req, res) => {
  res.status(201).json(await domain.createWorkspace(req.user.id, str(req.body.name, 'name', { max: 80 })));
}));
app.get('/workspaces/:wid/members', auth, wsParam, h(async (req, res) => res.json(await domain.listMembers(req.ctx))));
app.post('/workspaces/:wid/invites', auth, wsParamOwner, h(async (req, res) => {
  const email = str(req.body.email, 'email', { max: 254 }).toLowerCase();
  const role = req.body.role ?? 'member';
  if (!['owner', 'member'].includes(role)) throw bad("role must be 'owner' or 'member'");
  res.status(201).json(await domain.inviteMember(req.ctx, email, role));
}));

app.get('/wallet', auth, wsHeader, h(async (req, res) => res.json(await domain.getWallet(req.ctx, int(+req.query.limit || 20, 'limit', { min: 1, max: 200 })))));
app.get('/audit', auth, wsHeader, h(async (req, res) => res.json(await domain.listAudit(req.ctx))));
app.get('/audit/verify', auth, wsHeader, h(async (req, res) => res.json(await domain.verifyAuditChain(req.ctx))));

const styleBody = (b, partial) => {
  const out = {
    name: str(b.name, 'name', { max: 80, optional: partial }),
    prompt_suffix: str(b.prompt_suffix ?? (partial ? undefined : ''), 'prompt_suffix', { min: 0, max: 500, optional: true }),
    negative_prompt: str(b.negative_prompt ?? (partial ? undefined : ''), 'negative_prompt', { min: 0, max: 500, optional: true }),
    params: b.params,
  };
  if (out.params !== undefined && (typeof out.params !== 'object' || Array.isArray(out.params) || out.params === null || JSON.stringify(out.params).length > 2000)) throw bad('params must be an object (<2KB)');
  return out;
};
app.get('/styles', auth, wsHeader, h(async (req, res) => res.json(await domain.listStyles(req.ctx))));
app.post('/styles', auth, wsHeader, h(async (req, res) => res.status(201).json(await domain.createStyle(req.ctx, styleBody(req.body, false)))));
app.get('/styles/:id', auth, wsHeader, h(async (req, res) => res.json(await domain.getStyle(req.ctx, idParam(req)))));
app.put('/styles/:id', auth, wsHeader, h(async (req, res) => res.json(await domain.updateStyle(req.ctx, idParam(req), styleBody(req.body, true)))));
app.delete('/styles/:id', auth, wsHeader, h(async (req, res) => { await domain.archiveStyle(req.ctx, idParam(req)); res.status(204).end(); }));

app.post('/generations', auth, wsHeader, genLimiter, h(async (req, res) => {
  const idemKey = req.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey.length < 1 || idemKey.length > 200) throw bad('Idempotency-Key header is required (1-200 chars)');
  const prompt = str(req.body.prompt, 'prompt', { max: 2000 });
  const styleId = req.body.style_id ?? null;
  if (styleId !== null && !isUuid(styleId)) throw bad('style_id must be a uuid');
  const imageCount = int(req.body.image_count, 'image_count', { min: 1, max: 8, def: 3 });
  const seed = int(req.body.seed, 'seed', { min: 0, max: 2147483647, def: 0 });
  const { generation, replay } = await pipeline.createGeneration(req.ctx, { prompt, styleId, imageCount, seed, idemKey });
  const body = await pipeline.getGeneration(req.ctx, generation.id);
  if (replay) res.set('Idempotent-Replayed', 'true');
  res.status(replay ? 200 : 201).location(`/generations/${generation.id}`).json(body);
}));

app.get('/generations', auth, wsHeader, h(async (req, res) => {
  res.json(await pipeline.listGenerations(req.ctx, { limit: int(+req.query.limit || 30, 'limit', { min: 1, max: 100 }), before: req.query.before }));
}));
app.get('/generations/:id', auth, wsHeader, h(async (req, res) => res.json(await pipeline.getGeneration(req.ctx, idParam(req)))));
app.post('/generations/:id/cancel', auth, wsHeader, h(async (req, res) => {
  await pipeline.cancelGeneration(req.ctx, idParam(req));
  res.json(await pipeline.getGeneration(req.ctx, req.params.id));
}));

app.get('/generations/:id/video', auth, wsHeader, h(async (req, res) => {
  const v = await pipeline.getVideo(req.ctx, idParam(req));
  res.set({ 'Content-Type': v.mime, 'Content-Length': v.data.length, 'Cache-Control': 'private, max-age=3600' }).end(v.data);
}));

const sseAuth = authenticate(true); 
app.get('/generations/:id/events', sseAuth, wsHeader, h(async (req, res) => {
  const id = idParam(req);
  const exists = await withTenant(req.ctx, async c => (await c.query('SELECT 1 FROM generations WHERE id=$1', [id])).rowCount);
  if (!exists) throw new HttpError(404, 'not_found', 'generation not found');
  let last = parseInt(req.headers['last-event-id'] ?? req.query.last_event_id ?? '0', 10);
  if (!Number.isFinite(last) || last < 0) last = 0;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 1500\n\n');
  let closed = false;
  req.on('close', () => { closed = true; });
  let lastWrite = Date.now();
  while (!closed) {
    let rows;
    try {
      rows = await withTenant(req.ctx, async c => (await c.query(
        'SELECT seq, type, data FROM generation_events WHERE generation_id=$1 AND seq > $2 ORDER BY seq LIMIT 200', [id, last])).rows);
    } catch (e) { log.error('sse poll failed', { req_id: req.id, err: e.message }); break; }
    for (const e of rows) {
      res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
      last = e.seq; lastWrite = Date.now();
      if (e.type === 'generation.completed') { res.write('event: end\ndata: {}\n\n'); return res.end(); }
    }
    if (Date.now() - lastWrite > 15000) { res.write(': ping\n\n'); lastWrite = Date.now(); }
    await sleep(rows.length === 200 ? 0 : 400);
  }
  res.end();
}));

if (config.devRoutes) {
  app.post('/dev/simulate-payment', auth, wsHeader, h(async (req, res) => {
    const credits = int(req.body.credits, 'credits', { min: 1, max: 100000, def: 100 });
    const raw = JSON.stringify({ id: `evt_dev_${crypto.randomUUID()}`, type: 'payment.succeeded', workspace_id: req.ws.id, credits, created: Date.now() });
    res.json(await domain.handlePaymentWebhook(raw, domain.signPayload(raw)));
  }));
}

app.get('/admin/tenants', h(async (req, res) => {
  const a = Buffer.from(String(req.headers['x-admin-token'] || '')), b = Buffer.from(config.adminToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'unauthorized', 'admin token required');
  res.json(await adminTenants());
}));

app.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'route not found')));
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') err = new HttpError(400, 'invalid_json', 'request body is not valid JSON');
  if (err instanceof HttpError) {
    if (err.extra.retryAfter) res.set('Retry-After', String(err.extra.retryAfter));
    return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  }
  log.error('unhandled', { req_id: req.id, err: err.stack || String(err) });
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'internal_error', message: 'unexpected error', request_id: req.id });
});

const server = app.listen(config.port, () => log.info('api listening', { port: config.port }));
server.keepAliveTimeout = 65000;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
