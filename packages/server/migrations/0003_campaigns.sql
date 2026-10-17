-- M2: block library originals, campaigns (working draft) and campaign revisions.

-- Original, reusable block definitions. Immutable: a change means a new version row.
CREATE TABLE block_definition (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type, version)
);

CREATE FUNCTION block_definition_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'block_definition is immutable: add a new version instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER block_definition_no_change
  BEFORE UPDATE OR DELETE ON block_definition
  FOR EACH ROW EXECUTE FUNCTION block_definition_immutable();

CREATE TABLE campaign (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id),
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  draft_content JSONB NOT NULL,                 -- structured blocks + settings: the working copy
  draft_version INTEGER NOT NULL DEFAULT 1,     -- optimistic concurrency counter
  draft_hash    TEXT NOT NULL,
  created_by    UUID NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID REFERENCES app_user(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX campaign_updated_idx ON campaign (workspace_id, updated_at DESC);

-- Named snapshots of a campaign. Never edited after creation.
CREATE TABLE campaign_revision (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspace(id),
  campaign_id         UUID NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  number              INTEGER NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('created', 'manual', 'restore', 'duplicate')),
  label               TEXT,
  content             JSONB NOT NULL,
  content_hash        TEXT NOT NULL,
  restored_from_id    UUID REFERENCES campaign_revision(id),
  created_by          UUID NOT NULL REFERENCES app_user(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, number)
);

CREATE FUNCTION campaign_revision_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM campaign WHERE id = OLD.campaign_id) THEN
    RETURN OLD; -- allowed only as part of deleting the whole campaign (cascade)
  END IF;
  RAISE EXCEPTION 'campaign_revision is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER campaign_revision_no_change
  BEFORE UPDATE OR DELETE ON campaign_revision
  FOR EACH ROW EXECUTE FUNCTION campaign_revision_immutable();
