-- B3: sending a saved revision of a language email to QA. A submission points at ONE immutable revision; saving a newer
-- revision later never changes what is under review. (Checks, issues, corrections and approval arrive with the QA phase.)

CREATE TABLE qa_submission (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id),
  campaign_id   UUID NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  variant_id    UUID NOT NULL REFERENCES email_variant(id) ON DELETE CASCADE,
  revision_id   UUID NOT NULL REFERENCES email_revision(id),
  state         TEXT NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'sent_for_corrections', 'retest', 'approved', 'withdrawn')),
  note          TEXT,
  request_id    TEXT,
  submitted_by  UUID NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (variant_id, request_id)
);
CREATE INDEX qa_submission_variant_idx ON qa_submission (variant_id, created_at DESC);
CREATE INDEX qa_submission_revision_idx ON qa_submission (revision_id);
