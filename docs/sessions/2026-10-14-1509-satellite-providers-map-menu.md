---
type: session
date: 2026-10-14-1509
branch: feat/satellite-providers
status: complete
related: [../architecture/adr/0007-globe-architecture.md]
---

# Online satellite maps and one shared Map menu

## What changed

- Landed earlier: `fix/globe-start-view` (#122, main `c0ebe72b`): the Globe opens on the whole Earth, centred over the open project's site, straight down; the session camera restore, Fly to and Show all sites stay.
- `feat/satellite-providers` (16 tasks in parallel subagent batches, each reviewed, plus a whole-branch review on the strongest model and one fix wave). Online map sources: Esri World Imagery (key optional, the default when online maps are first switched on), Mapbox Satellite plus the Streets, Outdoors, Light, Dark and Satellite Streets styles as raster tiles (key required), Sentinel-2 2016 kept.
- Keys live per computer in the OS credential store (`map:esri`, `map:mapbox`) with an in-memory cache in main, never in the renderer, logs or project files. Save and Test check a key with one zoom-0 tile request.
- Every tile goes through the main proxy `aio://online/<sourceId>/z/x/y`; hosts live only in `apps/desktop/src/main/onlineUpstream.ts`. Only Sentinel-2 is cached on disk; Esri and Mapbox sit in an in-memory LRU (their terms). An offline-only workstation fetches nothing.
- One shared "Gallery" Map menu (mockup A): Offline, Online satellite and Mapbox styles, On top switches, a footer with the credit and a Map sources link. It replaces BasemapPicker in the Map view and GlobeMapMenu in the Globe, and is a new Map chip in the 3D scene. Settings gets a Map sources page (Online maps switch, a key row per provider with Test and Remove, a terms note). ADR 0007 amended, data sources, notices and security page updated, one contract-changes row.
- E2E exposed three app bugs, fixed: the Globe rebuilt its layers every render (a new `[]` for packs), menu headings failed axe heading order, focus was lost after the provider notice.

## Why

Online maps were limited to Sentinel-2 2016, too coarse to be useful. The founder asked for sharp satellite imagery from known providers, with keys kept safe, and one menu instead of separate pickers per view.

## How to test

1. Settings, Map sources: switch on Online maps. Esri is chosen; accept the notice that names Esri.
2. Open a project in the Map view, click the map chip at the top right, pick Esri under Online satellite. The imagery is sharp and the credit shows in the menu footer.
3. Settings, Map sources: paste a Mapbox token, click Test (it should say the key works), then save. In the menu the Mapbox styles are enabled. Pick Mapbox Dark: the chip says "Mapbox Dark" and "Improve this map" opens the browser.
4. Globe: open the Map chip, pick Esri, zoom from the whole Earth into the site.
5. 3D scene (Medium graphics or higher): open the new Map chip and pick Esri. The imagery around the site comes from Esri.
6. Turn Wi-Fi off. The online tiles grey out with "Go online to use it" and the map falls back to the offline street map.
7. Remove the Mapbox key. The Mapbox tiles show a "Key" badge and the reason.

## Open threads

- Evidence: `pnpm check` green (7893 tests); CI-like e2e: online-map-sources 5/5 (15/15 repeated), online-satellite 2/2, basemap-picker 5/5, small-window 7/7, globe 19/19, packages-globe 1/1, imagery-packs 2/2, walk-place 4/4.
- Decisions made for the founder, pending review: `online.json` stays version 1 with an optional `source`; an unavailable online source (offline, no key) falls back to the offline street map in every view, not to saved Sentinel-2 tiles; the 3D scene uses an online map only when picked; with online maps on, an imagery pack that does not reach the site is no longer drawn; no Mapbox Standard (the Static Tiles API does not serve it); the Mapbox credit is a text wordmark; the key check is disclosed, not gated.
- Incident: while regenerating the third-party notices an agent junctioned the main venv into the worktree and uv re-pointed the main checkout's editable `aio-pipelines` install at it. The `.pth` and `direct_url.json` were restored and the import path verified. Never junction the main venv into a worktree to run a uv-based generator.
- Follow-ups: the official Mapbox logo asset; no e2e places a walk on the map (Place walk online is unit-tested only); offline-only toggled mid-placement is not picked up; a Sentinel-2 offline Place walk may claim imagery over bare ground; arrow keys move one tile, not by grid row; `contract-changes.md` was re-padded (merge-conflict risk); the plan doc still describes the Sentinel-2 fallback; `test_walk_process` intermittent JSONDecodeError on the "pipelines (rest)" CI job.
- Owed by the founder: try the steps above; get a free ArcGIS Location Platform key for commercial Esri use; review the decisions; say whether to build an installer now (the next one would carry the globe fix, the processing fix and the map sources).

## Next session entry point

After this merges, add the official Mapbox logo and an e2e that places a walk with an online map picked; then continue the existing candidates in the north star.
