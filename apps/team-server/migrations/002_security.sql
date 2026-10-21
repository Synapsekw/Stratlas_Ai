-- Team Server: the security review of 2026-10-21.
-- Request nonces outlive a restart (a replayed request stays refused), and the server remembers
-- which device uploaded every byte of which blob (that device may read it back before any op of
-- a project names it). The grants of the application role are applied again, so a database made
-- before the role existed gets them too (docs/server/README.md, compose.yaml).

CREATE TABLE request_nonces (
  device  text   NOT NULL,
  nonce   text   NOT NULL,
  seen_ms bigint NOT NULL,
  PRIMARY KEY (device, nonce)
);
CREATE INDEX request_nonces_seen ON request_nonces (seen_ms);

CREATE TABLE blob_uploads (
  sha256      char(64) NOT NULL,
  device      text     NOT NULL,
  uploaded_at text     NOT NULL,
  PRIMARY KEY (sha256, device)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aio_app') THEN
    GRANT SELECT, INSERT ON ops, receipts TO aio_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON ops, receipts FROM aio_app;
    GRANT SELECT, INSERT, UPDATE ON meta, projects, invites, devices TO aio_app;
    GRANT USAGE ON SEQUENCE ops_pos_seq TO aio_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON request_nonces TO aio_app;
    GRANT SELECT, INSERT ON blob_uploads TO aio_app;
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO aio_app', current_schema());
  END IF;
END
$$;
