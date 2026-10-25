---
type: session
date: 2026-10-25-1242
branch: feat/walk-height-offset
status: complete
related: []
---

# Walk height offset and Drop to ground

## What changed

- A placed walk layer takes an optional `heightOffsetM` beside `place` (not inside the strict `WalkCalibration`, which the 0.21 schema would refuse); a contract row and `tools/compat/walk-height-offset-additive.test.mjs` cover it.
- `fitWalk` adds the offset to the ground at every moment, so the 3D line, the camera, the Beam, the spot track and the pose move together; the fit cache keys on it; pins picked in 3D while placing are stored without it.
- The `{ heightOffsetM }` layer patch now takes a placed walk and rewrites `walks/<id>/pose.json`; Remove placement clears the offset.
- Drop to ground (the shared `layer.dropToGround` action, right-click and menu) works on placed walks: about every metre along the path (at most 400 asks) it samples the floor near the walker, takes the median of floor minus stored ground ignoring misses, and needs 3 hits; Undo and Redo as for clouds. The Properties Height offset (m) row shows for placed walks.
- Checks: `pnpm check` green (15,995 tests); `walk-drop-to-ground.spec.ts` (new) with `drop-to-ground.spec.ts` 12 passed over three repeats; the other walk specs and spot-history 16 passed, the CI way.

## Why

Founder follow-up to this morning's walk drape fix: walks placed earlier keep stored heights on the ortho plane or a roof, and their pose file keeps them too.

## How to test

1. Open a project with a placed walk and a cloud or mesh: right-click the walk, Drop to ground; the line, the Beam and the 360 camera land on the floor and a notice offers Undo; Ctrl+Z puts it back.
2. Properties of the walk: Height offset (m) shows the value; type 1 and the walk rises 1 m.
3. Remove placement: the offset clears.

## Open threads

- If the pins sat on a roof along the whole path, the sampler finds the roof and the walk does not drop; only partly covered walks are fixed by the median.
- Drop to ground is not blocked while the same walk is open in Place walk; re-placing keeps the offset.
- A switched-off walk can still be dropped.

## Next session entry point

Hand `feat/walk-height-offset` to the merge coordinator.
