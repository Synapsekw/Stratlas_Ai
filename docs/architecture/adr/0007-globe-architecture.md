# ADR 0007: The Globe and 3D Tiles (CesiumJS beside the three.js site view)

- Status: **Accepted, 7 Oct 2026 (founder: go with the recommendations)**. M10 decision 3, option (c). Decision 3 amended 10 Oct 2026 (founder): one online imagery source, off by default; see the amendment at the end.
- Deciders: founder; integration lead (M10)
- Plan: `docs/plans/2026-10-07-m10-globe-and-photogrammetry.md`, "Cesium: options and recommendation"
- Contracts: `@aio/schema` `globe.ts`, `tilesets.ts`; code: `packages/globe` (G6), `packages/tiles` (G7), main `globe.ts`, `tilesets.ts`, `packs/raster.ts`

## Context

The founder asked to integrate Cesium "to import the satellite maps and work with a globe". The app already has one renderer, a three.js r186 site view with annotation, measuring, picking, video projection, change colouring and the agent's camera tools; the 2026 tech evaluation chose three.js as the single renderer because CesiumJS would mean "two engines, heavy, globe-first" and rewriting our projection shaders. CesiumJS is Apache-2.0, but the imagery and terrain it usually shows (Cesium ion, Bing, Google Photorealistic 3D Tiles) are online services whose terms forbid offline caching. No maintained integration renders CesiumJS and three.js in one canvas with shared depth.

## Decision

1. **Two views with a clear split.** A **Globe** view built on CesiumJS (`@cesium/engine` and `@cesium/core` only, a bare `CesiumWidget`, never `@cesium/widgets`, whose Knockout needs `'unsafe-eval'`) is the place to see the world: every library project on the Earth, offline imagery and terrain packs, each site's orthos and 3D Tiles, survey footprints and issues as pins, and a fly-in. **Open site here** hands over to the site view at the same camera. The Globe has a geodesic distance and area read-out labelled "on the ellipsoid" and no other tool.
2. **The site view gains Cesium's open standards** through 3DTilesRendererJS (NASA-AMMOS, Apache-2.0) behind `packages/tiles`: 3D Tiles 1.1 (large processed meshes, clouds, tilesets from other software) and terrain and imagery around the site. Every site tool keeps working on them; picking, annotation, measuring and editing exist once, in the site view.
3. **Offline by construction** (one narrow exception since 10 Oct 2026, in the amendment below). No ion token is ever set; the base layer is passed explicitly (Natural Earth II from the app's own copy of Cesium's assets, served from `'self'`); no geocoder, no base layer picker, no ion, Bing, Google, Esri or Mapbox provider. A lint rule bans those imports (`eslint.config.js`, `BANNED_CESIUM_IMPORTS` in `packages/globe`), the bundle check refuses any online map host in the built renderer, and the zero-network e2e guard runs with the Globe open. The app's CSP is never weakened for CesiumJS; any need for `'unsafe-eval'` is a blocker the G6 spike rules out first.
4. **One data layer for three renderers.** Imagery packs are raster PMTiles (Web Mercator) and terrain packs are Terrarium-encoded PMTiles, read by MapLibre, 3DTilesRendererJS and CesiumJS (a small `PmtilesImageryProvider` and a heightmap provider with the geoid offset). Tilesets are standard 3D Tiles in `<project>/tiles/<id>/`, listed in `tilesets.json` (`aio.tilesets/1`); no layer kind is added. Our tilesets are placed per vertex through the project CRS in float64, so the two views agree within 2 cm.
5. **Resources.** CesiumJS is a lazily loaded chunk; the Globe tears down its WebGL context when the person leaves it, so the two views never hold both GPU budgets. Low tier: terrain off, a higher screen-space error, no atmosphere.

## Amendment, 10 Oct 2026: the Globe is a street map (founder)

The Globe's default Earth is no longer Natural Earth II but the app's own street map: the street style of the Map view, drawn from the installed street packs (vector PMTiles) by a hidden MapLibre map, one Web Mercator tile at a time, and draped by CesiumJS as an imagery layer (`@aio/maps` `createStreetTiles`, `@aio/globe` `GlobeTileSource`). Under it, and alone on a fresh install, lie land and country borders from Natural Earth 1:50m vectors bundled with the app (about 750 kB), painted in the street style's colours. Imagery packs are the **Satellite** look, an explicit choice; Natural Earth II is the **Natural Earth** look. `planGlobeLayers` (`packages/globe/src/layers.ts`) is the one place that decides the layers. Decision 3 stands: every layer is drawn from files the app ships or the person installed, no provider is added, the lint rule, the bundle check and the zero-network guard are unchanged.

CesiumJS stays (decision 1): pins, fly-in, terrain, 3D Tiles, imagery packs and the read-out keep working as they were. The cost is that labels are part of the draped picture, so they turn and lean with the ground. CesiumJS mixes tile levels in one view; so that a label does not change size or get cut where a coarser tile meets a finer one, the street tiles in view are drawn again, once the view rests, in the style of the deepest of them. MapLibre's own globe projection would keep labels upright, but it has no terrain packs of ours, no 3D Tiles and no camera hand-off: a rebuild of the Globe, not taken.

## Consequences

