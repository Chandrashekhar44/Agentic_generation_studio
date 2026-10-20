

import crypto from 'node:crypto';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';
import { log } from './log.js';
import { withSystem } from './db.js';
import { sleep } from './util.js';
import { createProviderClient } from './providers.js';
import * as pipeline from './pipeline.js';

process.env.SERVICE_NAME ||= 'worker';

const workerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
let stopping = false;
const inflight = new Map();

const als = new AsyncLocalStorage();

const providers = createProviderClient({
  onAttempt: a => {
    const ctx = als.getStore() || {};

    withSystem(c => c.query(
      `INSERT INTO provider_calls
       (workspace_id, generation_id, step_id, provider, kind, outcome, status_code, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        ctx.workspace_id ?? null,
        ctx.generation_id ?? null,
        ctx.step_id ?? null,
        a.provider,
        a.kind === '-' ? (ctx.kind || '-') : a.kind,
        a.outcome,
        a.status_code ?? null,
        a.duration_ms ?? null,
      ],
    )).catch(() => {});
  },
});

function buildRequest(step, { gen, reference, scenes }) {
  const style = gen.style_snapshot;

  if (step.kind === 'plan') {
    return {
      kind: 'plan',
      body: {
        prompt: gen.prompt,
        style,
        scene_count: gen.image_count,
        seed: gen.seed,
      },
    };
  }

  if (step.kind === 'image') {
    const scene = gen.plan?.scenes?.find(s => s.index === step.idx);

    return {
      kind: 'image',
      body: {
        prompt: scene?.prompt ?? gen.prompt,
        negative_prompt: scene?.negative_prompt ?? style.negative_prompt,
        params: style.params,
        seed: gen.seed + step.idx,
        scene_index: step.idx,
        reference,
      },
    };
  }

  return {
    kind: 'compose',
    body: {
      scenes,
      style_name: style.name,
      prompt: gen.prompt,
    },
  };
}

async function runStep({ step }) {
  const lg = {
    run_id: step.generation_id,
    step_id: step.id,
    workspace_id: step.workspace_id,
    kind: step.kind,
    idx: step.idx,
    attempt: step.attempts,
    worker: workerId,
  };

  const ac = new AbortController();
  inflight.set(step.id, ac);

  let heartbeatBusy = false;
  let heartbeatLost = false;
  let heartbeatStopped = false;
  let heartbeatPromise = Promise.resolve();

  const hb = setInterval(() => {
    if (heartbeatBusy || heartbeatStopped || ac.signal.aborted) return;

    heartbeatBusy = true;

    heartbeatPromise = (async () => {
      try {
        const alive = await pipeline.heartbeat(step.id, workerId);

        if (!alive) {
          heartbeatLost = true;
          log.info('lease lost or canceled; aborting step', lg);

          if (!ac.signal.aborted) {
            ac.abort(new Error('lease lost or canceled'));
          }
        }
      } catch (e) {
        log.warn('heartbeat error', { ...lg, err: e.message });
      } finally {
        heartbeatBusy = false;
      }
    })();
  }, config.heartbeatMs);

  async function stopHeartbeat() {
    heartbeatStopped = true;
    clearInterval(hb);
    await heartbeatPromise;
  }

  const t0 = Date.now();
  let loadMs = null;
  let providerMs = null;
  let completeMs = null;

  try {
    const loadStarted = Date.now();
    const inputs = await pipeline.loadStepInputs(step);
    loadMs = Date.now() - loadStarted;

    const req = buildRequest(step, inputs);

    log.info('step started', { ...lg, loadMs });

    const providerStarted = Date.now();

    const out = await als.run(
      {
        workspace_id: step.workspace_id,
        generation_id: step.generation_id,
        step_id: step.id,
        kind: step.kind,
      },
      () => providers.call(req.kind, req.body, {
        idemKey: step.id,
        signal: ac.signal,
      }),
    );

    providerMs = Date.now() - providerStarted;

    await stopHeartbeat();

    if (heartbeatLost || ac.signal.aborted) {
      log.info('step result discarded after lease loss or cancellation', lg);
      return;
    }

    const completeStarted = Date.now();
    const r = await pipeline.completeStep(step, workerId, out);
    completeMs = Date.now() - completeStarted;

    log.info(
      r.discarded ? 'step result discarded' : 'step succeeded',
      {
        ...lg,
        provider: out.provider,
        degraded: out.degraded,
        loadMs,
        providerMs,
        completeMs,
        ms: Date.now() - t0,
      },
    );
  } catch (e) {
    await stopHeartbeat();

    if (ac.signal.aborted || heartbeatLost) {
      log.info('step aborted', {
        ...lg,
        reason: ac.signal.reason?.message || e.message,
      });
      return;
    }

    log.warn('step failed', {
      ...lg,
      err: e.message,
      permanent: !!e.permanent,
      loadMs,
      providerMs,
      completeMs,
      ms: Date.now() - t0,
    });

    await pipeline.failStep(step, workerId, e).catch(err =>
      log.error('failStep error', { ...lg, err: err.message }),
    );
  } finally {
    await stopHeartbeat();
    inflight.delete(step.id);
  }
}

async function slot(n) {
  while (!stopping) {
    let claimed = null;

    try {
      claimed = await pipeline.claimStep(workerId);
    } catch (e) {
      log.error('claim error', { slot: n, err: e.message });
    }

    if (!claimed) {
      await sleep(config.pollMs * (0.75 + Math.random() / 2));
      continue;
    }

    await runStep(claimed).catch(e =>
      log.error('runStep crashed', { err: e.stack }),
    );
  }
}

async function waitForSchema() {
  for (;;) {
    try {
      await withSystem(c => c.query('SELECT 1 FROM generation_steps LIMIT 1'));
      return;
    } catch {
      log.info('waiting for schema');
      await sleep(1000);
    }
  }
}

async function shutdown(sig) {
  if (stopping) return;

  stopping = true;

  log.info('shutting down; returning in-flight steps to the queue', {
    sig,
    inflight: inflight.size,
  });

  const ids = [...inflight.keys()];

  for (const ac of inflight.values()) {
    ac.abort(new Error('shutdown'));
  }

  await pipeline.giveBack(workerId, ids).catch(() => {});
  process.exit(0);
}

for (const s of ['SIGTERM', 'SIGINT']) {
  process.on(s, () => shutdown(s));
}

await waitForSchema();

log.info('worker started', {
  workerId,
  concurrency: config.workerConcurrency,
  leaseMs: config.leaseMs,
});

await Promise.all(
  Array.from({ length: config.workerConcurrency }, (_, i) => slot(i)),
);
