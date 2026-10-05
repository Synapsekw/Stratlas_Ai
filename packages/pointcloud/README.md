# @aio/pointcloud

Point clouds for the shared 3D scene: packed-cloud decoders in Web Workers, chunk LOD under a global point budget, a point material with four colour modes, Eye-Dome Lighting, point picking and a React control panel.

Owner: stream S4. Depends on `@aio/schema`, `@aio/engine` (see `docs/architecture/SPEC.md` section 2). Public API: `src/index.ts`.

## Usage

```ts
import { registerPointcloudAdapters, pickPoint, PointCloudControls } from '@aio/pointcloud';

registerPointcloudAdapters(); // once, at app start, next to registerEngineAdapters()
// SceneView then creates a layer for every manifest layer of kind "pointcloud".

const hit = pickPoint(handle, { x: ndcX, y: ndcY }); // nearest visible point within 6 px
// <PointCloudControls /> anywhere in the UI: colour by RGB / Elevation / Intensity / Flight, point size, budget, EDL
// <ElevationLegend range={useElevationRange()} toElevation={(y) => ...} /> on the stage
```

Formats: `copc`, `kit-packed` and `png-packed`. `potree2` layers are rejected with a clear error for now.

## Formats

### `copc` (Cloud Optimized Point Cloud, LAS 1.4 point formats 6, 7, 8)

