# /whats-next: triage, recommend a parallel batch, dispatch scoping worktrees

Answer "what should we work on next?" the way a lead assigning work to a team would: read the north star and recent session notes, reconcile them with git, size each candidate by the files it would touch, find the ones independent enough to build at the same time, and let the founder pick. Each pick gets its own worktree and a scoping agent that stops at a written plan.

This is the planning counterpart to `/wrapup` (which records where we landed) and to `/develop` (which builds one brief). It **never edits the notes and never builds**.

## Precondition: run from the main checkout

Dispatch creates worktrees at `.claude/worktrees/<slug>` inside the main checkout, the only place subagents can write. Inside a worktree, still do steps 1 to 5, but instead of dispatching print the `start-task` commands for the founder.

## Steps

Make a todo per step and work them in order.

### 1. Gather candidates (bounded reads only)

- `docs/NORTH-STAR.md`: section 2 (milestones) and section 3 (Phase, In flight, Next, Owed).
- The 8 newest notes in `docs/sessions/`: their "Open threads" and "Next session entry point".
- `docs/plans/ROADMAP.md` and the plan of the milestone in progress: unchecked tasks and open phases.
- Open founder feedback from the review board (`tools/review-board/`) and the team test board (`tools/test-board/`), only where the north star or a recent note points at it.

Bucket each candidate: `milestone` (roadmap or plan task), `in-flight`, `carryover` (open threads, deferred work), `ops` (CI, installer, cleanup, founder decisions).

### 2. Reconcile with git

`git fetch origin` (continue if offline). Then `git worktree list`, `git branch --list`, and open draft pull requests (`gh pr list --state open`). Write a **Drift** line for each place the notes disagree with git. **Drop any candidate an existing worktree or branch is already building**; never recommend a collision. Ask the Orchestrator (ListAgents) nothing; just read git.

### 3. Size footprints

For each serious candidate dispatch one read-only `Explore` agent, all in **one message** so they run in parallel. Each returns only a footprint: top folders and files it would touch, the packages (CONTRIBUTING.md stream ownership), whether it changes `@aio/schema` contracts, and a size S, M or L.

### 4. Build the execution DAG

From the footprints: edges (shared files or packages, or a real order), parallel batches (disjoint footprints, safe at once), the critical path, and a blocker per candidate (a founder decision, a contract change, another branch). Contract changes and wide-footprint work go in their own batch; the Orchestrator merges wide branches last.

### 5. Present the board

Open with one snapshot line: `main` versus `origin/main`, live worktrees, open draft pull requests, and the count of carryover versus new work. Then two markdown tables (never ASCII art), rows numbered continuously across both:

**Carryover**

| #   | Status | Work | Type | Size | Batch | Blocker or note | From |
| --- | ------ | ---- | ---- | ---- | ----- | --------------- | ---- |

**Milestone work**

| #   | Status | Work | Milestone | Size | Batch | Blocker or note | Critical path |
| --- | ------ | ---- | --------- | ---- | ----- | --------------- | ------------- |

Status is `ready`, `waits` (depends on another row or needs the founder) or `blocked`. Batch letters: same letter means disjoint footprints. Then a Drift callout if there is any, and a plain recommendation ("Dispatch batch A (#1, #3, #4): three worktrees, no shared files. The critical path is #4.").

### 6. Pick

Offer only `ready` rows. Up to 4: AskUserQuestion with multiSelect, one option per row, the recommended batch in the first option's description. More than 4: the recommended batch as the first option plus up to 3 single picks, and say the founder can reply with any row numbers instead.

### 7. Dispatch: scope to a plan, then stop

For each pick, `node tools/agent/start-task.mjs <slug> --type <type>`, then dispatch one agent per worktree, **all in one message**. Each agent works only in `.claude/worktrees/<slug>`, runs `superpowers:brainstorming` then `superpowers:writing-plans` (the plan needs the Execution DAG, tests, contract changes and package ownership listed in `.claude/commands/develop.md` step 2), commits the spec and plan on its branch, and **stops at "plan written, awaiting review"**. It does not build.

When they return, list each plan's path with a one-line summary so the founder can review them together. Each approved plan is then built with `/develop` (from a session re-rooted into that worktree) or by a build session the founder starts.

Why stop at plans: several unattended builds landing at once, with no review in between, is too much blast radius.

## Discipline

- Bounded reads only; never scan all of `docs/`.
- Read-only until dispatch; dispatch only cuts worktrees and writes plans.
- Respect live worktrees and branches.
- No emoji. No em or en dashes.
