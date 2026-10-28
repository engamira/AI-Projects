-- B4: QA runs, findings, corrections, suppression rules and approvals.
-- Everything here points at an exact, immutable revision. Approval binds to that revision (and its content hash).

ALTER TABLE qa_submission ADD COLUMN previous_submission_id UUID REFERENCES qa_submission(id);   -- a retest points back at the submission it follows

-- "Ignore" for a whole kind of finding. Never deleted: it is revoked, and every change is in the activity history.
CREATE TABLE suppression_rule (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id),
  scope         TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  campaign_id   UUID REFERENCES campaign(id) ON DELETE CASCADE,          -- set for scope 'project'
  check_id      TEXT NOT NULL,                                           -- for example links.insecure_http
  fingerprint   TEXT,                                                    -- one exact finding; null = every finding of that check
  description   TEXT NOT NULL,                                           -- what it hides, in words, shown in App Settings
  reason        TEXT NOT NULL,
  created_by    UUID NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by    UUID REFERENCES app_user(id),
  revoked_at    TIMESTAMPTZ,
  revoke_reason TEXT,
  CHECK ((scope = 'project') = (campaign_id IS NOT NULL))
);
CREATE INDEX suppression_active_idx ON suppression_rule (check_id) WHERE revoked_at IS NULL;

CREATE FUNCTION suppression_rule_keep() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM campaign WHERE id = OLD.campaign_id) OR OLD.campaign_id IS NULL THEN RAISE EXCEPTION 'suppression rules are revoked, never deleted'; END IF;
    RETURN OLD; -- allowed only as part of deleting the whole email (cascade)
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'a revoked suppression rule cannot change'; END IF;
  IF NEW.scope <> OLD.scope OR NEW.check_id <> OLD.check_id OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR NEW.reason <> OLD.reason OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'only revoking is allowed on a suppression rule';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER suppression_rule_guard BEFORE UPDATE OR DELETE ON suppression_rule FOR EACH ROW EXECUTE FUNCTION suppression_rule_keep();

CREATE TABLE qa_run (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspace(id),
  submission_id    UUID NOT NULL REFERENCES qa_submission(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('deterministic', 'ai')),
  check_set_version INTEGER NOT NULL,
  coverage         JSONB NOT NULL DEFAULT '{}',        -- what ran and what could not be checked
  started_by       UUID NOT NULL REFERENCES app_user(id),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);
CREATE INDEX qa_run_submission_idx ON qa_run (submission_id, started_at DESC);

CREATE SEQUENCE qa_issue_number_seq;

CREATE TABLE qa_issue (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number         INTEGER NOT NULL DEFAULT nextval('qa_issue_number_seq'),      -- shown as QA-0042
  workspace_id   UUID NOT NULL REFERENCES workspace(id),
  campaign_id    UUID NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  variant_id     UUID NOT NULL REFERENCES email_variant(id) ON DELETE CASCADE,
  submission_id  UUID NOT NULL REFERENCES qa_submission(id) ON DELETE CASCADE,
  run_id         UUID NOT NULL REFERENCES qa_run(id) ON DELETE CASCADE,
  revision_id    UUID NOT NULL REFERENCES email_revision(id),
  fingerprint    TEXT NOT NULL,
  check_id       TEXT NOT NULL,
  category       TEXT NOT NULL,
  severity       TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  source         TEXT NOT NULL CHECK (source IN ('deterministic', 'ai')),
  block_id       TEXT,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL,
  evidence       JSONB NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sent_for_correction', 'retest', 'resolved', 'ignored')),
  reviewer_comment TEXT,
  ignored_by     UUID REFERENCES app_user(id),
  ignore_reason  TEXT,
  suppressed_by  UUID REFERENCES suppression_rule(id),
  carried_from   UUID REFERENCES qa_issue(id),             -- the same finding on the revision before
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submission_id, fingerprint)
);
CREATE INDEX qa_issue_variant_idx ON qa_issue (variant_id, status);
CREATE UNIQUE INDEX qa_issue_number_idx ON qa_issue (number);

CREATE TABLE correction_item (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID NOT NULL REFERENCES workspace(id),
  campaign_id              UUID NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  variant_id               UUID NOT NULL REFERENCES email_variant(id) ON DELETE CASCADE,
  issue_id                 UUID NOT NULL UNIQUE REFERENCES qa_issue(id) ON DELETE CASCADE,
  assigned_to              UUID NOT NULL REFERENCES app_user(id),
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retest_requested', 'resolved', 'withdrawn')),
  qa_note                  TEXT,
  original_description     TEXT NOT NULL,                 -- kept as first written, whatever happens later
  original_revision_number INTEGER NOT NULL,
  retest_submission_id     UUID REFERENCES qa_submission(id),
  created_by               UUID NOT NULL REFERENCES app_user(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX correction_item_assignee_idx ON correction_item (assigned_to, status);

CREATE TABLE qa_approval (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id),
  submission_id UUID NOT NULL UNIQUE REFERENCES qa_submission(id) ON DELETE CASCADE,
  revision_id   UUID NOT NULL REFERENCES email_revision(id),
  content_hash  TEXT NOT NULL,
  reviewer_id   UUID NOT NULL REFERENCES app_user(id),
  approved_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The database refuses an approval by the person who wrote the revision or sent it to QA, or for any revision other than the submitted one.
CREATE FUNCTION qa_approval_guard() RETURNS trigger AS $$
DECLARE author UUID; submitter UUID; submitted UUID;
BEGIN
  SELECT created_by INTO author FROM email_revision WHERE id = NEW.revision_id;
  SELECT submitted_by, revision_id INTO submitter, submitted FROM qa_submission WHERE id = NEW.submission_id;
  IF NEW.revision_id IS DISTINCT FROM submitted THEN RAISE EXCEPTION 'an approval applies to the submitted revision only'; END IF;
  IF NEW.reviewer_id = author OR NEW.reviewer_id = submitter THEN RAISE EXCEPTION 'the approver must be a different person from the author of the revision'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER qa_approval_check BEFORE INSERT ON qa_approval FOR EACH ROW EXECUTE FUNCTION qa_approval_guard();

CREATE FUNCTION qa_approval_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM qa_submission WHERE id = OLD.submission_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'an approval is a record and cannot change';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER qa_approval_keep BEFORE UPDATE OR DELETE ON qa_approval FOR EACH ROW EXECUTE FUNCTION qa_approval_immutable();
