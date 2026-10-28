-- B2: segments and test audiences made from the show/hide rules of the language emails.
-- Both are rebuilt by the server whenever the languages or the rules change; they are test fixtures, never real contacts.

CREATE TABLE derived_segment (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id),
  campaign_id   UUID NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  language_id   TEXT NOT NULL REFERENCES language(id),
  fingerprint   TEXT NOT NULL,                  -- language + values: the same rules always give the same fingerprint
  name          TEXT NOT NULL,                  -- "UAE VIP English Segment"
  polarity      TEXT NOT NULL CHECK (polarity IN ('positive', 'negative')),
  predicate     JSONB NOT NULL,                 -- the contact values that define it
  rule_ids      JSONB NOT NULL DEFAULT '[]',
  position      INTEGER NOT NULL DEFAULT 0,     -- the order the rules produce them in
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, fingerprint)
);

CREATE TABLE test_audience (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id),
  campaign_id   UUID NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  language_id   TEXT NOT NULL REFERENCES language(id),
  fingerprint   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('baseline', 'scenario')),
  polarity      TEXT NOT NULL CHECK (polarity IN ('baseline', 'positive', 'negative')),
  name          TEXT NOT NULL,                  -- "UAE VIP English-Audience", "en-Audience"
  email         TEXT NOT NULL CHECK (email LIKE '%.invalid'),   -- made up, never mailed
  attributes    JSONB NOT NULL,                 -- every contact value of the made-up contact
  rule_ids      JSONB NOT NULL DEFAULT '[]',
  expected      JSONB NOT NULL DEFAULT '{}',    -- which blocks of the language email should be shown / hidden
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, fingerprint)
);
CREATE INDEX test_audience_campaign_idx ON test_audience (campaign_id, language_id);
