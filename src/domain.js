import crypto from 'node:crypto';
import { config } from './config.js';
import { withTenant, HttpError } from './db.js';
import * as ledger from './ledger.js';
import { appendAudit, verifyAudit } from './audit.js';

const DEFAULT_STYLES = [
  { name: 'Cinematic', prompt_suffix: 'cinematic lighting, shallow depth of field, 35mm film grain', negative_prompt: 'blurry, low quality, watermark', params: { guidance: 7, aspect_ratio: '16:9' } },
  { name: 'Anime', prompt_suffix: 'vibrant anime style, clean line art, cel shading', negative_prompt: 'photorealistic, muddy colours', params: { guidance: 8, aspect_ratio: '16:9' } },
  { name: 'Noir', prompt_suffix: 'high-contrast black and white, rain-soaked streets, film noir', negative_prompt: 'colour, oversaturated', params: { guidance: 6, aspect_ratio: '16:9' } },
];

export async function createWorkspace(userId, name) {
  const id = crypto.randomUUID();
  return withTenant({ workspaceId: id, userId }, async c => {
    await c.query('INSERT INTO workspaces (id, name, created_by) VALUES ($1,$2,$3)', [id, name, userId]);
    await c.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [id, userId]);
    await c.query('INSERT INTO wallets (workspace_id) VALUES ($1)', [id]);
    for (const s of DEFAULT_STYLES) await insertStyle(c, id, userId, s);
    await appendAudit(c, id, 'workspace.created', { name, owner: userId });
    return { id, name, role: 'owner' };
  });
}

export const listWorkspaces = userId => withTenant({ userId }, async c =>
  (await c.query(`SELECT w.id, w.name, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id AND m.user_id = $1 ORDER BY w.created_at`, [userId])).rows);

export const listMembers = ctx => withTenant(ctx, async c =>
  (await c.query(`SELECT u.id, u.email, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.created_at`, [ctx.workspaceId])).rows);

