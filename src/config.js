const e = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));
export const config = {
  port: int(e.PORT, 3000),
  databaseUrl: e.DATABASE_URL,               
  systemDatabaseUrl: e.SYSTEM_DATABASE_URL, 
  jwtSecret: e.JWT_SECRET || 'dev-only-jwt-secret-change-me',
  webhookSecret: e.WEBHOOK_SECRET || 'dev-only-webhook-secret',
  adminToken: e.ADMIN_TOKEN || 'dev-admin-token',
  devRoutes: (e.ENABLE_DEV_ROUTES ?? 'true') === 'true',

  costs: { plan: int(e.COST_PLAN, 1), image: int(e.COST_IMAGE, 3), compose: int(e.COST_COMPOSE, 2) },

  rateLimit: { rps: int(e.RATE_LIMIT_RPS, 50), burst: int(e.RATE_LIMIT_BURST, 100) },
  authRateLimit: { rps: int(e.AUTH_RATE_LIMIT_RPS, 10), burst: int(e.AUTH_RATE_LIMIT_BURST, 60) },
  maxActiveRunsPerTenant: int(e.MAX_ACTIVE_RUNS_PER_TENANT, 100),
  tenantStepConcurrency: int(e.TENANT_STEP_CONCURRENCY, 3), 

  workerConcurrency: int(e.WORKER_CONCURRENCY, 8),
  leaseMs: int(e.LEASE_MS, 15000),
  heartbeatMs: int(e.HEARTBEAT_MS, 2000),
  pollMs: int(e.POLL_MS, 400),
  stepMaxAttempts: int(e.STEP_MAX_ATTEMPTS, 5),

  providers: [
    { name: 'a', baseUrl: e.PROVIDER_A_URL || 'http://provider:4000/a' },
    { name: 'b', baseUrl: e.PROVIDER_B_URL || 'http://provider:4000/b' },
  ],
  providerTimeoutMs: int(e.PROVIDER_TIMEOUT_MS, 25000),
  providerAttemptsPerProvider: int(e.PROVIDER_ATTEMPTS, 2),
  backoffBaseMs: int(e.BACKOFF_BASE_MS, 300),
  backoffCapMs: int(e.BACKOFF_CAP_MS, 5000),
  breaker: { threshold: int(e.BREAKER_THRESHOLD, 5), windowMs: int(e.BREAKER_WINDOW_MS, 30000), cooldownMs: int(e.BREAKER_COOLDOWN_MS, 15000) },
};
