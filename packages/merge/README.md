# @aio/merge

The merge engine (M9 stream T4): projects journal ops into state files for every record type,
order-independent, with conflicts and quarantine. Public API: `src/index.ts`. Ownership and
dependencies: `docs/architecture/SPEC.md` section 2 (depends on schema).

- `rules.ts`: `MERGE_RULES`, the rule per record kind (the merge rules table of the M9 plan).
- `lww.ts`: last writer by clock reading, commutative and idempotent.
- `project.ts`: `project(ops)` (T4 implements it; property tests prove convergence).

Pure: no file system, no clock, no randomness. Runs in the data process or a worker.
