# Team Server (preview): admin guide

> **Preview.** The Team Server is a preview in this release (decision 1 of the M9 plan). It is
> not covered by the 1.0 support policy, and it has not had its external security test yet
> (decision 14). Teams that need a supported way to share today use exchange files or a hub
> folder, which need no server at all.

The Team Server lets a team share Quadrion AI projects over your own network. It runs on your
premises, in Docker, with Postgres. Synapse runs nothing and receives nothing: projects, people
and files stay on your machines.

- It **stores and forwards** the project history (signed ops) and project files (blobs). It never
  merges: every Quadrion AI app computes the same state from the same history.
- It **enforces roles.** Every change is checked against the person's role at the time it was
  made (owner, reviewer, viewer, client) and refused with 403 when it is not allowed.
- It **countersigns** every change it accepts (a receipt chain), so an export of its audit shows
  exactly what it accepted and in what order.
- People who work alone, or offline, need no server and no account.

## What you need

- A Linux host or VM with Docker and Docker Compose (2 CPU, 4 GB RAM, disk for the projects'
  files).
- A TLS certificate for the server's name (from your CA, a corporate CA or a public CA). The app
  shows the certificate fingerprint to each person on first contact and remembers it.
- A firewall rule letting the reviewers' computers reach the server's port (8443 by default).

## Install

1. Copy `apps/team-server/compose.yaml` to a folder on the host, for example `/opt/team-server`.
2. Put the certificate and its key in `tls/server.crt` and `tls/server.key` next to it. The key
   must be readable by the server's user (65532):
   `sudo chown 65532 tls/server.key && sudo chmod 600 tls/server.key`.
3. Copy the `apps/team-server/initdb` folder next to it too: on the first start it creates the
   `aio_app` role the server runs as.
4. Write two long random passwords into `.env`: `DB_PASSWORD=...` (the database owner, used only
   to apply migrations) and `APP_DB_PASSWORD=...` (the `aio_app` role).
5. Start: `docker compose up -d`. The server creates its database tables and its own signing key
   (`/data/server-key.pem` in the `data` volume) on first start.
6. Name the server and get the first owner invite:

   ```
   docker compose exec server /nodejs/bin/node /app/dist/main.mjs create-team --name "Survey team"
   ```

   It prints an invite code such as `7KQ2-M9XD-4TRB-P0WE`, valid for 7 days and one use.

The image runs as a non-root user on a read-only file system with no shell. Its health check
calls `/v1/health`.

## Invite people

Each person needs their own one-time code, with the role they get:

```
docker compose exec server /nodejs/bin/node /app/dist/main.mjs invite --role reviewer
docker compose exec server /nodejs/bin/node /app/dist/main.mjs invite --role viewer --project t_...
```

- Roles: `owner` (everything, including sharing new projects to the server), `reviewer` (edit,
  comment, assign, approve), `viewer` (read; comments only when the project's policy allows),
  `client` (only client-visible comments and acceptance).
- Without `--project`, the role applies in every project on the server until an owner adds the
  person to a project in the app; from then on, the project's own member list decides.
- `--days 1` to `--days 90` changes how long the code is valid.

The person opens **Settings**, **Data folder**, **Team server**, enters the server address
(`https://team.example.com:8443`) and the code, checks the fingerprint with you and accepts it.

## Keep it safe

- **Every request is signed** by the person's device key (RFC 9421 HTTP message signatures,
  Ed25519). There are no passwords and no bearer tokens to steal. A replayed or altered request
  is refused.
- **The certificate is pinned.** The app refuses a server whose certificate changed. In this
  preview that includes a certificate your corporate CA renewed: after a renewal, each person
  forgets the server in the app and connects again with a new invite code.
