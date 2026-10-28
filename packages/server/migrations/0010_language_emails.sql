-- B1: language registry, language emails (one per language, each with its own revisions).
-- Additive only: existing tables keep working; nothing is deleted or rewritten here.

-- Which editor model an email uses. 'legacy' = everything inside campaign.draft_content (the previous editor);
-- 'v2' = one email_variant per language. Existing rows stay 'legacy' until a Builder upgrades them.
ALTER TABLE campaign ADD COLUMN model TEXT NOT NULL DEFAULT 'legacy' CHECK (model IN ('legacy', 'v2'));
-- Per-segment copies / mapping of the previous editor that the new model does not use: kept, read-only.
ALTER TABLE campaign ADD COLUMN legacy_variants JSONB;

CREATE TABLE language (
  id          TEXT PRIMARY KEY,                 -- stable slug, e.g. 'de', 'pt-br'
  locale      TEXT NOT NULL UNIQUE,             -- BCP-47, e.g. 'de-DE'
  name        TEXT NOT NULL,                    -- English name shown in the app
  native_name TEXT NOT NULL,
  direction   TEXT NOT NULL DEFAULT 'ltr' CHECK (direction IN ('ltr', 'rtl')),
  aliases     JSONB NOT NULL DEFAULT '[]',      -- other spellings accepted when typing a list of languages
  active      BOOLEAN NOT NULL DEFAULT true,
  sort        INTEGER NOT NULL
);

INSERT INTO language (id, locale, name, native_name, direction, aliases, sort) VALUES
  ('en',      'en-US',   'English',               'English',            'ltr', '["en","english"]', 1),
  ('ar',      'ar',      'Arabic',                'العربية',            'rtl', '["ar","arabic"]', 2),
  ('da',      'da-DK',   'Danish',                'Dansk',              'ltr', '["da","danish"]', 3),
  ('nl',      'nl-NL',   'Dutch',                 'Nederlands',         'ltr', '["nl","dutch"]', 4),
  ('el',      'el-GR',   'Greek',                 'Ελληνικά',           'ltr', '["el","greek"]', 5),
  ('ru',      'ru-RU',   'Russian',               'Русский',            'ltr', '["ru","russian"]', 6),
  ('pl',      'pl-PL',   'Polish',                'Polski',             'ltr', '["pl","polish"]', 7),
  ('fr',      'fr-FR',   'French',                'Français',           'ltr', '["fr","french"]', 8),
  ('de',      'de-DE',   'German',                'Deutsch',            'ltr', '["de","german"]', 9),
  ('tr',      'tr-TR',   'Turkish',               'Türkçe',             'ltr', '["tr","turkish"]', 10),
  ('pt-pt',   'pt-PT',   'European Portuguese',   'Português (Portugal)', 'ltr', '["pt-pt","portuguese (portugal)","portuguese portugal","european portuguese"]', 11),
  ('pt-br',   'pt-BR',   'Brazilian Portuguese',  'Português (Brasil)', 'ltr', '["pt-br","portuguese (brazil)","portuguese brazil","brazilian portuguese"]', 12),
  ('zh-tw',   'zh-TW',   'Taiwanese',             '臺灣華語',            'ltr', '["zh-tw","taiwanese"]', 13),
  ('th',      'th-TH',   'Thai',                  'ไทย',                'ltr', '["th","thai"]', 14),
  ('ja',      'ja-JP',   'Japanese',              '日本語',              'ltr', '["ja","japanese"]', 15),
  ('ko',      'ko-KR',   'Korean',                '한국어',              'ltr', '["ko","korean"]', 16),
  ('zh-hans', 'zh-Hans', 'Simplified Chinese',    '简体中文',            'ltr', '["zh-hans","zh-cn","simplified chinese","chinese simplified"]', 17),
  ('zh-hant', 'zh-Hant', 'Traditional Chinese',   '繁體中文',            'ltr', '["zh-hant","traditional chinese","chinese traditional"]', 18),
  ('id',      'id-ID',   'Bahasa',                'Bahasa Indonesia',   'ltr', '["id","bahasa","bahasa indonesia","indonesian"]', 19),
  ('hu',      'hu-HU',   'Hungarian',             'Magyar',             'ltr', '["hu","hungarian"]', 20),
  ('no',      'nb-NO',   'Norwegian',             'Norsk',              'ltr', '["no","nb","norwegian"]', 21),
  ('es',      'es-ES',   'Spanish',               'Español',            'ltr', '["es","spanish"]', 22),
  ('cs',      'cs-CZ',   'Czech',                 'Čeština',            'ltr', '["cs","czech"]', 23),
  ('vi',      'vi-VN',   'Vietnamese',            'Tiếng Việt',         'ltr', '["vi","vietnamese"]', 24),
  ('sv',      'sv-SE',   'Swedish',               'Svenska',            'ltr', '["sv","swedish"]', 25),
  ('it',      'it-IT',   'Italian',               'Italiano',           'ltr', '["it","italian"]', 26);

-- The languages an email is written in (English first).
CREATE TABLE campaign_language (
  campaign_id  UUID NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  language_id  TEXT NOT NULL REFERENCES language(id),
  position     INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, language_id)
);

-- One email per language. The draft is the working copy (autosaved); revisions are the saved, numbered snapshots.
CREATE TABLE email_variant (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspace(id),
  campaign_id       UUID NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  language_id       TEXT NOT NULL REFERENCES language(id),
  source_variant_id UUID REFERENCES email_variant(id) ON DELETE SET NULL,   -- the email it was created from
  request_id        TEXT,                                                    -- makes a retried "create" return the first result
  draft_content     JSONB NOT NULL,
  draft_version     INTEGER NOT NULL DEFAULT 1,
  draft_hash        TEXT NOT NULL,
  created_by        UUID NOT NULL REFERENCES app_user(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID REFERENCES app_user(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, language_id),
  UNIQUE (campaign_id, request_id)
);
CREATE INDEX email_variant_campaign_idx ON email_variant (campaign_id);

CREATE TABLE email_revision (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspace(id),
  variant_id       UUID NOT NULL REFERENCES email_variant(id) ON DELETE CASCADE,
  number           INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('created', 'manual', 'restore', 'clone', 'upgrade')),
  label            TEXT,
  content          JSONB NOT NULL,
  content_hash     TEXT NOT NULL,
  restored_from_id UUID REFERENCES email_revision(id),
  created_by       UUID NOT NULL REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (variant_id, number)
);

-- Saved revisions are never edited. They can only disappear together with their email (cascade).
CREATE FUNCTION email_revision_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM email_variant WHERE id = OLD.variant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'email_revision is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER email_revision_no_change
  BEFORE UPDATE OR DELETE ON email_revision
  FOR EACH ROW EXECUTE FUNCTION email_revision_immutable();
