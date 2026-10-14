# Online map sources: Esri, Mapbox and one Map menu (design)

|        |                                                       |
| ------ | ----------------------------------------------------- |
| Status | Approved in brainstorming by the founder, 14 Oct 2026 |
| Branch | `feat/satellite-providers`                            |
| Amends | ADR 0007 (online satellite amendment of 10 Oct 2026)  |

## Why

The only online imagery today is Sentinel-2 from 2016, at about 10 m per pixel, which is blurry on any site. The founder wants sharp online imagery (Esri World Imagery, Mapbox) and Mapbox's other looks (Streets, Outdoors, Light, Dark), selectable in the Map view, the Globe and the 3D scene. The map menus have also grown messy: three places, three different structures. They become one shared menu.

## Decisions (founder, 14 Oct 2026)

1. API keys are stored **per computer**, in the OS credential store. They are never kept in project files and never synced or packaged.
2. There is **no Custom tile URL** in this round. Only named providers with fixed hosts.
3. **Esri World Imagery is the default** when online maps are first switched on. A workstation that already had Sentinel-2 switched on keeps it.
4. **Mapbox looks become extra base maps** (Streets, Outdoors, Light, Dark, Satellite Streets, and Standard if the Static Tiles API serves it). They are drawn as raster tiles, so the 2D map, the Globe and the 3D scene show the same thing.
5. The menu uses the **Gallery** layout (mockup A, 14 Oct). Base maps appear as small pictures grouped by source (Offline / Online satellite / Mapbox styles). The "On top" switches sit below them. A footer shows the credit line and a "Map sources" link. The same component is used in all three views.

## Map sources

A catalog in `@aio/schema` (`onlineImagery.ts`, extended). Each source has an id, a group (`offline`, `satellite` or `mapbox`), a label, a host, a key policy (`none`, `optional` or `required`), the attribution, min and max zoom, tile size, the accepted formats (JPEG, PNG, WebP), and whether it may be cached on disk.

| id                                                                                                 | Group     | Key      | Disk cache               | Upstream (main only)                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | --------- | -------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s2cloudless-2016`                                                                                 | satellite | none     | yes (today's 300 MB LRU) | `tiles.maps.eox.at` (unchanged)                                                                                                                                                                                  |
| `esri-world-imagery`                                                                               | satellite | optional | no                       | keyless: `server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`; with a key: `ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=KEY` |
| `mapbox-satellite`                                                                                 | satellite | required | no                       | `api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=KEY`                                                                                                                                       |
| `mapbox-streets`, `-outdoors`, `-light`, `-dark`, `-satellite-streets` (and `-standard` if served) | mapbox    | required | no                       | `api.mapbox.com/styles/v1/mapbox/<style>/tiles/512/{z}/{x}/{y}@2x?access_token=KEY`                                                                                                                              |

The exact style ids, tile sizes and endpoints are confirmed against the providers' current docs during the build.

## Tile flow and security

- The renderer only asks for `aio://online/<sourceId>/<z>/<x>/<y>`. The CSP and `hardenSession` stay unchanged, so the renderer still cannot reach any server.
- `apps/desktop/src/main/onlineTiles.ts` generalises from one source to the catalog:
  - one allowed host per source; nothing outside the catalog;
  - the key is appended in main from the vault;
  - backoff and the missing-tile TTL per source;
  - format sniffing (JPEG, PNG, WebP), with the matching content type;
  - existing behaviour kept: polite client, 4 concurrent requests, 15 s timeout, `redirect: 'error'`, `credentials: 'omit'`, no prefetch.
- Disk cache only for `s2cloudless-2016`. Esri and Mapbox tiles get an in-memory LRU per session (bounded, for example 64 MB), as their terms forbid offline storage.
- Gate order for every request:
  1. online maps off: 403;
  2. bad address or unknown source: 400;
  3. key required but missing: 401;
  4. cache hit (Sentinel-2 only): serve, also when offline-only;
  5. offline-only: 404;
  6. fetch.
- First use of each provider shows the privacy notice, which names that company as the party that sees the areas viewed. A seen flag is kept per provider.

## Keys

- `KeyVault` (`apps/desktop/src/main/keys.ts`) gets map accounts `map:esri` and `map:mapbox`. The AI provider enum stays untouched. The map accounts are a separate, typed set.
- New IPC channels:
  - `mapKeys:status` returns, per provider, whether a key is present (never the key);
  - `mapKeys:set` takes a provider and a key, validates it with one tile request through the same proxy, and stores it only if the request succeeds;
  - `mapKeys:test` takes a provider;
  - `mapKeys:clear` takes a provider.
- The preload allowlist gets these four channels. `diagnostics/redact.ts` redacts `access_token=` and `token=` query values.

## Settings

