# ADR 0014: Team trust anchored in a signed genesis

- Status: **Accepted, 21 Oct 2026 (security hardening, this PR).**
- Deciders: founder (fix every audit finding); the build's rulings, recorded below
- Code: `packages/journal/src/teamPin.ts` (`readTeamPin`, `genesisOf`, `pinTeamFile`), `packages/journal/src/members.ts` (`judgeOp`, `orderForTeam`, `teamFences`, `replayTeam`), `apps/team-server/src/parity.test.ts`, `apps/desktop/src/main` sync client (server key pin, receipt checks)
- Contracts: rows of 21 Oct 2026 in `contract-changes.md` (team trust; Team Server security review); user wording in `docs/release/SECURITY-AND-DATA.md`

## Context

The security audit of 21 Oct 2026 found that the team was rebuilt by replaying journal ops in clock order with no lower bound. A self-signed `member.add` dated 1970 made its author the first owner, and a revoked, removed or demoted person could keep writing ops dated just before that change, or start a new chain dated earlier. The Team Server judged pushes with its own copy of the rules and let any invitee enrol under any actor, including the owner's.

## Decision

1. **The genesis is pinned.** When a project is shared, `team.json` (`aio.team/1`) records the op that made the first owner (`genesis`: op, device, key, clock, heads), signed by that device under the new signing domain `aio.team/1`. Only that op makes the first owner; ops dated before it must be the history it was shared with.
2. **Older shared projects are pinned trust-on-first-use** on their first sync or `.aiosync` import with this version. Until then Verify reports `team-unpinned`.
3. **Revocations are fenced by what the owner had seen.** `device.revoke`, `member.remove` and a demoting `member.role` carry `seen` (last seq per chain). Ops of the target the author had not seen and dated before the change are judged right after it (`orderForTeam`), so they are held, and the owner can release them.
4. **Clocks are monotonic per chain.** An op dated at or before its chain predecessor is held (`clock-back`).
5. **One set of team rules.** The Team Server judges pushes with the journal's `judgeOp`, `orderForTeam` and `teamFences`, not its own copy. A parity test checks 25 arrival orders.
6. **The server is pinned too.** Enrolment binds the device to the actor its invite names, and re-enrolment cannot change role or actor. The client pins the server's Ed25519 key and verifies its device certificate and every push receipt.

## Consequences

- Offline ops the owner had not seen at a revoke or demotion, and pre-share edits from a device that was never a member, are held until the owner releases them.
- Trust-on-first-use means a copy trusts the first team it sees. The Team Server still pins `team.json` trust-on-first-use too, because it has no route to receive the signed file yet (parked), and the genesis does not yet travel with invites or identity cards (parked).
- The server does not yet run the `@aio/merge` gate rules (comment delete, approval withdraw); those stay client-side for now.
- All new fields are optional, so `aio.sync/1` and older readers are unchanged.
