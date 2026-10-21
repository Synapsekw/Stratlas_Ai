#!/bin/sh
# Team Server: the role the server connects as (compose.yaml). It owns nothing: the migrations run
# as the database owner and grant it only SELECT and INSERT on the history (ops, receipts), so even
# the server process cannot rewrite or delete what it accepted. Postgres runs this once, when it
# first creates its data folder; docs/server/README.md has the steps for an existing database.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE aio_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"db" TO aio_app;
GRANT USAGE ON SCHEMA public TO aio_app;
SQL
