# @aio/merge

The merge engine (M9 stream T4): projects journal ops into state files for every record type,
order-independent, with conflicts and quarantine. Public API: `src/index.ts`. Depends on
`@aio/schema` and `@aio/journal` (canonical JSON, content hashes, op checks).

Pure: no file system, no clock, no randomness (`now` is passed in). Runs in the data process or a
worker; the renderer imports types only.

## Modules

- `causal.ts`: `indexOps`. Dedupes by id, orders by clock reading then op id, and builds a vector
  of the highest seq seen per chain from `prev` and `deps`, so the engine tells a later write from
  a concurrent one. Ops whose `prev` or `deps` are missing are held (`held`), never applied.
- `quarantine.ts`: `gate`. Refuses ops that fail verification (`keys`, `refused`), come from a
  revoked device or a non-member, go beyond the role at their clock reading (`OP_PERMISSION`,
  plus `builder.georef` for `crs`, `origin` and `verticalDatum`, and `close-approved`), edit
  another person's comment, withdraw another person's approval, or approve through the agent.
  More than 24 hours ahead: held in quarantine; 5 minutes: a clock notice. A project never
  shared has no roles. An owner releases with `conflict.resolve` naming `quarantine:<op id>`.
- `registers.ts`: `FieldLog`, last writer per field; conflicts are writes concurrent with the
  winner, with another value, that nothing later replaced (one per losing value).
- `rules/issue.ts`: issues. Fields by last writer (`classId` with `severityModelId` as one
  conflict; `updatedAt` quiet); sightings as an add-wins set by content hash (a remove takes only
  the adds it had seen); delete or merge against a concurrent edit keeps the issue (conflict
  `delete-edit` or `merge`); a merge carries sightings added concurrently to the source into the
  target; equal codes: the issue made later by clock takes the next free code (`recodes`, and a
  `code` conflict until dismissed, listing packages delivered with the old code).
- `rules/records.ts`: change items (`change.review`, `status` with `by` and `at`), detections and
  whole passes (`detection.review`), model parts (`procmodel.part`), manifest entries
  (`manifest.entry`, projected but not yet applied to `manifest.json`), boundary edits (last
  writer per pile and date) and narrative versions (grow-only).
- `rules/collab.ts`: comments (grow-only, versions by the author, tombstones, redaction),
  assignments (last writer, two different concurrent assignees are a conflict), approvals
  (grow-only, withdrawn by the same actor). `@aio/collab` decides whether an approval is current.
- `conflicts.ts`: stable conflict ids, `ours` as the viewer's side, `resolveDrafts` (a
  `conflict.resolve` op, then the write when the chosen value is not the one in the files),
  `writeDrafts` (Restore), `releaseDraft`.
- `apply.ts`: today's files, byte for byte as today's writers make them (the IPC zod shape, then
  `writeJsonAtomic`'s text). Adds no field to any record. `mergeStateFiles` reads and merges
  every file the projection decides.
- `inbox.ts`: `createInbox`, the four `sync:*` channels over injected I/O.
- `testing/generator.ts` (`@aio/merge/generator`): `TeamSim` and `randomHistory`, seeded
  multi-actor histories with fictional people and TEST-ONLY keys.

## Op conventions the writers follow (T1)

- Issues: `issue.create` and `issue.restore` carry `{ record }`; `issue.patch` carries
  `{ set, unset }` per field (a `sightings` key replaces the set); sightings by
  `issue.sighting.add|remove` `{ hash, sighting }` with `hash` = `contentHash(sighting)`.
- `change.review`: target `{ rec: 'change-item', id: <item id>, in: <change set id> }`, payload
  `{ set }` of `ChangeReview` fields (or `{ set: { review } }`).
- `detection.review`: target `{ rec: 'detection', id, in: <pass file name in detections/> }`, or
  `{ rec: 'detection-pass', id: <pass file name> }` for a pass without ids.
- `procmodel.part`: target `{ rec: 'part', id: <part id>, in: <model id> }`.
- `boundary.edit`: `{ record: BoundaryEdit }`; `narrative.version`: `{ record: { part, ...version } }`.
- `record.external` with a `patch` on a known record applies as that patch.

## Wiring (T5, `apps/desktop/src/main/sync/index.ts`)

```ts
const inbox = (projectId) => createInbox({ ops, viewer, keys, now: Date.now, append, read, write });
handle('sync:conflicts', ({ projectId }) => inbox(projectId).conflicts());
handle('sync:resolve', ({ projectId, conflict, choice, op }) =>
  inbox(projectId).resolve({ conflict, choice, op }),
);
handle('sync:quarantine', ({ projectId }) => inbox(projectId).quarantine());
handle('sync:release', ({ projectId, op }) => inbox(projectId).release({ op }));
```

Call `inbox(projectId).refresh()` after every sync or import (it writes recodes and the merged
state files), then emit `journal:changed`.
