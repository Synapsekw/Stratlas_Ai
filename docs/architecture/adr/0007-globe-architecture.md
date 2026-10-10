# ADR 0007: The Globe and 3D Tiles (CesiumJS beside the three.js site view)

- Status: **Accepted, 7 Oct 2026 (founder: go with the recommendations)**. M10 decision 3, option (c).
- Deciders: founder; integration lead (M10)
- Plan: `docs/plans/2026-10-07-m10-globe-and-photogrammetry.md`, "Cesium: options and recommendation"
- Contracts: `@aio/schema` `globe.ts`, `tilesets.ts`; code: `packages/globe` (G6), `packages/tiles` (G7), main `globe.ts`, `tilesets.ts`, `packs/raster.ts`

## Context

The founder asked to integrate Cesium "to import the satellite maps and work with a globe". The app already has one renderer, a three.js r186 site view with annotation, measuring, picking, video projection, change colouring and the agent's camera tools; the 2026 tech evaluation chose three.js as the single renderer because CesiumJS would mean "two engines, heavy, globe-first" and rewriting our projection shaders. CesiumJS is Apache-2.0, but the imagery and terrain it usually shows (Cesium ion, Bing, Google Photorealistic 3D Tiles) are online services whose terms forbid offline caching. No maintained integration renders CesiumJS and three.js in one canvas with shared depth.

## Decision

1. **Two views with a clear split.** A **Globe** view built on CesiumJS (`@cesium/engine` and `@cesium/core` only, a bare `CesiumWidget`, never `@cesium/widgets`, whose Knockout needs `'unsafe-eval'`) is the place to see the world: every library project on the Earth, offline imagery and terrain packs, each site's orthos and 3D Tiles, survey footprints and issues as pins, and a fly-in. **Open site here** hands over to the site view at the same camera. The Globe has a geodesic distance and area read-out labelled "on the ellipsoid" and no other tool.
2. **The site view gains Cesium's open standards** through 3DTilesRendererJS (NASA-AMMOS, Apache-2.0) behind `packages/tiles`: 3D Tiles 1.1 (large processed meshes, clouds, tilesets from other software) and terrain and imagery around the site. Every site tool keeps working on them; picking, annotation, measuring and editing exist once, in the site view.
3. **Offline by construction.** No ion token is ever set; the base layer is passed explicitly (Natural Earth II from the app's own copy of Cesium's assets, served from `'self'`); no geocoder, no base layer picker, no ion, Bing, Google, Esri or Mapbox provider. A lint rule bans those imports (`eslint.config.js`, `BANNED_CESIUM_IMPORTS` in `packages/globe`), the bundle check refuses any online map host in the built renderer, and the zero-network e2e guard runs with the Globe open. The app's CSP is never weakened for CesiumJS; any need for `'unsafe-eval'` is a blocker the G6 spike rules out first.
4. **One data layer for three renderers.** Imagery packs are raster PMTiles (Web Mercator) and terrain packs are Terrarium-encoded PMTiles, read by MapLibre, 3DTilesRendererJS and CesiumJS (a small `PmtilesImageryProvider` and a heightmap provider with the geoid offset). Tilesets are standard 3D Tiles in `<project>/tiles/<id>/`, listed in `tilesets.json` (`aio.tilesets/1`); no layer kind is added. Our tilesets are placed per vertex through the project CRS in float64, so the two views agree within 2 cm.
5. **Resources.** CesiumJS is a lazily loaded chunk; the Globe tears down its WebGL context when the person leaves it, so the two views never hold both GPU budgets. Low tier: terrain off, a higher screen-space error, no atmosphere.

## Consequences

- Two engines to keep current: CesiumJS is pinned and updated once per milestone with the zero-network test as the gate; 3DTilesRendererJS (pre-1.0) is pinned and wrapped.
- The installer grows by at most 15 MB (decision 6) for CesiumJS and 3DTilesRendererJS. Amended 10 Oct 2026 (founder): 20 MB over the 0.9.0 installer in total, adding 5 MB for the M11 survey tools (0.11.0 was 16.3 MB over).
- Imagery and terrain come only from packs whose licence allows offline redistribution, or from the customer's own imagery under its licence (decisions 4 and 12, ADR-level detail in the plan's "Imagery and terrain: sources and licences").
- Rejected: (a) CesiumJS alone (every tool rebuilt or missing on the globe); (b) 3DTilesRendererJS alone (most of the value at a fraction of the cost, but not the Cesium globe the founder named, and a less mature globe).
