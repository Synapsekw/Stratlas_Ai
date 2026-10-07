# Launch screen

Date: 8 Oct 2026. Status: built on its own branch from the rename branch, not merged.

The approved launch-screen design (`docs/brand/quadrion/gate/index.html`, made by `docs/brand/quadrion/build/gate.mjs`, Split layout, approved 7 Oct 2026) is now part of the desktop app. This file records what was built and the decisions taken on the way.

## What it does

- Every start shows the launch screen over the app shell, which is already mounted underneath (and `inert` until Enter). No extra window; the gate paints on the first frame, so there is no white flash.
- Left: the Time steps mark beside the outlined QUADRION AI wordmark, the tagline under it. A hairline, then "WELCOME BACK,", the person's name, the company and "this computer", the mint Enter button with ↵, and the status line ("Offline · stays on this machine", or "cloud AI on"). At 900 px wide or less (a zoomed window; the window itself is at least 1100 px) the welcome stacks under the lockup, centred.
- Background: the point-cloud terrain, the scan band, the pointer as a scanner (fine pointers only), the vignette. The plates follow the pointer on springs and return to the centre after 4 s idle. The canvas draws at about 30 fps, pauses while the window is hidden and is removed with the gate.
- Intro about 1.3 s, Esc or **Skip intro** jumps to its end; Enter (anywhere) or a click opens the app from the first frame; the exit takes 0.3 s.
- Reduced motion (Windows or Settings): no intro, no parallax, a still terrain, a plain fade out.

## Decisions

1. The name is the identity's name (`identity:get`), the name the app writes as author. Main's placeholder for a profile with no name at all ("Reviewer", `migratedFrom: 'new'`) is never greeted: the screen says "Welcome" and "Set your name in Settings, Identity and team." There is no first-run identity prompt to reuse.
2. The org line uses the company in Settings, Report branding; the app has no team or workspace name yet. A team sign-in will take the same panel.
3. Settings, Appearance, **Show launch screen** is stored in its own userData file, `launch.json` (`aio.launch-settings/1`, `show?`; no file means shown), read and written by main (`launch:get`, `launch:set`). It is not a `Settings` field: a 0.9 build reads settings.json strictly, so settings.json keeps exactly its 0.9 keys (the same rule as M10's globe.json). A copy in the profile's local storage (`quadrion.launchScreen`) lets a start with the screen switched off show nothing at all; launch.json stays the record and the copy is corrected on the next start when they differ.
4. Automated runs skip it: the preload's `launchGate()` answers `skip` when QUADRION_E2E=1, so the existing specs are unchanged. QUADRION_SHOW_GATE=1 brings it back (its own spec, `e2e/launch-gate.spec.ts`); QUADRION_SHOW_GATE=0 skips it in any run.
5. The gate is always dark (`data-surface='dark'`), like the prototype: it is the app's splash.
6. After Enter, focus goes to the top of the page (no ring on a heading), as on a start without the gate.
7. `BrandSymbol` gained `layered` (plates and their cuts tagged `data-plate`, each mask on an unmoved group) and `label`; `BrandWordmark` gained `decorative`. The title bar renders as before.

## Where

- `apps/desktop/src/renderer/gate/`: `LaunchGate.tsx`, `gate.css`, `model.ts` (show or skip, greeting, org line), `motion.ts` (springs, plate offsets), `terrain.ts`.
- `apps/desktop/src/preload/launchGate.ts`; contract change recorded in `docs/architecture/contract-changes.md` (8 Oct 2026).
- Tests: unit tests beside each module; `e2e/launch-gate.spec.ts` (normal and `QUADRION_E2E_SWGL=1`). Founder checks: `docs/TESTING.md`, Stage L.
