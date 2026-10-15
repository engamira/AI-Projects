-- M1: workspace, users, sessions, 2FA recovery codes, invitations, notifications, activity log.

CREATE TABLE workspace (
  id         UUID PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Version 1 has exactly one workspace. Every tenant-owned table carries workspace_id.
INSERT INTO workspace (id, name) VALUES ('00000000-0000-4000-8000-000000000001', 'Default workspace');

CREATE TABLE app_user (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspace(id),
  email             TEXT NOT NULL,                       -- stored lowercase
  name              TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('admin', 'builder', 'qa_reviewer')),
  status            TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  password_hash     TEXT,
  totp_secret_enc   TEXT,                                -- AES-256-GCM encrypted
  totp_enabled_at   TIMESTAMPTZ,
  totp_last_step    BIGINT,                              -- blocks reuse of a code
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ,
  created_by        UUID REFERENCES app_user(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);

CREATE TABLE auth_session (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash              TEXT NOT NULL UNIQUE,
  stage                   TEXT NOT NULL CHECK (stage IN ('password', 'full')),
  csrf_token              TEXT NOT NULL,
  pending_totp_secret_enc TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_session_user_idx ON auth_session (user_id);

CREATE TABLE recovery_code (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   TIMESTAMPTZ
);
CREATE INDEX recovery_code_user_idx ON recovery_code (user_id);

CREATE TABLE invitation (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_by UUID REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notification (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  user_id      UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  link         TEXT,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notification_user_idx ON notification (user_id, created_at DESC);

CREATE TABLE activity_log (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  UUID NOT NULL REFERENCES workspace(id),
  actor_user_id UUID REFERENCES app_user(id),
  action        TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     TEXT,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX activity_log_created_idx ON activity_log (workspace_id, created_at DESC);

-- The activity log is append-only: updates and deletes are rejected at the database level.
CREATE FUNCTION activity_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'activity_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_log_no_update
  BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_immutable();
