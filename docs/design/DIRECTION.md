# Design direction: Mission

| | |
|---|---|
| Status | **Decided** 2026-10-03 by the founder |
| Reference build | `docs/design/ui-options/round2/option-1-mission.html` (+ `.css`, `.js`, `-3d.js`, `-map.js`) |
| Rejected | Round 1 (Console, Workbench, Canvas); round 2 Flight and Studio (kept in `ui-options/round2/` for reference) |

## The direction in one paragraph

Stratlas looks and behaves like an operations picture, in the school of Palantir Gotham and Anduril Lattice, applied to drone reality capture. The fused 3D and map stage is the hero. Drones are tracked entities with a telemetry label stack (altitude, speed, gimbal, timecode). Assets and issues carry precise callouts with leader lines. A context panel on the right changes with the selection: asset, issue, clip or photo. A timeline with tracks runs along the bottom. The tone is serious, calm and defence-grade, never neon or gamer.

## Fixed elements

- **Dark first.** A light theme exists in the tokens but is secondary.
- **Collapsible left sidebar:** expanded 252 px (wordmark, navigation, project switcher, dataset tree by type), collapsed 52 px icon rail with tooltips; Ctrl+B; state remembered. Every viewport redraws on resize (ResizeObserver plus an immediate render).
- **Title bar** 40 px: breadcrumb (customer, project, view), command search (Ctrl+K), screen and status chips (Offline, Cloud AI).
- **Stage modes:** 3D, Map, Split. Tools along the stage top. Compass and grid readout (UTM and plant grid) on the stage.
- **Right panel:** Selection (identity, coordinates in plant grid and UTM, geometry, last capture, counts) above the Agent (bound to the focused view, tool steps with approve, reject and undo, cost meter).
- **Bottom timeline:** tracks for clips, altitude, roof or target visibility, panoramas, issues; playhead synced to video and flight.
- **Video window:** floating picture-in-picture over the stage, with live telemetry overlay; can dock.
- **Balanced density:** 13 to 14 px UI text, 11 to 12 px telemetry in mono.

## Tokens (seed for `packages/ui`)

Taken from `option-1-mission.css`; the UI stream turns these into the design-token source.

- Surfaces: `--bg-0` stage surround, `--bg-1` panels, `--bg-2` raised, `--bg-3` selected, `--bg-chrome` title bar and sidebar; oklch blue-greys at hue 250.
- Lines: `--line`, `--line-soft`, `--line-strong`.
- Text: `--fg-0` to `--fg-4`.
- Accent: teal `--acc` (oklch 0.79 0.115 172) with `--acc-strong`, `--acc-ink` and alpha steps.
- Severity: `--s5` critical (red), `--s4` high (orange), `--s3` medium (yellow), `--s2` low (blue), `--s1` info (grey), each with an alpha tint. Severity colours come from the project's severity model at runtime; these are the defaults.
- Overlays on imagery: `--ov`, `--ov-dim`, `--ov-faint`, `--scrim`.
- Type: IBM Plex Sans (UI), IBM Plex Sans Condensed (dense labels), IBM Plex Mono (telemetry, coordinates, IDs). All SIL OFL; **bundled locally** in the app, never loaded from Google Fonts.
- Scale: 11, 12, 13, 14, 16, 20, 24 px. Radii 2, 4, 6 px. Motion: ease-out-quart for UI, ease-out-expo for panels and the sidebar.

## Carry forward from the other directions (optional, founder to confirm when building)

- From Studio: the sequencer's keyframe editing for video annotation tracks (ANN-3) inside Mission's timeline.
- From Flight: altitude and speed graphs as timeline tracks.

## Weaknesses to fix in the product build

- HCl 3D view is cramped with the sidebar open; the right panel should collapse too, and the video window should dock to a split.
- Projected video reads faintly on the tank; raise projection opacity and add an edge vignette.
- Label crowding: declutter overlapping callouts into dots that expand on hover.
- Masafi and Ring Road need real thumbnails.
