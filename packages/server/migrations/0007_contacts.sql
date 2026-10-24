-- M4: audience. At most 10 stored contacts, ever (enforced here in the database as well as in the app, so no code path can exceed it).

CREATE TABLE import_batch (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspace(id),
  filename           TEXT,
  total_rows         INTEGER NOT NULL,
  added              INTEGER NOT NULL,
  updated            INTEGER NOT NULL,
  duplicates_in_file INTEGER NOT NULL,
  over_limit         INTEGER NOT NULL,
  invalid            INTEGER NOT NULL,
  update_existing    BOOLEAN NOT NULL,
  issues             JSONB NOT NULL DEFAULT '[]', -- first row problems, without personal details beyond the row number
  created_by         UUID REFERENCES app_user(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contact (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspace(id),
  email             TEXT NOT NULL,
  email_key         TEXT NOT NULL,                 -- trimmed lowercase email: the identity of the contact
  first_name        TEXT,
  last_name         TEXT,
  company           TEXT,
  country           TEXT,
  city              TEXT,
  language          TEXT,
  customer_since    DATE,
  orders            INTEGER CHECK (orders IS NULL OR orders >= 0),
  vip               BOOLEAN,
  marketing_active  BOOLEAN NOT NULL DEFAULT true, -- permission to send marketing email
  unsubscribed_at   TIMESTAMPTZ,
  suppressed_reason TEXT CHECK (suppressed_reason IN ('bounce', 'complaint', 'manual')),
  suppressed_at     TIMESTAMPTZ,
  import_batch_id   UUID REFERENCES import_batch(id) ON DELETE SET NULL,
  created_by        UUID REFERENCES app_user(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email_key)
);

CREATE FUNCTION contact_cap() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('contact_cap:' || NEW.workspace_id::text)); -- two imports at once cannot both squeeze in
  IF (SELECT count(*) FROM contact WHERE workspace_id = NEW.workspace_id) >= 10 THEN
    RAISE EXCEPTION 'contact limit reached: at most 10 contacts can be stored' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contact_cap_check BEFORE INSERT ON contact FOR EACH ROW EXECUTE FUNCTION contact_cap();
