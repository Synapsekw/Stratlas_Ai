# @aio/collab

The multi-reviewer workflow (M9 stream T3): approval rules, the comments, assignments and
approvals projection, and the review panels. Public API: `src/index.ts`. Ownership and
dependencies: `docs/architecture/SPEC.md` section 2 (depends on schema; ui when T3 adds panels).
Data: journal ops only (data-conventions section 18); no field is added to `Issue` or the strict
review records.

- `policy.ts`: `approvalOutcome` (required approvals, four-eyes, out-of-date content hash).

T3 adds `project.ts`, `CommentThread.tsx`, `AssignMenu.tsx`, `ApprovalBar.tsx`, `MyWork.tsx`
and `SignOff.tsx`. The agent never approves.
