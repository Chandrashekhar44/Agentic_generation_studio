CREATE TABLE videos (
  generation_id uuid PRIMARY KEY REFERENCES generations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mime text NOT NULL DEFAULT 'video/mp4',
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE videos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON videos USING (workspace_id = app_ws()) WITH CHECK (workspace_id = app_ws());
GRANT SELECT, INSERT, UPDATE, DELETE ON videos TO studio_app, studio_system;
