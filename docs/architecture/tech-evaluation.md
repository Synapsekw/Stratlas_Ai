# Technology evaluation

|        |                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| Status | Draft for review                                                                                           |
| Date   | 2026-10-03                                                                                                 |
| Inputs | [PRD](../PRD.md), [design brief](../design/BRIEF.md)                                                       |
| Method | Versions, dates and licences checked against the npm registry, vendor docs and release pages on 2026-10-03 |

The deciding constraints from the PRD: offline with zero network requests (NFR Offline), 60 fps fusion with video projection and 1 billion points (FUS-6, FUS-8), Windows plus macOS from one codebase, keys in the OS vault (AI-1), and reuse of six working vanilla three.js / Leaflet / pdf.js viewers. "Reuse" below means our existing `onBeforeCompile` projector shaders, f-theta lens code, `requestVideoFrameCallback` sync and packed int16 `THREE.Points` clouds survive with modest porting.

---

## 1. Desktop shell

| Option                         | Version                                                                                                                              | Licence                    | Maturity / maintenance           | Offline fit                                  | Reuse of three.js code                                                                                                                      | Risks                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | -------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Electron**                   | 44.5.1 (Chromium 152, Node 24), 45 stable due 2026-10-20 ([schedule](https://releases.electronjs.org/schedule))                      | MIT                        | 8-week majors, 3 supported lines | Full: bundled Chromium, no runtime downloads | 100 %: same Chromium on both OSes; HEVC decode built in since v22 ([ref](https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding)) | ~150 MB installer; must track majors for security                                                       |
| Tauri 2                        | 2.12 (2026-09-26), CLI 2.12.1; 3.0 alpha started ([blog](https://v2.tauri.app/blog/tauri-2.12/))                                     | MIT / Apache-2.0           | Active                           | Good                                         | Partial: WebView2 (Chromium) on Windows but WKWebView (WebKit) on macOS, see list below                                                     | Two rendering engines to QA; Node libraries (AI SDK, better-sqlite3) need a sidecar or Rust equivalents |
| Tauri 2 + CEF runtime (hybrid) | Upstream `feat/cef` branch unreleased; community port `tauri-runtime-cef` ([repo](https://github.com/SableClient/tauri-runtime-cef)) | MIT / Apache-2.0 + CEF BSD | Experimental                     | Good                                         | High (Chromium on both OSes)                                                                                                                | Not an official release; Chromium updates become our job; installer as large as Electron                |

**Team familiarity.** The team already ships a Tauri app (Kestrel: React/TS UI, Python/YOLO backend, built installers). That is a real asset: the signing and installer pipeline, the Python sidecar pattern and the React/TS skills exist. Most of it transfers to Electron unchanged (React/TS, Python sidecar over stdio, code-signing certificates); only the Rust command layer and Tauri configuration do not. The deciding question is therefore the rendering engine, not the shell API.

**Chromium vs WebView2 / WKWebView differences that matter here**

| Capability                               | Electron (Chromium 152, pinned)                                | WebView2 (Windows, Tauri)                                                                                                                                                                                                                           | WKWebView (macOS, Tauri)                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Engine version control                   | Pinned per release, identical on both OSes                     | Evergreen, updates under us unless the fixed-version runtime is shipped                                                                                                                                                                             | Tied to the macOS version; macOS 13 users get an older WebKit                                                                                                                                                                                                                                                                                                      |
| WebGL2                                   | ANGLE (D3D11 / Metal), same extension set on both OSes         | Same as Chrome                                                                                                                                                                                                                                      | ANGLE on Metal; extension set differs (verify `EXT_disjoint_timer_query_webgl2` for GPU timing and float render targets used by EDL); rAF capped at 60 fps on macOS 13–15 ([ref](https://github.com/userFRM/tauri-plugin-macos-fps)); reports of frame drops vs Safari ([ref](https://forum.babylonjs.com/t/performance-between-safari-and-wkwebview-tauri/60811)) |
| WebCodecs                                | Full                                                           | Full                                                                                                                                                                                                                                                | Video interfaces from Safari 16.4, full API only from Safari 26 / macOS 26 ([ref](https://www.testmuai.com/learning-hub/webcodecs-browser-support/))                                                                                                                                                                                                               |
| H.265 decode                             | Built in: D3D11VA / VideoToolbox, no OS add-on                 | Goes through Media Foundation and needs the **HEVC Video Extensions** from the Microsoft Store ([Microsoft](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/video-playback-issues)); not present on many corporate images | Native VideoToolbox, good                                                                                                                                                                                                                                                                                                                                          |
| `requestVideoFrameCallback`              | Yes                                                            | Yes                                                                                                                                                                                                                                                 | Yes since Safari 15.4 ([caniuse](https://caniuse.com/mdn-api_htmlvideoelement_requestvideoframecallback))                                                                                                                                                                                                                                                          |
| OffscreenCanvas + WebGL in workers       | Yes                                                            | Yes                                                                                                                                                                                                                                                 | 2D from Safari 16.4, WebGL later; check per supported macOS version                                                                                                                                                                                                                                                                                                |
| Large-file streaming via custom protocol | `protocol.handle` with own Range/206 handling, streamed bodies | Custom schemes mapped to `http://<scheme>.localhost`; asset protocol had crashes on multi-GB seeks before a streaming rewrite ([tauri#6375](https://github.com/tauri-apps/tauri/issues/6375))                                                       | WKURLSchemeHandler; same Range work needed                                                                                                                                                                                                                                                                                                                         |
| Node in main process                     | Yes (AI SDK, SQLite, pdf tooling in-process)                   | No (Rust, or a Node/Python sidecar)                                                                                                                                                                                                                 | No                                                                                                                                                                                                                                                                                                                                                                 |

**Hybrid options.** (a) Tauri + CEF runtime: Chromium everywhere with the Tauri model, but still unreleased upstream. (b) Tauri with the WebView2 fixed-version runtime on Windows and WKWebView on macOS: works on Windows, leaves the macOS gaps above. (c) Electron shell reusing Kestrel's React components and Python sidecar unchanged, with any Rust hot paths moved in as napi-rs native modules.

**Recommendation (open for the merged review): Electron**, starting on 44 and moving to 45 after its first patch releases, then staying on N-1. The H.265 dependency on a Store extension in WebView2 (DJI and Elios footage is often HEVC, customer machines are locked down) and the WebKit differences on macOS hit the two must-have workspaces directly. Installer size is not a factor because map packs and projects are gigabytes anyway. If the merged review favours Tauri for team velocity, the condition should be the CEF runtime (option a) once it is released upstream, validated by the same Al-Zour and HCl 60 fps spike on a Mac and a locked-down Windows image.

**Build tooling**

| Option                                  | Version         | Role                                                            | Notes                                                                                                                                                       |
| --------------------------------------- | --------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **electron-vite**                       | 5.0.0           | Dev server + build for main / preload / renderer on Vite        | Thin, fast HMR, works with any packager                                                                                                                     |
| **electron-builder** + electron-updater | 26.15.3 / 6.8.9 | Packaging (NSIS, DMG, zip), signing hooks, updates              | Broadest target support; `generic` provider can point at a file share or local folder                                                                       |
| Electron Forge                          | 8.0.1           | Official all-in-one (scaffold, Vite plugin, makers, publishers) | Gets new Electron features first ([ref](https://www.electronforge.io/core-concepts/why-electron-forge)); default updater path assumes Squirrel and a server |

**Recommendation: electron-vite + electron-builder.** Offline update (APP-2): the app accepts a signed installer file picked by the user, checks its Authenticode / Developer ID signature and version, then runs it; the optional online check uses electron-updater with the `generic` provider against a Synapse URL, disabled when offline-only is on. Harden with `@electron/fuses` 2.1.3 (disable RunAsNode and `NODE_OPTIONS`, enable ASAR integrity and OnlyLoadAppFromAsar).

**Code signing.** macOS: Developer ID Application certificate, hardened runtime, `notarytool` via `@electron/notarize` 3.1.1; every bundled `.dylib`/`.so` (including the Python runtime in Release B) must be signed. Windows: EV certificates no longer bypass SmartScreen reputation ([ref](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)), so a cheaper OV certificate in a cloud HSM is enough. Azure Artifact Signing is the cheapest option ([Electron docs](https://www.electronjs.org/docs/latest/tutorial/code-signing)) but is generally available only to organisations in the USA, Canada and Europe ([ref](https://www.devclass.com/security/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/4079554)). Confirm eligibility for the Synapse entity, otherwise use an OV certificate from a CA with cloud signing (DigiCert KeyLocker, SSL.com eSigner).

---

## 2. 3D fusion engine

| Option                              | Version                                | Licence         | Maturity / maintenance                                                                                                                                                           | Offline fit                              | Reuse of existing code                                                                                               | Risks                                                       |
| ----------------------------------- | -------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **three.js + own geospatial layer** | r186 / 0.186.1 (2026-09)               | MIT             | Releases every 8–11 weeks ([ref](https://github.com/mrdoob/three.js/releases))                                                                                                   | Full                                     | Complete: shaders, loaders, controls port r128/r160/r170 to r186 (mostly API renames)                                | We build CRS, tiling and LOD ourselves                      |
| **3d-tiles-renderer** (NASA-AMMOS)  | 0.5.3 (2026-09-18)                     | Apache-2.0      | Very active; plugin system; `PotreePlugin`, `PointCloudEffectsPlugin`, projected (flat) surfaces in 0.5.3 ([releases](https://github.com/NASA-AMMOS/3DTilesRendererJS/releases)) | Full (local URLs)                        | High: adds objects to _our_ three.js scene, peer `three >=0.167`                                                     | Pre-1.0 API churn                                           |
| Giro3D                              | 2.0.4 (2026-08-31)                     | MIT             | Oslandia, 1.0 in Dec 2025 ([ref](https://oslandia.com/en/2025/12/19/sortie-giro3d-v1-0-outil-web-visualisation-opensource/))                                                     | Full                                     | Medium: three.js underneath with renderer access, but `Instance` owns loop and camera; peer `three ^0.180` lags r186 | Pinned three.js version; OpenLayers 10 peer adds weight     |
| iTowns                              | 2.46.0 (npm 2025-10), 2.47 in progress | CECILL-B or MIT | Slower cadence                                                                                                                                                                   | Full                                     | Medium (three.js based, globe-centric)                                                                               | Release gap of a year                                       |
| CesiumJS                            | 1.146.0 (2026-10-01)                   | Apache-2.0      | Monthly, excellent                                                                                                                                                               | Full with local assets; ion features off | None: own WebGL renderer, shaders rewritten as CustomShader                                                          | Two engines, heavy, globe-first; projection shaders rebuilt |
| deck.gl                             | 9.4.0 (2026-09-05)                     | MIT             | Active, WebGPU parity                                                                                                                                                            | Full                                     | Low: luma.gl renderer; three.js interop only by sharing a context                                                    | Data-viz focus, no mesh-video projection                    |

Criteria scored: existing shader reuse (three.js-based options win), CRS via proj4 2.22 (all can do it; Cesium is ECEF-only), point cloud LOD (3DTR, Giro3D, Cesium), map as ground plane (Giro3D best out of the box, 3DTR next), video projection (only our own shaders do f-theta today), 60 fps (any of them if we control draw calls and point budget).

**Recommendation: three.js r186 as the single renderer, our own thin geospatial layer, plus 3d-tiles-renderer as a library of tiling plugins.** The geospatial layer is small but must be ours: a project CRS defined by proj4 string or EPSG code, a float64 local origin (ENU or UTM offset) held on the CPU, every layer converted to float32 relative-to-origin coordinates, and a per-layer 4x4 transform for engineering grids (FUS-1). This keeps the f-theta and pinhole projector code untouched. Run a two-week spike against Giro3D 2.0 on the Al-Zour data; adopt it only if its Map entity saves more than its version pin and loop ownership cost.

---

## 3. Point clouds

| Option                                                   | Version                              | Licence          | Maintenance                                                                       | Offline fit                  | Reuse                                                        | Risks                                      |
| -------------------------------------------------------- | ------------------------------------ | ---------------- | --------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| **copc.js + laz-perf (WASM) in workers, own octree LOD** | copc 0.0.9 (2026-08), laz-perf 0.0.7 | MIT / Apache-2.0 | Small but alive, reference COPC reader ([copc.io](https://copc.io/software.html)) | Range reads from local files | High: decoded chunks feed our existing `THREE.Points` shader | We write node selection, point budget, EDL |
| 3DTR `PotreePlugin`                                      | 0.5.3                                | Apache-2.0       | New in 0.5.3                                                                      | Full                         | High                                                         | Brand-new code                             |
| potree-core                                              | 2.0.15 (2026-04)                     | MIT              | Single maintainer                                                                 | Full                         | High (three.js)                                              | Bus factor                                 |
| @pnext/three-loader                                      | 1.0.0 (2025-11)                      | MIT              | Peer `three ~0.160`                                                               | Full                         | Medium                                                       | Stale three.js pin                         |
| Giro3D COPC source                                       | 2.0.4                                | MIT              | Active                                                                            | Full                         | Only if Giro3D adopted                                       | Couples to Giro3D                          |
| Cesium point-cloud 3D Tiles                              | 1.146                                | Apache-2.0       | Mature                                                                            | Full                         | None                                                         | Conversion plus second engine              |

**Recommendation:** COPC as the canonical cloud format. Read it with copc.js + laz-perf in a worker pool, served through the range-capable protocol from section 9; a screen-space-error octree traversal with a global point budget (e.g. 8 M on the reference workstation, 3 M on the minimum laptop) and eye-dome lighting. Potree 2 octrees (existing Al-Zour streaming) load through 3DTR `PotreePlugin` or potree-core until migrated. 1 billion points is a storage figure; the budget is what reaches the GPU.

**Conversion (Release B):** PDAL 2.10 ([release](https://github.com/PDAL/PDAL/releases/tag/2.10.0), BSD) with `writers.copc` as the default; untwine is faster above ~500 M points but is **GPLv3** ([repo](https://github.com/hobuinc/untwine)), so ship it only as a separate executable after a licence review, or buy the commercial licence. PotreeConverter 2.1.5 (BSD-2) only for legacy Potree output.

---

## 4. 2D maps

| Option                       | Version                | Licence       | Maintenance | Offline fit                                           | Reuse                        | Risks                                                 |
| ---------------------------- | ---------------------- | ------------- | ----------- | ----------------------------------------------------- | ---------------------------- | ----------------------------------------------------- |
| **MapLibre GL JS + pmtiles** | 6.11.2 / pmtiles 4.5.0 | BSD-3         | Very active | Full: `pmtiles://` protocol, local glyphs and sprites | Low (road viewer is Leaflet) | WebGL context per map window                          |
| OpenLayers + ol-pmtiles      | 10.10.0 / 2.0.2        | BSD-2 / BSD-3 | Active      | Full                                                  | Low                          | Vector-tile styling less natural than MapLibre styles |
| Leaflet                      | 1.9.4 (2023-05)        | BSD-2         | 1.x frozen  | Raster only offline                                   | High for road viewer         | No vector tiles; keep for legacy viewer only          |

**Recommendation: MapLibre GL JS 6 + PMTiles + Protomaps basemaps** (`@protomaps/basemaps` 5.7.2 for light and dark styles). Bundle style JSON, glyph PBFs and sprites inside the app (served by our protocol, never a CDN). Arabic: MapLibre now shapes Arabic and reorders bidirectional text natively and `setRTLTextPlugin` is deprecated ([docs](https://maplibre.org/maplibre-gl-js/docs/API/functions/setRTLTextPlugin/)), so no plugin download is needed. The glyph set must cover Arabic ranges (U+0600–06FF, U+0750–077F, U+FB50–FDFF, U+FE70–FEFF); verify the Protomaps font stack covers them, otherwise generate glyph PBFs from Noto Sans Arabic. Label language switching uses `name:ar` / `name:en`.

**Building the packs.** Daily planet builds are listed at maps.protomaps.com/builds, kept for a week ([downloads](https://docs.protomaps.com/basemaps/downloads)); the planet is ~120 GB+ at z0–15. Extract with the go-pmtiles CLI ([docs](https://docs.protomaps.com/pmtiles/cli)), which reads remote archives by range request:

```sh
# GCC street level: use a polygon of the six countries, not a rectangle (a bbox 34.4,16.0,60.0,32.2 also pulls Iraq, Jordan, Yemen and south Iran)
pmtiles extract https://build.protomaps.com/20261002.pmtiles gcc-z15.pmtiles --region=gcc.geojson --maxzoom=15 --download-threads=8
# World overview
pmtiles extract https://build.protomaps.com/20261002.pmtiles world-z8.pmtiles --maxzoom=8
```

**Size estimates (to confirm in the spike):** world z0–6 ~60 MB ([Protomaps guide](https://docs.protomaps.com/guide/getting-started)); each zoom roughly doubles, so world z0–8 ~250–400 MB. GCC to z15: Geofabrik's GCC extract is 242 MB of PBF (2026-10-02, [ref](https://download.geofabrik.de/asia/gcc-states.html)); a polygon extract should land around 0.5–1.5 GB, and a rectangular bbox 2–4 GB. Base install: world z0–6 plus GCC; world z7–8 as an optional pack.

**Licence.** Protomaps basemap is an ODbL Produced Work; show "© OpenStreetMap contributors" on every map and in exported screenshots and PDFs, and keep any extra attribution from `pmtiles show` metadata. Legacy Mapbox-baked tiles stay out of new packs (PRD §11).

---

## 5. Map tiles as the 3D ground plane

| Option                                                                    | Fit                                                                                                       | Effort                | Risks                                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| Giro3D Map entity (color + elevation layers, vector tiles via OpenLayers) | Best out of the box, reprojection included                                                                | Low if Giro3D adopted | Couples engine choice; vector rasterised by OL                                     |
| 3DTR XYZ / image-overlay plugins with projected surface                   | Good for raster tiles (ortho, pre-rendered basemap)                                                       | Medium                | Web Mercator assumption; needs reprojection into project CRS                       |
| Render MapLibre to texture                                                | Exact 2D style in 3D                                                                                      | Medium                | Per-frame copy is expensive; only valid while camera rests; one more WebGL context |
| **Custom quadtree of raster tiles**                                       | Full control: grid meshes reprojected per vertex with proj4, same shader receives video ground projection | Medium                | We own LOD and seams                                                               |

**Recommendation:** a custom quadtree of 32×32 vertex tile meshes in the project CRS, each vertex reprojected from tile coordinates (exact for both Web Mercator basemap and UTM orthos), optionally displaced by a DSM. Textures come from (a) ortho/DSM COG via `geotiff` 3.0.5 or kit pyramids and (b) the basemap rasterised once per tile by a hidden MapLibre instance and cached on disk per style; ship pre-rasterised low zooms in the map pack for instant first frame. The existing ground-projection shader for Al-Zour video plugs straight into this material. 3DTR plugins remain a fallback for the raster path.

---

## 6. Video

| Option                                                            | Role                                                | Pros                                                                                   | Cons                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **HTMLVideoElement + `requestVideoFrameCallback`**                | Playback, projection texture                        | Existing code; hardware decode; `metadata.mediaTime` gives the shown frame's timestamp | `currentTime` seeks land on nearest decodable frame; not frame-exact |
| **WebCodecs `VideoDecoder` + demuxer (mediabunny 1.61, MPL-2.0)** | Frame-exact scrub, frame capture for AI, thumbnails | Decode from previous keyframe to exact frame; `VideoFrame` uploads to a texture        | More code; GOP-length latency                                        |

**Recommendation:** keep the `<video>` + rVFC path for playback and projection, add a WebCodecs path for exact-frame seek, frame extraction (AI-4, BLD-6) and contact sheets. The flight log, not the video clock, is the timeline master; each clip stores an offset and drift from alignment (FUS-6). H.265: Electron includes HEVC hardware decode since v22 (D3D11VA on Windows, VideoToolbox on macOS; Main and Main10) ([ref](https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding)); a GPU without HEVC support fails, so detect with `MediaCapabilities.decodingInfo` and offer a Release B transcode to H.264 with a bundled LGPL ffmpeg. Meet the 100 ms scrub target with H.264/H.265 proxies with 1 s GOP generated at import.

**Telemetry.** DJI SRT varies by model (bracketed key/value on Mini 4 Pro, HTML-styled on Mavic 3; [ref](https://callmarcus.com/guides/dji-srt-format/)); write our own tolerant parser with fixtures per model. Release B DJI `.txt` logs: `dji-log-parser` (MIT, Rust with JS/WASM bindings) handles v13+ encryption with a keychain fetched once online via a DJI developer key and cached beside the log ([repo](https://github.com/lvauvillier/dji-log-parser)), which matches PRD §11.

---

## 7. UI framework, docking, state

| Option       | Version | Licence | Notes                                                                  |
| ------------ | ------- | ------- | ---------------------------------------------------------------------- |
| **React 19** | 19.3.0  | MIT     | Largest ecosystem; dockview, Radix, TanStack available; hiring easiest |
| Svelte 5     | 5.57.1  | MIT     | Smaller bundles, runes; fewer pro-grade docking/grid libraries         |
| SolidJS      | 1.9.15  | MIT     | Fastest fine-grained updates; smallest ecosystem                       |

| Docking       | Version                 | Notes                                                                                                                                                 |
| ------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **dockview**  | 8.4.0 (2026-09-30), MIT | Zero dependencies, tabs, groups, floating panels, **popout windows**, layout serialisation, React/Vue/Angular/vanilla ([site](https://dockview.dev/)) |
| FlexLayout    | 0.11.1, MIT             | React only, active, popouts                                                                                                                           |
| golden-layout | 2.6.0 (2022), MIT       | Unmaintained since 2022: reject                                                                                                                       |

**Recommendation: React 19 + dockview + Zustand 5** for UI state, with **the 3D engine outside React**: an imperative `Engine` per viewport, driven by a typed command bus that both UI and agent tools call (AI-5 approve/undo comes from the same commands). Rendering is never triggered by React reconciliation. TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; zod 4 for IPC and manifest schemas. Legacy viewers run in sandboxed `WebContentsView`s or iframes on our protocol, not React components.

---

## 8. AI provider layer

| Option                                                               | Version                                                  | Licence          | Tool calling / streaming / vision                                                                                                                              | Risks                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`, `/openai`, `/google`) | ai 7.0.127; providers 4.0.x (2026-09-30)                 | Apache-2.0       | Unified; v7 adds typed tool context and built-in **tool approvals** on `streamText`/`ToolLoopAgent` ([blog](https://vercel.com/blog/ai-sdk-7)); per-step usage | Abstraction lags newest vendor features by days or weeks                  |
| Vendor SDKs directly                                                 | @anthropic-ai/sdk 0.131, openai 7.27, @google/genai 2.27 | MIT / Apache-2.0 | Full fidelity                                                                                                                                                  | Three tool schemas, three streaming formats to normalise                  |
| LangChain JS                                                         | 1.5.15                                                   | MIT              | Broad                                                                                                                                                          | Heavy abstraction, frequent churn, little value for a fixed tool registry |

**Recommendation: AI SDK 7 in the Electron main process (or a dedicated utility process)**, with vendor SDKs as an escape hatch for provider-specific features behind the same provider interface (also the AI-9 seam for Ollama). The renderer sends `{windowContext, userMessage}` over an allow-listed IPC channel; main attaches keys, enforces the offline switch and per-project policy (AI-2), streams tokens back, and routes tool calls to the renderer's command bus, where approvals render as chips. Frames and images for vision are captured in the renderer, shown in the "what will be sent" preview (AI-6), then passed to main. Cost meter (AI-7): sum `usage` per step into SQLite with a versioned local price table per model.

**Key storage:** `keytar` has been unmaintained since December 2022 ([ref](https://github.com/microsoft/vscode/issues/185677)). Use `@napi-rs/keyring` 2.1.0 (MIT) to store one item per provider in Windows Credential Manager or the macOS Keychain, which meets AI-1's "OS credential vault" literally and lets IT revoke it; fall back to Electron `safeStorage` async APIs (DPAPI / Keychain-wrapped key) ([docs](https://www.electronjs.org/docs/latest/api/safe-storage)). Keys never cross IPC to the renderer, and the logger has a redaction filter.

---

## 9. Local data

| Option             | Version                                                                                     | Notes                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **better-sqlite3** | 13.0.3 (2026-08), MIT                                                                       | Mature, synchronous and fast, FTS5, prebuilds; native module rebuilt per Electron ABI via `@electron/rebuild` |
| node:sqlite        | Node 24.15+ "release candidate" (stability 1.2) ([ref](https://nodejs.org/api/sqlite.html)) | No native build; API not final; availability inside Electron's Node build needs checking                      |

**Recommendation: better-sqlite3** in a utility process (library index, findings, AI history, cost), with Kysely 0.29 for typed queries and numbered SQL migrations. Re-evaluate node:sqlite when it reaches stability 2.

**Project package format.** A **folder** with:

```
project.aio/                     (folder; .aio suffix only for OS association)
  manifest.json                  schema-versioned: CRS, origin, layers, clips, refs
  project.sqlite                 findings, edits, views, AI history
  assets/sha256/ab/cd…           content-addressed blobs (GLB, COPC, PMTiles, MP4, JPEG)
  external.json                  references to data left in place (NAS, LIB-2)
```

Content addressing deduplicates shared assets (two survey dates, the same basemap) and makes integrity checks cheap (NFR Reliability: name the missing hash and its layer). For customer delivery (BLD-9) export a single **uncompressed ZIP64** (store mode, so every member is range-readable in place) with optional AES encryption; a single SQLite container is rejected because 500 GB of blobs inside SQLite are slow to write and impossible to range-stream efficiently.

**Streaming to the renderer.** Register `aio://` with `registerSchemesAsPrivileged({standard, secure, supportFetchAPI, stream: true, corsEnabled})` and serve it with `protocol.handle`. Implement `Range` and `206 Partial Content` yourself: a naive `net.fetch('file://…')` breaks video seeking ([electron#38749](https://github.com/electron/electron/issues/38749)). The handler resolves only hashes or paths inside opened project roots (no traversal), and the same endpoint feeds `<video>`, COPC, PMTiles and COG range reads. CSP: `default-src 'self' aio:`, no remote origins.

---

## 10. Python pipelines (Release B)

| Option                                         | Licence                       | Fit                                                                                                                                                                                                                                                                                | Risks                                                         |
| ---------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **python-build-standalone + uv-locked wheels** | MPL/PSF; uv MIT/Apache        | Relocatable CPython (latest build 20260924, [releases](https://github.com/astral-sh/python-build-standalone/releases/tag/20260924)); rasterio wheels bundle GDAL on Windows and macOS ([ref](https://github.com/rasterio/rasterio-wheels)); trimesh, scipy, numpy are plain wheels | Wheel GDAL omits some drivers (e.g. ECW)                      |
| conda-pack (conda-forge)                       | BSD                           | Full GDAL/PROJ/PDAL stack                                                                                                                                                                                                                                                          | 1–2 GB, more binaries to sign                                 |
| PyInstaller per pipeline                       | GPL with bootloader exception | Single executables                                                                                                                                                                                                                                                                 | Hard to extend; antivirus false positives; duplicate runtimes |

**Recommendation:** a versioned "pipeline pack" (not in the base installer) built from python-build-standalone 3.13 plus a `uv.lock` wheel set, signed and notarised file by file in CI. Switch to conda-pack only if the spike finds missing GDAL drivers or PDAL bindings are required. IPC: main spawns `python -m aio_pipelines <job>` with JSON-RPC 2.0 over stdio (JSON lines): `progress`, `log`, `artifact`, `error` notifications; cancellation via a `cancel` request then process kill; resume from a per-step manifest in the project. Bulk data moves through files in the project folder, never through pipes.

---

## 11. Quality tooling

| Tool                   | Version                                                                                                  | Note                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint                 | **10.12** (flat config only since 10.0, [ref](https://eslint.org/blog/2026/02/eslint-v10.0.0-released/)) | Brief asked for 9; 10 is current and flat-config-only                                                                                          |
| typescript-eslint      | 8.71                                                                                                     | Supports TypeScript `>=4.8.4 <6.1.0` only                                                                                                      |
| TypeScript             | **6.0.3 pinned**; 7.0.2 (native) for fast `tsc --noEmit`                                                 | TS 7 lacks the programmatic API typescript-eslint needs until 7.1 ([ref](https://github.com/typescript-eslint/typescript-eslint/issues/12521)) |
| Prettier               | 3.9.9                                                                                                    |                                                                                                                                                |
| Vitest                 | 5.0.3                                                                                                    | Unit tests for geo math, parsers, IPC schemas                                                                                                  |
| Playwright             | 1.63, `_electron.launch` (experimental tier, [docs](https://playwright.dev/docs/api/class-electron))     | E2E on Windows and macOS runners, plus the **zero-network test**: route all requests and fail on any non-`aio:` request                        |
| lefthook + lint-staged | 2.1.16 / 17.6                                                                                            | Pre-commit format and lint; commitlint on messages                                                                                             |
| pnpm workspaces        | 12.8                                                                                                     | Set `node-linker=hoisted` for the Electron app package (packagers expect a flat `node_modules`)                                                |

Layout:

```
apps/desktop          main, preload, renderer (electron-vite)
packages/engine       three.js viewport, projector shaders, controls
packages/geo          CRS, origin, quadtree tiles, proj4 wrappers
packages/pointcloud   COPC worker, octree LOD
packages/video        rVFC + WebCodecs, SRT/flight parsers
packages/ai           provider layer, tool registry, cost meter
packages/schema       zod manifest, IPC contracts
packages/ui           React components, dockview panels, tokens
legacy/               six existing viewers, unchanged
python/               pipelines (Release B), uv.lock
```

---

## Recommended stack

| Concern         | Choice                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Shell           | Electron 44 → 45 (N-1 policy), context isolation, sandbox, fuses; Tauri + CEF only if the merged review favours Tauri                  |
| Build / package | electron-vite 5 + Vite 8; electron-builder 26 (NSIS, DMG); electron-updater `generic` + offline installer import                       |
| Signing         | Apple Developer ID + notarytool; Windows OV in cloud HSM (Azure Artifact Signing if eligible)                                          |
| 3D              | three.js r186 + own CRS/origin layer (proj4 2.22) + 3d-tiles-renderer 0.5 plugins; Giro3D 2.0 spike                                    |
| Point clouds    | COPC via copc.js + laz-perf workers, own LOD + EDL; Potree 2 via 3DTR PotreePlugin; PDAL 2.10 conversion                               |
| 2D map          | MapLibre GL JS 6.11 + pmtiles 4.5 + Protomaps basemaps 5.7; bundled glyphs/sprites; native Arabic                                      |
| 3D ground       | Custom quadtree of reprojected raster tiles (ortho COG + rasterised basemap cache)                                                     |
| Video           | `<video>` + rVFC for playback/projection; WebCodecs + mediabunny for exact frames; HEVC via Chromium                                   |
| Telemetry       | Own SRT parser; dji-log-parser (Release B)                                                                                             |
| UI              | React 19.3, dockview 8.4, Zustand 5, zod 4, TypeScript strict                                                                          |
| AI              | AI SDK 7 (+ Anthropic, OpenAI, Google providers) in main; keys in @napi-rs/keyring, safeStorage fallback                               |
| Data            | better-sqlite3 13 + Kysely; folder package with manifest + content-addressed assets; ZIP64 store export                                |
| Streaming       | `aio://` privileged protocol with own Range/206 handling                                                                               |
| Python (B)      | python-build-standalone 3.13 + uv lock; JSON-RPC over stdio                                                                            |
| Quality         | ESLint 10 flat + typescript-eslint 8, TS 6.0 (TS 7 for typecheck), Prettier 3, Vitest 5, Playwright 1.63, lefthook, pnpm 12 workspaces |

## Top 5 risks and mitigations

| #   | Risk                                                                                                                                                          | Mitigation                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **60 fps with 842 M–1 B points, video projection and map ground together** fails on the reference workstation, or 30 fps fails on integrated GPUs             | Performance spike in the first sprint on Al-Zour data: point budget, worker decode, EDL in one pass, frame-time HUD; CI performance test with recorded camera path; quality presets per GPU tier |
| 2   | **Precision and CRS errors** (float32 jitter at UTM magnitudes, wrong datum, engineering-grid transforms) misplace video footprints and findings              | float64 origin on CPU, relative-to-origin geometry, single proj4 registry with EPSG definitions bundled offline; golden tests against surveyed control points from the six projects              |
| 3   | **Vector basemap as 3D ground** is costly (rasterisation, seams, style parity with 2D)                                                                        | Pre-rasterised low zooms in the pack, disk cache for runtime tiles, shared style source with the 2D map; fallback to raster-only ground for Release A if the spike overruns                      |
| 4   | **Codec and seek variance**: HEVC absent on some GPUs, imprecise `currentTime`, scrub latency over 100 ms                                                     | Capability probe at import; generate short-GOP proxies; WebCodecs exact-frame path; flight log as clock master with per-clip offsets                                                             |
| 5   | **Signing and distribution**: Windows certificate eligibility by region, SmartScreen reputation, notarising thousands of Python binaries; GPL tools (untwine) | Buy certificates now (PRD §11); sign in CI from day one; Python as separate signed pack; licence scan (license-checker) in CI with an allow-list; PDAL instead of untwine unless licensed        |

Smaller watch items: 3d-tiles-renderer and copc.js are pre-1.0 (pin and wrap behind our interfaces); Playwright Electron support is experimental (keep E2E thin, test logic in Vitest); AI SDK abstraction lag (vendor-SDK escape hatch).
