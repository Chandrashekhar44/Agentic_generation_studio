# Architecture

```
browser ──HTTP/SSE──> api ──(RLS role studio_app)──> Postgres <──(studio_system)── worker ──HTTP──> provider a / b (mock)
                       │                                                              └─ ffmpeg compose happens in provider; MP4 bytes stored in Postgres
```
Services: `db`, `migrate` (schema + roles), `provider` (mock a/b, chaos switch, ffmpeg), `api`, `worker`, `seed`, `tools` (tests).

## State machine
Generation: `queued → planning → generating → composing → succeeded | partial | failed | canceled`.
Step: `pending → running → succeeded | failed | canceled` (`running → pending` on retry). Steps: plan, N images (depends_on gives a DAG; scenes 4+ continue from earlier scenes), compose.
Compose is skipped (and not charged) if no image succeeded. `partial` = composed from a subset of scenes.

## Data model (key tables)
`users, workspaces, memberships, invites` · `styles` + immutable `style_versions` · `generations` (style snapshot, idempotency key, cost counters) · `generation_steps` (lease columns) ·
`generation_events` (per-run gap-free `seq`) · `wallets` (projection) + append-only `ledger` · `webhook_events` · `audit_log` + `audit_heads` · `provider_calls` · `videos`.

## Tenant isolation
Postgres RLS on every tenant table (`ENABLE` + `FORCE`), policy `workspace_id = app_ws()`. Every API query runs in a transaction that sets `app.workspace_id` / `app.user_id` (`withTenant`), so a forgotten `WHERE` returns nothing instead of leaking. Membership is verified *before* the tenant GUC is set; non-members get 404. The API role is non-superuser, no BYPASSRLS. Only the worker/metrics/admin use `studio_system` (BYPASSRLS), always by explicit ids.

## Ledger
Entries: `grant` (avail+), `reserve` (avail−, held+), `commit` (held−), `release` (held−, avail+). A CHECK constraint ties entry type to deltas; triggers forbid UPDATE/DELETE. Every mutation first locks the wallet row (`FOR UPDATE`), updates the projection in the same transaction, and `CHECK (available >= 0 AND held >= 0)` is the last line of defence. `/wallet` re-derives balances from the ledger (`verified`). Each entry has a unique idempotency key (`payment:<event>`, `reserve:<gen>`, `commit:<step>`, `release:<gen>`).
Lifecycle: reserve full cost at creation → commit each completed step → on finish/cancel release `reserved − committed`.

## Idempotency & durability
- **Create run**: wallet lock serialises creations per workspace; lookup by `(workspace, Idempotency-Key)` → same body returns the same run (200, `Idempotent-Replayed`), different body → 422. Unique index as backstop.
- **Webhook**: HMAC check, `webhook_events.event_id` PK with `ON CONFLICT DO NOTHING` in the same tx as the grant; concurrent duplicates block on the index, then report `duplicate`.
- **Worker**: claims steps with a lease (`FOR UPDATE SKIP LOCKED`, heartbeat every 2 s, lease 15 s). If killed, the lease expires and any worker resumes the step. Provider calls use `Idempotency-Key = step id`; commits are keyed by step id; completed steps are never re-selected → nothing is redone or re-charged. Takeover of a dead lease does not consume a retry attempt. SIGTERM returns in-flight steps to the queue.
- **Cancel**: marks pending+running steps canceled, releases remainder; late worker results fail the `status='running' AND locked_by=me` guard and are discarded (not charged). Heartbeat failure aborts the in-flight provider call.
- Lock order everywhere: generation row → wallet → audit head (no deadlocks).

## Provider resilience
Per-call timeout, 2 attempts/provider with exponential backoff + full jitter, `Retry-After` honoured (429 doesn't trip the breaker), per-provider circuit breaker (closed/open/half-open single probe), fallback A→B, step-level retries with backoff (5 attempts). 4xx (≠429) is permanent: no retry, no fallback. Runs served by B are flagged `degraded`.

## Realtime
Events are an append-only per-run log; `seq` is assigned under the generation row lock so it commits in order. SSE `id: seq`; reconnect with `Last-Event-ID` replays `seq > last`. The UI is event-sourced and de-duplicates by seq; stream ends after `generation.completed`.

## Fairness
Per-tenant token bucket (429 + `Retry-After`), cap of 100 active runs per tenant, and in the worker's claim query each step is ranked by position inside its own tenant's queue and ordered by that rank (round-robin across tenants) with `inflight + rank ≤ 3` per-tenant concurrency cap.

## Audit / observability
Per-workspace hash chain (`sha256(prev | canonical(entry))`); `/audit/verify` detects edits, reordering, truncation. JSON logs with request/run/step ids; `/metrics` (queue depth, runs by status, latency histogram, provider outcomes/failures) derived from Postgres so it spans processes.

## Decisions & trade-offs
- Postgres as queue (SKIP LOCKED) instead of Redis: one fewer moving part, transactional with the ledger.
- Reserve-upfront + per-step commit: cannot overspend under concurrency; cost is partial-refund friendly.
- Dedicated worker process: `docker kill` is a meaningful test, and state lives only in the DB.
- Videos in Postgres: simple tenant-safe serving; would move to object storage at scale.
- Cut / simplified: breaker state and rate limiter are in-process; per-scene style selection (stretch 13) is not done (DAG dependencies are); no browser E2E tests.
- Cache (stretch 14), audit chain, metrics, admin view (stretch 15) are implemented.
