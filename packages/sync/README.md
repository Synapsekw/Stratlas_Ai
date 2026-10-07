# @aio/sync

Moving ops and blobs between copies of a team project (M9 streams T5, T6, T7). Public API:
`src/index.ts`, plus `./exchange`, `./hub`, `./blobs` and `./http`. Ownership and dependencies:
`docs/architecture/SPEC.md` section 2 (depends on schema). Formats: data-conventions sections 19
and 20; protocol `aio.sync/1` in `@aio/schema` `sync.ts`.

- `transport.ts`: `SyncTransport` (`heads`, `pushOps`, `pullOps`, `hasBlobs`, `putBlob`,
  `getBlob`). A transport stores and forwards; it never merges.
- `memory.ts`: an in-memory transport for tests.
- `exchange/` (T5): `.aiosync` members and the member-name check for hostile archives.
- `hub/` (T5): hub folder layout and presence.
- `blobs/` (T6): fetch policy defaults; hashing, transfers and the cache.
- `http/` (T7): the team server client (signed requests, pinned fingerprint).
