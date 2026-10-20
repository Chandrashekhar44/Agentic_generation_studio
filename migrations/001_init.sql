CREATE FUNCTION app_ws()  RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
CREATE FUNCTION app_uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','member')),
  invited_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  UNIQUE (workspace_id, email)
);

CREATE TABLE styles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  current_version int NOT NULL DEFAULT 1,
  archived boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE style_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  style_id uuid NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version int NOT NULL,
  name text NOT NULL,
  prompt_suffix text NOT NULL DEFAULT '',
  negative_prompt text NOT NULL DEFAULT '',
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (style_id, version)
);

CREATE TABLE generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  prompt text NOT NULL,
  style_id uuid REFERENCES styles(id),
  style_version_id uuid REFERENCES style_versions(id),
  style_version int,
  style_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb, 
  image_count int NOT NULL CHECK (image_count BETWEEN 1 AND 8),
  seed int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','planning','generating','composing','succeeded','partial','failed','canceled')),
  degraded boolean NOT NULL DEFAULT false,             
  cached boolean NOT NULL DEFAULT false,
  cache_key text,
  cost_reserved int NOT NULL DEFAULT 0,
  cost_committed int NOT NULL DEFAULT 0,
  cost_released int NOT NULL DEFAULT 0,
  plan jsonb,
  result jsonb,
  error text,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  event_seq int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (workspace_id, idempotency_key),
  CHECK (cost_committed + cost_released <= cost_reserved)
);
CREATE INDEX generations_ws_created ON generations (workspace_id, created_at DESC);
CREATE INDEX generations_active ON generations (workspace_id) WHERE status IN ('queued','planning','generating','composing');
CREATE INDEX generations_cache ON generations (workspace_id, cache_key) WHERE status = 'succeeded';

CREATE TABLE generation_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('plan','image','compose')),
  idx int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','canceled')),
  depends_on int[] NOT NULL DEFAULT '{}',              
  cost int NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  provider text,
  result jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (generation_id, kind, idx)
);
CREATE INDEX steps_claimable ON generation_steps (status, run_after);
CREATE INDEX steps_gen ON generation_steps (generation_id);

CREATE TABLE generation_events (
  generation_id uuid NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  seq int NOT NULL,                                     
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (generation_id, seq)
);

CREATE TABLE wallets (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  available bigint NOT NULL DEFAULT 0 CHECK (available >= 0),
  held bigint NOT NULL DEFAULT 0 CHECK (held >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_type text NOT NULL CHECK (entry_type IN ('grant','reserve','commit','release')),
  amount bigint NOT NULL CHECK (amount > 0),
  available_delta bigint NOT NULL,
  held_delta bigint NOT NULL,
  generation_id uuid REFERENCES generations(id),
  step_id uuid,
  idempotency_key text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT ledger_deltas_consistent CHECK (
    (entry_type = 'grant'   AND available_delta =  amount AND held_delta = 0) OR
    (entry_type = 'reserve' AND available_delta = -amount AND held_delta = amount) OR
    (entry_type = 'commit'  AND available_delta = 0       AND held_delta = -amount) OR
    (entry_type = 'release' AND available_delta =  amount AND held_delta = -amount))
);
CREATE INDEX ledger_ws ON ledger (workspace_id, id);

CREATE TABLE webhook_events (
  event_id text PRIMARY KEY,                            
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_heads (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  last_seq bigint NOT NULL DEFAULT 0,
  last_hash text NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
);
CREATE TABLE audit_log (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL,
  ts text NOT NULL,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  PRIMARY KEY (workspace_id, seq)
);

CREATE TABLE provider_calls (
  id bigserial PRIMARY KEY,
  workspace_id uuid,
  generation_id uuid,
  step_id uuid,
  provider text NOT NULL,
  kind text NOT NULL,
  outcome text NOT NULL,  
  status_code int,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_calls_created ON provider_calls (created_at);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_append_only  BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON generation_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invites','styles','style_versions','generations','generation_steps','generation_events',
                           'wallets','ledger','webhook_events','audit_heads','audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = app_ws()) WITH CHECK (workspace_id = app_ws())', t);
  END LOOP;
END $$;

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_visibility ON memberships
  USING (user_id = app_uid() OR workspace_id = app_ws())
  WITH CHECK (workspace_id = app_ws());

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_visibility ON workspaces
  USING (id = app_ws() OR id IN (SELECT workspace_id FROM memberships WHERE user_id = app_uid()))
  WITH CHECK (id = app_ws());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO studio_app, studio_system;
REVOKE UPDATE, DELETE ON ledger, audit_log, generation_events FROM studio_app, studio_system;
REVOKE ALL ON provider_calls FROM studio_app;         
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO studio_app, studio_system;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO studio_app, studio_system;
