-- M3: folders for the picture library (one level). A picture is in at most one folder; deleting a folder
-- keeps its pictures and moves them back to "No folder".
CREATE TABLE asset_folder (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  created_by   UUID REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX asset_folder_name_idx ON asset_folder (workspace_id, lower(name));

ALTER TABLE asset ADD COLUMN folder_id UUID REFERENCES asset_folder(id) ON DELETE SET NULL;
CREATE INDEX asset_folder_id_idx ON asset (folder_id);
