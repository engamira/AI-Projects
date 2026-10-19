-- M3: cropped, resized copies of library pictures (square speaker photos, 4:3 cards).
-- Email apps cannot crop pictures themselves, so the app delivers them already the right shape.
-- Generated on first request, then kept. The original picture is never changed.
CREATE TABLE asset_variant (
  asset_id   UUID NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  variant    TEXT NOT NULL,
  mime       TEXT NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, variant)
);
