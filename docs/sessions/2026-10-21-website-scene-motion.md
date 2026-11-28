# Website scene motion

Local preview work on branch `codex/scene-transitions`. The website was untracked in the main checkout, so it and the required preview assets were copied to the isolated worktree. Hash checks confirm the original source files remain unchanged. Nothing is published or merged.

The homepage now interpolates layer visibility and camera position, orientation and field of view. Camera moves can be retargeted from their displayed pose. Grabbing an in-progress move preserves the current gaze, then levels the slight camera roll over 250 ms while orbit remains interactive. Reduced motion completes these transitions immediately. The frame loop no longer skips every other 60 Hz callback; flight-frustum updates reuse their geometry buffer and cloud coloring reuses one color object while yielding between chunks.

The existing visual identity, five chapters, source geometry, projection calibration, video and other page content are preserved. No production package or public contract changed.

## Verification

- Baseline browser regressions reproduced the abrupt cloud reveal and drone-exit camera jump.
- A new pointer-interruption regression reproduced the review finding before it was repaired.
- Build, syntax and formatting checks pass. The final motion and eight-page browser checks write logs and desktop/mobile screenshots under the ignored `.superpowers/scene-verification/` folder.
- Independent review found no remaining actionable issues after the fixes.
- Final browser result: nine motion checks and all eight pages' desktop/mobile regression checks passed, including optional-cloud failure recovery. Desktop/mobile screenshots were visually inspected.

## How to test

1. Start `serve.mjs` with `QUADRION_PREVIEW_PORT=8786`, then open `http://127.0.0.1:8786/landing-options/atlas.html`.
2. Play the transformation. Watch the cloud and projected footage fade into the model, and the camera travel into drone perspective.
3. Select The flight while in Drone perspective, then grab and drag the model during the return. The camera should retain its visible direction. Flight overview should restore the authored framing.
4. Click chapters quickly, then try a narrow viewport and reduced motion. The last chapter selection should win and reduced motion should settle immediately.

Run `check-transitions.mjs` and `check-quadrion.mjs` with `QUADRION_PREVIEW_URL=http://127.0.0.1:8786/landing-options/` for automated verification.
