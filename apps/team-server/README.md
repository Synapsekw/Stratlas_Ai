# @aio/team-server

Team Server (self-hosted, preview; M9 stream T7): the `aio.sync/1` API run by customer IT on
their premises (decision 2). It stores and forwards ops and blobs and checks chain, signature
and role on every op; it never merges, so server and app cannot disagree on state. Synapse hosts
no customer data. Licences: Fastify (MIT) and its dependencies (MIT, BSD, ISC); Postgres and an
optional customer-provided S3-compatible store; no PostGIS, no MinIO, nothing GPL or AGPL.

- `src/server.ts`: `buildServer({ store, version })` (health now; T7 adds the routes).
- `src/store/store.ts`: the append-only `Store` interface; `src/store/memory.ts` for tests.

T7 adds Postgres, the blob stores, enrolment, RFC 9421 request signatures, receipts, the admin
CLI, the Dockerfile and compose file, and the `team-server` CI job.
