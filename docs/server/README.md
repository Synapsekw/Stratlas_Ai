# Team Server (preview): admin guide

> **Preview.** The Team Server is a preview in this release (decision 1 of the M9 plan). It is
> not covered by the 1.0 support policy, and it has not had its external security test yet
> (decision 14). Teams that need a supported way to share today use exchange files or a hub
> folder, which need no server at all.

The Team Server lets a team share Stratlas projects over your own network. It runs on your
premises, in Docker, with Postgres. Synapse runs nothing and receives nothing: projects, people
and files stay on your machines.

- It **stores and forwards** the project history (signed ops) and project files (blobs). It never
  merges: every Stratlas app computes the same state from the same history.
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
3. Write a long random database password into `.env`: `DB_PASSWORD=...`.
4. Start: `docker compose up -d`. The server creates its database tables and its own signing key
   (`/data/server-key.pem` in the `data` volume) on first start.
5. Name the server and get the first owner invite:

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

The person opens **Settings**, **Data**, **Team server**, enters the server address
(`https://team.example.com:8443`) and the code, checks the fingerprint with you and accepts it.

## Keep it safe

- **Every request is signed** by the person's device key (RFC 9421 HTTP message signatures,
  Ed25519). There are no passwords and no bearer tokens to steal. A replayed or altered request
  is refused.
- **The certificate is pinned.** The app refuses a server whose certificate changed, unless the
  new certificate is issued by a CA the computer trusts (a corporate CA renewing it).
- **TLS is required** except on the server's own machine. Behind a reverse proxy that ends TLS,
  set `AIO_BEHIND_TLS_PROXY=1`, `AIO_PUBLIC_URL=https://team.example.com` and
  `AIO_TLS_FINGERPRINT` (the SHA-256 of the proxy's certificate) instead of the certificate files.
- **History is append-only.** The database refuses UPDATE, DELETE and TRUNCATE on the history
  and receipt tables for every user. For defence in depth, create a role `aio_app` before the
  first start and let the server connect as it: the first migration grants it only SELECT and
  INSERT on those tables.
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
server applies new database migrations on start. The app checks the server's protocol version
and says so when the app or the server needs an update.

## Audit

Export one project's history as the server holds it, with the server's receipts and public key:

```
docker compose exec server /nodejs/bin/node /app/dist/main.mjs export-audit --project t_... --out /data/audit-t_...
docker compose exec server /nodejs/bin/node /app/dist/main.mjs verify /data/audit-t_...
```

The export uses the journal's own folder layout (`journal/ops/...`, `journal/devices/...`), so
the app's **Verify** reads the same files, and its result matches `verify`.

## Settings

| Variable                                | Default                | Meaning                                                   |
| --------------------------------------- | ---------------------- | --------------------------------------------------------- |
| `DATABASE_URL`                          | none (required)        | The Postgres database                                     |
| `AIO_TLS_CERT_FILE`, `AIO_TLS_KEY_FILE` | none                   | The server ends TLS itself                                |
| `AIO_BEHIND_TLS_PROXY`                  | off                    | `1`: plain HTTP behind a proxy that ends TLS              |
| `AIO_PUBLIC_URL`                        | none                   | The address people use (required behind a proxy)          |
| `AIO_TLS_FINGERPRINT`                   | none                   | The proxy certificate's SHA-256, shown at enrolment       |
| `AIO_HOST`, `AIO_PORT`                  | `0.0.0.0`, `8443`      | Where the server listens                                  |
| `AIO_DATA_DIR`                          | `/data`                | Server key and project files                              |
| `AIO_SERVER_KEY_FILE`                   | `/data/server-key.pem` | The server's signing key (a Docker secret is better)      |
| `AIO_BLOB_STORE`                        | `fs`                   | Where project files live (`s3` is not in the preview yet) |
| `AIO_SERVER_NAME`                       | `Team server`          | The name people see (`create-team` sets it too)           |
| `AIO_LOG`                               | on                     | `off` silences the request log                            |

## What the preview does not do yet

- No S3-compatible blob store yet: project files are on the server's disk (the `data` volume).
- No web interface: the command line above is the admin interface.
- One server process per database (no cluster).
- Clients do not download shared packages from the server yet; they reply with reply files.
- Two people syncing through the server needs the app's server mode for a project (share a
  project with **Server** mode), which arrives with the sync streams of this release.

## Licences

Node.js, Fastify, node-postgres and zod (MIT, BSD, ISC), Postgres (PostgreSQL licence). No
PostGIS, no MinIO, nothing GPL or AGPL in the image; CI checks it on every change.
