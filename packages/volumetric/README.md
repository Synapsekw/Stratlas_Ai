# @aio/volumetric

Native volumetric workspace (PRD REV-3, stream N1): stockpile register with the four bases,
volumes recomputed from the source grids in a Web Worker, cut and fill between surveys, sections
and the boundary editor in 3D. Parity reference: the original Volumetric Survey Kit review under a
project's `legacy/` folder. Public API: `src/index.ts`. Ownership and dependencies:
`docs/architecture/SPEC.md` section 2 (depends on schema, engine, ui, workspace).

## Data

- `volumes.json` (`aio.volumes/1`) and `edits/boundaries.json` (`aio.boundaries/1`), schemas in
  `@aio/schema` `volumes.ts`, layout in `docs/architecture/data-conventions.md` section 8.
- Grids are the kit's own scripts, located by `volumes.json` `grids` or, when absent, under
  `legacy/data/`: 10 cm pile grids (`piles/Pxx.js`: surface per survey, pile mask, triangulated
  toe, low, average and plane bases), the 0.4 m site DSM per survey (`dsm_e1.js`) and the 0.4 m
  pile masks (`vol.js`). They are fetched over `aio://` and decoded in the worker
  (`DecompressionStream('deflate')`).

## Layout

| Path                    | What                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/model/kitdata.ts`  | Kit script parser and grid decoders (int16 row deltas, packed bits)                                               |
| `src/model/volume.ts`   | `pileVolume` (the kit's `volume()`: fill, cut, net per base on the 10 cm grid), `pileChange`                      |
| `src/model/edit.ts`     | Boundary editor maths: densify, simplify, bases refitted to an edited line (SOR membrane), `editVolumes` on 10 cm |
| `src/model/dsm.ts`      | DSM sampling, section profile with cut and fill areas, change and relief colour rasters                           |
| `src/model/bodies.ts`   | Body cells (surface over base, or survey over survey) for the volume body, base plate and change body             |
| `src/model/section.ts`  | Long section along a pile's main axis                                                                             |
| `src/model/register.ts` | Edits applied to piles, register rows, sorting, totals, CSV                                                       |
| `src/model/compute.ts`  | `VolumeCompute`: lazy grid loading and every computation, used by the worker                                      |
| `src/worker/`           | Worker entry, message protocol (typed arrays transferred) and `startVolumeWorker` client                          |

## Parity

`src/model/masafi.test.ts` runs on the real Masafi package when present: all 152 pile volumes
(19 piles, 2 dates, 4 bases) and 19 changes recomputed from the grids equal `volumes.json` within
0.5 % (relative to the larger of the figure and 10 m³), and an edit started on P02 (10 Jan) gives
the original review's 7,637 m³.
