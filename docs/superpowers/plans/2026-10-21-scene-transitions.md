# Homepage scene transitions

> Execute with the debugging, test-driven-development and verification skills, followed by an independent code review.

**Goal:** Make the existing five homepage chapters flow smoothly while preserving their data, controls, branding and reduced-motion behavior.

**Architecture:** Keep the existing Three.js scene and projector. Interpolate layer opacity and camera pose from the currently displayed state. Let requestAnimationFrame drive visible motion and avoid rebuilding geometry during flight updates.

**Scope:** Local website preview in docs/design/landing-options. No desktop package or contract changes. Preserve the untracked original preview in the main checkout.

## Execution DAG

Reproduce and add browser regressions -> repair camera/layer/render coordination -> verify motion and existing eight-page checks -> independent review and final preview. These tasks share atlas.js and run sequentially.

## Implementation

- [x] Add check-transitions.mjs: intermediate cloud opacity, rendering on every available frame, orientation continuity returning from drone view, interrupted transitions, reduced motion and mobile.
- [x] Run against the copied baseline and record the failures.
- [x] Update atlas.js: reversible layer fades, consistent camera interpolation, no intermediate flight-view reset, no orbit update during camera interpolation, reduced-motion completion, reusable frustum positions and cloud coloring values.
- [x] Update quadrion.css: smoothly fade the hero shade, hero copy and loading fallback without changing layout or branding.
- [x] Allow an alternate local preview port so existing servers can remain running.
- [x] Build the site, run transition and existing site checks, inspect desktop/mobile scenes and review the diff.

## Review focus

Rapid chapter reversals must begin at the visible state; loading a cloud after a chapter change must not reveal it; drone exit must preserve orientation; media readiness must not bypass fades; reduced-motion changes must finish ongoing motion without resuming autoplay.

## Evidence

Baseline browser checks reproduced instant cloud opacity (1.0) and a 0.864-radian drone-exit jump. A follow-up regression reproduced a 0.339-radian jump when taking over with the mouse during a camera move.

The independent review found four issues in the first implementation: interrupted orbit orientation, opaque-cloud depth behavior, unnecessary projector depth invalidation and explicit overview reset. All were fixed and the second review found no remaining actionable issues.

The final browser run has confirmed a gradual cloud reveal, 60 scene renders across 60 available animation callbacks, a 0.0216-radian initial drone-exit movement, seamless mouse takeover, projected-footage fading and overview reset. Complete suite results are recorded in .superpowers/scene-verification/.

Final result: all nine motion checks passed, plus the existing eight-page desktop/mobile checks covering navigation, branding, controls, deliverables, reduced motion, layout and optional-cloud failure recovery. Build, syntax and formatting checks passed. Desktop and mobile screenshots were inspected. Only atlas.js, quadrion.css, README.md, serve.mjs and check-quadrion.mjs differ from the original copied sources, alongside the new transition regression script.
