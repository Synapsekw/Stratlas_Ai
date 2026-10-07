# @aio/team-server

Team Server (self-hosted, preview; M9 stream T7): the `aio.sync/1` API run by customer IT on
their premises (decision 2). It stores and forwards ops and blobs, checks schema, hash, chain,
signature and role on every op, and countersigns what it accepts; it never merges, so server and
app cannot disagree on state. Synapse hosts no customer data. Admin guide: `docs/server/README.md`.

- `src/server.ts`: `buildServer(...)`, the Fastify routes; every route but health is signed per
  device (RFC 9421, `src/auth/signatures.ts`).
- `src/core.ts`: push checks, pulls with cursors, members, enrolment; `src/roles.ts`: roles at
  each op's clock reading; `src/receipts.ts`: the server's receipt chain.
- `src/store/`: the append-only `Store` interface, `memory.ts` (tests, trials) and `postgres.ts`
  with `migrations/*.sql` (UPDATE, DELETE and TRUNCATE refused on ops and receipts).
- `src/blobs/`: `fs.ts` (default) and `s3.ts` (interface only in the preview).
- `src/cli.ts`: `serve`, `migrate`, `create-team`, `invite`, `devices`, `revoke-device`,
  `export-audit`, `verify`, `backup`, `restore`, `version`.
- `src/testkit.ts`: TEST-ONLY people, chains and a loopback TLS server (the suite and the e2e).
- `Dockerfile` (distroless, non-root, read-only), `compose.yaml` (server and `postgres:16`).

Tests: `pnpm -F @aio/team-server test` runs every route on the memory store; with
`DATABASE_URL` set the same suite and the append-only and backup tests run on Postgres (CI job
`team-server`). `pnpm -F @aio/team-server build` bundles `dist/main.mjs`.

Licences: Fastify, node-postgres, zod and their dependencies (MIT, BSD, ISC); Postgres; no
PostGIS, no MinIO, nothing GPL or AGPL.
