-- M3: asset library (images) and per-template brand header/footer profiles.

-- Images are stored in the database for now (a few small files). The access layer hides this,
-- so they can move to object storage (R2) later without changing emails: emails reference "asset:<id>".
CREATE TABLE asset (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  size_bytes   INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  sha256       TEXT NOT NULL,
  data         BYTEA NOT NULL,
  created_by   UUID REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, sha256)
);

-- Each template (palette) has a versioned shared header and footer. A change adds a new version;
-- old versions are kept so earlier emails can always be reproduced.
CREATE TABLE brand_profile_version (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  palette      TEXT NOT NULL CHECK (palette IN ('travel', 'events', 'cosmetics')),
  version      INTEGER NOT NULL,
  header       JSONB NOT NULL,
  footer       JSONB NOT NULL,
  created_by   UUID REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, palette, version)
);

CREATE FUNCTION brand_profile_version_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'brand_profile_version is immutable: save a new version instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brand_profile_version_no_change
  BEFORE UPDATE OR DELETE ON brand_profile_version
  FOR EACH ROW EXECUTE FUNCTION brand_profile_version_immutable();