- **TLS is required** except on the server's own machine. Behind a reverse proxy that ends TLS,
  set `AIO_BEHIND_TLS_PROXY=1`, `AIO_PUBLIC_URL=https://team.example.com` and
  `AIO_TLS_FINGERPRINT` (the SHA-256 of the proxy's certificate) instead of the certificate files.
- **History is append-only.** The database refuses UPDATE, DELETE and TRUNCATE on the history
  and receipt tables for every user (a trigger). The example `compose.yaml` also runs the server
  as a role that owns nothing, `aio_app` (`DATABASE_URL`), while the migrations run as the
  database owner (`AIO_MIGRATION_DATABASE_URL`). The migrations grant `aio_app` only SELECT and
  INSERT on the history and receipt tables. Never point `DATABASE_URL` at the owner or a
  superuser: a superuser can switch the trigger off.
- **Identities are bound at enrolment.** An invite code lets a device join as a new person, or
  as a person the server already knows only with a certificate from one of that person's devices
  or from an owner. A project's member list always has the last word on which devices are whose.
- **Project files stay in their projects.** A device reads a file only when a project it may read
  names the file, or when it sent every byte of that file itself. Only owners and reviewers send
  files. Each device's unfinished uploads are its own, count against a quota
  (`AIO_BLOB_PARTIAL_QUOTA_GB`) and are deleted after 7 days without progress.
- **Behind a reverse proxy** the server listens on `127.0.0.1` and trusts `X-Forwarded-For` only
  from `127.0.0.1` by default. When the proxy runs elsewhere (another container), set `AIO_HOST`
  to the address it reaches and `AIO_TRUSTED_PROXIES` to the proxy's address or network.
- **Logs** are structured and never contain project content, signatures or invite codes.
- **Rate limits** slow down code guessing and floods (enrolment: 20 attempts per address per 10
  minutes).

### Revoke a device

```
docker compose exec server /nodejs/bin/node /app/dist/main.mjs devices
docker compose exec server /nodejs/bin/node /app/dist/main.mjs revoke-device d_... --reason "Lost laptop"
```

The device's requests are refused at once. An owner also revokes it in the app, so the project
history records it.

## Back up, restore, upgrade

Back up three things: the database (the `backup` command), the `data` volume (project files and
the server key) and your `.env` and `tls` folder.

```
docker compose exec server /nodejs/bin/node /app/dist/main.mjs backup --out /data/backup-2026-10-07.jsonl
```

Restore into an **empty** database (a new install with the same server key):

```
docker compose exec server /nodejs/bin/node /app/dist/main.mjs restore --in /data/backup-2026-10-07.jsonl
```

Restore reads the whole file first and writes nothing if the file is damaged or its receipt chain
does not verify. Test a restore on a spare VM now and then; CI does it on every change.

**Upgrade:** back up, change the image tag in `compose.yaml`, then `docker compose up -d`. The
server applies new database migrations on start.

**Upgrading a server installed before 21 October 2026** to the `aio_app` role: add
`APP_DB_PASSWORD=...` to `.env`, create the role once, then start with the new `compose.yaml`
(its first migration after the upgrade grants the role what it needs):

````
docker compose exec db psql -U aio -d aio -c "CREATE ROLE aio_app LOGIN NOSUPERUSER NOINHERIT PASSWORD '<APP_DB_PASSWORD>'"
docker compose up -d
``` The app checks the server's protocol version
and says so when the app or the server needs an update.

## Audit

Export one project's history as the server holds it, with the server's receipts and public key:

````

docker compose exec server /nodejs/bin/node /app/dist/main.mjs export-audit --project t_... --out /data/audit-t_...
docker compose exec server /nodejs/bin/node /app/dist/main.mjs verify /data/audit-t_...

```

The export uses the journal's own folder layout (`journal/ops/...`, `journal/devices/...`), so
the app's **Verify** reads the same files, and its result matches `verify`.

## Settings

| Variable                                | Default                | Meaning                                                   |
| --------------------------------------- | ---------------------- | --------------------------------------------------------- |
| `DATABASE_URL`                          | none (required)        | The Postgres database, as the role the server runs as     |
| `AIO_MIGRATION_DATABASE_URL`            | `DATABASE_URL`         | The same database as its owner, for the migrations        |
| `AIO_TLS_CERT_FILE`, `AIO_TLS_KEY_FILE` | none                   | The server ends TLS itself                                |
| `AIO_BEHIND_TLS_PROXY`                  | off                    | `1`: plain HTTP behind a proxy that ends TLS              |
| `AIO_PUBLIC_URL`                        | none                   | The address people use (required behind a proxy)          |
| `AIO_TLS_FINGERPRINT`                   | none                   | The proxy certificate's SHA-256, shown at enrolment       |
| `AIO_HOST`, `AIO_PORT`                  | `0.0.0.0`, `8443`      | Where the server listens (`127.0.0.1` behind a proxy)     |
| `AIO_TRUSTED_PROXIES`                   | `127.0.0.1,::1`        | Proxy addresses or networks whose forwarded headers count |
| `AIO_REQUIRE_SIGNED_HEADERS`            | off                    | `1`: refuse unsigned content types (once every app is updated) |
| `AIO_BLOB_PARTIAL_QUOTA_GB`             | `64`                   | Unfinished uploads per device                             |
| `AIO_DATA_DIR`                          | `/data`                | Server key and project files                              |
| `AIO_SERVER_KEY_FILE`                   | `/data/server-key.pem` | The server's signing key (a Docker secret is better)      |
| `AIO_BLOB_STORE`                        | `fs`                   | Where project files live (`s3` is not in the preview yet) |
| `AIO_SERVER_NAME`                       | `Team server`          | The name people see (`create-team` sets it too)           |
| `AIO_LOG`                               | on                     | `off` silences the request log                            |

## What the preview does not do yet

- No S3-compatible blob store yet: project files are on the server's disk (the `data` volume).
- No web interface: the command line above is the admin interface.
- One server process per database (no cluster).
- Clients do not download shared packages from the server yet, and the free player does not
  write reply files yet.
- Project files are stored once on the server's disk, whatever project names them (who may
  read them is checked per project).
- The app shows no live server status.
- A certificate renewed by a trusted CA is not accepted on its own yet (see "Keep it safe").

To share a project through the server, its owner opens it in the app, clicks **Share** in the
title bar and picks **Team server**. Each other person needs a copy of the project that belongs
to the team project: they import one exchange file from the owner, then in the **Team** dialog
click **Use a shared folder**, pick **Team server** and click **Share**. See the user guide
chapter "Team server (preview)".

## Licences

Node.js, Fastify, node-postgres and zod (MIT, BSD, ISC), Postgres (PostgreSQL licence). No
PostGIS, no MinIO, nothing GPL or AGPL in the image; CI checks it on every change.
```
