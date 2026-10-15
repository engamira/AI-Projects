-- M0 persistence probe: proves data survives restarts and redeploys.
CREATE TABLE IF NOT EXISTS m0_probe (
  id         SERIAL PRIMARY KEY,
  note       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
