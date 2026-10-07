-- Team Server (M9 T7, preview): the first schema.
-- Ops and receipts are append-only: a trigger refuses UPDATE, DELETE and TRUNCATE for every
-- role, the table owner included, and the grants below give the application role only SELECT
-- and INSERT on them. Ops are kept as the exact JSON the device sent (text, not jsonb), so every
-- hash and signature still verifies after a dump and restore.

CREATE TABLE meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE projects (
  team_project_id text PRIMARY KEY,
  name            text NOT NULL,
  created_at      text NOT NULL,
  created_by      text NOT NULL
);

CREATE TABLE ops (
  pos         bigserial PRIMARY KEY,
  project     text NOT NULL REFERENCES projects (team_project_id),
  id          char(64) NOT NULL,
  chain       text NOT NULL,
  seq         integer NOT NULL CHECK (seq >= 1),
  kind        text NOT NULL,
  raw         text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project, id),
  UNIQUE (project, chain, seq)
);
CREATE INDEX ops_project_pos ON ops (project, pos);

CREATE TABLE receipts (
  seq bigint PRIMARY KEY CHECK (seq >= 1),
  id  char(64) NOT NULL UNIQUE,
  op  char(64) NOT NULL,
  raw text NOT NULL
);

CREATE TABLE invites (
  code_hash  char(64) PRIMARY KEY,
  role       text NOT NULL,
  project    text,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  used_at    text,
  used_by    text
);

CREATE TABLE devices (
  device        text PRIMARY KEY,
  actor         text NOT NULL,
  raw           jsonb NOT NULL,
  revoked_at    text,
  revoke_reason text
);

CREATE FUNCTION aio_refuse_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'aio: % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER ops_append_only BEFORE UPDATE OR DELETE ON ops
  FOR EACH ROW EXECUTE FUNCTION aio_refuse_change();
CREATE TRIGGER ops_no_truncate BEFORE TRUNCATE ON ops
  FOR EACH STATEMENT EXECUTE FUNCTION aio_refuse_change();
CREATE TRIGGER receipts_append_only BEFORE UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION aio_refuse_change();
CREATE TRIGGER receipts_no_truncate BEFORE TRUNCATE ON receipts
  FOR EACH STATEMENT EXECUTE FUNCTION aio_refuse_change();

REVOKE UPDATE, DELETE, TRUNCATE ON ops, receipts FROM PUBLIC;

-- The application role (docs/server/README.md): only reads and appends ops and receipts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aio_app') THEN
    GRANT SELECT, INSERT ON ops, receipts TO aio_app;
    GRANT SELECT, INSERT, UPDATE ON meta, projects, invites, devices TO aio_app;
    GRANT USAGE ON SEQUENCE ops_pos_seq TO aio_app;
  END IF;
END
$$;