- Two engines to keep current: CesiumJS is pinned and updated once per milestone with the zero-network test as the gate; 3DTilesRendererJS (pre-1.0) is pinned and wrapped.
- The installer grows by at most 15 MB (decision 6) for CesiumJS and 3DTilesRendererJS. Amended 10 Oct 2026 (founder): 20 MB over the 0.9.0 installer in total, adding 5 MB for the M11 survey tools (0.11.0 was 16.3 MB over).
- Imagery and terrain come only from packs whose licence allows offline redistribution, or from the customer's own imagery under its licence (decisions 4 and 12, ADR-level detail in the plan's "Imagery and terrain: sources and licences").
- Rejected: (a) CesiumJS alone (every tool rebuilt or missing on the globe); (b) 3DTilesRendererJS alone (most of the value at a fraction of the cost, but not the Cesium globe the founder named, and a less mature globe).

## Amendment, 10 Oct 2026 (founder): one online imagery source

The founder: "Not everybody wants to work completely offline." Decision 3 gains one narrow exception. When the workstation is not offline-only and the person has switched it on, the app may stream satellite imagery from one named source. Offline-only workstations stay exactly as strict as before.

**The exception.**

- **One source, named in code:** Sentinel-2 cloudless 2016 by EOX IT Services GmbH, read as WMTS tiles in Web Mercator (`tiles.maps.eox.at`, layer `s2cloudless_3857`, tile matrix set `GoogleMapsCompatible`, JPEG, 256 px). No key, no account.
- **Off by default.** The switch is **Online satellite (Sentinel-2)** in Settings, Offline maps, and the **Online satellite** row of the map type picker on the map (one switch, shown in both). It is kept in its own file in the app profile (userData `online.json`, `aio.online-settings/1`), not in `settings.json`, which keeps exactly the keys older builds read. The first time it is switched on, the app says what that means: the tiles for the areas the person looks at are requested from EOX's servers, so those areas are visible to that service; the imagery is from 2016, at about 10 m per pixel.
- **Never on an offline-only workstation.** With `Settings.offlineOnly` on, nothing is requested, whatever the switch says. Tiles already in the cache still draw, because they are files on this computer.

**Licence and attribution.** The 2016 layer is released under CC BY 4.0: commercial use, use of the hosted tiles in applications and keeping tiles are allowed, with attribution. The credit is shown wherever the imagery is drawn (the map's attribution control, the Globe's credits once it is wired in) and in Settings, About:

> EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)

This is the service's own wording for the 2016 layer, copied from its capabilities document as of 10 Oct 2026 (the abstract of the layer, up to "released under"). It is one constant, `ONLINE_SATELLITE.attribution` in `@aio/schema`, and every place that shows the credit reads it. The address in it is the product's page; the app never requests it.

**Why 2016 only.** The 2018 to 2025 layers of the same service are CC BY-NC-SA 4.0, which forbids commercial use; the app must never request them. The capabilities document lists the 2017 layer as CC BY 4.0 as well, but it is not used: the founder's decision names 2016, and one layer is enough.

**The real id of the 2016 layer is `s2cloudless_3857`.** In the service's capabilities document (read 10 Oct 2026) the 2016 Web Mercator layer is the one whose identifier has no year; `s2cloudless-2016_3857` does not exist and answers 404. The later years are `s2cloudless-<year>_3857`. The app's own id for the source, `s2cloudless-2016`, says the year so that nobody takes it for the newest imagery. The layer id is one constant in main (`ONLINE_SATELLITE_LAYER`) with this reason beside it, and a unit test fails if it ever carries a later year. A newer or sharper source is a new founder decision and a new amendment, not a change of that constant.

**Main enforces the gate.** The renderer never names the service and cannot reach it: its CSP and the session's request filter are unchanged, and it asks the app's own protocol, `aio://online/s2cloudless-2016/{z}/{x}/{y}.jpg`. The handler in main (`apps/desktop/src/main/onlineTiles.ts`):

- refuses every tile with 403, without reading the cache or asking anyone, unless the switch is on;
- accepts only that one source id, zoom 0 to 14 (the imagery's own detail; a closer view stretches those tiles instead of requesting deeper ones) and x, y inside the zoom;
- serves the tile from its cache when it is there, on any workstation;
- asks the service only when the workstation is not offline-only: that one host, https only, a redirect is an error and is not followed, no cookie is kept or sent;
- is a polite client of a free service with no guarantee: at most four requests at a time, a User-Agent that names the app, a growing wait after a failure (5 s doubling to 5 min, one request at a time until the service answers again), and only tiles a view asked for (no prefetch, no bulk download);
- keeps what it fetched in a bounded cache, `<userData>/cache/online-tiles/` (300 MB, the tiles used longest ago go first, cleared from Settings), so areas already viewed stay available and a repeat view costs the service nothing;
- answers 404 when it has no tile to give, so the map quietly draws the coarser tile it has.

In an end-to-end run (`QUADRION_E2E=1`) main has no way to the service at all; a spec may ask for a stand-in that makes tiles in main without any network.

**What stands.** Everything else in decision 3: no ion token, no ion, Bing, Google, Esri or Mapbox provider, no geocoder; the lint ban (`BANNED_CESIUM_IMPORTS`) and the bundle check are unchanged, and the CSP is not weakened. Imagery packs stay the way to have imagery offline, are sharper where the customer has them, and draw over the online imagery. The online imagery is never written into a pack, a project or a package.

**Where it draws.** On the 2D map it is imagery like a pack: drawn with the map types Satellite and Satellite only (which it makes a choice at any site, also where no pack covers it), not with Streets. It is the bottom of the satellite stack: under the installed imagery packs and under the project's own orthos, with the street lines and labels above. The Globe does not draw it yet; the provider for it exists (`@aio/globe/view`, `createOnlineSatelliteProvider`) and reads the same `aio://online/` address.
