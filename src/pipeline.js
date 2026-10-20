import { config } from './config.js';
import { withTenant, withSystem, HttpError } from './db.js';
import { sha256 } from './util.js';
import * as ledger from './ledger.js';
import { appendAudit } from './audit.js';
import { emit } from './events.js';

const STEP_TERMINAL = ['succeeded', 'failed', 'canceled'];
const GEN_TERMINAL = ['succeeded', 'partial', 'failed', 'canceled'];
const isTerminalStep = s => STEP_TERMINAL.includes(s.status);

export const generationCost = n => config.costs.plan + n * config.costs.image + config.costs.compose;

export async function createGeneration(ctx, { prompt, styleId, imageCount, seed, idemKey }) {
  const cost = generationCost(imageCount);
  const requestHash = sha256(JSON.stringify([prompt, styleId || null, imageCount, seed]));
  return withTenant(ctx, async c => {
    const ws = ctx.workspaceId;
const initialWallet = await ledger.lockWallet(c, ws);

    const ex = await c.query('SELECT * FROM generations WHERE workspace_id=$1 AND idempotency_key=$2', [ws, idemKey]);
    if (ex.rowCount) {
      if (ex.rows[0].request_hash !== requestHash)
        throw new HttpError(422, 'idempotency_key_reuse', 'Idempotency-Key was already used with a different request body');
      return { generation: ex.rows[0], replay: true };
    }

    let snapshot = { style_id: null, version: null, name: 'None', prompt_suffix: '', negative_prompt: '', params: {} };
    let styleVersionId = null;
    if (styleId) {
      const { rows: [s] } = await c.query(
        `SELECT s.id, v.id AS vid, v.version, v.name, v.prompt_suffix, v.negative_prompt, v.params
           FROM styles s JOIN style_versions v ON v.style_id = s.id AND v.version = s.current_version
          WHERE s.id = $1 AND NOT s.archived`, [styleId]);
      if (!s) throw new HttpError(404, 'not_found', 'style not found');
      styleVersionId = s.vid;
      snapshot = { style_id: s.id, version: s.version, name: s.name, prompt_suffix: s.prompt_suffix, negative_prompt: s.negative_prompt, params: s.params };
    }

    const { rows: [act] } = await c.query(
      `SELECT count(*)::int AS n FROM generations WHERE workspace_id=$1 AND status IN ('queued','planning','generating','composing')`, [ws]);
    if (act.n >= config.maxActiveRunsPerTenant)
      throw new HttpError(429, 'tenant_run_cap', `workspace already has ${act.n} active runs`, { retryAfter: 5 });

    const cacheKey = sha256(JSON.stringify([ws, prompt, styleVersionId, imageCount, seed]));
    const { rows: [hit] } = await c.query(
      `SELECT result FROM generations WHERE workspace_id=$1 AND cache_key=$2 AND status='succeeded' ORDER BY created_at DESC LIMIT 1`, [ws, cacheKey]);

   if (!hit && initialWallet.available < cost) {
  throw new HttpError(402, 'insufficient_credits', 'not enough credits', {
    available: initialWallet.available,
    required: cost,
  });
}

    const { rows: [gen] } = await c.query(
      `INSERT INTO generations (workspace_id, user_id, prompt, style_id, style_version_id, style_version, style_snapshot,
                                image_count, seed, status, cached, cache_key, cost_reserved, idempotency_key, request_hash, result, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [ws, ctx.userId, prompt, snapshot.style_id, styleVersionId, snapshot.version, JSON.stringify(snapshot), imageCount, seed,
       hit ? 'succeeded' : 'queued', !!hit, cacheKey, hit ? 0 : cost, idemKey, requestHash, hit ? JSON.stringify(hit.result) : null, hit ? new Date() : null]);

    if (hit) {
      await emit(c, ws, gen.id, 'generation.created', { status: 'succeeded', prompt, image_count: imageCount, style: snapshot.name, cached: true, steps: [], cost_reserved: 0 });
      await emit(c, ws, gen.id, 'generation.completed', { status: 'succeeded', cached: true, result: hit.result, credits: { reserved: 0, committed: 0, released: 0 } });
      await appendAudit(c, ws, 'generation.cached', { generation_id: gen.id, cache_key: cacheKey });
      return { generation: await reload(c, gen.id), replay: false };
    }

    await ledger.reserve(c, ws, cost, gen.id, `reserve:${gen.id}`);
    const steps = [{ kind: 'plan', idx: 0, cost: config.costs.plan },
      ...Array.from({ length: imageCount }, (_, i) => ({ kind: 'image', idx: i, cost: config.costs.image })),
      { kind: 'compose', idx: 0, cost: config.costs.compose }];
    for (const s of steps)
      await c.query('INSERT INTO generation_steps (workspace_id, generation_id, kind, idx, cost, max_attempts) VALUES ($1,$2,$3,$4,$5,$6)',
        [ws, gen.id, s.kind, s.idx, s.cost, config.stepMaxAttempts]);
    await emit(c, ws, gen.id, 'generation.created', { status: 'queued', prompt, image_count: imageCount, style: snapshot.name, style_version: snapshot.version, cost_reserved: cost, steps });
    await appendAudit(c, ws, 'generation.created', { generation_id: gen.id, user_id: ctx.userId, cost_reserved: cost, style_version: snapshot.version });
    return { generation: await reload(c, gen.id), replay: false };
  });
}

const reload = async (c, id) => (await c.query('SELECT * FROM generations WHERE id=$1', [id])).rows[0];

export async function cancelGeneration(ctx, id) {
  return withTenant(ctx, async c => {
    const { rows: [gen] } = await c.query('SELECT * FROM generations WHERE id=$1 FOR UPDATE', [id]);
    if (!gen) throw new HttpError(404, 'not_found', 'generation not found');
    if (GEN_TERMINAL.includes(gen.status)) return { generation: gen, already_finished: true };
 
    await c.query(`UPDATE generation_steps SET status='canceled', error='canceled', finished_at=now(), locked_by=NULL, locked_until=NULL
                    WHERE generation_id=$1 AND status IN ('pending','running')`, [id]);
    const released = await ledger.releaseRemaining(c, ctx.workspaceId, gen);
    const g = await reload(c, id);
    await c.query(`UPDATE generations SET status='canceled', finished_at=now() WHERE id=$1`, [id]);
    await emit(c, ctx.workspaceId, id, 'generation.completed', {
      status: 'canceled', credits: { reserved: g.cost_reserved, committed: g.cost_committed, released: g.cost_released + 0 }, degraded: g.degraded });
    await appendAudit(c, ctx.workspaceId, 'generation.canceled', { generation_id: id, committed: g.cost_committed, released });
    return { generation: await reload(c, id), already_finished: false };
  });
}

export function toPublic(g, steps = []) {
  const done = steps.filter(isTerminalStep).length;
  return {
    id: g.id, status: g.status, prompt: g.prompt, image_count: g.image_count, seed: g.seed,
    style: g.style_snapshot, degraded: g.degraded, cached: g.cached,
    credits: { reserved: g.cost_reserved, committed: g.cost_committed, released: g.cost_released },
    progress: { done, total: steps.length },
    steps: steps.map(s => ({ kind: s.kind, idx: s.idx, status: s.status, attempts: s.attempts, provider: s.provider, error: s.error, cost: s.cost,
                             image_url: s.kind === 'image' ? s.result?.image_url : undefined })),
    result: g.result, error: g.error, created_at: g.created_at, finished_at: g.finished_at, event_seq: g.event_seq,
  };
}
export async function getGeneration(ctx, id) {
  return withTenant(ctx, async c => {
    const { rows: [g] } = await c.query('SELECT * FROM generations WHERE id=$1', [id]);
    if (!g) throw new HttpError(404, 'not_found', 'generation not found');
    const { rows: steps } = await c.query(`SELECT * FROM generation_steps WHERE generation_id=$1 ORDER BY CASE kind WHEN 'plan' THEN 0 WHEN 'image' THEN 1 ELSE 2 END, idx`, [id]);
    return toPublic(g, steps);
  });
}
export async function listGenerations(ctx, { limit = 30, before } = {}) {
  return withTenant(ctx, async c => {
    const { rows } = await c.query(
      `SELECT g.*, (SELECT count(*) FROM generation_steps s WHERE s.generation_id=g.id)::int AS total,
              (SELECT count(*) FROM generation_steps s WHERE s.generation_id=g.id AND s.status IN ('succeeded','failed','canceled'))::int AS done
         FROM generations g WHERE ($2::timestamptz IS NULL OR g.created_at < $2) ORDER BY g.created_at DESC LIMIT $1`, [limit, before || null]);
    return rows.map(g => ({ ...toPublic(g), progress: { done: g.done, total: g.total }, result: undefined, steps: undefined }));
  });
}

const CANDIDATES = `
WITH inflight AS (
  SELECT workspace_id, count(*)::int AS n FROM generation_steps WHERE status='running' AND locked_until > now() GROUP BY workspace_id
), eligible AS (
  SELECT s.id, s.generation_id, s.workspace_id, s.created_at,
         row_number() OVER (PARTITION BY s.workspace_id ORDER BY s.created_at, s.idx) AS rn
    FROM generation_steps s
   WHERE ((s.status = 'pending' AND s.run_after <= now()) OR (s.status = 'running' AND s.locked_until <= now()))
     AND ( s.kind = 'plan'
        OR (s.kind = 'image'
            AND EXISTS (SELECT 1 FROM generation_steps p WHERE p.generation_id = s.generation_id AND p.kind = 'plan' AND p.status = 'succeeded')
            AND NOT EXISTS (SELECT 1 FROM generation_steps d WHERE d.generation_id = s.generation_id AND d.kind = 'image'
                              AND d.idx = ANY (s.depends_on) AND d.status NOT IN ('succeeded','failed','canceled')))
        OR (s.kind = 'compose'
            AND NOT EXISTS (SELECT 1 FROM generation_steps i WHERE i.generation_id = s.generation_id AND i.kind = 'image' AND i.status NOT IN ('succeeded','failed','canceled'))
            AND EXISTS (SELECT 1 FROM generation_steps i WHERE i.generation_id = s.generation_id AND i.kind = 'image' AND i.status = 'succeeded')))
)
SELECT e.id, e.generation_id FROM eligible e LEFT JOIN inflight f USING (workspace_id)
 WHERE COALESCE(f.n, 0) + e.rn <= $1
 ORDER BY e.rn, e.created_at LIMIT 25`;


export async function claimStep(workerId) {
  return withSystem(async c => {
    const { rows: cands } = await c.query(CANDIDATES, [config.tenantStepConcurrency]);
    for (const cand of cands) {
      const g = await c.query(`SELECT * FROM generations WHERE id=$1 AND status NOT IN ('succeeded','partial','failed','canceled') FOR UPDATE SKIP LOCKED`, [cand.generation_id]);
      if (!g.rowCount) continue;
      const s = await c.query(
        `SELECT * FROM generation_steps WHERE id=$1 AND ((status='pending' AND run_after<=now()) OR (status='running' AND locked_until<=now())) FOR UPDATE`, [cand.id]);
      if (!s.rowCount) continue;
      const resumed = s.rows[0].status === 'running';
      const { rows: [step] } = await c.query(
        `UPDATE generation_steps SET status='running', attempts = attempts + $4, locked_by=$2, locked_until = now() + ($3 || ' milliseconds')::interval,
                started_at = COALESCE(started_at, now()), error = NULL WHERE id=$1 RETURNING *`,
        [cand.id, workerId, String(config.leaseMs), resumed ? 0 : 1]);   // taking over a dead worker's lease is not the step's fault
      await refreshStatus(c, g.rows[0]);
      await emit(c, step.workspace_id, step.generation_id, resumed ? 'step.resumed' : 'step.started', { kind: step.kind, idx: step.idx, attempt: step.attempts });
      return { step, generation: g.rows[0] };
    }
    return null;
  });
}

export async function heartbeat(stepId, workerId) {
  const r = await withSystem(c => c.query(
    `UPDATE generation_steps SET locked_until = now() + ($3 || ' milliseconds')::interval WHERE id=$1 AND status='running' AND locked_by=$2`,
    [stepId, workerId, String(config.leaseMs)]));
  return r.rowCount === 1; 
}

export async function giveBack(workerId, stepIds) {
  if (!stepIds.length) return;
  await withSystem(c => c.query(
    `UPDATE generation_steps SET status='pending', locked_by=NULL, locked_until=NULL, attempts = GREATEST(attempts-1,0)
      WHERE id = ANY($1::uuid[]) AND status='running' AND locked_by=$2`, [stepIds, workerId]));
}

export async function loadStepInputs(step) {
  return withSystem(async c => {
    const { rows: [g] } = await c.query('SELECT * FROM generations WHERE id=$1', [step.generation_id]);
    let reference = null;
    if (step.kind === 'image' && step.depends_on?.length) {
      const { rows } = await c.query(`SELECT result FROM generation_steps WHERE generation_id=$1 AND kind='image' AND idx = ANY($2) AND status='succeeded' ORDER BY idx LIMIT 1`, [step.generation_id, step.depends_on]);
      reference = rows[0]?.result?.image_url ?? null;
    }
    let scenes = [];
    if (step.kind === 'compose') {
      const { rows } = await c.query(`SELECT idx, status, result FROM generation_steps WHERE generation_id=$1 AND kind='image' ORDER BY idx`, [step.generation_id]);
      scenes = rows.filter(r => r.status === 'succeeded').map(r => ({ index: r.idx, image_url: r.result.image_url }));
    }
    return { gen: g, reference, scenes };
  });
}

export async function completeStep(step, workerId, { result, provider, degraded }) {
  return withSystem(async c => {
    let videoBytes = null;
    if (step.kind === 'compose') {                                
      if (!result.video_b64) throw new Error('compose returned no video');
      videoBytes = Buffer.from(result.video_b64, 'base64');
      const { video_b64, ...rest } = result;
      result = { ...rest, video_url: `/generations/${step.generation_id}/video` };
    }
    const { rows: [gen] } = await c.query('SELECT * FROM generations WHERE id=$1 FOR UPDATE', [step.generation_id]);
    const upd = await c.query(
      `UPDATE generation_steps SET status='succeeded', result=$3, provider=$4, error=NULL, finished_at=now(), locked_by=NULL, locked_until=NULL
        WHERE id=$1 AND status='running' AND locked_by=$2 RETURNING *`, [step.id, workerId, JSON.stringify(result), provider]);
    if (!upd.rowCount) return { discarded: true };       
    if (videoBytes) await c.query('INSERT INTO videos (generation_id, workspace_id, data) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [step.generation_id, step.workspace_id, videoBytes]);
    await ledger.commit(c, step.workspace_id, step.cost, step.generation_id, step.id, `commit:${step.id}`);
    if (degraded) await c.query('UPDATE generations SET degraded=true WHERE id=$1', [step.generation_id]);
    if (step.kind === 'plan') {
      await c.query('UPDATE generations SET plan=$2 WHERE id=$1', [step.generation_id, JSON.stringify(result)]);
      for (const sc of result.scenes ?? [])
        await c.query(`UPDATE generation_steps SET depends_on=$3 WHERE generation_id=$1 AND kind='image' AND idx=$2`, [step.generation_id, sc.index, sc.depends_on ?? []]);
    }
    await emit(c, step.workspace_id, step.generation_id, 'step.succeeded', {
      kind: step.kind, idx: step.idx, provider, degraded: !!degraded, cost: step.cost,
      image_url: step.kind === 'image' ? result.image_url : undefined,
      scenes: step.kind === 'plan' ? result.scenes?.map(s => ({ index: s.index, depends_on: s.depends_on })) : undefined });
    await advance(c, step.generation_id);
    return { discarded: false };
  });
}

export async function failStep(step, workerId, err) {
  return withSystem(async c => {
    await c.query('SELECT 1 FROM generations WHERE id=$1 FOR UPDATE', [step.generation_id]);
    const { rows: [cur] } = await c.query(`SELECT * FROM generation_steps WHERE id=$1 AND status='running' AND locked_by=$2 FOR UPDATE`, [step.id, workerId]);
    if (!cur) return { discarded: true };
    const msg = String(err.message || err).slice(0, 300);
    if (!err.permanent && cur.attempts < cur.max_attempts) {
      const delay = Math.min(30000, 1000 * 2 ** (cur.attempts - 1)) * (0.5 + Math.random() / 2);
      await c.query(`UPDATE generation_steps SET status='pending', run_after = now() + ($2 || ' milliseconds')::interval, locked_by=NULL, locked_until=NULL, error=$3 WHERE id=$1`,
        [step.id, String(Math.round(delay)), msg]);
      await emit(c, step.workspace_id, step.generation_id, 'step.retry', { kind: step.kind, idx: step.idx, attempt: cur.attempts, error: msg, retry_in_ms: Math.round(delay) });
      const { rows: [g] } = await c.query('SELECT * FROM generations WHERE id=$1', [step.generation_id]);
      await refreshStatus(c, g);
      return { retry: true };
    }
    await c.query(`UPDATE generation_steps SET status='failed', error=$2, finished_at=now(), locked_by=NULL, locked_until=NULL WHERE id=$1`, [step.id, msg]);
    await emit(c, step.workspace_id, step.generation_id, 'step.failed', { kind: step.kind, idx: step.idx, attempt: cur.attempts, error: msg, permanent: !!err.permanent });
    await advance(c, step.generation_id);
    return { retry: false };
  });
}

async function refreshStatus(c, gen) {
  const { rows: steps } = await c.query('SELECT kind, status FROM generation_steps WHERE generation_id=$1', [gen.id]);
  const { rows: [cur] } = await c.query('SELECT status FROM generations WHERE id=$1', [gen.id]);
  if (GEN_TERMINAL.includes(cur.status)) return;
  const plan = steps.find(s => s.kind === 'plan');
  const compose = steps.find(s => s.kind === 'compose');
  let next;
  if (plan.status !== 'succeeded') next = (plan.status === 'running' || cur.status !== 'queued') ? 'planning' : 'queued';
  else next = ['running', 'succeeded'].includes(compose.status) ? 'composing' : 'generating';
  if (next !== cur.status) {
    await c.query('UPDATE generations SET status=$2 WHERE id=$1', [gen.id, next]);
    await emit(c, gen.workspace_id, gen.id, 'generation.status', { status: next });
  }
}


async function advance(c, genId) {
  const load = async () =>
    (await c.query(
      'SELECT * FROM generation_steps WHERE generation_id=$1 ORDER BY kind, idx',
      [genId]
    )).rows;

  let steps = await load();
  const plan = steps.find(s => s.kind === 'plan');
  const images = steps.filter(s => s.kind === 'image');
  const compose = steps.find(s => s.kind === 'compose');

  const skip = ids =>
    c.query(
      `UPDATE generation_steps
       SET status='canceled', error='skipped', finished_at=now()
       WHERE id = ANY($1::uuid[])
         AND status IN ('pending','running')`,
      [ids]
    );

  let changed = false;

  if (plan.status === 'failed') {
    await skip(steps.filter(s => !isTerminalStep(s)).map(s => s.id));
    changed = true;
  } else if (
    images.every(isTerminalStep) &&
    !images.some(s => s.status === 'succeeded') &&
    !isTerminalStep(compose)
  ) {
    await skip([compose.id]);
    changed = true;
  }

  if (changed) steps = await load();

  const { rows: [gen] } = await c.query(
    'SELECT * FROM generations WHERE id=$1',
    [genId]
  );

  if (steps.every(isTerminalStep)) return finalize(c, gen, steps);

  await refreshStatus(c, gen);
}


async function finalize(c, gen, steps) {
  const plan = steps.find(s => s.kind === 'plan');
  const compose = steps.find(s => s.kind === 'compose');
  const images = steps.filter(s => s.kind === 'image');
  const ok = images.filter(s => s.status === 'succeeded');
  const bad = images.filter(s => s.status !== 'succeeded');
  let status, error = null;
  if (compose.status === 'succeeded') status = bad.length ? 'partial' : 'succeeded';
  else {
    status = 'failed';
    error = plan.status === 'failed' ? `planning failed: ${plan.error}` : ok.length === 0 ? 'all image generations failed' : `compose failed: ${compose.error}`;
  }
  const result = {
    video: compose.status === 'succeeded' ? compose.result : null,
    scenes: images.map(s => ({ index: s.idx, status: s.status, provider: s.provider, error: s.status === 'failed' ? s.error : undefined, image_url: s.result?.image_url })),
    failed_scenes: bad.map(s => s.idx),
  };
  const released = await ledger.releaseRemaining(c, gen.workspace_id, gen);
  await c.query(`UPDATE generations SET status=$2, result=$3, error=$4, finished_at=now() WHERE id=$1`, [gen.id, status, JSON.stringify(result), error]);
  const { rows: [g] } = await c.query('SELECT * FROM generations WHERE id=$1', [gen.id]);
  await emit(c, gen.workspace_id, gen.id, 'generation.completed', {
    status, error, result, degraded: g.degraded,
    credits: { reserved: g.cost_reserved, committed: g.cost_committed, released: g.cost_released } });
  await appendAudit(c, gen.workspace_id, 'generation.finished', { generation_id: gen.id, status, committed: g.cost_committed, released });
}

export async function getVideo(ctx, id) {
  return withTenant(ctx, async c => {
    const { rows: [v] } = await c.query('SELECT data, mime FROM videos WHERE generation_id=$1', [id]);
    if (!v) throw new HttpError(404, 'not_found', 'video not found');
    return v;
  });
}