export async function inviteMember(ctx, email, role) {
  return withTenant(ctx, async c => {
    const { rows: [u] } = await c.query('SELECT id FROM users WHERE email=$1', [email]);
    if (u) {
      await c.query('INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ctx.workspaceId, u.id, role]);
      await c.query(`INSERT INTO invites (workspace_id, email, role, invited_by, accepted_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT (workspace_id, email) DO UPDATE SET accepted_at = now()`,
        [ctx.workspaceId, email, role, ctx.userId]);
    } else {
      await c.query(`INSERT INTO invites (workspace_id, email, role, invited_by) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id, email) DO UPDATE SET role = EXCLUDED.role`,
        [ctx.workspaceId, email, role, ctx.userId]);
    }
    await appendAudit(c, ctx.workspaceId, 'member.invited', { email, role, immediate: !!u });
    return { status: u ? 'added' : 'pending' };
  });
}

async function insertStyle(c, ws, userId, s) {
  const { rows: [st] } = await c.query(`INSERT INTO styles (workspace_id, name, created_by) VALUES ($1,$2,$3) RETURNING id`, [ws, s.name, userId]);
  await c.query(`INSERT INTO style_versions (style_id, workspace_id, version, name, prompt_suffix, negative_prompt, params) VALUES ($1,$2,1,$3,$4,$5,$6)`,
    [st.id, ws, s.name, s.prompt_suffix || '', s.negative_prompt || '', JSON.stringify(s.params || {})]);
  return st.id;
}
const STYLE_SELECT = `SELECT s.id, s.name, s.current_version AS version, v.prompt_suffix, v.negative_prompt, v.params, s.created_at, s.updated_at
  FROM styles s JOIN style_versions v ON v.style_id = s.id AND v.version = s.current_version`;

export const listStyles = ctx => withTenant(ctx, async c => (await c.query(`${STYLE_SELECT} WHERE NOT s.archived ORDER BY s.created_at`)).rows);

export const createStyle = (ctx, s) => withTenant(ctx, async c => {
  const id = await insertStyle(c, ctx.workspaceId, ctx.userId, s);
  await appendAudit(c, ctx.workspaceId, 'style.created', { style_id: id, name: s.name });
  return (await c.query(`${STYLE_SELECT} WHERE s.id=$1`, [id])).rows[0];
});

export const getStyle = (ctx, id) => withTenant(ctx, async c => {
  const { rows: [s] } = await c.query(`${STYLE_SELECT} WHERE s.id=$1`, [id]);
  if (!s) throw new HttpError(404, 'not_found', 'style not found');
  const { rows: versions } = await c.query('SELECT version, name, prompt_suffix, negative_prompt, params, created_at FROM style_versions WHERE style_id=$1 ORDER BY version DESC', [id]);
  return { ...s, versions };
});

export const updateStyle = (ctx, id, patch) => withTenant(ctx, async c => {
  const { rows: [cur] } = await c.query(`SELECT s.id, s.current_version, v.name, v.prompt_suffix, v.negative_prompt, v.params
     FROM styles s JOIN style_versions v ON v.style_id=s.id AND v.version=s.current_version WHERE s.id=$1 AND NOT s.archived FOR UPDATE OF s`, [id]);
  if (!cur) throw new HttpError(404, 'not_found', 'style not found');
  const next = { name: patch.name ?? cur.name, prompt_suffix: patch.prompt_suffix ?? cur.prompt_suffix, negative_prompt: patch.negative_prompt ?? cur.negative_prompt, params: patch.params ?? cur.params };
  const version = cur.current_version + 1;
  await c.query(`INSERT INTO style_versions (style_id, workspace_id, version, name, prompt_suffix, negative_prompt, params) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, ctx.workspaceId, version, next.name, next.prompt_suffix, next.negative_prompt, JSON.stringify(next.params)]);
  await c.query('UPDATE styles SET name=$2, current_version=$3, updated_at=now() WHERE id=$1', [id, next.name, version]);
  await appendAudit(c, ctx.workspaceId, 'style.updated', { style_id: id, version });
  return (await c.query(`${STYLE_SELECT} WHERE s.id=$1`, [id])).rows[0];
});

export const archiveStyle = (ctx, id) => withTenant(ctx, async c => {
  const r = await c.query('UPDATE styles SET archived=true, updated_at=now() WHERE id=$1 AND NOT archived', [id]);
  if (!r.rowCount) throw new HttpError(404, 'not_found', 'style not found');
  await appendAudit(c, ctx.workspaceId, 'style.archived', { style_id: id });
});

export const signPayload = raw => 'sha256=' + crypto.createHmac('sha256', config.webhookSecret).update(raw).digest('hex');

function signatureValid(raw, header) {
  if (!header) return false;
  const given = Buffer.from(String(header).replace(/^sha256=/, ''), 'utf8');
  const want = Buffer.from(signPayload(raw).replace(/^sha256=/, ''), 'utf8');
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}


export async function handlePaymentWebhook(raw, signature) {
  if (!signatureValid(raw, signature)) throw new HttpError(401, 'invalid_signature', 'signature verification failed');
  let ev;
  try { ev = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_json', 'body is not JSON'); }
  if (!ev || typeof ev.id !== 'string' || typeof ev.type !== 'string') throw new HttpError(400, 'invalid_event', 'id and type are required');
  if (ev.type !== 'payment.succeeded') return { status: 'ignored', type: ev.type };
  const credits = ev.credits ?? ev.data?.credits;
  const ws = ev.workspace_id ?? ev.data?.workspace_id;
  if (!Number.isInteger(credits) || credits <= 0) throw new HttpError(422, 'invalid_event', 'credits must be a positive integer');
  if (!/^[0-9a-f-]{36}$/i.test(ws || '')) throw new HttpError(422, 'invalid_event', 'workspace_id must be a uuid');

  return withTenant({ workspaceId: ws }, async c => {
    const exists = await c.query('SELECT 1 FROM wallets WHERE workspace_id=$1', [ws]);
    if (!exists.rowCount) throw new HttpError(422, 'unknown_workspace', 'workspace does not exist');
    const ins = await c.query(`INSERT INTO webhook_events (event_id, workspace_id, type, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [ev.id, ws, ev.type, raw]);
    if (!ins.rowCount) return { status: 'duplicate', event_id: ev.id };
    await ledger.grant(c, ws, credits, `payment:${ev.id}`, { event_id: ev.id, source: 'webhook' });
    return { status: 'processed', event_id: ev.id, credits };
  });
}

export const getWallet = (ctx, limit = 20) => withTenant(ctx, async c => {
  const w = await ledger.verifyWallet(c, ctx.workspaceId);
  const { rows } = await c.query('SELECT id, entry_type, amount, generation_id, idempotency_key, created_at FROM ledger WHERE workspace_id=$1 ORDER BY id DESC LIMIT $2', [ctx.workspaceId, limit]);
  return { available: w.available, held: w.held, verified: w.verified, derived: w.derived, recent: rows };
});
export const verifyAuditChain = ctx => withTenant(ctx, c => verifyAudit(c, ctx.workspaceId));
export const listAudit = (ctx, limit = 50) => withTenant(ctx, async c =>
  (await c.query('SELECT seq, type, data, ts, hash FROM audit_log WHERE workspace_id=$1 ORDER BY seq DESC LIMIT $2', [ctx.workspaceId, limit])).rows);
