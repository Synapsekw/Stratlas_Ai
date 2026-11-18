# @aio/volumetric

What is left of the stockpile kit in the 3D view of an older project: the survey swipe, the cut
and fill colours between two surveys, the elevation relief, the toe lines of kit piles that have no
volume measurement yet and the text of the pile callouts, drawn from the kit's grids in a Web
Worker. It computes no volume and draws no pile body: every pile is a volume measurement that the
survey engine computes (`@aio/survey`) and the desktop app draws, opened pile included. The kit's
base computation, register and boundary editor retired with volumetric parity W3; its volume
bodies, base plates, body modes and section line retired with the volumetrics finalization
(18 Nov 2026). Parity reference: the original Volumetric Survey Kit review under a project's
`legacy/` folder. Public API: `src/index.ts`. Ownership and dependencies:
`docs/architecture/SPEC.md` section 2 (depends on schema, engine, ui, workspace).

## Data

- `volumes.json` (`aio.volumes/1`) and `edits/boundaries.json` (`aio.boundaries/1`), schemas in
  `@aio/schema` `volumes.ts`, layout in `docs/architecture/data-conventions.md` section 10.
- Grids are the kit's own scripts, located by `volumes.json` `grids` or, when absent, under
  `legacy/data/`: 10 cm pile grids (`piles/Pxx.js`: surface per survey, pile mask and the
  kit's bases, which nothing draws any more), the 0.4 m site DSM per survey (`dsm_e1.js`) and the 0.4 m
  pile masks (`vol.js`). They are fetched over `aio://` and decoded in the worker
  (`DecompressionStream('deflate')`).

## Layout

| Path                    | What                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `src/model/kitdata.ts`  | Kit script parser and grid decoders (int16 row deltas, packed bits)                      |
| `src/model/edit.ts`     | Ring helpers for the toe lines: densify, row crossings, area                             |
| `src/model/frame.ts`    | Local frame to easting and northing, a pile's surface on a survey                        |
| `src/model/dsm.ts`      | DSM sampling, hillshade, the change and relief colours and their rasters                 |
| `src/model/layers.ts`   | Which layers show a survey, and a pile's node in its terrain                             |
| `src/model/register.ts` | Saved boundary edits applied to the piles (`applyEdits`, from `@aio/survey`)             |
| `src/model/compute.ts`  | `VolumeCompute`: lazy grid loading and every computation, used by the worker             |
| `src/worker/`           | Worker entry, message protocol (typed arrays transferred) and `startVolumeWorker` client |

## Workspace

| Path                                 | What                                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/store.ts`                       | `volumetric` store: loads through IPC `project:readVolumes`; the survey shown, the surface, the Cut / fill pair and the selected pile (in step with the scene's pile node) |
| `src/scene/controller.ts`            | `VolumetricScene`: toe lines, survey drapes (cut and fill, relief), swipe clipping, callout text                                                                           |
| `src/components/VolumetricStage.tsx` | Over the 3D pane: swipe divider, legend, notices; a click near a toe line selects its pile                                                                                 |

Display model: a kit pile shows in 3D once it is selected (its toe line clicked, its callout or
terrain node picked, or its volume measurement opened), with its measurement's figure in the
callout; a click on the pile already selected counts as a pick again, so the app brings its
panel forward. Esc or a click on empty ground lets it go. A pile whose volume measurement is on
screen draws no toe line here: the measurement's outline stands for it. Piles can be shown on
purpose, and "show all" plus the elevation colours (ramp, range, hillshade) are remembered per
project (`localPrefStore`). In 3D a survey's flat ortho is hidden when its terrain mesh carries
the photo, and the toe lines baked into the terrain models are hidden in favour of the overlay's.

The app composes it: `App.tsx` loads the store when a project opens, `Stage` mounts
`VolumetricStage`, the Show control writes the surface, `kitPileLink.ts` opens a picked kit
pile's volume measurement in the right panel, and `connectVolumeChange`
(`apps/desktop/src/renderer/workspace/VolumeTools.tsx`) runs the survey engine's whole-site
comparison of the Cut / fill pair and hands the store its difference.

Seams used in other packages, read only unless noted: the stage's `onFrame`, `claimClicks`,
`clippingPlanes` and `setLabelMode`; terrain layer groups `layer:<id>` (their material clipping
planes are swapped during the swipe and restored); the layer root's `userData.aioTags` is
replaced (never mutated) so callouts show the figure of the pile's volume measurement. The
engine's merged terrain meshes keep their UVs, so survey photos show on the terrain itself;
change and relief colours are drawn on copies of the original (pick-layer) meshes so the survey
materials stay untouched.

## Parity

The package computes no figure, so it has no parity test of its own. The survey engine's figures are
held to its Python twin by the shared fixtures in `@aio/schema` (ADR 0013, decision 9).
