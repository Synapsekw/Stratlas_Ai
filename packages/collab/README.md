# @aio/collab

The multi-reviewer workflow (M9 stream T3): approval rules, the comments, assignments and
approvals projection, and the review panels. Ownership and dependencies:
`docs/architecture/SPEC.md` section 2. Data: journal ops only (data-conventions section 18); no
field is added to `Issue` or the strict review records.

Pure part (`@aio/collab`, main and renderer):

- `project.ts`: `projectCollab` folds `comment.*`, `assign.set`, `approval.*` and `policy.set`
  ops into `CollabState`, in clock order, whatever order they arrived in.
- `policy.ts`: `approvalOutcome` (required approvals, four-eyes against the creator and the last
  material editor, out-of-date content hash), `approveRefusal` (what main checks before it writes
  an approval), `allowed` (the roles table with the policy switches).
- `material.ts`: the material view each approval signs (issue, change item and set, detection
  pass, model and part, report inputs). Status counts by phase, so approving or closing never
  voids an approval; going back to draft does.
- `mentions.ts`, `text.ts` (markdown-lite, links stay text), `work.ts` (My work, Mine, client
  visibility, threads), `signoff.ts` (the report's sign-off block), `agent.ts` (no agent tool may
  approve).

Panels (`@aio/collab/ui`, renderer only): `IssueCollab` (assign, comments, approvals),
`ChangeCollab`, `CommentThread`, `AssignMenu`, `ApprovalBar`, `MyWork` and `MineFilter`, `SignOff`.
Every write goes to main (`collab:*`), which decides. The agent never approves.
