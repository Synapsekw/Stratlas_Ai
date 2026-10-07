# ADR 0004: Sync architecture

- Status: **Draft, awaiting founder sign-off** (7 Oct 2026). Written at M9 T0 with the recommended defaults of the M9 plan's founder decisions 1, 2, 3, 7 and 15; the founder may override them.
- Deciders: founder; integration lead (M9)
- Plan: `docs/plans/2026-10-07-m9-team-and-1.0.md`, "Sync architectures" and "Design"

## Context

Stratlas is offline first and single user. M9 must let a team share a project, assign, discuss and approve findings, and prove later who changed what, on connected sites, on a shared folder or across an air gap with a USB stick, without taking anything away from a person who works alone, offline, with no account. Customers include GCC government and regulated sectors, where data residency and procurement rule out a service that holds their data elsewhere. Large binaries (COPC clouds, video, GLB) reach hundreds of gigabytes.

Two findings in the code constrain the design. `Issue` is a plain zod object, so an 0.8 build that loads and saves `issues.json` drops any field it does not know; `ChangeReview`, `Detection`, `BoundaryEdit` and the other review records are `.strict()`, so an 0.8 build refuses the whole file. And today two people on one shared folder overwrite each other (`project:writeIssues` replaces the whole file with no check).

## Options

(a) File-based exchange first: `.aiosync` patches and bundles plus a shared-folder hub. (b) A self-hosted server: a Docker image (Node sync API, Postgres, blob store) on the customer's premises. (c) A hosted cloud service run by Synapse. The plan's table compares them on infrastructure, air gaps, latency, enforcement, binaries, residency, operating burden, effort, PRD fit and M10 fit.

## Decision

1. **One core, several transports.** State files stay as they are (readable JSON, every old reader and pipeline keeps working). Every change is also an op in a signed, hash-chained, per-device journal (ADR 0005). A transport only moves ops and blobs between copies; one interface, `SyncTransport` (`heads`, `pushOps`, `pullOps`, `hasBlobs`, `putBlob`, `getBlob`, in `@aio/sync`), has the exchange, hub and server implementations. The choice between (a), (b) and (c) is about transport and hosting, never the data model.
2. **Build (a) to GA in M9** (decision 1). It serves every customer, air-gapped included, costs nothing to run and has no residency question. Hub folders need no lock: each device writes only its own files that never change (temp name, then rename).
3. **Ship (b) as "Team Server (preview)"** speaking the same protocol, `aio.sync/1` (`@aio/schema` `sync.ts`), if stream T7 is green; otherwise in 1.1. Customer IT runs our signed image on its premises; Synapse sells installation and an optional managed-on-premises contract and hosts no customer data (decision 2). The server stores and forwards and checks chain, signature and role on every op; it never merges, so server and app cannot disagree on state. No bearer tokens: every request is signed by the device key (RFC 9421, Ed25519), and the certificate fingerprint is pinned at enrolment.
4. **Defer (c) until after M10**, only with in-country hosting per client and never as the only way for government (decision 3).
5. **Merge is last writer wins per field by hybrid logical clock**, with sets for sightings, grow-only comments and approvals, and a Conflicts inbox with Restore (decision 7). Merging never silently discards a value: the losing value stays in history and appears in the inbox. No CRDT library: they target real-time text co-editing (a non-goal, decision 15) and would replace readable JSON with binary documents.
6. **New data in new files only.** Assignments, comments, approvals, members and sign-offs exist only as journal ops and their projections. No field is added to `Issue`, `ChangeReview`, `Detection`, `BoundaryEdit`, `ProcPart` or `NarrativeFile`; a test pins their 0.8 keys and that an 0.8 `issues.json` round-trips unchanged. Older builds ignore `journal/` and `team.json`.
7. **Binaries by content.** Every binary is registered by SHA-256 (`blob.add`) and fetched by a per-machine policy; missing is a normal state with a placeholder (`x-aio-blob: missing <sha256> <size>`).
8. **Flexible where decisions may flip.** The hosting model (`HostingModel`), the approval numbers (`ApprovalPolicy`), the journal switch (`JournalPolicy`) and the identity verification level (`TeamPolicy.minVerification`) are fields with defaults, not code paths.

## Consequences

- Role enforcement in file and hub mode is tamper-evident, not enforced: ops beyond a role are quarantined on import, but anyone with folder write access can still edit files (seen as "changed outside Stratlas"). The server enforces roles. KNOWN-LIMITS says so.
- Latency is minutes (hub) to days (USB) without the server.
- Every JSON writer gains compare-before-write and a lease for folders opened in place on a share, shared or not.
- The zero-network suite stays green with sharing off and in hub and exchange modes; the app makes a request only in server mode when a sync runs, and the offline-only setting blocks it.
- Licences: no GPL or AGPL in the app or the server image; no PostGIS, no MinIO. Postgres, Fastify, `pg`, fast-check and `@aws-sdk/client-s3` are fine.

## Appendix: STRIDE outline (T8 completes it for 1.0)

- Spoofing: device keys in the OS vault; ids derived from keys; owner certificates; server enrolment with invite codes and pinned fingerprints.
- Tampering: hash chain, signatures, `deps`, checkpoints; Verify names the line.
- Repudiation: every op signed by a device bound to an actor; server receipts countersign.
- Information disclosure: optional AES-256 on exchange files; keys never in projects, logs, bundles or the renderer.
- Denial of service: exchange parser limits (traversal, links, bombs, duplicates); server rate limits.
- Elevation of privilege: one permission table (`PERMISSIONS`, `OP_PERMISSION`) shared by quarantine and the server's 403.
