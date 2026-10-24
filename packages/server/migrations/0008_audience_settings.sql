-- M4: the contact limit becomes a setting (default 10 while testing, raisable by an Admin up to 1000),
-- and contacts can carry custom fields (for example "Country of residence") that can be used to segment.

CREATE TABLE audience_setting (
  workspace_id  UUID PRIMARY KEY REFERENCES workspace(id),
  contact_limit INTEGER NOT NULL DEFAULT 10 CHECK (contact_limit BETWEEN 1 AND 1000),
  updated_by    UUID REFERENCES app_user(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The database still enforces the limit on every insert, now using the setting.
CREATE OR REPLACE FUNCTION contact_cap() RETURNS trigger AS $$
DECLARE
  lim INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('contact_cap:' || NEW.workspace_id::text)); -- two imports at once cannot both squeeze in
  SELECT COALESCE((SELECT contact_limit FROM audience_setting WHERE workspace_id = NEW.workspace_id), 10) INTO lim;
  IF (SELECT count(*) FROM contact WHERE workspace_id = NEW.workspace_id) >= lim THEN
    RAISE EXCEPTION 'contact limit reached: at most % contacts can be stored', lim USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE contact_field (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  key          TEXT NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label        TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  type         TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'boolean')),
  created_by   UUID REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, key)
);

ALTER TABLE contact ADD COLUMN custom JSONB NOT NULL DEFAULT '{}';