`src` is a `.copc.laz` file in the project package. Points are in the project CRS (manifest `crs`;
a different EPSG in the file's WKT is reported); the adapter maps them to the local frame with the
manifest `origin`: `x = E - origin[0]`, `y = H - origin[2]`, `z = origin[1] - N`. Conversion with
PDAL: `tools/pointcloud/README.md`.

- **Reading.** The worker pool (half the cores, 2 to 8 workers) reads the header and hierarchy
  pages with copc.js and decompresses nodes with laz-perf (WASM bundled with the app, never a CDN),
  all by HTTP range requests on `aio://` (206 answers). Nodes come back as uint16 positions over
  the node box (scaled on the GPU through the object transform), 8-bit RGB and intensity (16-bit
  values are reduced when any exceeds 255) and the ASPRS class per point.
- **Level of detail.** `selectNodes` (`octree.ts`) walks every cloud's octree from the roots,
  largest angular size first, skipping nodes outside the view frustum; a node's children join the
  frontier while its spacing projects to more than 1.5 px (screen-space error). Selection stops at
  the global point budget; hierarchy pages are fetched when the walk reaches them. Loaded nodes
  outside the selection stay while the total is under budget x 1.1. Octree points draw at the
  spacing of their deepest loaded descendant (Potree's adaptive size). Flat chunk sets
  (`png-packed`) use the same walk as one level under their overview.
- **Classification.** Colour mode `classification` (ASPRS palette, `classes.ts`);
  `<ClassificationLegend />` lists the classes of the shown points with their share, and a click
  hides a class (`hiddenClasses` in the settings, any colour mode).

All positions are in the project local frame (`docs/architecture/data-conventions.md` section 1: metres, Y up, X east, Z south).

### `kit-packed` (HCl tank, Asset Inspection Kit)

`src` is a single binary file, no header, little-endian, **planar**:

| Bytes        | Content                                               |
| ------------ | ----------------------------------------------------- |
| `0 .. 6N-1`  | block A: N x (int16 x, int16 y, int16 z), millimetres |
| `6N .. 7N-1` | block B: N x uint8 intensity (0..255)                 |

`N = byteLength / 7`. Metres = `int16 * 0.001`. This is the layout of the HCl artifact (`vy()` builds `Int16Array(buf, 0, 3N)` and `buf.slice(6N)`) and of `docs/design/assets/hcl/cloud.json`. Note: it is not interleaved per point. One file per flight; one layer per flight. The per-flight colour mode gives each kit layer its own palette colour (palette `Vd` of the HCl artifact) in layer creation order.

### `png-packed` (Al-Zour photogrammetry)

The cloud is split into chunks; each chunk is a lossless PNG whose pixels carry a byte stream.

**Chunk pixels.** Decode the PNG with no colour conversion and no premultiplication (`createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })`, then `getImageData`). Read the **R, G, B** bytes of consecutive pixels in row-major order (alpha is ignored) into one stream. For a chunk of N points the first 9N bytes of the stream are nine planes of N bytes:

| Plane | Bytes        | Content          |
| ----- | ------------ | ---------------- |
| 0     | `0 .. N-1`   | x low byte       |
| 1     | `N .. 2N-1`  | x high byte      |
| 2     | `2N .. 3N-1` | y low byte       |
| 3     | `3N .. 4N-1` | y high byte      |
| 4     | `4N .. 5N-1` | z low byte       |
| 5     | `5N .. 6N-1` | z high byte      |
| 6     | `6N .. 7N-1` | red (8-bit sRGB) |
| 7     | `7N .. 8N-1` | green            |
| 8     | `8N .. 9N-1` | blue             |

`u = lo | hi << 8` (uint16). Position per axis = `offset + scale * u`. Trailing pixel bytes beyond 9N are padding. The image must hold at least `ceil(9N / 3)` pixels.

**Index (`aio.pngcloud/1`)**, the layer `src`:

```json
{
  "schema": "aio.pngcloud/1",
  "bounds": { "min": [x, y, z], "max": [x, y, z] },
  "spacing": 0.45,
  "chunks": [
    {
      "file": "clouds/alzour/l0.png",
      "points": 1048576,
      "bounds": { "min": [..], "max": [..] },
      "lod": 0,
      "quant": { "offset": [x, y, z], "scale": 0.0123 }
    }
  ]
}
```

- `file`: path relative to the **project package root** (resolved through `AdapterContext.url({ path })`).
- `points`: N for the chunk (required: the PNG may be padded).
- `bounds`: tight chunk bounds in the local frame; used for LOD distance.
- `lod`: `0` = overview chunk(s), always loaded; `1, 2, ...` = finer chunks. Refinement is **additive**: a finer chunk adds points to the coarser ones (it does not replace them).
- `quant` (optional): `offset` (Vec3) and `scale` (number for all axes, or Vec3). Without `quant` the uint16 range spans the chunk `bounds`: `offset = bounds.min`, `scale = (bounds.max - bounds.min) / 65535`.
- `spacing` (optional): typical point spacing in metres; sets the default point size.

**Legacy Al-Zour `pc/pc.json`** (also accepted, so the artifact data can be loaded before import):

```json
{ "levels": [[{ "f": "pc/l0.png", "n": 1048576, "o": [x, y, z], "q": 0.0123 }],
             [{ "f": "pc/1_0_0.png", "n": 250000, "o": [..], "q": .., "b": [minX, minZ, maxX, maxZ] }]],
  "urls": { "pc/1_0_0.png": "_blob/..." } }
```

`levels[k]` becomes `lod: k`; `o` is the offset and `q` the uniform scale; `b` is the 2D tile footprint (height unknown, the LOD box sits on `o.y`); `urls` (optional) maps a chunk file to its stored blob. Files resolve relative to the index URL. S10 converts this to `aio.pngcloud/1` losslessly with `quant: { offset: o, scale: q }`, `bounds` from `b` plus the decoded height range, and file paths made package-relative.

## Runtime

- **Workers.** All decoding runs in a pool of module workers (`src/worker.ts`); the main thread never decodes. The worker fetches the URL itself, decodes PNGs with `createImageBitmap` + `OffscreenCanvas`, and posts back transferable buffers: quantised positions (int16 or uint16, scaled on the GPU through the object transform), colours or intensities, and bounds.
- **LOD and budget.** `selectChunks` ranks every chunk of every cloud in the scene by angular size (half-diagonal over distance), always keeps lod 0, and fills the global budget (default 6 M points). Loaded chunks outside the selection stay until the total passes budget x 1.1, then the farthest unload. Up to four decodes run at a time; each landing chunk calls `requestRender()`.
- **Material.** Size attenuation (`size * pxPerMetre / depth`) clamped to 1..`maxPixels`, then multiplied by the point size scale (`uScale`, at least 1 px; `pointSizePx`), so the slider works where the clamp holds: far, sub-pixel points (octree nodes are sized to their spacing, about a pixel) and large ones up close; round points; colour modes `rgb`, `height` (shown as Elevation: the Turbo ramp from `ramp.ts` over the height range of the loaded, visible chunks), `intensity` and `flight`. A cloud without RGB draws `rgb` and `intensity` as its tinted intensity, and the controls disable RGB for it; a cloud without intensity draws `intensity` as luminance.
- **Elevation legend.** `useElevationRange()` gives the range while clouds are coloured by elevation (null otherwise); `<ElevationLegend range toElevation />` draws the same ramp with the top, middle and bottom in metres. `pointcloudStats` also reports whether the clouds carry RGB. Honours `renderer.clippingPlanes` (the shared section planes) and the logarithmic depth buffer.
- **EDL.** When on, the clouds render into an offscreen target (colour + depth texture) from a full-screen composite quad's `onBeforeRender`, so the pass runs inside the engine's own `renderer.render` call with the final camera matrices. The composite shades by the log-depth difference to 8 neighbours (Potree's EDL), and writes `gl_FragDepth` from the cloud depth so meshes and clouds still occlude each other correctly.
- **Picking.** `pickPoint(handle, ndc, radiusPx = 6)` projects the loaded points of chunks near the ray and returns the front-most point within the pixel radius (skipping clipped points).

## Engine seams

- Done: `SceneHandle.raycast` includes clouds. The adapter registers `pickPoint` with `SceneHandle.addRaycastProvider` while a scene shows clouds; the engine keeps the nearer of the mesh hit and the point hit.
- Done: point materials and `pickPoint` use the shared section planes `SceneHandle.clippingPlanes`, so the section tool cuts meshes and clouds together.
- `onFrame` runs on camera moves too (render on demand): LOD and uniforms update there.
- A post-process hook (or the EffectComposer) would let EDL run as a real pass instead of the composite quad; the quad keeps raycasting off and is flagged `userData.helper` so framing and picking can skip it.
- Budget, size, colour mode, hidden classes and EDL are remembered in localStorage (`stratlas.pointcloud.settings`). The app's graphics quality preset (Settings, Graphics quality) sets the budget and EDL when the GPU tier changes.
- The EDL composite lists its cloud scene in `userData.offscreen`, so the engine's perf HUD counts the clouds' GPU memory.

## Credits

- Packed decoders and the point shader idea: HCl tank and Al-Zour viewer artifacts (Synapse).
- EDL, point budget presets, colour mode fallbacks and the clip box approach follow Kestrel `frontend/src/clouds/` (MIT), which in turn uses potree-core's EDL. The EDL shader here is a port of Potree's `edl.fs` (Markus Schuetz, BSD-2-Clause).
