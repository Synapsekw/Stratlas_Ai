# @aio/volumetric

The stockpile kit's piles in 3D: their toe lines and volume bodies, cut and fill colours between
two picked surveys, the elevation relief, the survey swipe and the drawn section line, drawn from
the kit's grids in a Web Worker. It computes no volume: the kit's base computation, register and
boundary editor retired (volumetric parity W3), and every pile is a volume measurement that the
survey engine computes (`@aio/survey`). Parity reference: the original Volumetric Survey Kit review under a
project's `legacy/` folder. Public API: `src/index.ts`. Ownership and dependencies:
`docs/architecture/SPEC.md` section 2 (depends on schema, engine, ui, workspace).

## Data

- `volumes.json` (`aio.volumes/1`) and `edits/boundaries.json` (`aio.boundaries/1`), schemas in
  `@aio/schema` `volumes.ts`, layout in `docs/architecture/data-conventions.md` section 10.
- Grids are the kit's own scripts, located by `volumes.json` `grids` or, when absent, under
  `legacy/data/`: 10 cm pile grids (`piles/Pxx.js`: surface per survey, pile mask, triangulated
  toe, low, average and plane bases), the 0.4 m site DSM per survey (`dsm_e1.js`) and the 0.4 m
  pile masks (`vol.js`). They are fetched over `aio://` and decoded in the worker
  (`DecompressionStream('deflate')`).

## Layout

| Path                    | What                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/model/kitdata.ts`  | Kit script parser and grid decoders (int16 row deltas, packed bits)                                   |
| `src/model/volume.ts`   | `gridBase`: the base under a pile's 3D body (display only, never a figure)                            |
| `src/model/edit.ts`     | Ring helpers: densify, row crossings, area                                                            |
| `src/model/dsm.ts`      | DSM sampling, section profile with cut and fill areas, change and relief colour rasters               |
| `src/model/bodies.ts`   | Body cells (surface over base, or survey over survey) for the volume body, base plate and change body |
| `src/model/register.ts` | Saved boundary edits applied to the piles (`applyEdits`, from `@aio/survey`)                          |
| `src/model/compute.ts`  | `VolumeCompute`: lazy grid loading and every computation, used by the worker                          |
| `src/worker/`           | Worker entry, message protocol (typed arrays transferred) and `startVolumeWorker` client              |

## Workspace

| Path                                 | What                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/store.ts`                       | `volumetric` store: loads through IPC `project:readVolumes`, survey, surface and the Cut / fill pair, body mode, selection (in step with the scene's pile node), section |
| `src/scene/controller.ts`            | `VolumetricScene`: volume bodies (lifted or in place), base plates, toe lines, change bodies, survey drapes (cut and fill, relief), swipe clipping, callouts             |
| `src/components/VolumetricStage.tsx` | Over the 3D pane: swipe divider, legend, notices; section picking and body clicks (the section panel is the desktop's `VolumeSection`)                                   |

Display model: no pile is drawn in 3D until it is selected (clicked on the terrain, in the
volumes view or by the agent), which flies to it and draws its toe line, body and measurement
callout; Esc or a click on empty ground hides it. Piles can be shown on purpose, and
"show all" plus the elevation colours (ramp, range, hillshade) are remembered per project
(`localPrefStore`). In 3D a survey's flat ortho is hidden when its terrain mesh carries the
photo, and the toe lines baked into the terrain models are hidden in favour of the overlay's.

The app composes it: `App.tsx` loads the store when a project opens, `WorkspaceScreen` adds the
Volumes tab, `Stage` mounts `VolumetricStage` and `VolumeSection`, and the Volumes bench holds the toolbar group
(`apps/desktop/src/renderer/workspace/VolumeTools.tsx`, whose `connectVolumeChange` runs the
survey engine's whole-site comparison of the Cut / fill pair and hands the store its difference).

Seams used in other packages, read only unless noted: the stage's `onFrame`, `raycast`,
`clippingPlanes` and `setLabelMode`; terrain
layer groups `layer:<id>` (their material clipping planes are swapped during the swipe and
restored); the layer root's `userData.aioTags` is replaced (never mutated) so callouts show the
kit's figure on its default base (the figure the pile's volume measurement carries). The engine's merged terrain meshes keep their UVs, so survey photos show on the
terrain itself; change and relief colours are drawn on copies of the original (pick-layer)
meshes so the survey materials stay untouched.

## Parity

The stockpile parity test in `src/model/` runs on the real stockpile package when present: all 152 pile volumes
(19 piles, 2 dates, 4 bases) and 19 changes recomputed from the grids equal `volumes.json` within
0.5 % (relative to the larger of the figure and 10 m³), and an edit started on P02 (10 Jan) gives
the original review's 7,637 m³.
