# ADR 0005: Journal and audit trail

- Status: **Draft, awaiting founder sign-off** (7 Oct 2026). Written at M9 T0 with the recommended default of the M9 plan's founder decision 8; the founder may override it.
- Deciders: founder; integration lead (M9)
- Contracts: `@aio/schema` `journal.ts`; code: `@aio/journal`; format: data-conventions section 17

## Context

Customers must be able to prove later who changed what, when and how (by hand, by the agent, by a pipeline, outside the app), and a delivered report must not be contradicted by a quiet rewrite of history. Today the per-issue audit in the issue editor lives only for the session. The same history must also be what exchange files, hubs and the server move between copies (ADR 0004).

## Decision

1. **One op per change, append-only.** `aio.op/1`, one JSON line, in `journal/ops/<deviceId>.<replicaId>/NNNNNN.jsonl`, rotated at 4 MB or 10,000 ops. Ops are never edited or deleted. Main appends and fsyncs the op, then writes the state file atomically; on open a half-done write is re-applied, and any other difference is recorded honestly as `record.external` ("changed outside Stratlas"). Pipelines are attributed by content hashes around each job.
2. **Hashes and chain.** SHA-256 over RFC 8785 canonical JSON. `ph` hashes the payload; `id` hashes the op without `id`, `payload` and `sig`, so it covers `ph`. `prev` links each op to the one before in its chain; `deps` records the heads of the other chains the device had seen, so dropping another device's tail is detectable. Signed checkpoints (every 500 ops and at every exchange or sync) hold every head, the op count and a Merkle root.
3. **Signatures.** Ed25519 through `node:crypto`; no new crypto dependency. The message is `<domain>\n<hash>` with a domain per record kind (`aio.op/1`, `aio.checkpoint/1`, `aio.device/1`, `aio.cert/1`, `aio.idcard/1`, `aio.exchange/1`, `aio.receipt/1`, `aio.request/1`), so a signature for one kind never verifies as another. Main stamps every op; renderer code never signs. If the vault fails, ops are written unsigned (still chained) and Verify says so.
4. **Clocks.** A hybrid logical clock `<ms>.<counter>.<device>` orders last-writer decisions, never wall time alone. A reading more than 5 minutes ahead raises a notice; more than 24 hours ahead holds the op.
5. **Forward compatible.** Readers accept unknown op kinds, record kinds and fields: they are kept, verified and shown as "unknown change". Verification always works on the raw JSON of each line, never on a parser's output.
6. **Redaction keeps the chain.** An owner's `op.redact` (or `comment.redact`) removes payloads from every copy; `ph` stays, so the chain verifies and the audit shows "redacted by X on date". A payload missing without such an op is a Verify problem.
7. **Verify** reports chains, signatures, gaps, forks, unsigned, external, quarantined and redacted entries with the exact file and line, while the app keeps working. Golden fixtures (a valid three-device history and ten tamper cases, `packages/schema/src/__fixtures__/journal/`) are produced by a deterministic, dependency-free generator, a second implementation of the format that `@aio/journal` must agree with byte for byte. `tools/audit-verify/verify.mjs` (Node, no dependencies) gives customers an independent check.
8. **Audit by default (decision 8).** The journal is on for every folder project, single user included (`JournalPolicy` defaults). A private project may switch it off with the switch recorded (`journal.off`); a team project may not. Customer packages carry a signed audit summary by default and the full history only when the builder ticks it (`PackageHeader.journal`, `TeamPolicy.packageHistory`). Never compacted: about 400 bytes per op.
9. **Every generated report prints the audit head** (root, count, verified yes or no), so a later rewrite contradicts reports already delivered.

## Consequences

- About 40 MB per 100,000 ops; a projection snapshot in userData `journal-cache/` keeps opening fast (budget: under 1 s extra for 100,000 ops). Replay, verify and hashing run in the data process.
- Writers that bypass main (old builds, pipelines outside a job, hand edits) appear as "unknown author" entries, labelled, never guessed.
- Local undo writes new ops; history is never rewritten.
- Copied folders start a new replica (replica ids live in userData per folder path), so they never fork a chain; a fork found anyway is named by Verify.
