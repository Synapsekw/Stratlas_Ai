# @aio/project

Project packages: read, write, importers for kit formats, exports.

See `docs/architecture/SPEC.md` section 2 for ownership and dependencies. Public API: `src/index.ts`
(renderer safe) and `src/import/index.ts` (Node only: file system, ffmpeg).

## Importers (stream S10)

Convert staged source folders into native packages laid out per `docs/architecture/data-conventions.md`.

```bash
cd packages/project
pnpm import:hcl      # E:\Stratlas Data\sources\hcl    -> E:\Stratlas Data\projects\hcl
pnpm import:alzour   # E:\Stratlas Data\sources\alzour -> E:\Stratlas Data\projects\alzour
# options: --src <folder> --out <folder>; STRATLAS_DATA overrides the data root
```

Requirements: `ffmpeg` and `ffprobe` on `PATH` (or `FFMPEG` / `FFPROBE`) for posters, review copies
and, only when a codec does not play in Chromium, H.264 transcodes.

Re-runs are incremental: copies keep the source mtime and are skipped when unchanged, generated
files are skipped when byte-identical, derived files when newer than their sources. Each package
gets an `IMPORT-REPORT.md` with counts, sizes, the frame check and warnings.

### Formats written

- `kit-packed` cloud: N x (int16 x, y, z) little-endian millimetres in the local frame, then
  N x uint8 intensity (planar, as the Asset Inspection Kit and the design fixture `cloud.bin`).
- `png-packed` cloud index (`aio.pngcloud/1`): each chunk PNG (RGB) holds a byte stream of 9 planes
  of n bytes: x lo, x hi, y lo, y hi, z lo, z hi, r, g, b. Position in the local frame
  `= bounds.min + u / 65535 * (bounds.max - bounds.min)`; the bounds are a cube, so this equals the
  Al-Zour viewer rule `o + q * u` (both are given per chunk; `aabb` is the tight box).
- Flight files: `aio.flight/1`, optional top-level `name`.