- `online.json` becomes `aio.online-settings/2`: `{ enabled: boolean, satellite: SourceId }`.
  - A file at version 1 with `satellite: true` migrates to `{ enabled: true, satellite: 's2cloudless-2016' }`.
  - Version 1 with `false`, or no file, gives `{ enabled: false, satellite: 'esri-world-imagery' }`.
  - Offline-only blocks enabling, as today.
- The per-view choice of base map lives in the existing renderer prefs (`siteTiles.ts` `RasterPrefs`, globe settings). It is extended from the fixed set to `streets | natural-earth | <sourceId>`, plus the "street names on top" switch (today's Satellite versus Satellite only).
- Settings, **Map sources** (today's Offline maps page keeps its packs):
  - the master switch "Online maps";
  - one row per provider: status, key field, Test, Remove, and a short note on terms and price;
  - "Clear saved satellite tiles".

## The Map menu

- One component, `MapMenu` (renderer, `apps/desktop/src/renderer/maps/`), built on a pure model `mapMenuModel(view, prefs, sources, packs, online, keys)`. The model decides each tile's state: `available`, `needs-key`, `offline` or `no-pack`, each with its reason.
- Sections:
  - **Offline**: Streets, plus Natural Earth on the Globe.
  - **Online satellite**: Esri, Mapbox, Sentinel-2.
  - **Mapbox styles**.
  - **On top**:
    - street names and roads (over imagery);
    - terrain shading (Map view);
    - imagery packs and orthos with a pack picker;
    - Terrain (Globe);
    - imagery and terrain around the site (3D scene);
    - issues (Globe).
  - **Footer**: the active credit line and a "Map sources" link to Settings.
- The trigger is a chip that shows the current map's picture and name:
  - the existing basemap chip in the Map view;
  - the Globe's Map button;
  - a new chip in the 3D scene, which takes over the ground rows of the "Layers and issue pins" pop.
- Accessibility kept: the dialog role, the focus trap, Esc, focus returning to the chip, a radio group with arrow keys over the tiles, a visible reason on each disabled tile, `forced-colors`, and reduced motion. It fits 1100 x 700 by scrolling inside the pop.
- When the chosen online source is unavailable (offline or no key), the view draws saved Sentinel-2 tiles where they exist, otherwise the offline street map. The chip shows a small "offline map" note.

## Views

- **Map view (MapLibre):** a raster source per online source id in `packages/maps/src/rasterPacks.ts`, at the bottom of the stack as today. Packs and orthos draw above it. The street overlay is optional over imagery. The attribution comes from the catalog.
- **Globe (Cesium):** `OnlineSatelliteImageryProvider` becomes `OnlineTileImageryProvider(sourceId)`. `planGlobeLayers` gets an `online` entry with a source id. The Cesium offline host rewrite (`packages/globe/src/offline.ts`) stays, because every request still goes through `aio://`. The credits come from the catalog.
- **3D scene (three.js):** a `RasterTileSource` over `aio://online/<id>/...` feeds `buildSurroundings`, so "Imagery around the site" can use the chosen online map when no pack covers the site, or when the user picks it.

## Paperwork

- ADR 0007 gets an amendment (14 Oct 2026). Esri and Mapbox are allowed through the main proxy, with no disk cache, keys per computer and per-provider consent. It also fixes the stale line that says the Globe does not draw online imagery.
- `tools/release/data-sources.json`, `docs/release/THIRD-PARTY-NOTICES.md` and `SECURITY-AND-DATA.md` are updated.
- `docs/architecture/contract-changes.md` gets a row for `online.json` version 2, the `mapKeys:*` IPC channels, the catalog exports and the `aio://online/<sourceId>` address.

## Testing

- **Unit:**
  - the catalog (every source has a host, an attribution and a key policy);
  - `upstreamTileUrl` per source;
  - the proxy's gate order, the key added only in main, no disk write for Esri or Mapbox, the in-memory LRU bound, format sniffing;
  - the settings migration from version 1 to 2;
  - the vault map accounts;
  - redaction;
  - `mapMenuModel` states per view;
  - the MapLibre sources;
  - the Globe layer plan;
  - the 3D online tile source.
- **e2e** (fake fetcher, `QUADRION_ONLINE_TILES_TEST`; CI never reaches a provider):
  - pick Esri in the Map view: tiles requested through main and credited;
  - a Mapbox style without a key is greyed with "Add a key in Map sources"; adding a fake key enables it;
  - the Globe picks Esri;
  - the 3D scene's Map chip turns on imagery around the site from Esri;
  - offline-only: online tiles are greyed and main asks nobody;
  - the small-window fit.
- **Existing specs updated for the new menu:** `basemap-picker.spec.ts`, `online-satellite.spec.ts`, `globe.spec.ts` (map menu helpers), `packages-globe.spec.ts` and `small-window.spec.ts`.

## Out of scope

- A Custom tile URL.
- Mapbox vector styles.
- Google or Bing.
- Downloading provider imagery for offline use.
- Per-project keys.
- Any change to the Globe's opening camera (separate branch `fix/globe-start-view`).
