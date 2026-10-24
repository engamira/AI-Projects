-- M4: a campaign chooses which fields segment its audience (for example Country + Language), and can have a
-- generated TEST audience: made-up contacts, one per segment, used only to test the email. They live in their own
-- table and never in the real contact list, and their addresses use the reserved ".invalid" ending, so they can never be mailed.

CREATE TABLE campaign_audience (
  campaign_id  UUID PRIMARY KEY REFERENCES campaign(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  fields       JSONB NOT NULL DEFAULT '[]',  -- field keys, in the order chosen
  updated_by   UUID REFERENCES app_user(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE campaign_test_contact (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  campaign_id  UUID NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,                -- the segment name, e.g. UAE-en
  email        TEXT NOT NULL CHECK (email LIKE '%.invalid'),
  data         JSONB NOT NULL,               -- every field value of the made-up contact
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, code)
);
