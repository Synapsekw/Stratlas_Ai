# Contributing to Stratlas

## Setup

```bash
pnpm install
pnpm check        # lint, format check, typecheck, unit tests
pnpm dev          # run the desktop app (once apps/desktop exists)
```

Node 24 and pnpm 10 are required. Hooks (lefthook) run lint-staged on commit and commitlint on the message.

## Rules

- TypeScript strict everywhere; no `any`, no non-null assertions.
- Every package exposes its public API from `src/index.ts` and depends only on the packages listed in `docs/architecture/SPEC.md` section 2.
- Renderer code never imports `electron` or `node:*`; it talks to main through `window.aio` (typed by `@aio/schema` `ipc`).
- The product name lives only in `@aio/brand`.
- Client data never enters git. Fixtures live in git-ignored `fixtures/data/`; full projects live in `E:\Stratlas Data\` (or the path in Settings).
- No em or en dashes in user-facing text.
- Conventional commits: `feat(scope): ...`, `fix(scope): ...`, `chore: ...`.

## Streams and worktrees

Parallel work follows SPEC section 9. Each stream works in its own worktree and branch:

```bash
git worktree add ../stratlas-wt/s3-engine -b stream/s3-engine
```

- A stream owns its package(s) and may not edit another stream's package. Ask the integration lead instead.
- Merge to `main` only when `pnpm check` is green in the worktree.
- Contracts in `@aio/schema` are frozen (`contracts-v1`). A change needs an entry in `docs/architecture/contract-changes.md` and the integration lead's sign-off before merge.

## Tests

- Unit: Vitest, next to the code as `*.test.ts`.
- End to end: Playwright with Electron in `apps/desktop/e2e/`, including the zero-network test.
