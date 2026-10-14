# Online Map Sources (Esri, Mapbox) and One Map Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add sharp online base maps (Esri World Imagery, Mapbox Satellite and four Mapbox styles plus Satellite Streets) beside Sentinel-2, streamed only through main with per-computer keys, and replace the three map menus with one shared Gallery-style `MapMenu` in the Map view, the Globe and the 3D scene.

**Architecture:** `@aio/schema` gains one catalog of online sources (`ONLINE_SOURCES`, no server named) and the base map id type. Main owns every upstream address in one module (`onlineUpstream.ts`), adds the key from the OS credential store, and generalises the `aio://online/<id>/<z>/<x>/<y>` proxy: per-source backoff, format sniffing, a disk cache for Sentinel-2 only and a bounded in-memory LRU for the others. The renderer builds every menu from one pure model (`mapMenuModel`) and one presentational component (`MapMenu`); each view has a thin adapter that reads and writes its own prefs. MapLibre, Cesium and three.js each get a raster source over the same `aio://online/` address.

**Tech Stack:** TypeScript strict, zod 4 (`@aio/schema`), Electron main (`session.fetch`, `@napi-rs/keyring`), React 19 + zustand (renderer), MapLibre GL (`@aio/maps`), CesiumJS (`@aio/globe`), three.js (`@aio/tiles`), Vitest (unit, jsdom for components), Playwright + Electron (e2e).

**Spec:** `docs/plans/2026-10-14-satellite-providers-design.md` (approved by the founder, 14 Oct 2026). Executors read both.

## Global Constraints

- API keys are stored per computer in the OS credential store (`KeyVault`, accounts `map:esri` and `map:mapbox`); never in project files, never synced, never packaged, never sent to the renderer, never logged.
- No Custom tile URL. Only the named providers with fixed hosts.
- Esri World Imagery is the default online satellite when online maps are first switched on; a workstation that already had Sentinel-2 switched on keeps Sentinel-2.
- Mapbox looks are raster tiles (Static Tiles API), so the 2D map, the Globe and the 3D scene show the same thing. Mapbox Standard is not offered: the Static Tiles API does not serve Standard or Standard Satellite (Mapbox docs, read 14 Oct 2026).
- The renderer only asks `aio://online/<sourceId>/<z>/<x>/<y>`. The CSP (`apps/desktop/src/main/csp.ts`) and `hardenSession` stay unchanged. Nothing the renderer is built from (renderer, preload, `docs/guide`, `packages/*/src`) names an upstream host; `tools/release/check-bundle.mjs` still refuses `arcgisonline.com` and `mapbox.com` in the built renderer, so attribution strings carry no URL.
- Main keeps today's polite client for every source: 4 concurrent requests in total, 15 s timeout, `redirect: 'error'`, `credentials: 'omit'`, no prefetch.
- Disk cache only for `s2cloudless-2016` (300 MB LRU, unchanged). Esri and Mapbox tiles live in an in-memory LRU of 64 MB per session.
- Gate order for every tile: (1) online maps off: 403; (2) bad address or unknown source: 400; (3) key required but missing: 401; (4) Sentinel-2 disk cache hit: serve, also offline-only; (5) offline-only: 404; (6) fetch.
- First use of each provider shows the privacy notice naming that company; the seen flag is per provider.
- `online.json` stays `aio.online-settings/1` (additive, see "Spec deviations"); a v1 file with `satellite: true` reads as `{ enabled: true, source: 's2cloudless-2016' }`, `false` or no file as `{ enabled: false, source: 'esri-world-imagery' }`; offline-only still blocks switching on in the UI.
- The Map menu is the founder-chosen Gallery: a 312 px pop; sections Offline / Online satellite / Mapbox styles, each a 4-column grid of 44 px swatch tiles with labels; a 2 px teal (`--acc`) outline on the selected tile; disabled tiles at reduced opacity with a visible reason; an "On top" section of switches; a footer with the credit line on the left and a "Map sources" link on the right. Dark first, IBM Plex, radii 2/4/6, ease-out-quart (`docs/design/DIRECTION.md`).
- Accessibility kept: dialog role, focus trap, Esc, focus returns to the chip, a radio group with arrow keys over the tiles, a visible reason on each disabled tile, `forced-colors`, reduced motion; the pop fits 1100 x 700 by scrolling inside it.
- When the chosen online source cannot be drawn: offline-only with online maps on draws the saved Sentinel-2 tiles; otherwise (no key, online maps off) the offline street map. The chip shows a small "Offline map" note.
- No change to the Globe's opening camera (`startOf`, `flyToSite`). Branch `fix/globe-start-view` edits `GlobeScreen.tsx` ~81-94, `GlobeView.tsx` ~154-163, `packages/globe/src/camera.ts`, `controller.ts`, `globe.spec.ts` ~1364 and `packages-globe.spec.ts` ~316. Edits to those files here stay minimal and away from those lines.
- No em or en dashes in user-facing text. No client, site, tester or person names in anything committed.
- Out of scope: Custom tile URL, Mapbox vector styles, Google or Bing, downloading provider imagery for offline use, per-project keys, the Globe's opening camera.

**Rules for every task (repeated in each task):** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers` (branch `feat/satellite-providers`); stage by path (never `git add -A`, never `git stash`); Electron windows stay off-screen (the e2e fixtures' isolated `QUADRION_USER_DATA` profile; never launch the app without it); e2e runs the way CI does, from `apps/desktop`: `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp QUADRION_E2E_PYTHON="E:\Dev\AIO Software\python\.venv\Scripts\python.exe" npx playwright test e2e/<spec>.spec.ts --workers=1`; commit messages are conventional and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A Mapbox key removed while a Mapbox map is drawn.** The next tile must answer 401 at once (the memory LRU must not keep serving that provider without a key), and the view falls back to the street map with the "Offline map" note. Pinned in Task 3 (`a removed key stops tiles at once, even ones in memory`) and Task 11 (`falls back to the street map when the key goes`).
2. **Switching offline-only on while Esri is drawn.** Memory tiles must not be served, only Sentinel-2 disk tiles; the view switches to saved Sentinel-2 tiles. Pinned in Task 3 (`offline-only refuses Esri even from memory`) and Task 9 (`offline-only draws saved Sentinel-2 when online maps are on`).
3. **A workstation that had Sentinel-2 on and never opens the new menu.** After the update it still sees Sentinel-2 under its packs on the Map, the Globe and in Place walk, not the street map. Pinned in Task 1 (compat), Task 11 (`legacy Satellite with online on draws the preferred source`) and Task 13 (`globeBaseOf keeps the Satellite look of 0.11`).
4. **An ArcGIS error that comes back as HTTP 200 with a JSON body, and an HTML error page with an image content type.** Neither may be cached or drawn, and a key check must call it refused. Pinned in Task 3 (`a 200 that is not an image is a failure` and `probe calls a JSON 200 refused`).
5. **The key leaking out of main.** The token must never reach the renderer DOM, its resource timing entries, a log line or a diagnostics bundle. Pinned in Task 4 (redaction of Mapbox and Esri key shapes), Task 5 (`status never carries a key`) and Task 16 (`the token never reaches the page`).

## Spec deviations (decided while planning; flag to the founder at plan review)

1. **`online.json` stays at version 1, additive.** The spec asked for `aio.online-settings/2`. `docs/release/UPGRADE-POLICY.md` (rule 2: fields are only added as optional; rule 4: a `/2` needs a migrator, an Upgrade dialog and a backup) and `packages/schema/src/versions.test.ts` ("each at version 1 in 1.x") make a `/2` a policy change. The same behaviour comes from one optional field: `satellite` keeps meaning "online maps on" (0.11 reads it) and `source?: OnlineSourceId` is added. A file without `source` reads as Sentinel-2 when on and Esri when off, exactly the spec's migration. A downgraded 0.11 build keeps working: it sees `satellite: true` and streams Sentinel-2 after its own notice.
2. **Hosts are not in the schema catalog.** The spec lists a host per catalog entry, but `onlineTiles.test.ts` requires that nothing under `packages/*/src` names a tile service. The catalog in `@aio/schema` carries everything except the upstream; main's `onlineUpstream.ts` is the one catalog of endpoints, keyed by the same ids and type-checked to cover every id.
3. **Tile states.** The spec's `no-pack` state belongs to the On top rows (imagery packs, terrain shading), not to base map tiles. Tiles use `available`, `needs-key`, `offline` and `tier` (the 3D scene needs Medium graphics for imagery around the site).
4. **Address without extension.** New addresses are `aio://online/<id>/<z>/<x>/<y>`; main still answers the 0.11 form `s2cloudless-2016/<z>/<x>/<y>.jpg` for Sentinel-2 only.
5. **3D scene with an online base.** When the scene's base is an online source, the imagery around the site comes from that source alone (packs are not mixed into the same texture: their tile sizes differ). Imagery packs around the site stay the On top switch for the street base.

## File Structure

Created:

| File                                                                          | Responsibility                                                                   |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/schema/src/onlineImagery.test.ts`                                   | catalog and settings helpers                                                     |
| `tools/compat/online-sources-additive.test.mjs`                               | `online.json` and `globe.json` stay readable by 0.11                             |
| `apps/desktop/src/main/onlineUpstream.ts` (+ `.test.ts`)                      | the one place that names upstream hosts and builds upstream URLs                 |
| `apps/desktop/src/main/onlineMemory.ts` (+ `.test.ts`)                        | bounded in-memory LRU of tiles                                                   |
| `apps/desktop/src/main/onlineMaps.ts` (+ `.test.ts`)                          | map key cache and the `mapKeys:*` IPC                                            |
| `packages/tiles/src/online.ts` (+ `.test.ts`)                                 | `RasterTileSource` over `aio://online/<id>` for the 3D scene                     |
| `packages/globe/src/view/onlineTiles.ts`                                      | Cesium `OnlineTileImageryProvider(sourceId)` (renamed from `onlineSatellite.ts`) |
| `apps/desktop/src/renderer/maps/mapMenuModel.ts` (+ `.test.ts`)               | pure menu model: tile states, On top rows, drawn base, credit                    |
| `apps/desktop/src/renderer/maps/MapSwatch.tsx`                                | the 44 px pictures of each base map                                              |
| `apps/desktop/src/renderer/maps/MapMenu.tsx` (+ `.test.tsx`)                  | the shared chip and Gallery pop                                                  |
| `apps/desktop/src/renderer/maps/mapMenu.css`                                  | Gallery styles                                                                   |
| `apps/desktop/src/renderer/workspace/MapMenus.tsx` (+ `.test.tsx`)            | Map view and 3D scene adapters                                                   |
| `apps/desktop/src/renderer/globe/globeBase.ts` (+ `.test.ts`)                 | Globe base map from `globe.json` and back                                        |
| `apps/desktop/src/renderer/globe/GlobeMenu.tsx`                               | Globe adapter                                                                    |
| `apps/desktop/src/renderer/screens/settings/mapSourcesView.ts` (+ `.test.ts`) | pure rows of Settings, Map sources                                               |
| `apps/desktop/src/renderer/screens/settings/MapSources.tsx`                   | Settings, Map sources page                                                       |
| `apps/desktop/e2e/online-map-sources.spec.ts`                                 | new end to end spec                                                              |

Deleted: `apps/desktop/src/renderer/workspace/BasemapPicker.tsx`, `BasemapPicker.test.tsx`, `apps/desktop/src/renderer/globe/GlobeMapMenu.tsx`.

## Execution DAG

| Task                                   | Depends on    | Packages touched                                                                                                             |
| -------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1 Contract: catalog, settings, IPC     | none          | `@aio/schema`, `tools/compat`, `apps/desktop` (preload, main `onlineSettings.ts`, `index.ts`, renderer `siteTiles.ts`), docs |
| 2 Upstream endpoints in main           | 1             | `apps/desktop` (main)                                                                                                        |
| 3 Proxy generalised                    | 1, 2, 4       | `apps/desktop` (main)                                                                                                        |
| 4 Map key vault and redaction          | 1             | `apps/desktop` (main)                                                                                                        |
| 5 Map keys IPC and wiring              | 3, 4          | `apps/desktop` (main)                                                                                                        |
| 6 MapLibre online sources              | 1             | `@aio/maps`, `apps/desktop` (a type-only fix in `basemap.ts`)                                                                |
| 7 Globe online provider, plan, credits | 1             | `@aio/globe`, `apps/desktop` (one line of `GlobeScreen.tsx`)                                                                 |
| 8 3D online tile source                | 1             | `@aio/tiles`                                                                                                                 |
| 9 Menu model and strings               | 1             | `apps/desktop` (renderer/maps), `@aio/ui` (`en.ts`)                                                                          |
| 10 MapMenu component                   | 9             | `apps/desktop` (renderer/maps)                                                                                               |
| 11 Renderer online state               | 1, 6, 8, 9    | `apps/desktop` (renderer/workspace)                                                                                          |
| 12 Map view and 3D scene menus         | 10, 11, 14    | `apps/desktop` (renderer/workspace, shell)                                                                                   |
| 13 Globe menu                          | 7, 10, 11, 14 | `apps/desktop` (renderer/globe)                                                                                              |
| 14 Settings, Map sources               | 1, 9          | `apps/desktop` (renderer/screens, store)                                                                                     |
| 15 Paperwork                           | 1             | docs, `tools/release`                                                                                                        |
| 16 End to end and cleanup              | all           | `apps/desktop` (e2e, renderer), `@aio/ui` (`en.ts`)                                                                          |

Parallel batches (tasks in a batch share no file; dispatch each batch in one message):

- **Batch 1:** Task 1.
- **Batch 2:** Tasks 2, 4, 6, 7, 8, 9, 15.
- **Batch 3:** Tasks 3, 10, 11, 14.
- **Batch 4:** Tasks 5, 12, 13.
- **Batch 5:** Task 16.

File ownership inside batches (checked): Batch 2: Task 2 owns `main/onlineUpstream.*` and the two-line edits of `main/onlineTiles.ts`/`.test.ts`; Task 4 owns `main/keys.*`, `main/testVault.ts`, `main/diagnostics/redact.*`; Task 6 `packages/maps/src/rasterPacks.*` and the type-only fix in `renderer/workspace/basemap.ts`/`.test.ts`; Task 7 `packages/globe/src/**` and `GlobeScreen.tsx` line ~515; Task 8 `packages/tiles/src/**`; Task 9 `renderer/maps/mapMenuModel.*` and `packages/ui/src/i18n/en.ts`; Task 15 `docs/architecture/adr/0007-*`, `docs/release/*`, `tools/release/data-*`. Batch 3: Task 3 `main/onlineTiles.*`, `main/onlineMemory.*`, `main/index.ts`; Task 10 `renderer/maps/MapMenu*`, `MapSwatch.tsx`, `mapMenu.css`; Task 11 `renderer/workspace/{siteTiles,basemap,onlineSatellite,OnlineSatelliteNotice,siteBasemap}.*`; Task 14 `renderer/screens/**`, `renderer/store.ts`. Batch 4: Task 5 `main/onlineMaps.*`, `main/index.ts`; Task 12 `renderer/workspace/{MapMenus,BasemapPicker,StageTools,Stage,basemap,basemapPicker.css}*`, `renderer/shell/Palette.tsx`; Task 13 `renderer/globe/**`.

**Critical path:** Task 1 → Task 2 → Task 3 → Task 5 → Task 16, in parallel with Task 1 → Task 9 → Task 10 → Task 12 → Task 16. Five batches; the longest single tasks on it are 3 (proxy) and 12 (view adapters).

## Contract change

`@aio/schema` changes (Task 1), all in `onlineImagery.ts`, `globe.ts` and `ipc.ts`:

- New: `ONLINE_SOURCE_IDS`, `OnlineSourceId`, `OnlineSource`, `OnlineProvider`, `OnlineSourceGroup`, `KeyPolicy`, `TileFormat`, `ONLINE_SOURCES`, `DEFAULT_ONLINE_SOURCE`, `onlineSource`, `onlineTileTemplate`, `onlineTileUrl`, `OnlineState`, `onlineState`, `OnlineAvailability`, `onlineAvailability`, `BaseMapId`, `isOnlineBase`, `MAP_KEY_PROVIDERS`, `MapKeyProvider`, `MapKeysStatus`.
- `OnlineSettings` gains optional `source` (`.catch(undefined)`); `satellite` now means "online maps on". Still `aio.online-settings/1`.
- `OnlineTilesStatus` becomes `{ enabled, source, cache }`.
- `GlobeSettings` gains optional `base` and `packs`.
- IPC: `onlineTiles:setSatellite` removed, `onlineTiles:set` added; `mapKeys:status`, `mapKeys:set`, `mapKeys:test`, `mapKeys:clear` added.
- Kept unchanged for 0.11 compatibility: `ONLINE_SATELLITE`, `onlineSatelliteTileUrl`, `onlineSatelliteAvailability`, `onlineSatelliteOn`.

Row to append to the table in `docs/architecture/contract-changes.md` (exact text, one line):

```markdown
| 2026-10-14 | Online map sources (plan `2026-10-14-satellite-providers`; ADR 0007, amendment of 14 Oct 2026). `onlineImagery.ts` gains the catalog `ONLINE_SOURCES` (`OnlineSource`: `id`, `group` `satellite` \| `mapbox`, `provider` `eox` \| `esri` \| `mapbox`, `keyProvider?`, `label`, `attribution`, `licence`, `keyPolicy` `none` \| `optional` \| `required`, `minZoom`, `maxZoom`, `tileSize`, `imagePx`, `formats`, `diskCache`, `imagery`, `labels`; it names no server), `ONLINE_SOURCE_IDS`/`OnlineSourceId` (`esri-world-imagery`, `mapbox-satellite`, `s2cloudless-2016`, `mapbox-streets`, `mapbox-outdoors`, `mapbox-light`, `mapbox-dark`, `mapbox-satellite-streets`), `DEFAULT_ONLINE_SOURCE`, `onlineSource`, `onlineTileTemplate`, `onlineTileUrl`, `onlineState`, `onlineAvailability`, `BaseMapId` (`streets`, `natural-earth` or a source id), `isOnlineBase`, `MAP_KEY_PROVIDERS`/`MapKeyProvider` (`esri`, `mapbox`) and `MapKeysStatus`. The `aio://online/<sourceId>/<z>/<x>/<y>` address serves every source (main still answers the 0.11 form `s2cloudless-2016/<z>/<x>/<y>.jpg`). userData `online.json` stays `aio.online-settings/1` and gains optional `source` (an unknown id reads as absent); `satellite` now means "online maps on"; a file without `source` reads as Sentinel-2 when on and Esri World Imagery when off. `GlobeSettings` gains optional `base` (`BaseMapId`) and `packs` (boolean), both `.catch(undefined)`; `style` is still written for older builds. IPC: `onlineTiles:status` answers `{ enabled, source, cache }` (was `{ satellite, cache }`); `onlineTiles:setSatellite` is replaced by `onlineTiles:set` (`{ enabled?, source? }` to `{ ok, enabled, source }` or a failure); new `mapKeys:status` (`{}` to `{ esri, mapbox }`, never a key), `mapKeys:set` (`{ provider, key }`, checked with one tile request through main before it is stored), `mapKeys:test` (`{ provider }`) and `mapKeys:clear` (`{ provider }`), each answering `OkOrFailure`. Files additive (`tools/compat/online-sources-additive.test.mjs`); the IPC change is internal to one build |
```

## Tests per task (summary)

| Task | Unit tests                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `packages/schema/src/onlineImagery.test.ts`, `tools/compat/online-sources-additive.test.mjs`, `apps/desktop/src/main/onlineSettings.test.ts` (rewritten) |
| 2    | `apps/desktop/src/main/onlineUpstream.test.ts`                                                                                                           |
| 3    | `apps/desktop/src/main/onlineTiles.test.ts` (updated and extended), `onlineMemory.test.ts`                                                               |
| 4    | `apps/desktop/src/main/keys.test.ts`, `apps/desktop/src/main/diagnostics/redact.test.ts`                                                                 |
| 5    | `apps/desktop/src/main/onlineMaps.test.ts`                                                                                                               |
| 6    | `packages/maps/src/rasterPacks.test.ts`                                                                                                                  |
| 7    | `packages/globe/src/look.test.ts`, `packages/globe/src/globe.test.ts`                                                                                    |
| 8    | `packages/tiles/src/online.test.ts`, `packages/tiles/src/surroundings.test.ts`                                                                           |
| 9    | `apps/desktop/src/renderer/maps/mapMenuModel.test.ts`                                                                                                    |
| 10   | `apps/desktop/src/renderer/maps/MapMenu.test.tsx`                                                                                                        |
| 11   | `apps/desktop/src/renderer/workspace/basemap.test.ts`, `siteTiles.test.ts`, `onlineSatellite.test.ts`                                                    |
| 12   | `apps/desktop/src/renderer/workspace/MapMenus.test.tsx`, `basemap.test.ts`                                                                               |
| 13   | `apps/desktop/src/renderer/globe/globeBase.test.ts`, `GlobeScreen.test.tsx`                                                                              |
| 14   | `apps/desktop/src/renderer/screens/settings/mapSourcesView.test.ts`                                                                                      |
| 15   | `tools/release/data-licences.test.mjs`, `tools/release/notices.test.mjs`                                                                                 |

**End to end specs.** Added: `apps/desktop/e2e/online-map-sources.spec.ts`. Changed: `basemap-picker.spec.ts`, `online-satellite.spec.ts`, `globe.spec.ts` (map menu helpers ~603-634, online tests ~1930-2023), `packages-globe.spec.ts` (~330-342), `small-window.spec.ts` (~363-379). All run in Task 16 the way CI runs them, after `pnpm demo:build --quick`.

---

### Task 1: Contract: online source catalog, settings and IPC

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it (not needed in this task); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Packages:** `@aio/schema`, `tools/compat`, `apps/desktop` (preload, main, one renderer file), docs.

**Files:**

- Modify: `packages/schema/src/onlineImagery.ts` (append the catalog; change `OnlineSettings`, `OnlineTilesStatus`)
- Create: `packages/schema/src/onlineImagery.test.ts`
- Modify: `packages/schema/src/globe.ts` (`GlobeSettings`, around L157-182)
- Modify: `packages/schema/src/ipc.ts:59` (import) and `:2546-2556` (channels)
- Create: `tools/compat/online-sources-additive.test.mjs`
- Modify: `apps/desktop/src/preload/index.ts:202-204`
- Modify: `apps/desktop/src/main/onlineSettings.ts` (whole file), `apps/desktop/src/main/onlineSettings.test.ts` (whole file)
- Modify: `apps/desktop/src/main/index.ts:471-476`, `:1639-1644`
- Modify: `apps/desktop/src/renderer/workspace/siteTiles.ts:163-196`, `apps/desktop/src/renderer/workspace/siteTiles.test.ts:50-90`
- Modify: `docs/architecture/contract-changes.md` (append the row from the plan's "Contract change" section)

**Interfaces:**

- Consumes: nothing new.
- Produces (exact, used by every later task):
  - `ONLINE_SOURCE_IDS: readonly ['esri-world-imagery','mapbox-satellite','s2cloudless-2016','mapbox-streets','mapbox-outdoors','mapbox-light','mapbox-dark','mapbox-satellite-streets']`, `OnlineSourceId` (zod enum + type)
  - `MAP_KEY_PROVIDERS`, `MapKeyProvider` (`'esri' | 'mapbox'`), `OnlineProvider` (`'eox' | 'esri' | 'mapbox'`)
  - `interface OnlineSource { id; group: 'satellite' | 'mapbox'; provider: OnlineProvider; keyProvider?: MapKeyProvider; label: string; attribution: string; licence: string; keyPolicy: 'none' | 'optional' | 'required'; minZoom: number; maxZoom: number; tileSize: number; imagePx: number; formats: readonly ('jpeg' | 'png' | 'webp')[]; diskCache: boolean; imagery: boolean; labels: boolean }`
  - `ONLINE_SOURCES: readonly OnlineSource[]`, `DEFAULT_ONLINE_SOURCE: OnlineSourceId` (`'esri-world-imagery'`)
  - `onlineSource(id: string): OnlineSource | undefined`
  - `onlineTileTemplate(id: OnlineSourceId): string` (`aio://online/<id>/{z}/{x}/{y}`), `onlineTileUrl(id, z, x, y): string`
  - `interface OnlineState { enabled: boolean; source: OnlineSourceId }`, `onlineState(s: { satellite?: boolean; source?: OnlineSourceId }): OnlineState`
  - `type OnlineAvailability = 'off' | 'online' | 'cached' | 'offline'`, `onlineAvailability(source: Pick<OnlineSource,'diskCache'>, switches: { enabled: boolean; offlineOnly: boolean }): OnlineAvailability`
  - `BaseMapId` (zod + type: `'streets' | 'natural-earth' | OnlineSourceId`), `isOnlineBase(id: BaseMapId): id is OnlineSourceId`
  - `MapKeysStatus` (zod + type `{ esri: boolean; mapbox: boolean }`)
  - `OnlineTilesStatus` = `{ enabled: boolean; source: OnlineSourceId; cache: OnlineTileCache }`
  - `GlobeSettings.base?: BaseMapId`, `GlobeSettings.packs?: boolean`
  - IPC `onlineTiles:set` (`{ enabled?: boolean; source?: OnlineSourceId }` to `{ ok: true; enabled; source } | Failure`), `mapKeys:status` (`{}` to `MapKeysStatus`), `mapKeys:set` (`{ provider: MapKeyProvider; key: string (8..512) }` to `OkOrFailure`), `mapKeys:test` and `mapKeys:clear` (`{ provider }` to `OkOrFailure`)
  - main `createOnlineSettingsStore(file)` returning `{ load(): Promise<void>; current(): OnlineState; get(): Promise<OnlineState>; set(patch: IpcRequest<'onlineTiles:set'>): Promise<IpcResponse<'onlineTiles:set'>> }`

- [ ] **Step 1: Write the failing schema test**

Create `packages/schema/src/onlineImagery.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  BaseMapId,
  DEFAULT_ONLINE_SOURCE,
  isOnlineBase,
  MapKeysStatus,
  ONLINE_SATELLITE,
  ONLINE_SOURCE_IDS,
  ONLINE_SOURCES,
  onlineAvailability,
  onlineSource,
  OnlineSettings,
  onlineState,
  onlineTileTemplate,
  onlineTileUrl,
} from './onlineImagery';

describe('the online source catalog', () => {
  it('lists every id once, in the order of the ids', () => {
    expect(ONLINE_SOURCES.map((s) => s.id)).toEqual([...ONLINE_SOURCE_IDS]);
  });

  it('gives every source an attribution, a licence, a key policy and a zoom range', () => {
    for (const s of ONLINE_SOURCES) {
      expect(s.attribution.trim(), s.id).not.toBe('');
      expect(s.licence.trim(), s.id).not.toBe('');
      expect(['none', 'optional', 'required'], s.id).toContain(s.keyPolicy);
      // a source with a key policy names its vault account, and only then
      expect(s.keyPolicy === 'none', s.id).toBe(s.keyProvider === undefined);
      expect(s.minZoom, s.id).toBe(0);
      expect(s.maxZoom, s.id).toBeGreaterThan(s.minZoom);
      expect(s.maxZoom, s.id).toBeLessThanOrEqual(22);
      expect([256, 512], s.id).toContain(s.tileSize);
      expect(s.imagePx, s.id).toBeGreaterThanOrEqual(s.tileSize);
      expect(s.formats.length, s.id).toBeGreaterThan(0);
    }
  });

  it('keeps tiles on disk for Sentinel-2 only: the other terms forbid offline storage', () => {
    expect(ONLINE_SOURCES.filter((s) => s.diskCache).map((s) => s.id)).toEqual([
      's2cloudless-2016',
    ]);
  });

  it('names no tile server: the renderer reads this catalog', () => {
    const text = JSON.stringify(ONLINE_SOURCES);
    for (const host of [
      'tiles.maps.eox.at',
      'arcgisonline.com',
      'arcgis.com',
      'mapbox.com',
      'http://',
    ])
      expect(text).not.toContain(host);
  });

  it('keeps the Sentinel-2 entry in step with the 0.11 description', () => {
    const s2 = onlineSource('s2cloudless-2016');
    expect(s2?.attribution).toBe(ONLINE_SATELLITE.attribution);
    expect(s2?.maxZoom).toBe(ONLINE_SATELLITE.maxZoom);
    expect(s2?.keyPolicy).toBe('none');
  });

  it('marks which pictures carry their own street names', () => {
    const labelled = ONLINE_SOURCES.filter((s) => s.labels).map((s) => s.id);
    expect(labelled).toEqual([
      'mapbox-streets',
      'mapbox-outdoors',
      'mapbox-light',
      'mapbox-dark',
      'mapbox-satellite-streets',
    ]);
    expect(onlineSource('mapbox-satellite-streets')?.imagery).toBe(true);
    expect(onlineSource('mapbox-light')?.imagery).toBe(false);
  });

  it('builds the app own tile addresses', () => {
    expect(onlineTileTemplate('esri-world-imagery')).toBe(
      'aio://online/esri-world-imagery/{z}/{x}/{y}',
    );
    expect(onlineTileUrl('mapbox-streets', 3, 4, 2)).toBe('aio://online/mapbox-streets/3/4/2');
    expect(onlineSource('nope')).toBeUndefined();
  });

  it('takes streets, natural-earth and every source id as a base map, nothing else', () => {
    for (const id of ['streets', 'natural-earth', ...ONLINE_SOURCE_IDS])
      expect(BaseMapId.safeParse(id).success, id).toBe(true);
    expect(BaseMapId.safeParse('satellite').success).toBe(false);
    expect(isOnlineBase('streets')).toBe(false);
    expect(isOnlineBase('natural-earth')).toBe(false);
    expect(isOnlineBase('mapbox-dark')).toBe(true);
    expect(MapKeysStatus.parse({ esri: false, mapbox: true })).toEqual({
      esri: false,
      mapbox: true,
    });
  });
});

describe('online settings (online.json, still aio.online-settings/1)', () => {
  it('keeps Sentinel-2 for a workstation that had it on, and starts others on Esri', () => {
    expect(DEFAULT_ONLINE_SOURCE).toBe('esri-world-imagery');
    expect(onlineState({ satellite: true })).toEqual({ enabled: true, source: 's2cloudless-2016' });
    expect(onlineState({ satellite: false })).toEqual({
      enabled: false,
      source: 'esri-world-imagery',
    });
    expect(onlineState({})).toEqual({ enabled: false, source: 'esri-world-imagery' });
    expect(onlineState({ satellite: true, source: 'mapbox-satellite' })).toEqual({
      enabled: true,
      source: 'mapbox-satellite',
    });
  });

  it('reads a source a later build adds as absent', () => {
    const r = OnlineSettings.parse({
      schema: 'aio.online-settings/1',
      satellite: true,
      source: 'later-source',
    });
    expect(r.source).toBeUndefined();
    expect(onlineState(r)).toEqual({ enabled: true, source: 's2cloudless-2016' });
  });

  it('says per source what main may do', () => {
    const s2 = { diskCache: true };
    const esri = { diskCache: false };
    expect(onlineAvailability(esri, { enabled: false, offlineOnly: false })).toBe('off');
    expect(onlineAvailability(esri, { enabled: true, offlineOnly: false })).toBe('online');
    expect(onlineAvailability(esri, { enabled: true, offlineOnly: true })).toBe('offline');
    expect(onlineAvailability(s2, { enabled: true, offlineOnly: true })).toBe('cached');
    expect(onlineAvailability(s2, { enabled: false, offlineOnly: true })).toBe('off');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run packages/schema/src/onlineImagery.test.ts`
Expected: FAIL, `ONLINE_SOURCE_IDS` (and the other new names) is not exported.

- [ ] **Step 3: Implement the catalog and the settings helpers**

In `packages/schema/src/onlineImagery.ts`, replace the `OnlineSettings` block (from `export const OnlineSettings = z.looseObject({` through the `OnlineSettings` type line) with the block below, and append the catalog after `ONLINE_SATELLITE` (the catalog must come after `ONLINE_SATELLITE`, which it reads; `OnlineSettings` uses `OnlineSourceId`, so put the catalog before the `OnlineSettings` block). Keep `ONLINE_SATELLITE`, `onlineSatelliteOn`, `onlineSatelliteAvailability`, `onlineSatelliteTileUrl` and `OnlineTileCache` unchanged.

```ts
// ----------------------------------------- online map sources (ADR 0007, amendment of 14 Oct 2026)

/**
 * Every online source, in the order the Map menu shows them inside their group. Main serves them
 * at `aio://online/<id>/<z>/<x>/<y>` (`apps/desktop/src/main/onlineTiles.ts`) and is the only
 * place that knows their servers (`onlineUpstream.ts`); nothing here names one.
 */
export const ONLINE_SOURCE_IDS = [
  'esri-world-imagery',
  'mapbox-satellite',
  's2cloudless-2016',
  'mapbox-streets',
  'mapbox-outdoors',
  'mapbox-light',
  'mapbox-dark',
  'mapbox-satellite-streets',
] as const;
export const OnlineSourceId = z.enum(ONLINE_SOURCE_IDS);
export type OnlineSourceId = z.infer<typeof OnlineSourceId>;

/** The vault accounts of map keys (`map:esri`, `map:mapbox`): kept per computer, never synced. */
export const MAP_KEY_PROVIDERS = ['esri', 'mapbox'] as const;
export const MapKeyProvider = z.enum(MAP_KEY_PROVIDERS);
export type MapKeyProvider = z.infer<typeof MapKeyProvider>;

/** The company that sees the areas viewed (the privacy notice names it, one notice each). */
export type OnlineProvider = 'eox' | MapKeyProvider;
export type OnlineSourceGroup = 'satellite' | 'mapbox';
export type KeyPolicy = 'none' | 'optional' | 'required';
export type TileFormat = 'jpeg' | 'png' | 'webp';

export interface OnlineSource {
  id: OnlineSourceId;
  /** The Map menu's section: Online satellite or Mapbox styles. */
  group: OnlineSourceGroup;
  provider: OnlineProvider;
  /** The vault account of its key; absent when the source takes none. */
  keyProvider?: MapKeyProvider;
  label: string;
  /** The credit its terms ask for, shown wherever it is drawn. Never a URL (the bundle check). */
  attribution: string;
  licence: string;
  keyPolicy: KeyPolicy;
  minZoom: number;
  /** The deepest tile asked for; a closer view stretches it. */
  maxZoom: number;
  /** Edge of a tile in CSS pixels (MapLibre's `tileSize`, Cesium's tile width). */
  tileSize: number;
  /** Edge of the picture main answers with (a `@2x` tile is twice `tileSize`). */
  imagePx: number;
  formats: readonly TileFormat[];
  /** May be kept on disk: Sentinel-2 only, the other providers' terms forbid offline storage. */
  diskCache: boolean;
  /** A photo of the ground (street names may go on top), not a drawn map. */
  imagery: boolean;
  /** The picture has its own street names and roads. */
  labels: boolean;
}

const mapboxStyle = (
  id: OnlineSourceId,
  label: string,
  attribution: string,
  imagery: boolean,
): OnlineSource => ({
  id,
  group: 'mapbox',
  provider: 'mapbox',
  keyProvider: 'mapbox',
  label,
  attribution,
  licence: 'LicenseRef-Mapbox-Terms-of-Service',
  keyPolicy: 'required',
  minZoom: 0,
  maxZoom: 20,
  // Static Tiles at 512 px, asked @2x: 1024 px pictures, sharp on a high density screen
  tileSize: 512,
  imagePx: 1024,
  formats: ['png', 'jpeg', 'webp'],
  diskCache: false,
  imagery,
  labels: true,
});

const OSM_STYLE_CREDIT = '© Mapbox © OpenStreetMap';

export const ONLINE_SOURCES: readonly OnlineSource[] = [
  {
    id: 'esri-world-imagery',
    group: 'satellite',
    provider: 'esri',
    keyProvider: 'esri',
    label: 'Esri World Imagery',
    attribution:
      'Powered by Esri. Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    licence: 'LicenseRef-Esri-Terms-of-Use',
    keyPolicy: 'optional',
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    imagePx: 256,
    formats: ['jpeg', 'png'],
    diskCache: false,
    imagery: true,
    labels: false,
  },
  {
    id: 'mapbox-satellite',
    group: 'satellite',
    provider: 'mapbox',
    keyProvider: 'mapbox',
    label: 'Mapbox Satellite',
    attribution: '© Mapbox © Maxar',
    licence: 'LicenseRef-Mapbox-Terms-of-Service',
    keyPolicy: 'required',
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    imagePx: 512,
    formats: ['jpeg'],
    diskCache: false,
    imagery: true,
    labels: false,
  },
  {
    id: 's2cloudless-2016',
    group: 'satellite',
    provider: 'eox',
    label: 'Sentinel-2 cloudless 2016 (EOX)',
    attribution: ONLINE_SATELLITE.attribution,
    licence: ONLINE_SATELLITE.licence,
    keyPolicy: 'none',
    minZoom: ONLINE_SATELLITE.minZoom,
    maxZoom: ONLINE_SATELLITE.maxZoom,
    tileSize: ONLINE_SATELLITE.tileSize,
    imagePx: ONLINE_SATELLITE.tileSize,
    formats: ['jpeg'],
    diskCache: true,
    imagery: true,
    labels: false,
  },
  mapboxStyle('mapbox-streets', 'Mapbox Streets', OSM_STYLE_CREDIT, false),
  mapboxStyle('mapbox-outdoors', 'Mapbox Outdoors', OSM_STYLE_CREDIT, false),
  mapboxStyle('mapbox-light', 'Mapbox Light', OSM_STYLE_CREDIT, false),
  mapboxStyle('mapbox-dark', 'Mapbox Dark', OSM_STYLE_CREDIT, false),
  mapboxStyle(
    'mapbox-satellite-streets',
    'Mapbox Satellite Streets',
    `${OSM_STYLE_CREDIT} © Maxar`,
    true,
  ),
];

const SOURCE_BY_ID = new Map<string, OnlineSource>(ONLINE_SOURCES.map((s) => [s.id, s]));

/** The source with this id, or undefined for anything else. */
export function onlineSource(id: string): OnlineSource | undefined {
  return SOURCE_BY_ID.get(id);
}

/** The online satellite of a workstation that switches online maps on for the first time. */
export const DEFAULT_ONLINE_SOURCE: OnlineSourceId = 'esri-world-imagery';

/** The app's own address of a source's tiles, for MapLibre and the other tile clients. */
export function onlineTileTemplate(id: OnlineSourceId): string {
  return `aio://online/${id}/{z}/{x}/{y}`;
}

/** The app's own address of one tile. */
export function onlineTileUrl(id: OnlineSourceId, z: number, x: number, y: number): string {
  return `aio://online/${id}/${String(z)}/${String(x)}/${String(y)}`;
}

/** What a view draws under everything: the offline street map, Natural Earth or a source. */
export const BaseMapId = z.union([
  z.literal('streets'),
  z.literal('natural-earth'),
  OnlineSourceId,
]);
export type BaseMapId = z.infer<typeof BaseMapId>;

export const isOnlineBase = (id: BaseMapId): id is OnlineSourceId =>
  id !== 'streets' && id !== 'natural-earth';

/** `mapKeys:status`: whether this computer holds a key per provider (never the key). */
export const MapKeysStatus = z.object({ esri: z.boolean(), mapbox: z.boolean() });
export type MapKeysStatus = z.infer<typeof MapKeysStatus>;
```

Replace the `OnlineSettings` definition, its type and add the helpers (keep `defaultOnlineSettings` and `onlineSatelliteOn` as they are):

```ts
export const OnlineSettings = z.looseObject({
  schema: z.literal(ONLINE_SETTINGS_SCHEMA),
  /**
   * Online maps are switched on (14 Oct 2026: every online source, not only Sentinel-2; the name
   * is the one 0.11 reads, so an older build still sees the switch). Absent: off.
   */
  satellite: z.boolean().optional(),
  /**
   * The online satellite this workstation uses (14 Oct 2026, additive). A value this build does
   * not know reads as absent.
   */
  source: OnlineSourceId.optional().catch(undefined),
});
export type OnlineSettings = z.infer<typeof OnlineSettings>;

/** The switch and the source as main uses them. */
export interface OnlineState {
  enabled: boolean;
  source: OnlineSourceId;
}

/**
 * The state a file says. A file written before sources could be chosen has no `source`: a
 * workstation that had Sentinel-2 on keeps it, any other starts on Esri World Imagery.
 */
export function onlineState(s: {
  satellite?: boolean | undefined;
  source?: OnlineSourceId | undefined;
}): OnlineState {
  const enabled = s.satellite === true;
  return { enabled, source: s.source ?? (enabled ? 's2cloudless-2016' : DEFAULT_ONLINE_SOURCE) };
}

/**
 * What main may do for one source: `off` (online maps off), `online` (fetch), `cached` (offline
 * only, but the source keeps tiles on disk: serve those) or `offline` (offline only: nothing).
 */
export type OnlineAvailability = 'off' | 'online' | 'cached' | 'offline';

export function onlineAvailability(
  source: Pick<OnlineSource, 'diskCache'>,
  switches: { enabled: boolean; offlineOnly: boolean },
): OnlineAvailability {
  if (!switches.enabled) return 'off';
  if (!switches.offlineOnly) return 'online';
  return source.diskCache ? 'cached' : 'offline';
}
```

Replace `OnlineTilesStatus`:

```ts
/** `onlineTiles:status`: the switch and the source as main has them, and the Sentinel-2 cache. */
export const OnlineTilesStatus = z.object({
  enabled: z.boolean(),
  source: OnlineSourceId,
  cache: OnlineTileCache,
});
export type OnlineTilesStatus = z.infer<typeof OnlineTilesStatus>;
```

Update the file's top comment: "the online sources (ADR 0007, amendments of 10 and 14 Oct 2026)".

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `pnpm exec vitest run packages/schema/src/onlineImagery.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: GlobeSettings, IPC and the compat test**

In `packages/schema/src/globe.ts` add `import { BaseMapId } from './onlineImagery';` and, inside `GlobeSettings` right after `style`:

```ts
  /**
   * The Globe's base map (14 Oct 2026, additive): the street map, Natural Earth or an online
   * source. Absent: from `style`. `style` is still written, so 0.11 keeps a look it knows.
   */
  base: BaseMapId.optional().catch(undefined),
  /** Imagery packs on top of the base (14 Oct 2026, additive). Absent: on unless `style` is street. */
  packs: z.boolean().optional().catch(undefined),
```

In `packages/schema/src/ipc.ts` change the import at L59 to
`import { MapKeyProvider, MapKeysStatus, OnlineSourceId, OnlineTileCache, OnlineTilesStatus } from './onlineImagery';`
and replace the block L2541-2556 (from the `// --- Online satellite` comment through `'onlineTiles:clearCache'`) with:

```ts
  // ------------------------------------------- Online maps (ADR 0007, amended 10 and 14 Oct 2026)
  /**
   * Whether online maps are switched on and which online satellite this workstation uses
   * (userData `online.json`), and the Sentinel-2 cache. Whether tiles are requested also depends
   * on `Settings.offlineOnly`; main enforces both.
   */
  'onlineTiles:status': { request: Empty, response: OnlineTilesStatus },
  /** Switch online maps on or off, or choose the online satellite. Off counts at once. */
  'onlineTiles:set': {
    request: z
      .object({ enabled: z.boolean().optional(), source: OnlineSourceId.optional() })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), enabled: z.boolean(), source: OnlineSourceId }),
      Failure,
    ]),
  },
  /** **Clear saved satellite tiles**: deletes every Sentinel-2 tile on disk; answers the empty cache. */
  'onlineTiles:clearCache': { request: Empty, response: OnlineTileCache },
  /** Which map keys this computer holds (never a key). */
  'mapKeys:status': { request: Empty, response: MapKeysStatus },
  /** Check a key with one tile request through main, then keep it in the OS credential store. */
  'mapKeys:set': {
    request: z.object({ provider: MapKeyProvider, key: z.string().min(8).max(512) }).strict(),
    response: OkOrFailure,
  },
  /** Check the saved key with one tile request through main. */
  'mapKeys:test': { request: z.object({ provider: MapKeyProvider }).strict(), response: OkOrFailure },
  /** Remove the saved key from the OS credential store. */
  'mapKeys:clear': { request: z.object({ provider: MapKeyProvider }).strict(), response: OkOrFailure },
```

In `apps/desktop/src/preload/index.ts` replace the three `onlineTiles:*` lines (L202-204) with:

```ts
  'onlineTiles:status': true,
  'onlineTiles:set': true,
  'onlineTiles:clearCache': true,
  'mapKeys:status': true,
  'mapKeys:set': true,
  'mapKeys:test': true,
  'mapKeys:clear': true,
```

Create `tools/compat/online-sources-additive.test.mjs`:

```js
// Online map sources (plan 2026-10-14-satellite-providers) are additive, pinned against the 0.11
// schema (tools/compat/schema-0.11):
// - online.json stays aio.online-settings/1; it gains an optional `source`, which 0.11 keeps (its
//   object is loose) and ignores, and `satellite` still switches online imagery on for it;
// - a 0.11 file without `source` keeps Sentinel-2 when it was on and starts on Esri otherwise;
// - globe.json gains optional `base` and `packs`; 0.11 reads the file and keeps the `style` it knows.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v011 from './schema-0.11/index.mjs';

describe('online map sources are additive', () => {
  it('0.11 reads a new online.json and keeps the switch it knows', () => {
    const file = { schema: 'aio.online-settings/1', satellite: true, source: 'esri-world-imagery' };
    expect(current.OnlineSettings.safeParse(file).success).toBe(true);
    const old = v011.OnlineSettings.safeParse(file);
    expect(old.success).toBe(true);
    expect(v011.onlineSatelliteOn(old.data)).toBe(true);
  });

  it('a 0.11 file keeps Sentinel-2 when it was on, and starts on Esri otherwise', () => {
    const on = current.OnlineSettings.parse({ schema: 'aio.online-settings/1', satellite: true });
    expect(current.onlineState(on)).toEqual({ enabled: true, source: 's2cloudless-2016' });
    const off = current.OnlineSettings.parse({ schema: 'aio.online-settings/1' });
    expect(current.onlineState(off)).toEqual({ enabled: false, source: 'esri-world-imagery' });
  });

  it('online.json is still version 1 in the registry', () => {
    expect(current.SCHEMA_REGISTRY.find((e) => e.family === 'aio.online-settings')).toMatchObject({
      version: 1,
      since: '0.11',
    });
  });

  it('0.11 reads a globe.json with a base map and the packs switch', () => {
    const file = {
      schema: 'aio.globe-settings/1',
      style: 'satellite',
      base: 'esri-world-imagery',
      packs: false,
    };
    const now = current.GlobeSettings.safeParse(file);
    expect(now.success).toBe(true);
    expect(now.data?.base).toBe('esri-world-imagery');
    const old = v011.GlobeSettings.safeParse(file);
    expect(old.success).toBe(true);
    expect(old.data.style).toBe('satellite');
    // a base map a later build adds reads as absent here
    expect(current.GlobeSettings.parse({ ...file, base: 'later-map' }).base).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run the compat and schema tests**

Run: `pnpm exec vitest run tools/compat/online-sources-additive.test.mjs packages/schema`
Expected: PASS. (`versions.test.ts` still passes: no registry change.)

- [ ] **Step 7: Write the failing main settings test**

Replace `apps/desktop/src/main/onlineSettings.test.ts` with:

```ts
import { Settings } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOnlineSettingsStore, onlineSettingsPath } from './onlineSettings';

const OFF_ESRI = { enabled: false, source: 'esri-world-imagery' };

describe('online maps switch and source (userData online.json)', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-online-'));
    file = onlineSettingsPath(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lives in its own file, not in settings.json', () => {
    expect(file).toBe(join(dir, 'online.json'));
    for (const key of Object.keys(Settings.shape))
      expect(key.toLowerCase()).not.toContain('online');
  });

  it('is off before the file is read; a 0.11 file that was on keeps Sentinel-2', async () => {
    await writeFile(file, JSON.stringify({ schema: 'aio.online-settings/1', satellite: true }));
    const store = createOnlineSettingsStore(file);
    expect(store.current()).toEqual(OFF_ESRI);
    await store.load();
    expect(store.current()).toEqual({ enabled: true, source: 's2cloudless-2016' });
    expect(await createOnlineSettingsStore(join(dir, 'none.json')).get()).toEqual(OFF_ESRI);
  });

  it('writes the source with every change, so a file that says on never reads as Sentinel-2 by mistake', async () => {
    const store = createOnlineSettingsStore(file);
    expect(await store.set({ enabled: true })).toEqual({
      ok: true,
      enabled: true,
      source: 'esri-world-imagery',
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schema: 'aio.online-settings/1',
      satellite: true,
      source: 'esri-world-imagery',
    });
    expect(await createOnlineSettingsStore(file).get()).toEqual({
      enabled: true,
      source: 'esri-world-imagery',
    });
  });

  it('changes the source alone and keeps the switch', async () => {
    const store = createOnlineSettingsStore(file);
    await store.set({ enabled: true });
    expect(await store.set({ source: 'mapbox-satellite' })).toEqual({
      ok: true,
      enabled: true,
      source: 'mapbox-satellite',
    });
    expect(store.current()).toEqual({ enabled: true, source: 'mapbox-satellite' });
  });

  it('on counts once it is saved; off counts at once', async () => {
    const store = createOnlineSettingsStore(file);
    const on = store.set({ enabled: true });
    expect(store.current().enabled).toBe(false);
    await on;
    expect(store.current().enabled).toBe(true);
    const off = store.set({ enabled: false });
    expect(store.current().enabled).toBe(false);
    await off;
    expect(store.current().enabled).toBe(false);
  });

  it('a quick on then off ends off, also while the on is still being written', async () => {
    const store = createOnlineSettingsStore(file);
    const on = store.set({ enabled: true });
    const off = store.set({ enabled: false });
    await on;
    expect(store.current().enabled).toBe(false);
    await off;
    expect((await createOnlineSettingsStore(file).get()).enabled).toBe(false);
  });

  it('a switch that cannot be saved does not turn it on', async () => {
    await writeFile(join(dir, 'blocker'), 'x');
    const store = createOnlineSettingsStore(join(dir, 'blocker', 'online.json'));
    const r = await store.set({ enabled: true });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain('The online maps setting was not saved');
    expect(store.current().enabled).toBe(false);
  });

  it('keeps fields a newer build of the same version added', async () => {
    await writeFile(file, JSON.stringify({ schema: 'aio.online-settings/1', later: 1 }));
    const store = createOnlineSettingsStore(file);
    await store.set({ enabled: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schema: 'aio.online-settings/1',
      later: 1,
      satellite: true,
      source: 'esri-world-imagery',
    });
  });

  it('reads a file from a newer version as off and never overwrites it', async () => {
    const newer = JSON.stringify({ schema: 'aio.online-settings/2', satellite: true });
    await writeFile(file, newer);
    const store = createOnlineSettingsStore(file);
    expect(await store.get()).toEqual(OFF_ESRI);
    const r = await store.set({ enabled: true });
    expect(r.ok).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(newer);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/main/onlineSettings.test.ts`
Expected: FAIL, `store.current is not a function`.

- [ ] **Step 9: Rewrite the main settings store**

Replace `apps/desktop/src/main/onlineSettings.ts` with:

```ts
import { brand } from '@aio/brand';
import {
  defaultOnlineSettings,
  newerRefusal,
  ONLINE_SETTINGS_FILE,
  OnlineSettings,
  onlineState,
  type IpcRequest,
  type IpcResponse,
  type OnlineState,
} from '@aio/schema';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';

/**
 * Whether the person switched online maps on, and which online satellite this workstation uses
 * (ADR 0007, amendments of 10 and 14 Oct 2026), in userData `online.json`
 * (`aio.online-settings/1`), beside settings.json and not in it. A missing or unreadable file is
 * off; a file from a newer build is read as off and never overwritten.
 *
 * The tile gate (`onlineTiles.ts`) asks `current()` for every tile, so it answers at once:
 * - off until the file has been read;
 * - switching **off** counts from the moment it is asked for, before the file is written;
 * - switching **on** counts once the file is written, so a switch that could not be saved never
 *   lets a request out.
 * The source is written with every change: a file that says on without a source reads as
 * Sentinel-2 (what 0.11 streamed), which must only happen for files 0.11 wrote.
 */
export function onlineSettingsPath(userData: string): string {
  return join(userData, ONLINE_SETTINGS_FILE);
}

export function createOnlineSettingsStore(file: string) {
  let state: OnlineState = onlineState({});
  let loaded: Promise<void> | null = null;
  /** The newest change asked for; an older one still being written does not undo it. */
  let asked = 0;

  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  }

  async function read(): Promise<{ settings: OnlineSettings; newer: string | null }> {
    let raw: unknown;
    try {
      raw = await readJson(file);
    } catch {
      return { settings: defaultOnlineSettings(), newer: null };
    }
    if (raw === undefined) return { settings: defaultOnlineSettings(), newer: null };
    const newer = newerRefusal(raw, brand.productName);
    if (newer) return { settings: defaultOnlineSettings(), newer };
    const parsed = OnlineSettings.safeParse(raw);
    return { settings: parsed.success ? parsed.data : defaultOnlineSettings(), newer: null };
  }

  function load(): Promise<void> {
    loaded ??= serial(async () => {
      const { settings } = await read();
      // a change made while the file was being read wins over what the file said
      if (asked === 0) state = onlineState(settings);
    });
    return loaded;
  }

  return {
    load,
    /** For the tile gate: the switch and the source, right now. */
    current: (): OnlineState => state,
    /** The state once every change asked for so far is written. */
    async get(): Promise<OnlineState> {
      await load();
      await queue;
      return state;
    },
    set(patch: IpcRequest<'onlineTiles:set'>): Promise<IpcResponse<'onlineTiles:set'>> {
      asked += 1;
      const mine = asked;
      // off at once: nothing more is requested from this moment
      if (patch.enabled === false) state = { ...state, enabled: false };
      void load();
      return serial(async () => {
        let next: OnlineState;
        try {
          const { settings, newer } = await read();
          if (newer) return { ok: false, error: newer };
          const was = onlineState(settings);
          next = { enabled: patch.enabled ?? was.enabled, source: patch.source ?? was.source };
          await writeJsonAtomic(
            file,
            OnlineSettings.parse({ ...settings, satellite: next.enabled, source: next.source }),
          );
        } catch (e) {
          return {
            ok: false,
            error: `The online maps setting was not saved: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
        if (mine === asked) state = next;
        return { ok: true, enabled: next.enabled, source: next.source };
      });
    },
  };
}

export type OnlineSettingsStore = ReturnType<typeof createOnlineSettingsStore>;
```

- [ ] **Step 10: Wire the new shapes through main and the one renderer call site**

In `apps/desktop/src/main/index.ts`, inside `createOnlineTiles({ switches: ...` (L472-475) change `satellite: onlineSettings.satellite(),` to `satellite: onlineSettings.current().enabled,`. (Task 3 renames the option.) Replace the three handlers at L1639-1644 with:

```ts
handle('onlineTiles:status', async () => ({
  ...(await onlineSettings.get()),
  cache: await onlineTiles.cache(),
}));
handle('onlineTiles:set', (patch) => onlineSettings.set(patch));
handle('onlineTiles:clearCache', () => onlineTiles.clear());
```

In `apps/desktop/src/renderer/workspace/siteTiles.ts`, in `setOnlineSatellite` replace the two lines

```ts
const r = await bridge.invoke('onlineTiles:setSatellite', { on });
if (!r.ok) return r.error;
get().set({ onlineSatellite: r.satellite });
```

with

```ts
const r = await bridge.invoke('onlineTiles:set', { enabled: on });
if (!r.ok) return r.error;
get().set({ onlineSatellite: r.enabled });
```

and in `refresh()` change `const online = status?.satellite === true;` to `const online = status?.enabled === true;`.

In `apps/desktop/src/renderer/workspace/siteTiles.test.ts`, test `'online satellite is off until main says otherwise, ...'` (L50-90): the mock answers the new channel and shape. Replace the `onlineTiles:setSatellite` branch and the status branch with

```ts
if (channel === 'onlineTiles:set') {
  asked.push(req);
  // the layer must not be on before main has answered
  expect(rasterPacks.getState().prefs.onlineSatellite).toBe(stored);
  stored = req.enabled === true;
  return Promise.resolve({ ok: true, enabled: stored, source: 'esri-world-imagery' });
}
if (channel === 'onlineTiles:status')
  return Promise.resolve({
    enabled: stored,
    source: 'esri-world-imagery',
    cache: { bytes: 0, tiles: 0, capBytes: 1 },
  });
```

change the mock's parameter type to `req: { enabled?: boolean }` and `expect(asked).toEqual([{ on: true }]);` to `expect(asked).toEqual([{ enabled: true }]);`.

Append the contract row (the exact text in the plan's "Contract change" section) as the last line of the table in `docs/architecture/contract-changes.md`.

Note for the reviewer: `e2e/online-satellite.spec.ts` and `e2e/globe.spec.ts` still call `onlineTiles:setSatellite`; Task 16 updates them. No e2e runs before Task 16.

- [ ] **Step 11: Run the tests and the typecheck**

Run: `pnpm exec vitest run apps/desktop/src/main/onlineSettings.test.ts apps/desktop/src/main/onlineTiles.test.ts apps/desktop/src/renderer/workspace packages/schema tools/compat/online-sources-additive.test.mjs`
Expected: PASS.
Run: `pnpm typecheck`
Expected: exit 0.
Run: `pnpm lint` and `pnpm format:check`
Expected: exit 0.

- [ ] **Step 12: Commit**

```bash
git add packages/schema/src/onlineImagery.ts packages/schema/src/onlineImagery.test.ts packages/schema/src/globe.ts packages/schema/src/ipc.ts tools/compat/online-sources-additive.test.mjs apps/desktop/src/preload/index.ts apps/desktop/src/main/onlineSettings.ts apps/desktop/src/main/onlineSettings.test.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/workspace/siteTiles.ts apps/desktop/src/renderer/workspace/siteTiles.test.ts docs/architecture/contract-changes.md
git commit -m "feat(schema): online map source catalog, settings source and map key channels" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Upstream endpoints in main

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it (not needed here); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Packages:** `apps/desktop` (main).

**Files:**

- Create: `apps/desktop/src/main/onlineUpstream.ts`, `apps/desktop/src/main/onlineUpstream.test.ts`
- Modify: `apps/desktop/src/main/onlineTiles.ts:26-53` (remove the host, layer and URL builder; import them), `apps/desktop/src/main/onlineTiles.test.ts:11-153` (imports; move two describes out)

**Interfaces:**

- Consumes: `OnlineSourceId`, `ONLINE_SOURCE_IDS` from Task 1.
- Produces:
  - `ONLINE_SATELLITE_HOST = 'tiles.maps.eox.at'`, `ONLINE_SATELLITE_LAYER = 's2cloudless_3857'`, `ESRI_PUBLIC_HOST = 'server.arcgisonline.com'`, `ESRI_KEY_HOST = 'ibasemaps-api.arcgis.com'`, `MAPBOX_HOST = 'api.mapbox.com'`
  - `ONLINE_HOSTS: Readonly<Record<OnlineSourceId, readonly string[]>>`
  - `MAPBOX_STYLES: { 'mapbox-streets': 'streets-v12'; 'mapbox-outdoors': 'outdoors-v12'; 'mapbox-light': 'light-v11'; 'mapbox-dark': 'dark-v11'; 'mapbox-satellite-streets': 'satellite-streets-v12' }`
  - `upstreamTileUrl(id: OnlineSourceId, z: number, x: number, y: number, key: string | null): string` (throws for a Mapbox source without a key)

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/onlineUpstream.test.ts`:

```ts
/**
 * The one place that names the online map services, and the addresses it builds. No network.
 */
import { ONLINE_SOURCE_IDS } from '@aio/schema';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAPBOX_STYLES,
  ONLINE_HOSTS,
  ONLINE_SATELLITE_HOST,
  ONLINE_SATELLITE_LAYER,
  upstreamTileUrl,
} from './onlineUpstream';

const HOSTS = [...new Set(Object.values(ONLINE_HOSTS).flat())];

describe('the addresses of the services', () => {
  it('Sentinel-2: the one 2016 layer, z/y/x, no key whatever is given', () => {
    const url =
      'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/12/1420/2234.jpg';
    expect(upstreamTileUrl('s2cloudless-2016', 12, 2234, 1420, null)).toBe(url);
    expect(upstreamTileUrl('s2cloudless-2016', 12, 2234, 1420, 'secret')).toBe(url);
    expect(ONLINE_SATELLITE_HOST).toBe('tiles.maps.eox.at');
    // 2016 is the layer without a year; the non-commercial years carry one
    expect(ONLINE_SATELLITE_LAYER).toBe('s2cloudless_3857');
    expect(ONLINE_SATELLITE_LAYER).not.toMatch(/20(1[7-9]|2\d)/);
  });

  it('Esri: the public service without a key, the basemap service with one, z/y/x', () => {
    expect(upstreamTileUrl('esri-world-imagery', 15, 21000, 13000, null)).toBe(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/15/13000/21000',
    );
    expect(upstreamTileUrl('esri-world-imagery', 15, 21000, 13000, 'AAPTabc/+=')).toBe(
      'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/15/13000/21000?token=AAPTabc%2F%2B%3D',
    );
  });

  it('Mapbox Satellite: the raster tiles at 512 px, z/x/y, with the token', () => {
    expect(upstreamTileUrl('mapbox-satellite', 15, 21000, 13000, 'pk.abc')).toBe(
      'https://api.mapbox.com/v4/mapbox.satellite/15/21000/13000@2x.jpg90?access_token=pk.abc',
    );
  });

  it('Mapbox styles: the Static Tiles API at 512 px @2x, with the token', () => {
    expect(MAPBOX_STYLES).toEqual({
      'mapbox-streets': 'streets-v12',
      'mapbox-outdoors': 'outdoors-v12',
      'mapbox-light': 'light-v11',
      'mapbox-dark': 'dark-v11',
      'mapbox-satellite-streets': 'satellite-streets-v12',
    });
    expect(upstreamTileUrl('mapbox-dark', 4, 9, 6, 'pk.abc')).toBe(
      'https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/512/4/9/6@2x?access_token=pk.abc',
    );
  });

  it('never builds a Mapbox address without a key', () => {
    expect(() => upstreamTileUrl('mapbox-streets', 1, 0, 0, null)).toThrow(/needs a key/);
    expect(() => upstreamTileUrl('mapbox-satellite', 1, 0, 0, '')).toThrow(/needs a key/);
  });

  it('every source has its hosts, and every address goes to one of them over https', () => {
    expect(Object.keys(ONLINE_HOSTS).sort()).toEqual([...ONLINE_SOURCE_IDS].sort());
    for (const id of ONLINE_SOURCE_IDS)
      for (const key of [null, 'pk.key-123456']) {
        if (key === null && ONLINE_HOSTS[id].includes('api.mapbox.com')) continue;
        const url = new URL(upstreamTileUrl(id, 3, 4, 2, key));
        expect(url.protocol, id).toBe('https:');
        expect(ONLINE_HOSTS[id], id).toContain(url.host);
        // the key goes in the query only
        if (key) expect(url.pathname, id).not.toContain(key);
      }
  });
});

describe('main owns the network', () => {
  const repo = join(import.meta.dirname, '..', '..', '..', '..');
  // .md too: the guide (docs/guide) is built into the renderer's help
  const SOURCE = /\.(tsx?|mjs|cjs|js|css|html|json|md)$/;
  const TEST = /\.test\.tsx?$/;
  function sources(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap((e) => {
      const p = join(folder, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p);
      return SOURCE.test(e.name) ? [p] : [];
    });
  }
  const names = (file: string) => {
    const text = readFileSync(file, 'utf8');
    return HOSTS.some((h) => text.includes(h)) || text.includes(ONLINE_SATELLITE_LAYER);
  };

  // The credits name products and companies, never a tile service; tests are not built in.
  it('nothing the renderer is built from names a service', () => {
    const folders = [
      join(repo, 'apps', 'desktop', 'src', 'renderer'),
      join(repo, 'apps', 'desktop', 'src', 'preload'),
      join(repo, 'docs', 'guide'),
      ...readdirSync(join(repo, 'packages')).map((name) => join(repo, 'packages', name, 'src')),
    ].filter((f) => existsSync(f));
    expect(folders.length).toBeGreaterThan(10);
    const named = folders
      .flatMap(sources)
      .filter((file) => !TEST.test(file) && names(file))
      .map((file) => relative(repo, file));
    expect(named).toEqual([]);
  });

  it('in main, only this module names them (and tests)', () => {
    const main = join(repo, 'apps', 'desktop', 'src', 'main');
    const named = sources(main)
      .filter((file) => !TEST.test(file) && names(file))
      .map((file) => relative(main, file));
    expect(named).toEqual(['onlineUpstream.ts']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/main/onlineUpstream.test.ts`
Expected: FAIL, cannot find module `./onlineUpstream`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/main/onlineUpstream.ts`:

```ts
/**
 * The addresses of the online map services (ADR 0007, amendments of 10 and 14 Oct 2026): the one
 * place in the app that names them. Main only: the renderer asks `aio://online/<id>/...`, and the
 * catalog in `@aio/schema` (`ONLINE_SOURCES`) names no server. A key is added here, in main, and
 * leaves main only inside the request to its own provider.
 */
import type { OnlineSourceId } from '@aio/schema';

export const ONLINE_SATELLITE_HOST = 'tiles.maps.eox.at';

/**
 * The WMTS layer: Sentinel-2 cloudless **2016** in Web Mercator. In the service's capabilities
 * document (`https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml`, read 10 Oct 2026) the
 * 2016 layer is the one without a year in its identifier; `s2cloudless-2016_3857` does not exist.
 *
 * 2016 only, on purpose: it is released under CC BY 4.0. The 2018 to 2025 layers
 * (`s2cloudless-<year>_3857`) are CC BY-NC-SA 4.0, non-commercial, and must never be used here;
 * 2017 is not cleared for use either. Do not change this id without the founder's decision and
 * an amendment to ADR 0007.
 */
export const ONLINE_SATELLITE_LAYER = 's2cloudless_3857';
const MATRIX_SET = 'GoogleMapsCompatible';

/** Esri World Imagery without a key (the public ArcGIS Online service). */
export const ESRI_PUBLIC_HOST = 'server.arcgisonline.com';
/** Esri World Imagery with an ArcGIS Location Platform key (basemap image tiles). */
export const ESRI_KEY_HOST = 'ibasemaps-api.arcgis.com';
/** Mapbox Raster Tiles and Static Tiles APIs. */
export const MAPBOX_HOST = 'api.mapbox.com';

/** The hosts each source may reach; nothing outside this table is ever asked. */
export const ONLINE_HOSTS: Readonly<Record<OnlineSourceId, readonly string[]>> = {
  's2cloudless-2016': [ONLINE_SATELLITE_HOST],
  'esri-world-imagery': [ESRI_PUBLIC_HOST, ESRI_KEY_HOST],
  'mapbox-satellite': [MAPBOX_HOST],
  'mapbox-streets': [MAPBOX_HOST],
  'mapbox-outdoors': [MAPBOX_HOST],
  'mapbox-light': [MAPBOX_HOST],
  'mapbox-dark': [MAPBOX_HOST],
  'mapbox-satellite-streets': [MAPBOX_HOST],
};

/** The Mapbox style of each style source (Static Tiles API, `mapbox` account styles). */
export const MAPBOX_STYLES = {
  'mapbox-streets': 'streets-v12',
  'mapbox-outdoors': 'outdoors-v12',
  'mapbox-light': 'light-v11',
  'mapbox-dark': 'dark-v11',
  'mapbox-satellite-streets': 'satellite-streets-v12',
} as const;

const n = (v: number) => String(v);

function needKey(key: string | null): string {
  if (!key) throw new Error('This source needs a key');
  return encodeURIComponent(key);
}

/**
 * The service's address of a tile. WMTS and ArcGIS count z/y/x (row before column); Mapbox and
 * the app's own address count z/x/y.
 */
export function upstreamTileUrl(
  id: OnlineSourceId,
  z: number,
  x: number,
  y: number,
  key: string | null,
): string {
  switch (id) {
    case 's2cloudless-2016':
      return `https://${ONLINE_SATELLITE_HOST}/wmts/1.0.0/${ONLINE_SATELLITE_LAYER}/default/${MATRIX_SET}/${n(z)}/${n(y)}/${n(x)}.jpg`;
    case 'esri-world-imagery':
      return key
        ? `https://${ESRI_KEY_HOST}/arcgis/rest/services/World_Imagery/MapServer/tile/${n(z)}/${n(y)}/${n(x)}?token=${encodeURIComponent(key)}`
        : `https://${ESRI_PUBLIC_HOST}/ArcGIS/rest/services/World_Imagery/MapServer/tile/${n(z)}/${n(y)}/${n(x)}`;
    case 'mapbox-satellite':
      return `https://${MAPBOX_HOST}/v4/mapbox.satellite/${n(z)}/${n(x)}/${n(y)}@2x.jpg90?access_token=${needKey(key)}`;
    default:
      return `https://${MAPBOX_HOST}/styles/v1/mapbox/${MAPBOX_STYLES[id]}/tiles/512/${n(z)}/${n(x)}/${n(y)}@2x?access_token=${needKey(key)}`;
  }
}
```

In `apps/desktop/src/main/onlineTiles.ts`: delete `ONLINE_SATELLITE_HOST`, `ONLINE_SATELLITE_LAYER`, `MATRIX_SET` and `upstreamTileUrl` (L26-53), add `import { upstreamTileUrl } from './onlineUpstream';` and in `ask()` change `const url = upstreamTileUrl(t.z, t.x, t.y);` to `const url = upstreamTileUrl(ONLINE_SATELLITE.id, t.z, t.x, t.y, null);`.

In `apps/desktop/src/main/onlineTiles.test.ts`: drop `ONLINE_SATELLITE_HOST`, `ONLINE_SATELLITE_LAYER` and `upstreamTileUrl` from the `./onlineTiles` import and add `import { ONLINE_SATELLITE_HOST } from './onlineUpstream';`; delete the first test of `describe('the address of the service')` (now in `onlineUpstream.test.ts`) and the whole `describe('main owns the network')` block (L116-153). Keep the test "the app's own address names no server and counts z/x/y".

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/main/onlineUpstream.test.ts apps/desktop/src/main/onlineTiles.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/onlineUpstream.ts apps/desktop/src/main/onlineUpstream.test.ts apps/desktop/src/main/onlineTiles.ts apps/desktop/src/main/onlineTiles.test.ts
git commit -m "feat(desktop): one module in main names the online map services" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The online tile proxy serves every source

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it (not needed here); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Packages:** `apps/desktop` (main).

**Files:**

- Create: `apps/desktop/src/main/onlineMemory.ts`, `apps/desktop/src/main/onlineMemory.test.ts`
- Modify: `apps/desktop/src/main/onlineTiles.ts` (options, parse, gate, lanes, sniffing, probe)
- Modify: `apps/desktop/src/main/onlineTiles.test.ts` (fixture shape; new describes)
- Modify: `apps/desktop/src/main/index.ts:471-492` (switches, key)

**Interfaces:**

- Consumes: Task 1 (`onlineSource`, `onlineAvailability`, `OnlineSourceId`, `MapKeyProvider`), Task 2 (`upstreamTileUrl`), Task 4 (`keys.getMapKey(provider): Promise<string | null>` on the vault in `index.ts`).
- Produces:
  - `interface OnlineTilesOptions { switches: () => { enabled: boolean; offlineOnly: boolean }; key: (provider: MapKeyProvider) => Promise<string | null>; cacheDir: () => string; fetch: TileFetch | null; userAgent: string; capBytes?: number; memoryCapBytes?: number; concurrency?: number; timeoutMs?: number; now?: () => number }`
  - `type ProbeResult = 'ok' | 'refused' | 'unreachable' | 'offline-only' | 'no-network'`
  - `interface OnlineTiles { serve(segments: readonly string[], req: Request): Promise<Response>; cache(): Promise<OnlineTileCache>; clear(): Promise<OnlineTileCache>; probe(id: OnlineSourceId, key: string): Promise<ProbeResult> }`
  - `interface TileAddress { id: OnlineSourceId; z: number; x: number; y: number }`, `parseTilePath(segments): TileAddress | null`
  - `sniffImage(b: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null`
  - `x-aio-online` values: `off`, `bad-address`, `no-key`, `offline-only`, `no-network`, `backoff`, `missing`, `cache`, `memory`, `network`
  - `onlineMemory.ts`: `DEFAULT_MEMORY_CAP_BYTES = 64 * 2 ** 20`, `createMemoryTiles(capBytes?)` returning `{ get(key): HeldTile | null; put(key, tile: HeldTile): void; stats(): { bytes: number; tiles: number }; clear(): void }` with `HeldTile = { data: Buffer; type: string }`

- [ ] **Step 1: Write the failing memory test**

Create `apps/desktop/src/main/onlineMemory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryTiles, DEFAULT_MEMORY_CAP_BYTES } from './onlineMemory';

const tile = (size: number) => ({ data: Buffer.alloc(size, 1), type: 'image/png' });

describe('the in-memory tiles of providers that forbid offline storage', () => {
  it('is 64 MB by default', () => {
    expect(DEFAULT_MEMORY_CAP_BYTES).toBe(64 * 2 ** 20);
  });

  it('keeps tiles up to its cap and gives up the one used longest ago', () => {
    const m = createMemoryTiles(300);
    m.put('a', tile(100));
    m.put('b', tile(100));
    m.put('c', tile(100));
    // a is used: b is now the oldest
    expect(m.get('a')?.type).toBe('image/png');
    m.put('d', tile(100));
    expect(m.get('b')).toBeNull();
    expect(m.get('a')).not.toBeNull();
    expect(m.stats()).toEqual({ bytes: 300, tiles: 3 });
  });

  it('replaces a tile in place and never keeps one larger than the cap', () => {
    const m = createMemoryTiles(300);
    m.put('a', tile(100));
    m.put('a', tile(150));
    expect(m.stats()).toEqual({ bytes: 150, tiles: 1 });
    m.put('huge', tile(301));
    expect(m.get('huge')).toBeNull();
    m.clear();
    expect(m.stats()).toEqual({ bytes: 0, tiles: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/main/onlineMemory.test.ts`
Expected: FAIL, cannot find module `./onlineMemory`.

- [ ] **Step 3: Implement the memory LRU**

Create `apps/desktop/src/main/onlineMemory.ts`:

```ts
/**
 * Tiles of the providers whose terms forbid offline storage (Esri, Mapbox; ADR 0007, amendment of
 * 14 Oct 2026), kept in memory for this session only, so panning back over an area does not ask
 * again. Bounded: the tile used longest ago goes first. Nothing is ever written to disk.
 */
export const DEFAULT_MEMORY_CAP_BYTES = 64 * 2 ** 20;

export interface HeldTile {
  data: Buffer;
  /** The content type main answers with (`image/jpeg`, `image/png`, `image/webp`). */
  type: string;
}

export function createMemoryTiles(capBytes = DEFAULT_MEMORY_CAP_BYTES) {
  /** Insertion order is the order of use: the first key is the next to go. */
  const map = new Map<string, HeldTile>();
  let bytes = 0;
  return {
    get(key: string): HeldTile | null {
      const t = map.get(key);
      if (!t) return null;
      map.delete(key);
      map.set(key, t);
      return t;
    },
    put(key: string, tile: HeldTile): void {
      const old = map.get(key);
      if (old) {
        map.delete(key);
        bytes -= old.data.byteLength;
      }
      if (tile.data.byteLength > capBytes) return;
      map.set(key, tile);
      bytes += tile.data.byteLength;
      for (const [k, v] of map) {
        if (bytes <= capBytes) break;
        map.delete(k);
        bytes -= v.data.byteLength;
      }
    },
    stats: () => ({ bytes, tiles: map.size }),
    clear(): void {
      map.clear();
      bytes = 0;
    },
  };
}
```

Run: `pnpm exec vitest run apps/desktop/src/main/onlineMemory.test.ts`
Expected: PASS.

- [ ] **Step 4: Update the proxy test fixture and write the failing new tests**

In `apps/desktop/src/main/onlineTiles.test.ts`:

1. Imports: add `type MapKeyProvider` and `onlineTileUrl` to the `@aio/schema` import; add `sniffImage` to the `./onlineTiles` import.
2. Change `let flags: { satellite: boolean; offlineOnly: boolean };` to `let flags: { enabled: boolean; offlineOnly: boolean };`, add `let keys: Partial<Record<MapKeyProvider, string>> = {};`, and in `beforeEach` set `flags = { enabled: true, offlineOnly: false };` and `keys = {};`. Replace every other `satellite:` inside a `flags = {...}` literal in the file with `enabled:` (the gate tests at L186-262).
3. In `service()` add `key: (p) => Promise.resolve(keys[p] ?? null),` to the options.
4. In `describe('parseTilePath')`: change the expectations to include the id, e.g. `expect(parseTilePath([ID, '12', '2234', '1420.jpg'])).toEqual({ id: ID, z: 12, x: 2234, y: 1420 });` (all three lines), and move `[ID, '3', '4', '2']` out of the `bad` list (the address without an extension is now the canonical one); add `expect(parseTilePath([ID, '3', '4', '2'])).toEqual({ id: ID, z: 3, x: 4, y: 2 });`.
5. Append these describes at the end of the file:

```ts
const png = (size = 80) => {
  const b = Buffer.alloc(size, 9);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
};
const webp = (size = 80) => {
  const b = Buffer.alloc(size, 3);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  return b;
};
const answer =
  (body: Buffer, type: string, status = 200): Answer =>
  () =>
    new Response(new Uint8Array(body), { status, headers: { 'Content-Type': type } });

describe('every source of the catalog', () => {
  it('parses each source with its own zoom range, and the old .jpg only for Sentinel-2', () => {
    expect(parseTilePath(['esri-world-imagery', '19', '0', '0'])).toEqual({
      id: 'esri-world-imagery',
      z: 19,
      x: 0,
      y: 0,
    });
    expect(parseTilePath(['esri-world-imagery', '20', '0', '0'])).toBeNull();
    expect(parseTilePath(['mapbox-dark', '20', '0', '0'])).not.toBeNull();
    expect(parseTilePath(['esri-world-imagery', '3', '4', '2.jpg'])).toBeNull();
    expect(parseTilePath(['mapbox-standard', '3', '4', '2'])).toBeNull();
  });

  it('sniffs JPEG, PNG and WebP, and nothing else', () => {
    expect(sniffImage(jpeg())).toBe('image/jpeg');
    expect(sniffImage(png())).toBe('image/png');
    expect(sniffImage(webp())).toBe('image/webp');
    expect(sniffImage(Buffer.from('{"error":{"code":498}}'))).toBeNull();
    expect(sniffImage(Buffer.from('<html></html>'))).toBeNull();
  });

  it('asks Esri without a key on the public host, with the key on the key host', async () => {
    const { calls, fetch } = recorder();
    const s = service(fetch);
    expect((await ask(s, 'esri-world-imagery/15/21000/13000')).status).toBe(200);
    keys = { esri: 'AAPTkey-0123456789' };
    expect((await ask(s, 'esri-world-imagery/15/21001/13000')).status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/15/13000/21000',
      'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/15/13000/21001?token=AAPTkey-0123456789',
    ]);
    for (const c of calls) {
      expect(c.redirect).toBe('error');
      expect(c.credentials).toBe('omit');
    }
  });

  it('a Mapbox tile without a key is refused with 401, without a request', async () => {
    const { calls, fetch } = recorder();
    const res = await ask(service(fetch), 'mapbox-streets/4/9/6');
    expect(res.status).toBe(401);
    expect(res.headers.get('x-aio-online')).toBe('no-key');
    expect(calls).toEqual([]);
  });

  it('adds the Mapbox key in main and never answers with it', async () => {
    keys = { mapbox: 'pk.secret-token-123' };
    const { calls, fetch } = recorder(answer(png(), 'image/png'));
    const res = await ask(service(fetch), 'mapbox-streets/4/9/6');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(calls[0]?.url).toBe(
      'https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/4/9/6@2x?access_token=pk.secret-token-123',
    );
    expect(JSON.stringify([...res.headers])).not.toContain('pk.secret');
  });

  it('serves WebP with its own content type', async () => {
    keys = { mapbox: 'pk.secret-token-123' };
    const { fetch } = recorder(answer(webp(), 'image/webp'));
    const res = await ask(service(fetch), 'mapbox-light/2/1/1');
    expect(res.headers.get('content-type')).toBe('image/webp');
  });

  it('keeps Esri and Mapbox tiles in memory only: nothing on disk, no second request', async () => {
    keys = { mapbox: 'pk.secret-token-123' };
    const { calls, fetch } = recorder(answer(png(), 'image/png'));
    const s = service(fetch);
    await ask(s, 'mapbox-outdoors/5/10/12');
    const again = await ask(s, 'mapbox-outdoors/5/10/12');
    expect(again.status).toBe(200);
    expect(again.headers.get('x-aio-online')).toBe('memory');
    expect(calls).toHaveLength(1);
    expect(existsSync(join(dir, 'cache', 'mapbox-outdoors'))).toBe(false);
    expect(existsSync(join(dir, 'cache', 'esri-world-imagery'))).toBe(false);
    expect((await s.cache()).tiles).toBe(0);
  });

  it('bounds the memory: the tile used longest ago is asked again', async () => {
    const { calls, fetch } = recorder();
    const s = service(fetch, { memoryCapBytes: 200 });
    for (const x of [1, 2, 3, 4]) await ask(s, `esri-world-imagery/10/${String(x)}/1`);
    await ask(s, 'esri-world-imagery/10/1/1');
    expect(calls).toHaveLength(5);
  });

  it('a removed key stops tiles at once, even ones in memory', async () => {
    keys = { mapbox: 'pk.secret-token-123' };
    const { calls, fetch } = recorder(answer(png(), 'image/png'));
    const s = service(fetch);
    expect((await ask(s, 'mapbox-dark/3/1/1')).status).toBe(200);
    keys = {};
    const res = await ask(s, 'mapbox-dark/3/1/1');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it('offline-only refuses Esri even from memory, and still serves Sentinel-2 from disk', async () => {
    const { calls, fetch } = recorder();
    const s = service(fetch);
    await ask(s, 'esri-world-imagery/10/1/1');
    await ask(s, `${ID}/3/4/2`);
    flags = { enabled: true, offlineOnly: true };
    const esri = await ask(s, 'esri-world-imagery/10/1/1');
    expect(esri.status).toBe(404);
    expect(esri.headers.get('x-aio-online')).toBe('offline-only');
    const s2 = await ask(s, `${ID}/3/4/2`);
    expect(s2.status).toBe(200);
    expect(s2.headers.get('x-aio-online')).toBe('cache');
    expect(calls).toHaveLength(2);
  });

  it('keeps the gate order: off, then the address, then the key', async () => {
    const { calls, fetch } = recorder();
    const s = service(fetch);
    flags = { enabled: false, offlineOnly: false };
    expect((await ask(s, 'mapbox-streets/99/0/0')).status).toBe(403);
    flags = { enabled: true, offlineOnly: false };
    expect((await ask(s, 'mapbox-streets/99/0/0')).status).toBe(400);
    expect((await ask(s, 'mapbox-streets/3/0/0')).status).toBe(401);
    flags = { enabled: true, offlineOnly: true };
    expect((await ask(s, 'mapbox-streets/3/0/0')).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('a 200 that is not an image is a failure: nothing cached, the source backs off', async () => {
    const { calls, fetch, state } = recorder(answer(Buffer.from('<html>busy</html>'), 'image/png'));
    const s = service(fetch);
    const res = await ask(s, 'esri-world-imagery/10/1/1');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-aio-online')).toBe('backoff');
    state.answer = tile();
    expect((await ask(s, 'esri-world-imagery/10/1/2')).headers.get('x-aio-online')).toBe('backoff');
    expect(calls).toHaveLength(1);
  });

  it('backs off per source: a failing Esri does not stop Mapbox', async () => {
    keys = { mapbox: 'pk.secret-token-123' };
    const fetch: TileFetch = (url) =>
      Promise.resolve(
        url.includes('arcgisonline')
          ? new Response(null, { status: 503 })
          : new Response(new Uint8Array(png()), { headers: { 'Content-Type': 'image/png' } }),
      );
    const s = service(fetch);
    expect((await ask(s, 'esri-world-imagery/10/1/1')).headers.get('x-aio-online')).toBe('backoff');
    expect((await ask(s, 'esri-world-imagery/10/1/2')).headers.get('x-aio-online')).toBe('backoff');
    expect((await ask(s, 'mapbox-dark/3/1/1')).status).toBe(200);
  });
});

describe('a key check (probe)', () => {
  it('asks one tile with the key given, and keeps nothing', async () => {
    const { calls, fetch } = recorder(answer(png(), 'image/png'));
    const s = service(fetch);
    expect(await s.probe('mapbox-streets', 'pk.new-token-123')).toBe('ok');
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/0/0/0@2x?access_token=pk.new-token-123',
    ]);
    expect((await s.cache()).tiles).toBe(0);
  });

  it('calls a 401 and a JSON 200 refused, a server error unreachable', async () => {
    const { fetch, state } = recorder(answer(Buffer.alloc(0), 'text/plain', 401));
    const s = service(fetch);
    expect(await s.probe('mapbox-streets', 'pk.bad-token-123')).toBe('refused');
    state.answer = answer(Buffer.from('{"error":{"code":498}}'), 'application/json');
    expect(await s.probe('esri-world-imagery', 'AAPTbad-0123456789')).toBe('refused');
    state.answer = answer(Buffer.alloc(0), 'text/plain', 500);
    expect(await s.probe('esri-world-imagery', 'AAPTbad-0123456789')).toBe('unreachable');
  });

  it('works while online maps are off, never on an offline-only workstation or without a fetcher', async () => {
    const { calls, fetch } = recorder();
    flags = { enabled: false, offlineOnly: false };
    expect(await service(fetch).probe('esri-world-imagery', 'AAPTkey-0123456789')).toBe('ok');
    flags = { enabled: true, offlineOnly: true };
    expect(await service(fetch).probe('esri-world-imagery', 'AAPTkey-0123456789')).toBe(
      'offline-only',
    );
    expect(await service(null).probe('esri-world-imagery', 'AAPTkey-0123456789')).toBe(
      'offline-only',
    );
    flags = { enabled: true, offlineOnly: false };
    expect(await service(null).probe('esri-world-imagery', 'AAPTkey-0123456789')).toBe(
      'no-network',
    );
    expect(calls).toHaveLength(1);
  });

  it('serves the app own new address for Sentinel-2 too', async () => {
    const log: string[] = [];
    const s = service(fakeTileFetch(() => jpeg(60), log));
    const res = await s.serve(
      onlineTileUrl(ID, 11, 1117, 710).slice('aio://online/'.length).split('/'),
      new Request(onlineTileUrl(ID, 11, 1117, 710)),
    );
    expect(res.status).toBe(200);
    expect(log).toHaveLength(1);
  });
});
```

Keep the handler describe's literal EOX URL as it is.

- [ ] **Step 5: Run to verify the new tests fail**

Run: `pnpm exec vitest run apps/desktop/src/main/onlineTiles.test.ts`
Expected: FAIL (`key` is not an option, `parseTilePath` returns no `id`, `probe` is not a function, Esri addresses are refused with 400).

- [ ] **Step 6: Generalise the proxy**

Edit `apps/desktop/src/main/onlineTiles.ts`:

1. Rewrite the top comment to describe every source (one gate, the order of the Global Constraints, disk for Sentinel-2 only, memory for the others, the key added here from the vault).
2. Imports:

```ts
import {
  onlineAvailability,
  onlineSource,
  type MapKeyProvider,
  type OnlineSource,
  type OnlineSourceId,
  type OnlineTileCache,
} from '@aio/schema';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createMemoryTiles, DEFAULT_MEMORY_CAP_BYTES } from './onlineMemory';
import { upstreamTileUrl } from './onlineUpstream';
```

3. Replace `OnlineTilesOptions`, `OnlineTiles`, `TileAddress` and `parseTilePath` with:

```ts
export interface OnlineTilesOptions {
  /**
   * The two switches, read for every tile: `enabled` (online maps on, `onlineSettings.ts`) and
   * `offlineOnly` (`settings.current()`, so offline-only counts from the moment it is asked for).
   */
  switches: () => { enabled: boolean; offlineOnly: boolean };
  /** A provider's key from the vault, or null. Main only: never logged, never answered. */
  key: (provider: MapKeyProvider) => Promise<string | null>;
  /** The folder of the Sentinel-2 tile cache (`<userData>/cache/online-tiles`). */
  cacheDir: () => string;
  /**
   * How to reach the services, or null where the app must never do so (an e2e run without a
   * fake fetcher): Sentinel-2 tiles on disk still serve, everything else is a 404.
   */
  fetch: TileFetch | null;
  /** Names the app to the services, e.g. `Quadrion AI/0.13.0 (...)`. */
  userAgent: string;
  capBytes?: number;
  memoryCapBytes?: number;
  concurrency?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** The answer of a key check: one tile asked with the key given. */
export type ProbeResult = 'ok' | 'refused' | 'unreachable' | 'offline-only' | 'no-network';

export interface OnlineTiles {
  /** Answer `aio://online/<segments>` (the path after the host, decoded). */
  serve(segments: readonly string[], req: Request): Promise<Response>;
  /** The size of the Sentinel-2 cache on disk and its cap. */
  cache(): Promise<OnlineTileCache>;
  /** Delete every saved tile (disk and memory). */
  clear(): Promise<OnlineTileCache>;
  /** Check a key before it is stored (`mapKeys:set`) or again (`mapKeys:test`). */
  probe(id: OnlineSourceId, key: string): Promise<ProbeResult>;
}

export interface TileAddress {
  id: OnlineSourceId;
  z: number;
  x: number;
  y: number;
}

const WHOLE = /^(0|[1-9]\d{0,8})$/;

/**
 * The tile a path names, or null: `<id>/<z>/<x>/<y>` with a catalog id, whole numbers without
 * leading zeros, a zoom the source has and x, y inside it. 0.11's address of Sentinel-2,
 * `<y>.jpg`, is still answered for that source only.
 */
export function parseTilePath(segments: readonly string[]): TileAddress | null {
  if (segments.length !== 4) return null;
  const [id, zs, xs, last] = segments;
  if (id === undefined || zs === undefined || xs === undefined || last === undefined) return null;
  const source = onlineSource(id);
  if (!source) return null;
  const ys = source.id === 's2cloudless-2016' && last.endsWith('.jpg') ? last.slice(0, -4) : last;
  if (!WHOLE.test(zs) || !WHOLE.test(xs) || !WHOLE.test(ys)) return null;
  const z = Number(zs);
  const x = Number(xs);
  const y = Number(ys);
  if (z < source.minZoom || z > source.maxZoom) return null;
  const n = 2 ** z;
  if (x >= n || y >= n) return null;
  return { id: source.id, z, x, y };
}

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

/** The picture's own type from its first bytes; null for anything that is not a tile. */
export function sniffImage(b: Uint8Array): ImageType | null {
  if (b.byteLength > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.byteLength > 8 && sig.every((v, i) => b[i] === v)) return 'image/png';
  const riff = [0x52, 0x49, 0x46, 0x46];
  const wbp = [0x57, 0x45, 0x42, 0x50];
  if (b.byteLength > 12 && riff.every((v, i) => b[i] === v) && wbp.every((v, i) => b[8 + i] === v))
    return 'image/webp';
  return null;
}
```

4. `Refusal` becomes `'off' | 'bad-address' | 'no-key' | 'offline-only' | 'no-network' | 'backoff' | 'missing'`. Replace `tileResponse` and `isJpeg`:

```ts
function tileResponse(
  data: Buffer,
  type: string,
  req: Request,
  from: 'cache' | 'memory' | 'network',
): Response {
  const headers = {
    ...COMMON,
    'Content-Type': type,
    'Content-Length': String(data.byteLength),
    'x-aio-online': from,
  };
  return new Response(req.method === 'HEAD' ? null : new Uint8Array(data), {
    status: 200,
    headers,
  });
}

const isJpeg = (b: Buffer) => sniffImage(b) === 'image/jpeg';
```

`createTileStore` stays as it is (Sentinel-2 on disk, JPEG only).

5. Replace everything from `type Fetched =` to the end of `createOnlineTiles` with:

```ts
type Fetched =
  | { kind: 'tile'; data: Buffer; type: ImageType }
  | { kind: 'missing' }
  | { kind: 'failed'; retryAfterMs?: number };

type Got = { data: Buffer; type: ImageType } | Refusal;

interface Waiting {
  key: string;
  tile: TileAddress;
  secret: string | null;
  done: (r: Got) => void;
}

/** One source's own state: failures in a row, the wait they caused, tiles it does not have. */
interface Lane {
  failures: number;
  blockedUntil: number;
  missing: Map<string, number>;
}

function retryAfter(res: Response): number | undefined {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? v * 1000 : undefined;
}

const accept = (s: OnlineSource) => s.formats.map((f) => `image/${f}`).join(', ');

export function createOnlineTiles(o: OnlineTilesOptions): OnlineTiles {
  const now = o.now ?? Date.now;
  const capBytes = o.capBytes ?? DEFAULT_CACHE_CAP_BYTES;
  const concurrency = Math.max(1, o.concurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const store = createTileStore(() => join(o.cacheDir(), 's2cloudless-2016'), capBytes, now);
  const memory = createMemoryTiles(o.memoryCapBytes ?? DEFAULT_MEMORY_CAP_BYTES);

  const pending = new Map<string, Promise<Got>>();
  const waiting: Waiting[] = [];
  let active = 0;
  const activeBy = new Map<OnlineSourceId, number>();
  const lanes = new Map<OnlineSourceId, Lane>();
  const lane = (id: OnlineSourceId): Lane => {
    let l = lanes.get(id);
    if (!l) {
      l = { failures: 0, blockedUntil: 0, missing: new Map() };
      lanes.set(id, l);
    }
    return l;
  };

  const init = (source: OnlineSource, signal: AbortSignal) => ({
    headers: { 'User-Agent': o.userAgent, Accept: accept(source) },
    // a redirect would let the service send us to another host: an error instead
    redirect: 'error' as const,
    // no cookie is kept or sent: a tile request carries the address of the tile and no more
    credentials: 'omit' as const,
    signal,
  });

  async function ask(
    fetchTile: TileFetch,
    source: OnlineSource,
    t: TileAddress,
    secret: string | null,
  ): Promise<Fetched> {
    let res: Response;
    try {
      res = await fetchTile(
        upstreamTileUrl(t.id, t.z, t.x, t.y, secret),
        init(source, AbortSignal.timeout(timeoutMs)),
      );
    } catch {
      return { kind: 'failed' };
    }
    try {
      if (res.status === 404) return { kind: 'missing' };
      if (res.status !== 200) {
        const wait = retryAfter(res);
        return wait === undefined ? { kind: 'failed' } : { kind: 'failed', retryAfterMs: wait };
      }
      const header = (res.headers.get('content-type') ?? '').toLowerCase();
      const length = Number(res.headers.get('content-length') ?? '0');
      if (!header.startsWith('image/') || length > MAX_TILE_BYTES) return { kind: 'failed' };
      const data = Buffer.from(await res.arrayBuffer());
      const type = sniffImage(data);
      if (data.byteLength > MAX_TILE_BYTES || !type) return { kind: 'failed' };
      if (!source.formats.some((f) => type === `image/${f}`)) return { kind: 'failed' };
      return { kind: 'tile', data, type };
    } catch {
      return { kind: 'failed' };
    } finally {
      if (!res.bodyUsed) await res.body?.cancel().catch(() => undefined);
    }
  }

  function failed(id: OnlineSourceId, retryAfterMs: number | undefined): void {
    const l = lane(id);
    l.failures += 1;
    const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(l.failures - 1, 16));
    const wait = Math.min(Math.max(step, retryAfterMs ?? 0), 2 * BACKOFF_MAX_MS);
    l.blockedUntil = Math.max(l.blockedUntil, now() + wait);
    // nothing of this source that was waiting goes to a service that just failed
    for (let i = waiting.length - 1; i >= 0; i--)
      if (waiting[i]?.tile.id === id) waiting.splice(i, 1)[0]?.done('backoff');
  }

  async function run(fetchTile: TileFetch, w: Waiting): Promise<Got> {
    const source = onlineSource(w.tile.id);
    if (!source) return 'bad-address';
    // a switch may have changed while the tile waited: offline-only stops it here
    const availability = onlineAvailability(source, o.switches());
    if (availability === 'off') return 'off';
    if (availability !== 'online') return 'offline-only';
    const l = lane(source.id);
    if (now() < l.blockedUntil) return 'backoff';
    const r = await ask(fetchTile, source, w.tile, w.secret);
    if (r.kind === 'failed') {
      failed(source.id, r.retryAfterMs);
      return 'backoff';
    }
    l.failures = 0;
    l.blockedUntil = 0;
    if (r.kind === 'missing') {
      if (l.missing.size >= MAX_MISSING) l.missing.clear();
      l.missing.set(w.key, now() + MISSING_TTL_MS);
      return 'missing';
    }
    if (source.diskCache) {
      if (isJpeg(r.data))
        await store.put(diskKey(w.tile), r.data).catch((e: unknown) => {
          console.warn(`Online tile ${w.key} was not cached: ${String(e)}`);
        });
    } else memory.put(w.key, { data: r.data, type: r.type });
    return { data: r.data, type: r.type };
  }

  function pump(fetchTile: TileFetch): void {
    while (active < concurrency) {
      // after a failure a source sends one request at a time until it answers again
      const i = waiting.findIndex(
        (w) => lane(w.tile.id).failures === 0 || (activeBy.get(w.tile.id) ?? 0) === 0,
      );
      if (i < 0) return;
      const [w] = waiting.splice(i, 1);
      if (!w) return;
      active += 1;
      activeBy.set(w.tile.id, (activeBy.get(w.tile.id) ?? 0) + 1);
      void run(fetchTile, w)
        .catch((): Refusal => 'backoff')
        .then((r) => {
          active -= 1;
          activeBy.set(w.tile.id, (activeBy.get(w.tile.id) ?? 1) - 1);
          w.done(r);
          pump(fetchTile);
        });
    }
  }

  function request(fetchTile: TileFetch, key: string, tile: TileAddress, secret: string | null) {
    let p = pending.get(key);
    if (p) return p;
    p = new Promise<Got>((done) => {
      waiting.push({ key, tile, secret, done });
      pump(fetchTile);
      // the view moved on from the tile waiting longest: give it up rather than ask for more
      if (waiting.length > MAX_WAITING) waiting.shift()?.done('backoff');
    }).finally(() => {
      pending.delete(key);
    });
    pending.set(key, p);
    return p;
  }

  const stats = async (): Promise<OnlineTileCache> => ({ ...(await store.stats()), capBytes });

  return {
    async serve(segments, req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(405, 'bad-address');
      const switches = o.switches();
      // 1. the switch first: while it is off nothing is read, cached or asked
      if (!switches.enabled) return refuse(403, 'off');
      // 2. the address
      const tile = parseTilePath(segments);
      const source = tile ? onlineSource(tile.id) : undefined;
      if (!tile || !source) return refuse(400, 'bad-address');
      // 3. the key, from the vault, in main only
      const secret = source.keyProvider ? await o.key(source.keyProvider).catch(() => null) : null;
      if (source.keyPolicy === 'required' && !secret) return refuse(401, 'no-key');
      const key = `${tile.id}/${String(tile.z)}/${String(tile.x)}/${String(tile.y)}`;
      // 4. Sentinel-2 on disk: a local file, so also on an offline-only workstation
      if (source.diskCache) {
        const cached = await store.get(diskKey(tile)).catch(() => null);
        if (cached) return tileResponse(cached, 'image/jpeg', req, 'cache');
      }
      // 5. offline-only: what is on disk and nothing more
      if (switches.offlineOnly) return refuse(404, 'offline-only');
      const held = memory.get(key);
      if (held) return tileResponse(held.data, held.type, req, 'memory');
      // 6. the service
      if (!o.fetch) return refuse(404, 'no-network');
      const l = lane(tile.id);
      const gone = l.missing.get(key);
      if (gone !== undefined) {
        if (now() < gone) return refuse(404, 'missing');
        l.missing.delete(key);
      }
      if (now() < l.blockedUntil) return refuse(404, 'backoff');
      const got = await request(o.fetch, key, tile, secret);
      // 404 for every "no tile now": the client then draws the coarser tile it has, quietly
      return typeof got === 'string'
        ? refuse(got === 'off' ? 403 : 404, got)
        : tileResponse(got.data, got.type, req, 'network');
    },
    cache: stats,
    async clear() {
      await store.clear();
      memory.clear();
      for (const l of lanes.values()) l.missing.clear();
      return stats();
    },
    async probe(id, secret) {
      if (o.switches().offlineOnly) return 'offline-only';
      if (!o.fetch) return 'no-network';
      const source = onlineSource(id);
      if (!source) return 'refused';
      let res: Response;
      try {
        res = await o.fetch(
          upstreamTileUrl(id, 0, 0, 0, secret),
          init(source, AbortSignal.timeout(timeoutMs)),
        );
      } catch {
        return 'unreachable';
      }
      try {
        if ([401, 403, 498, 499].includes(res.status)) return 'refused';
        if (res.status !== 200) return 'unreachable';
        const data = Buffer.from(await res.arrayBuffer());
        // an ArcGIS error comes back as 200 with a JSON body
        return data.byteLength <= MAX_TILE_BYTES && sniffImage(data) ? 'ok' : 'refused';
      } catch {
        return 'unreachable';
      } finally {
        if (!res.bodyUsed) await res.body?.cancel().catch(() => undefined);
      }
    },
  };
}

/** The Sentinel-2 file of a tile on disk, `<z>/<x>/<y>` (the layout 0.11 wrote). */
const diskKey = (t: TileAddress) => `${String(t.z)}/${String(t.x)}/${String(t.y)}`;
```

`fakeTileFetch` stays as it is.

6. In `apps/desktop/src/main/index.ts` (L471-492) change the options: `switches: () => ({ enabled: onlineSettings.current().enabled, offlineOnly: settings.current().offlineOnly === true }),`, add `key: (provider) => keys.getMapKey(provider),` (the `keys` vault defined at L366; Task 4 adds `getMapKey`), and change the user agent to `` `${brand.productName}/${app.getVersion()} (desktop app; online maps)` ``. Update the comment above `onlineSettings` to say "Online maps (ADR 0007, amendments of 10 and 14 Oct 2026)".

- [ ] **Step 7: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/main/onlineTiles.test.ts apps/desktop/src/main/onlineMemory.test.ts apps/desktop/src/main/onlineUpstream.test.ts`
Expected: PASS (all old tests with the fixture changes, plus the new ones).
Run: `pnpm typecheck && pnpm lint`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/onlineMemory.ts apps/desktop/src/main/onlineMemory.test.ts apps/desktop/src/main/onlineTiles.ts apps/desktop/src/main/onlineTiles.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): the online tile proxy serves Esri and Mapbox with keys from the vault" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Map key vault and redaction

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it (not needed here); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Packages:** `apps/desktop` (main).

**Files:**

- Modify: `apps/desktop/src/main/keys.ts`, `apps/desktop/src/main/keys.test.ts`
- Modify: `apps/desktop/src/main/testVault.ts` (add `deletePassword`)
- Modify: `apps/desktop/src/main/diagnostics/redact.ts:56-72` (two patterns), `apps/desktop/src/main/diagnostics/redact.test.ts`

**Interfaces:**

- Consumes: `MapKeyProvider` (Task 1).
- Produces on `KeyVault`: `setMapKey(provider: MapKeyProvider, key: string): Promise<{ ok: boolean }>`, `hasMapKey(provider): Promise<boolean>`, `getMapKey(provider): Promise<string | null>` (main only), `clearMapKey(provider): Promise<{ ok: boolean }>`; `KeyEntry.deletePassword?(): boolean`; vault account names `map:esri`, `map:mapbox`.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/main/keys.test.ts`, give `memoryBackend()`'s entry a delete (`deletePassword: () => store.delete(k),`) and append:

```ts
describe('map keys', () => {
  it('keeps map keys in their own accounts, apart from the AI providers', async () => {
    const b = memoryBackend();
    const vault = createKeyVault('ai.example.app', b.entry);
    expect(await vault.setMapKey('mapbox', '  pk.abc-123456  ')).toEqual({ ok: true });
    expect(b.store.get('ai.example.app/map:mapbox')).toBe('pk.abc-123456');
    expect(await vault.hasMapKey('mapbox')).toBe(true);
    expect(await vault.hasMapKey('esri')).toBe(false);
    expect(await vault.getMapKey('mapbox')).toBe('pk.abc-123456');
    // an AI provider of the same name would never see it
    expect([...b.store.keys()]).toEqual(['ai.example.app/map:mapbox']);
  });

  it('removes a map key, also from a vault that cannot delete', async () => {
    const b = memoryBackend();
    const vault = createKeyVault('svc', b.entry);
    await vault.setMapKey('esri', 'AAPTkey-0123456789');
    expect(await vault.clearMapKey('esri')).toEqual({ ok: true });
    expect(await vault.hasMapKey('esri')).toBe(false);

    const store = new Map<string, string>();
    const noDelete = createKeyVault('svc', (s, a) => ({
      setPassword: (p) => {
        store.set(`${s}/${a}`, p);
      },
      getPassword: () => store.get(`${s}/${a}`) ?? null,
    }));
    await noDelete.setMapKey('esri', 'AAPTkey-0123456789');
    expect(await noDelete.clearMapKey('esri')).toEqual({ ok: true });
    expect(await noDelete.getMapKey('esri')).toBeNull();
  });

  it('a vault that refuses to delete reports it without the key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const vault = createKeyVault('svc', () => ({
      setPassword: () => {
        throw new Error('vault locked');
      },
      getPassword: () => 'pk.still-here-123',
      deletePassword: () => {
        throw new Error('vault locked');
      },
    }));
    expect(await vault.clearMapKey('mapbox')).toEqual({ ok: false });
    expect(warn.mock.calls.flat().join(' ')).not.toContain('pk.still-here');
    warn.mockRestore();
  });
});
```

Append to `apps/desktop/src/main/diagnostics/redact.test.ts` (it already imports `redactText`):

```ts
describe('map keys', () => {
  it('removes Mapbox and Esri keys from text and from tile addresses', () => {
    const mapbox = 'pk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbHh5ejEyMyJ9.AbCdEfGhIjKlMnOpQr';
    const esri = 'AAPTxy1wnqcmgL9a5bXFYzJtL0mN2oP3qR4sT5uV6wX7yZ8';
    const line = `fetch https://tiles.example/x?access_token=${mapbox} and ?token=${esri}; key ${mapbox} ${esri}`;
    const out = redactText(line);
    expect(out).not.toContain(mapbox);
    expect(out).not.toContain(esri);
    expect(out).toContain('access_token=[redacted]');
    expect(out).toContain('token=[redacted]');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/main/keys.test.ts apps/desktop/src/main/diagnostics/redact.test.ts`
Expected: FAIL (`vault.setMapKey is not a function`; the bare keys at the end of the line are not redacted).

- [ ] **Step 3: Implement**

Replace `apps/desktop/src/main/keys.ts` with:

```ts
import type { AiProvider, MapKeyProvider } from '@aio/schema';

/** The slice of `@napi-rs/keyring` Entry the vault uses (injectable for tests). */
export interface KeyEntry {
  setPassword(password: string): void;
  getPassword(): string | null;
  /** Remove the entry (`Entry.deletePassword`); a backend without it gets an empty password. */
  deletePassword?(): boolean;
}

export interface KeyVault {
  setKey(provider: AiProvider, key: string): Promise<{ ok: boolean }>;
  hasKey(provider: AiProvider): Promise<boolean>;
  /** Main process only: never send the result to the renderer or a log. */
  getKey(provider: AiProvider): Promise<string | null>;
  /** Map keys (ADR 0007, amendment of 14 Oct 2026): accounts `map:esri`, `map:mapbox`. */
  setMapKey(provider: MapKeyProvider, key: string): Promise<{ ok: boolean }>;
  hasMapKey(provider: MapKeyProvider): Promise<boolean>;
  /** Main process only: never send the result to the renderer or a log. */
  getMapKey(provider: MapKeyProvider): Promise<string | null>;
  clearMapKey(provider: MapKeyProvider): Promise<{ ok: boolean }>;
}

const mapAccount = (provider: MapKeyProvider) => `map:${provider}`;

/**
 * API keys in the OS credential vault (Windows Credential Manager, macOS Keychain, Secret
 * Service): service = brand app id, account = provider (`map:<provider>` for map keys, a set of
 * its own beside the AI providers). Errors are logged without the key.
 */
export function createKeyVault(
  service: string,
  entry: (service: string, account: string) => KeyEntry,
): KeyVault {
  function read(account: string): string | null {
    try {
      const v = entry(service, account).getPassword();
      return v === null || v === '' ? null : v;
    } catch (e) {
      console.warn(`Key vault: could not read the ${account} key (${errorName(e)}).`);
      return null;
    }
  }
  function write(account: string, key: string): { ok: boolean } {
    try {
      entry(service, account).setPassword(key.trim());
      return { ok: true };
    } catch (e) {
      console.warn(`Key vault: could not store the ${account} key (${errorName(e)}).`);
      return { ok: false };
    }
  }
  function remove(account: string): { ok: boolean } {
    const e = entry(service, account);
    try {
      e.deletePassword?.();
    } catch {
      // no entry to delete, or a backend that refuses: the empty password below decides
    }
    if (read(account) === null) return { ok: true };
    try {
      e.setPassword('');
    } catch (err) {
      console.warn(`Key vault: could not remove the ${account} key (${errorName(err)}).`);
    }
    return { ok: read(account) === null };
  }
  return {
    setKey: (provider, key) => Promise.resolve(write(provider, key)),
    hasKey: (provider) => Promise.resolve(read(provider) !== null),
    getKey: (provider) => Promise.resolve(read(provider)),
    setMapKey: (provider, key) => Promise.resolve(write(mapAccount(provider), key)),
    hasMapKey: (provider) => Promise.resolve(read(mapAccount(provider)) !== null),
    getMapKey: (provider) => Promise.resolve(read(mapAccount(provider))),
    clearMapKey: (provider) => Promise.resolve(remove(mapAccount(provider))),
  };
}

/** Error class and message only; OS vault messages never contain the secret. */
function errorName(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error';
}
```

In `apps/desktop/src/main/testVault.ts`, in the returned entry add:

```ts
      deletePassword: () => {
        const values = load();
        const had = key in values;
        delete values[key];
        save(values);
        return had;
      },
```

In `apps/desktop/src/main/diagnostics/redact.ts` add to `TOKEN_PATTERNS` after the Google line:

```ts
  // Mapbox access tokens (pk. public, sk. secret, tk. temporary)
  /\b[pst]k\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // ArcGIS API keys (AAPK legacy, AAPT and AAPE access tokens)
  /\bAAP[KTE][A-Za-z0-9_-]{20,}/g,
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/main/keys.test.ts apps/desktop/src/main/diagnostics/redact.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/keys.ts apps/desktop/src/main/keys.test.ts apps/desktop/src/main/testVault.ts apps/desktop/src/main/diagnostics/redact.ts apps/desktop/src/main/diagnostics/redact.test.ts
git commit -m "feat(desktop): map keys in the OS credential store, redacted everywhere" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Map keys IPC and wiring

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it (not needed here; Task 16 covers it); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Packages:** `apps/desktop` (main).

**Files:**

- Create: `apps/desktop/src/main/onlineMaps.ts`, `apps/desktop/src/main/onlineMaps.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (create the key cache before `createOnlineTiles`; register the IPC beside the `onlineTiles:*` handlers)

**Interfaces:**

- Consumes: `KeyVault.setMapKey/getMapKey/clearMapKey` (Task 4); `OnlineTiles.probe` and `ProbeResult` (Task 3); `collectHandlers` from `./notYet`; `registerSecret` from `./diagnostics/redact`.
- Produces: `createMapKeys(vault): MapKeys` with `get(provider): Promise<string | null>`, `status(): Promise<MapKeysStatus>`, `store(provider, key): Promise<{ ok: boolean }>`, `clear(provider): Promise<{ ok: boolean }>`; `registerMapKeysIpc({ handle, keys, tiles })`; `PROBE_SOURCE: Record<MapKeyProvider, OnlineSourceId>` (`esri` → `esri-world-imagery`, `mapbox` → `mapbox-streets`).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/onlineMaps.test.ts`:

```ts
import type { MapKeyProvider, OnlineSourceId } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { collectHandlers } from './notYet';
import { createMapKeys, PROBE_SOURCE, registerMapKeysIpc } from './onlineMaps';
import type { ProbeResult } from './onlineTiles';

function fakeVault() {
  const store = new Map<MapKeyProvider, string>();
  const reads: MapKeyProvider[] = [];
  return {
    store,
    reads,
    setMapKey: vi.fn((p: MapKeyProvider, k: string) => {
      store.set(p, k);
      return Promise.resolve({ ok: true });
    }),
    getMapKey: (p: MapKeyProvider) => {
      reads.push(p);
      return Promise.resolve(store.get(p) ?? null);
    },
    hasMapKey: (p: MapKeyProvider) => Promise.resolve(store.has(p)),
    clearMapKey: (p: MapKeyProvider) => {
      store.delete(p);
      return Promise.resolve({ ok: true });
    },
  };
}

function setup(answer: ProbeResult = 'ok') {
  const vault = fakeVault();
  const keys = createMapKeys(vault);
  const probes: { id: OnlineSourceId; key: string }[] = [];
  const tiles = {
    probe: (id: OnlineSourceId, key: string) => {
      probes.push({ id, key });
      return Promise.resolve(answer);
    },
  };
  const ipc = collectHandlers((handle) => {
    registerMapKeysIpc({ handle, keys, tiles });
  });
  return { vault, keys, probes, ipc };
}

describe('map keys over IPC', () => {
  it('answers the four channels', () => {
    expect(setup().ipc.channels()).toEqual([
      'mapKeys:clear',
      'mapKeys:set',
      'mapKeys:status',
      'mapKeys:test',
    ]);
  });

  it('checks a key with one tile through main before it is stored', async () => {
    const { ipc, probes, vault } = setup('ok');
    expect(
      await ipc.call('mapKeys:set', { provider: 'mapbox', key: '  pk.good-token-1  ' }),
    ).toEqual({ ok: true });
    expect(probes).toEqual([{ id: PROBE_SOURCE.mapbox, key: 'pk.good-token-1' }]);
    expect(vault.store.get('mapbox')).toBe('pk.good-token-1');
    expect(await ipc.call('mapKeys:status', {})).toEqual({ esri: false, mapbox: true });
  });

  it('never stores a key the provider refused, and says why', async () => {
    const { ipc, vault } = setup('refused');
    const r = await ipc.call('mapKeys:set', { provider: 'esri', key: 'AAPTbad-0123456789' });
    expect(r).toEqual({ ok: false, error: 'Esri refused the key. Check it and try again.' });
    expect(vault.setMapKey).not.toHaveBeenCalled();
  });

  it('says offline-only with its code, and that it could not reach the provider', async () => {
    expect(
      await setup('offline-only').ipc.call('mapKeys:set', {
        provider: 'mapbox',
        key: 'pk.x-123456',
      }),
    ).toEqual({
      ok: false,
      error: 'This workstation is offline-only, so the key cannot be checked.',
      code: 'offline-only',
    });
    const r = await setup('unreachable').ipc.call('mapKeys:test', { provider: 'mapbox' });
    expect(r).toEqual({ ok: false, error: 'No Mapbox key is saved.' });
  });

  it('tests the saved key, and removes it', async () => {
    const { ipc, probes } = setup('ok');
    await ipc.call('mapKeys:set', { provider: 'esri', key: 'AAPTkey-0123456789' });
    expect(await ipc.call('mapKeys:test', { provider: 'esri' })).toEqual({ ok: true });
    expect(probes.at(-1)).toEqual({ id: 'esri-world-imagery', key: 'AAPTkey-0123456789' });
    expect(await ipc.call('mapKeys:clear', { provider: 'esri' })).toEqual({ ok: true });
    expect(await ipc.call('mapKeys:status', {})).toEqual({ esri: false, mapbox: false });
  });

  it('status never carries a key, and the vault is read once per provider', async () => {
    const { ipc, vault } = setup('ok');
    vault.store.set('mapbox', 'pk.saved-before-1');
    const status = await ipc.call('mapKeys:status', {});
    expect(JSON.stringify(status)).not.toContain('pk.');
    await ipc.call('mapKeys:status', {});
    expect(vault.reads.filter((p) => p === 'mapbox')).toHaveLength(1);
  });

  it('refuses a request that is not a key before asking anyone', async () => {
    const { ipc, probes } = setup('ok');
    await expect(ipc.call('mapKeys:set', { provider: 'mapbox', key: 'short' })).rejects.toThrow();
    expect(probes).toEqual([]);
  });
});
```

Note: `collectHandlers` validates the request against the schema (`key` min 8), so the last test expects a rejection.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/main/onlineMaps.test.ts`
Expected: FAIL, cannot find module `./onlineMaps`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/main/onlineMaps.ts`:

```ts
/**
 * Map keys (ADR 0007, amendment of 14 Oct 2026): kept per computer in the OS credential store
 * (`keys.ts`, accounts `map:esri` and `map:mapbox`), read once into memory for the tile proxy,
 * and checked with one tile through the same proxy before they are stored. The renderer learns
 * only whether a key is present.
 */
import type { IpcResponse, MapKeyProvider, MapKeysStatus, OnlineSourceId } from '@aio/schema';
import { registerSecret } from './diagnostics/redact';
import type { KeyVault } from './keys';
import type { Handle } from './notYet';
import type { OnlineTiles, ProbeResult } from './onlineTiles';

/** The tile a key check asks for: a source each kind of key must be able to draw. */
export const PROBE_SOURCE: Record<MapKeyProvider, OnlineSourceId> = {
  esri: 'esri-world-imagery',
  mapbox: 'mapbox-streets',
};

const NAME: Record<MapKeyProvider, string> = { esri: 'Esri', mapbox: 'Mapbox' };

export type MapKeyVault = Pick<KeyVault, 'setMapKey' | 'getMapKey' | 'clearMapKey'>;

export function createMapKeys(vault: MapKeyVault) {
  const known = new Map<MapKeyProvider, string | null>();
  async function get(provider: MapKeyProvider): Promise<string | null> {
    if (known.has(provider)) return known.get(provider) ?? null;
    const key = await vault.getMapKey(provider);
    // a key the app has seen is redacted from every log line and diagnostics bundle
    registerSecret(key);
    known.set(provider, key);
    return key;
  }
  return {
    get,
    async status(): Promise<MapKeysStatus> {
      return { esri: (await get('esri')) !== null, mapbox: (await get('mapbox')) !== null };
    },
    async store(provider: MapKeyProvider, key: string): Promise<{ ok: boolean }> {
      const r = await vault.setMapKey(provider, key);
      if (r.ok) {
        registerSecret(key);
        known.set(provider, key);
      }
      return r;
    },
    async clear(provider: MapKeyProvider): Promise<{ ok: boolean }> {
      const r = await vault.clearMapKey(provider);
      if (r.ok) known.set(provider, null);
      return r;
    },
  };
}

export type MapKeys = ReturnType<typeof createMapKeys>;

function probeFailure(
  provider: MapKeyProvider,
  r: Exclude<ProbeResult, 'ok'>,
): Extract<IpcResponse<'mapKeys:set'>, { ok: false }> {
  switch (r) {
    case 'refused':
      return { ok: false, error: `${NAME[provider]} refused the key. Check it and try again.` };
    case 'unreachable':
      return {
        ok: false,
        error: `${NAME[provider]} could not be reached, so the key could not be checked. Try again when this computer is online.`,
      };
    case 'offline-only':
      return {
        ok: false,
        error: 'This workstation is offline-only, so the key cannot be checked.',
        code: 'offline-only',
      };
    case 'no-network':
      return { ok: false, error: 'There is no network in this run, so the key cannot be checked.' };
  }
}

export function registerMapKeysIpc({
  handle,
  keys,
  tiles,
}: {
  handle: Handle;
  keys: MapKeys;
  tiles: Pick<OnlineTiles, 'probe'>;
}): void {
  handle('mapKeys:status', () => keys.status());
  handle('mapKeys:set', async ({ provider, key }) => {
    const trimmed = key.trim();
    if (trimmed.length < 8) return { ok: false, error: `That is not a ${NAME[provider]} key.` };
    const r = await tiles.probe(PROBE_SOURCE[provider], trimmed);
    if (r !== 'ok') return probeFailure(provider, r);
    const saved = await keys.store(provider, trimmed);
    return saved.ok
      ? { ok: true }
      : { ok: false, error: "The key could not be kept in this computer's credential store." };
  });
  handle('mapKeys:test', async ({ provider }) => {
    const key = await keys.get(provider);
    if (!key) return { ok: false, error: `No ${NAME[provider]} key is saved.` };
    const r = await tiles.probe(PROBE_SOURCE[provider], key);
    return r === 'ok' ? { ok: true } : probeFailure(provider, r);
  });
  handle('mapKeys:clear', async ({ provider }) => {
    const r = await keys.clear(provider);
    return r.ok
      ? { ok: true }
      : { ok: false, error: "The key could not be removed from this computer's credential store." };
  });
}
```

In `apps/desktop/src/main/index.ts`: add `import { createMapKeys, registerMapKeysIpc } from './onlineMaps';`; right before `const onlineTiles = createOnlineTiles({` add `const mapKeys = createMapKeys(keys);`; change the option Task 3 added to `key: (provider) => mapKeys.get(provider),`; after `handle('onlineTiles:clearCache', ...)` add `registerMapKeysIpc({ handle, keys: mapKeys, tiles: onlineTiles });`.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/main/onlineMaps.test.ts apps/desktop/src/main/onlineTiles.test.ts`
Expected: PASS.
Run: `pnpm typecheck && pnpm lint`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/onlineMaps.ts apps/desktop/src/main/onlineMaps.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): mapKeys IPC checks a key through main before storing it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: MapLibre online sources

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it (not needed here); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Packages:** `@aio/maps`.

**Files:**

- Modify: `packages/maps/src/rasterPacks.ts:1` (import), `:104-135` (online block), `:154-166` (`RasterPackDisplay.online`), `:186-190` and `:212-216` (apply and sync)
- Modify: `packages/maps/src/rasterPacks.test.ts:10-14` (imports) and `:280-386` (the online describe)

**Interfaces:**

- Consumes: `onlineSource`, `onlineTileTemplate`, `OnlineSourceId` (Task 1).
- Produces: `onlineMapSourceId(id: OnlineSourceId): string` (`g7-raster-online-<id>`), `onlineMapLayerId(id): string` (`<sourceId>-layer`), `onlineRasterSource(id): RasterSourceSpecification`, `onlineRasterLayer(id): RasterLayerSpecification`; `RasterPackDisplay.online?: OnlineSourceId | null`. Removed: `ONLINE_SATELLITE_SOURCE`, `ONLINE_SATELLITE_LAYER`, `onlineSatelliteSource`, `onlineSatelliteLayer`.

- [ ] **Step 1: Write the failing test**

In `packages/maps/src/rasterPacks.test.ts` replace the four removed names in the import with `onlineMapLayerId, onlineMapSourceId, onlineRasterLayer, onlineRasterSource`, replace `ONLINE_SATELLITE` in the `@aio/schema` import with `onlineSource`, and replace the whole `describe('online satellite on the map ...')` block with:

```ts
describe('online sources on the map (ADR 0007, amended 14 Oct 2026)', () => {
  const S2 = 's2cloudless-2016' as const;
  const ESRI = 'esri-world-imagery' as const;
  const S2_SOURCE = onlineMapSourceId(S2);
  const S2_LAYER = onlineMapLayerId(S2);
  const s2Credit = onlineSource(S2)?.attribution ?? '';

  it("asks the app's own protocol, up to each source's zoom, with its credit", () => {
    expect(onlineRasterSource(S2)).toEqual({
      type: 'raster',
      tiles: ['aio://online/s2cloudless-2016/{z}/{x}/{y}'],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 14,
      attribution: s2Credit,
    });
    expect(onlineRasterSource(ESRI)).toMatchObject({ tileSize: 256, maxzoom: 19 });
    expect(onlineRasterSource(ESRI).attribution).toContain('Powered by Esri');
    // Mapbox styles are 512 px tiles: MapLibre asks one zoom shallower for the same detail
    expect(onlineRasterSource('mapbox-streets')).toMatchObject({ tileSize: 512, maxzoom: 20 });
    expect(S2_SOURCE).toBe('g7-raster-online-s2cloudless-2016');
    expect(onlineRasterLayer(S2)).toMatchObject({
      id: `${S2_SOURCE}-layer`,
      type: 'raster',
      source: S2_SOURCE,
    });
    // the renderer names no online server: every tile goes through aio://
    for (const id of [S2, ESRI, 'mapbox-dark'] as const)
      for (const url of onlineRasterSource(id).tiles ?? [])
        expect(url).toMatch(/^aio:\/\/online\//);
  });

  const world = pack('world');
  const site = pack('site', { bbox: [51, 28.9, 51.01, 28.94], maxZoom: 17 });
  const dem = pack('dem', { kind: 'terrain', maxZoom: 12 });
  const all = { imagery: [site, world], terrain: [dem], satellite: true, hillshade: true };
  const BASE = ['background', 'water', 'roads', 'buildings', 'labels', 'issues'];
  const stack = (layer: string) => [
    'background',
    'water',
    layer,
    'g7-raster-imagery-world-layer',
    'g7-raster-imagery-site-layer',
    HILLSHADE_LAYER,
    'roads',
    'buildings',
    'labels',
    'issues',
  ];

  it('sits at the bottom of the stack: under the packs, streets and labels above', () => {
    const map = new FakeMap();
    syncRasterPacks(map, { ...all, online: S2 });
    expect(map.layers.map((l) => l.id)).toEqual(stack(S2_LAYER));
    expect(map.sources.get(S2_SOURCE)).toMatchObject({ attribution: s2Credit });
    map.log = [];
    syncRasterPacks(map, { ...all, online: S2 });
    expect(map.log).toEqual([]);
  });

  it('switches source in place: the packs keep their layers and tiles', () => {
    const map = new FakeMap();
    syncRasterPacks(map, { ...all, online: S2 });
    map.log = [];
    syncRasterPacks(map, { ...all, online: ESRI });
    expect(map.log).toEqual([
      `-${S2_LAYER}`,
      `-${S2_SOURCE}`,
      `+${onlineMapSourceId(ESRI)}`,
      `+${onlineMapLayerId(ESRI)}`,
    ]);
    expect(map.layers.map((l) => l.id)).toEqual(stack(onlineMapLayerId(ESRI)));
  });

  it('comes and goes in place', () => {
    const map = new FakeMap();
    syncRasterPacks(map, all);
    map.log = [];
    syncRasterPacks(map, { ...all, online: S2 });
    expect(map.log).toEqual([`+${S2_SOURCE}`, `+${S2_LAYER}`]);
    map.log = [];
    syncRasterPacks(map, { ...all, online: null });
    expect(map.log).toEqual([`-${S2_LAYER}`, `-${S2_SOURCE}`]);
  });

  it('draws alone when no pack is installed, and not at all unless asked', () => {
    const map = new FakeMap();
    const none = { imagery: [], terrain: [], satellite: true, hillshade: true };
    syncRasterPacks(map, none);
    syncRasterPacks(map, { ...none, online: null });
    expect(map.layers.map((l) => l.id)).toEqual(BASE);
    expect(map.sources.size).toBe(0);
    syncRasterPacks(map, { ...none, online: ESRI });
    expect([...map.sources.keys()]).toEqual([onlineMapSourceId(ESRI)]);
    // hiding the streets over it keeps the source and its credit
    setStreetOverlay(map, false);
    expect(map.getLayer(onlineMapLayerId(ESRI))).toBeDefined();
    syncRasterPacks(map, none);
    expect(map.layers.map((l) => l.id)).toEqual(BASE);
  });

  it('applyRasterPacks puts it in the same place', () => {
    const map = new FakeMap();
    const off = applyRasterPacks(map, { ...all, online: S2 });
    expect(map.layers.map((l) => l.id)).toEqual(stack(S2_LAYER));
    off();
    expect(map.layers.map((l) => l.id)).toEqual(BASE);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run packages/maps/src/rasterPacks.test.ts`
Expected: FAIL, `onlineMapSourceId` is not exported.

- [ ] **Step 3: Implement**

In `packages/maps/src/rasterPacks.ts` change the first import to
`import { onlineSource, onlineTileTemplate, type OnlineSourceId, type RasterPackInfo, type RasterPackKind } from '@aio/schema';`
and replace the online satellite block (the comment, `ONLINE_SATELLITE_SOURCE`, `ONLINE_SATELLITE_LAYER`, `onlineSatelliteSource`, `onlineSatelliteLayer`) with:

```ts
/**
 * Online sources (ADR 0007, amendments of 10 and 14 Oct 2026): Sentinel-2, Esri World Imagery and
 * the Mapbox maps, streamed by main through `aio://online/<id>/...`. The catalog
 * (`ONLINE_SOURCES` in `@aio/schema`) names no server; each source carries the credit its terms
 * ask for, so the map's attribution control shows it while the layer is on.
 */
export function onlineMapSourceId(id: OnlineSourceId): string {
  return `${PREFIX}online-${id}`;
}

export function onlineMapLayerId(id: OnlineSourceId): string {
  return `${onlineMapSourceId(id)}-layer`;
}

export function onlineRasterSource(id: OnlineSourceId): RasterSourceSpecification {
  const s = onlineSource(id);
  if (!s) throw new Error(`Unknown online source "${id}"`);
  return {
    type: 'raster',
    tiles: [onlineTileTemplate(id)],
    tileSize: s.tileSize,
    minzoom: s.minZoom,
    // the source's own detail: a closer view stretches these tiles, no deeper one is asked for
    maxzoom: s.maxZoom,
    attribution: s.attribution,
  };
}

export function onlineRasterLayer(id: OnlineSourceId): RasterLayerSpecification {
  return {
    id: onlineMapLayerId(id),
    type: 'raster',
    source: onlineMapSourceId(id),
    paint: { 'raster-fade-duration': 0 },
  };
}
```

In `RasterPackDisplay` replace `online?: boolean;` with:

```ts
  /**
   * The online source to draw at the bottom of the stack, under the imagery packs (sharper where
   * they have tiles) and the project's own orthos; null or absent for none.
   */
  online?: OnlineSourceId | null;
```

In `applyRasterPacks` replace the `if (d.online) { ... }` body with
`addSource(onlineMapSourceId(d.online), onlineRasterSource(d.online)); addLayer(onlineRasterLayer(d.online));`
and in `syncRasterPacks` with
`sources.set(onlineMapSourceId(d.online), onlineRasterSource(d.online)); layers.push(onlineRasterLayer(d.online));`
(keep the comments).

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run packages/maps`
Expected: PASS.
Run: `pnpm typecheck`
Expected: FAIL only in `apps/desktop/src/renderer/workspace/basemap.ts` / `siteTiles.ts` where `draw.online` is a boolean. Fix there, minimally, so this task commits green: in `basemap.ts` change `BasemapDraw.online` to `online: OnlineSourceId | null` (import the type from `@aio/schema`) and set it to `satelliteOn && online ? 's2cloudless-2016' : null` in `basemapModel`. Task 11 replaces this. Rerun `pnpm typecheck` (exit 0) and `pnpm exec vitest run apps/desktop/src/renderer/workspace/basemap.test.ts` (update the two `online: true/false` expectations in `draw` to `'s2cloudless-2016'`/`null`; PASS).

- [ ] **Step 5: Commit**

```bash
git add packages/maps/src/rasterPacks.ts packages/maps/src/rasterPacks.test.ts apps/desktop/src/renderer/workspace/basemap.ts apps/desktop/src/renderer/workspace/basemap.test.ts
git commit -m "feat(maps): a raster source per online map source" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Batch note: Task 6 touches `basemap.ts` and `basemap.test.ts`; no other Batch 2 task does.

---

### Task 7: Globe online provider, layer plan and credits

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it (not needed here; Task 16 covers the Globe specs); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Packages:** `@aio/globe`; one line of `apps/desktop/src/renderer/globe/GlobeScreen.tsx`.

**Overlap:** branch `fix/globe-start-view` edits `controller.ts` (camera), `GlobeView.tsx` ~154-163 and `GlobeScreen.tsx` ~81-94. Edit only the lines named here: `controller.ts` ~93, ~252, ~694-701, ~758-781, ~824-825; `GlobeView.tsx` ~37-38 and ~186-188; `GlobeScreen.tsx` ~515.

**Files:**

- Move: `packages/globe/src/view/onlineSatellite.ts` → `packages/globe/src/view/onlineTiles.ts` (`git mv`, then rewrite)
- Modify: `packages/globe/src/view/index.ts:32-37`, `packages/globe/src/index.ts:18` (exports)
- Modify: `packages/globe/src/layers.ts:84-145`, `packages/globe/src/credits.ts` (whole online part)
- Modify: `packages/globe/src/view/controller.ts` (lines above), `packages/globe/src/view/GlobeView.tsx` (lines above)
- Modify: `apps/desktop/src/renderer/globe/GlobeScreen.tsx:515`
- Test: `packages/globe/src/look.test.ts:83-122`, `packages/globe/src/globe.test.ts:72-121`

**Interfaces:**

- Consumes: `onlineSource`, `onlineTileUrl`, `OnlineSourceId` (Task 1).
- Produces:
  - `GlobeLayerPlan` entry `{ kind: 'online'; source: OnlineSourceId }` (replaces `{ kind: 'online-satellite' }`); `GlobeLayerInput.online?: OnlineSourceId | null` (replaces `onlineSatellite?: boolean`). Rule unchanged: drawn in the `satellite` look only, over the Earth, under the packs.
  - `onlineCredit(id: OnlineSourceId): string`; `CreditsShown.online?: OnlineSourceId | null` (replaces `onlineSatellite?: boolean`). `ONLINE_SATELLITE_CREDIT` removed.
  - `OnlineTileImageryProvider` class (`constructor(sourceId: OnlineSourceId, read?: OnlineTileRead)`), `createOnlineTileProvider(sourceId, read?): ImageryProvider`, `type OnlineTileRead`.
  - `GlobeController.setOnline(source: OnlineSourceId | null): void` (replaces `setOnlineSatellite`); inspection layer name `online:<id>`.
  - `GlobeView` prop `online?: OnlineSourceId | null` (replaces `onlineSatellite?: boolean`).

- [ ] **Step 1: Write the failing tests**

In `packages/globe/src/look.test.ts` replace the test `'online satellite: in the satellite look only, ...'` and the test `'credits online satellite right after the Earth ...'` with:

```ts
it('an online source: in the satellite look only, over the street globe and under the packs', () => {
  const on = { street: true, imagery: [SITE, WIDE], online: 'esri-world-imagery' as const };
  const plan = planGlobeLayers({ style: 'satellite', ...on });
  expect(kinds(plan)).toEqual(['earth-shapes', 'street', 'online', 'imagery-pack', 'imagery-pack']);
  expect(plan[2]).toEqual({ kind: 'online', source: 'esri-world-imagery' });
  expect(
    kinds(
      planGlobeLayers({ style: 'satellite', street: false, imagery: [], online: 'mapbox-dark' }),
    ),
  ).toEqual(['earth-shapes', 'online']);
  // never in the other looks, and never unless one is given
  expect(kinds(planGlobeLayers({ style: 'street', ...on }))).toEqual(['earth-shapes', 'street']);
  expect(kinds(planGlobeLayers({ style: 'natural-earth', ...on }))).not.toContain('online');
  const off = { style: 'satellite' as const, street: true, imagery: [WIDE] };
  for (const input of [off, { ...off, online: null }])
    expect(kinds(planGlobeLayers(input))).toEqual(['earth-shapes', 'street', 'imagery-pack']);
});

it('credits the online source right after the Earth it lies on, while the plan draws it', () => {
  const osm = '© OpenStreetMap contributors';
  const input = { street: true, imagery: [WIDE], online: 'esri-world-imagery' as const };
  expect(planCredits(planGlobeLayers({ style: 'satellite', ...input }), osm)).toEqual([
    EARTH_SHAPES_CREDIT,
    osm,
    onlineCredit('esri-world-imagery'),
    'wide imagery',
  ]);
  expect(onlineCredit('esri-world-imagery')).toContain('Powered by Esri');
  expect(planCredits(planGlobeLayers({ style: 'street', ...input }), osm)).not.toContain(
    onlineCredit('esri-world-imagery'),
  );
});
```

and change its import of `ONLINE_SATELLITE_CREDIT` to `onlineCredit`.

In `packages/globe/src/globe.test.ts` replace the two tests `'credits the online satellite imagery when it is drawn, ...'` and `'the online satellite source is read through the app, ...'` with:

```ts
it('credits the online source when it is drawn, right above the bundled one', () => {
  expect(onlineCredit('s2cloudless-2016')).toBe(ONLINE_SATELLITE.attribution);
  const packs = [{ attribution: 'Customer aerial survey 2026', customerLicence: true }];
  expect(creditLines(packs, { online: 'mapbox-satellite' })).toEqual([
    'Natural Earth II (public domain)',
    '© Mapbox © Maxar',
    'Customer aerial survey 2026 (customer licence)',
  ]);
  expect(creditLines(packs, { online: null })).toHaveLength(2);
  expect(creditLines(packs)).toHaveLength(2);
});

it('online tiles are read through the app, never from a server by name', () => {
  // ADR 0007, amendments of 10 and 14 Oct 2026: main owns the address of every service
  const provider = repoFile('packages/globe/src/view/onlineTiles.ts');
  expect(provider).toContain('onlineTileUrl');
  expect(provider).not.toMatch(/https?:\/\//);
  expect(onlineHostsIn(provider)).toEqual([]);
  for (const name of BANNED_CESIUM_IMPORTS)
    expect(provider, name).not.toMatch(new RegExp(`\\b${name}\\b`));
});
```

change its import of `ONLINE_SATELLITE_CREDIT` to `onlineCredit`, and in `describe('project rasters in the layer plan')` change `onlineSatellite: true` to `online: 'esri-world-imagery' as const`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run packages/globe/src/look.test.ts packages/globe/src/globe.test.ts`
Expected: FAIL, `onlineCredit` is not exported.

- [ ] **Step 3: Implement the plan and the credits**

In `packages/globe/src/layers.ts` add `import type { OnlineSourceId } from '@aio/schema';`, replace the plan member

```ts
  | { kind: 'online-satellite' }
```

with

```ts
  | { kind: 'online'; source: OnlineSourceId }
```

(its comment: "An online source (ADR 0007, amendments of 10 and 14 Oct 2026) through the app's own `aio://online/<id>/...` address. Main decides whether a tile is served; the plan only lists it."), replace `onlineSatellite?: boolean;` in `GlobeLayerInput` with

```ts
  /**
   * The online source that may be drawn (the person switched online maps on and chose it), or
   * null. Main still decides tile by tile.
   */
  online?: OnlineSourceId | null;
```

and in `baseLayers` replace the `online` constant with

```ts
const online: GlobeLayerPlan<P, R>[] = input.online
  ? [{ kind: 'online', source: input.online }]
  : [];
```

Replace the online part of `packages/globe/src/credits.ts`: change the import to `import { onlineSource, type OnlineSourceId, type RasterPackInfo } from '@aio/schema';`, replace `ONLINE_SATELLITE_CREDIT` with

```ts
/**
 * The credit of an online source (ADR 0007, amendments of 10 and 14 Oct 2026), from the catalog:
 * its terms ask for it wherever it is drawn.
 */
export function onlineCredit(id: OnlineSourceId): string {
  return onlineSource(id)?.attribution ?? '';
}
```

in `CreditsShown` replace `onlineSatellite?: boolean;` with `online?: OnlineSourceId | null;` (comment: "The online source drawn: its credit comes right after the bundled Earth's."), in `creditLines` replace `if (shown.onlineSatellite) out.push(ONLINE_SATELLITE_CREDIT);` with `if (shown.online) out.push(onlineCredit(shown.online));`, and in `planCredits` replace `let onlineSatellite = false;` with `let online: OnlineSourceId | null = null;`, the branch with `else if (layer.kind === 'online') online = layer.source;` and the return with `return creditLines([...packs, ...terrain], { base, online });`.

In `packages/globe/src/index.ts` export `onlineCredit` instead of `ONLINE_SATELLITE_CREDIT`.

- [ ] **Step 4: Implement the provider, the controller and the view prop**

Run `git mv packages/globe/src/view/onlineSatellite.ts packages/globe/src/view/onlineTiles.ts`, then replace its content with:

```ts
/**
 * Online sources on the Globe (ADR 0007, amendments of 10 and 14 Oct 2026): Sentinel-2, Esri World
 * Imagery or a Mapbox map as a CesiumJS imagery provider, drawn in the Satellite look above the
 * street globe and under the imagery packs when the layer plan lists it (`planGlobeLayers`).
 *
 * The provider asks the app's own protocol only (`aio://online/<id>/{z}/{x}/{y}`): main decides
 * whether a tile is served (the switch, the key, the offline-only gate, the cache), so nothing
 * here names a server and the offline rules of `offline.ts` stand. No ion, Bing, Google, Esri or
 * Mapbox provider of CesiumJS is involved; this is a plain tile provider of our own, like
 * `PmtilesImageryProvider`.
 */
import { Event } from '@cesium/core';
import { Credit, WebMercatorTilingScheme, type ImageryProvider } from '@cesium/engine';
import { onlineSource, onlineTileUrl, type OnlineSourceId } from '@aio/schema';

/** Decode the tile bytes to an image CesiumJS uploads as it does its own (blob URL, no network). */
async function decodeImage(data: ArrayBuffer, type: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([data], { type: type || 'image/jpeg' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** How the provider reads a tile: `fetch` on the app's own address by default. */
export type OnlineTileRead = (url: string) => Promise<Response>;

/**
 * One online source through `aio://online/<id>/...`. Tiles deeper than the source's own zoom are
 * drawn from the deepest ones by CesiumJS. A tile main does not serve (switched off, no key,
 * offline-only, the service unreachable) is a quiet failure: CesiumJS keeps the coarser tile it
 * has, and nothing is written to the console.
 */
export class OnlineTileImageryProvider {
  readonly tilingScheme = new WebMercatorTilingScheme();
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly minimumLevel: number;
  readonly maximumLevel: number;
  readonly rectangle = this.tilingScheme.rectangle;
  readonly errorEvent = new Event();
  /** The credit the source's terms ask for, shown while the layer is. */
  readonly credit: Credit;
  readonly proxy = undefined;
  readonly hasAlphaChannel = false;
  readonly tileDiscardPolicy = undefined;
  /** Tiles decoded so far (for the inspection hook and tests). */
  tilesLoaded = 0;
  private readonly label: string;

  constructor(
    readonly sourceId: OnlineSourceId,
    private readonly read: OnlineTileRead = (url) => fetch(url),
  ) {
    const source = onlineSource(sourceId);
    if (!source) throw new Error(`Unknown online source "${sourceId}"`);
    this.tileWidth = source.tileSize;
    this.tileHeight = source.tileSize;
    this.minimumLevel = source.minZoom;
    this.maximumLevel = source.maxZoom;
    this.credit = new Credit(source.attribution);
    this.label = source.label;
    // with a listener CesiumJS reports a missing tile here instead of logging it
    this.errorEvent.addEventListener(() => undefined);
  }

  getTileCredits(): Credit[] | undefined {
    return undefined;
  }

  async requestImage(x: number, y: number, level: number): Promise<HTMLImageElement> {
    const res = await this.read(onlineTileUrl(this.sourceId, level, x, y));
    if (!res.ok)
      throw new Error(
        `No ${this.label} tile ${String(level)}/${String(x)}/${String(y)} (${String(res.status)})`,
      );
    const img = await decodeImage(await res.arrayBuffer(), res.headers.get('content-type') ?? '');
    this.tilesLoaded++;
    return img;
  }

  pickFeatures(): undefined {
    return undefined;
  }
}

/** The provider as the type CesiumJS's `ImageryLayer` takes (an interface it duck-types). */
export function createOnlineTileProvider(
  sourceId: OnlineSourceId,
  read?: OnlineTileRead,
): ImageryProvider {
  return new OnlineTileImageryProvider(sourceId, read) as unknown as ImageryProvider;
}
```

In `packages/globe/src/view/index.ts` replace the export block from `./onlineSatellite` with:

```ts
// Online sources (ADR 0007, amended 10 and 14 Oct 2026): the Globe's Satellite look draws one
export {
  OnlineTileImageryProvider,
  createOnlineTileProvider,
  type OnlineTileRead,
} from './onlineTiles';
```

In `packages/globe/src/view/controller.ts`:

- L93: `import { createOnlineTileProvider } from './onlineTiles';`
- L252: `private online: OnlineSourceId | null = null;` (add `import type { OnlineSourceId } from '@aio/schema';` beside the other type imports)
- L694-701: replace `setOnlineSatellite` with

```ts
  /**
   * The online source that may be drawn (online maps on and this source chosen; main still
   * decides tile by tile), or null. It shows in the Satellite look only, under the imagery packs.
   */
  setOnline(source: OnlineSourceId | null): void {
    if (source === this.online) return;
    this.online = source;
    this.queueRebuild();
  }
```

- in `rebuildLayers`: `onlineSatellite: this.onlineSatellite,` becomes `online: this.online,`; in the `names` mapping replace the last arm (`: entry.kind,` after the `natural-earth` arm) so the mapping reads:

```ts
            entry.kind === 'earth-shapes'
              ? `earth-shapes:${entry.role}`
              : entry.kind === 'imagery-pack'
                ? `pack:${entry.pack.id}`
                : entry.kind === 'natural-earth'
                  ? OFFLINE_CESIUM.naturalEarth
                  : entry.kind === 'online'
                    ? `online:${entry.source}`
                    : entry.kind,
```

- L824-825: `} else if (entry.kind === 'online') { layers.add(new ImageryLayer(createOnlineTileProvider(entry.source)));`

In `packages/globe/src/view/GlobeView.tsx`:

- L37-38: `/** The online source that may be drawn (Satellite look only), or null. */ online?: OnlineSourceId | null;` (import the type from `@aio/schema`)
- L186-188: `useEffect(() => { ctl?.setOnline(props.online ?? null); }, [ctl, props.online]);`

In `apps/desktop/src/renderer/globe/GlobeScreen.tsx` L515 change `onlineSatellite={online}` to `online={online ? 's2cloudless-2016' : null}` (Task 13 replaces it with the chosen source).

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm exec vitest run packages/globe apps/desktop/src/renderer/globe`
Expected: PASS.
Run: `pnpm typecheck && pnpm lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/globe/src/view/onlineTiles.ts packages/globe/src/view/onlineSatellite.ts packages/globe/src/view/index.ts packages/globe/src/index.ts packages/globe/src/layers.ts packages/globe/src/credits.ts packages/globe/src/view/controller.ts packages/globe/src/view/GlobeView.tsx packages/globe/src/look.test.ts packages/globe/src/globe.test.ts apps/desktop/src/renderer/globe/GlobeScreen.tsx
git commit -m "feat(globe): an imagery provider and plan entry per online source" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 3D online tile source

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it (not needed here); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Packages:** `@aio/tiles`.

**Files:**

- Create: `packages/tiles/src/online.ts`, `packages/tiles/src/online.test.ts`
- Modify: `packages/tiles/src/packs.ts:86-101` (`RasterTileSource.tilePx?`)
- Modify: `packages/tiles/src/surroundings.ts:158-164` (`zoomFor`), `packages/tiles/src/surroundings.test.ts` (one test)
- Modify: `packages/tiles/src/index.ts` (export)

**Interfaces:**

- Consumes: `onlineSource`, `onlineTileUrl`, `OnlineSourceId` (Task 1).
- Produces: `createOnlineTileSource(id: OnlineSourceId, read?: (url: string, signal?: AbortSignal) => Promise<Response>): RasterTileSource` (kind `imagery`, one whole-world pseudo pack whose id is the source id, `tilePx` = `imagePx`); `RasterTileSource.tilePx?: number`; `zoomFor` counts `source.tilePx ?? 256` pixels per tile.

- [ ] **Step 1: Write the failing tests**

Create `packages/tiles/src/online.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createOnlineTileSource } from './online';
import { zoomFor } from './surroundings';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function reader(status = 200, body: Uint8Array = png) {
  const asked: string[] = [];
  const read = (url: string) => {
    asked.push(url);
    return Promise.resolve(new Response(status === 200 ? body : null, { status }));
  };
  return { asked, read };
}

describe('an online source around the site in 3D', () => {
  it("asks the app's own address and answers the bytes", async () => {
    const { asked, read } = reader();
    const src = createOnlineTileSource('esri-world-imagery', read);
    const t = await src.getTile(15, 21000, 13000);
    expect(asked).toEqual(['aio://online/esri-world-imagery/15/21000/13000']);
    expect(new Uint8Array(t?.data ?? new ArrayBuffer(0))).toEqual(png);
    expect(t?.pack.id).toBe('esri-world-imagery');
  });

  it('is imagery of the whole Earth with the source zoom range and credit', () => {
    const src = createOnlineTileSource('mapbox-satellite', reader().read);
    expect(src.kind).toBe('imagery');
    expect(src.packs).toHaveLength(1);
    expect(src.packs[0]?.bbox).toEqual([-180, -85.0511, 180, 85.0511]);
    expect([src.minZoom, src.maxZoom]).toEqual([0, 19]);
    expect(src.tilePx).toBe(512);
    expect(src.credits()).toEqual(['© Mapbox © Maxar']);
  });

  it('answers nothing for a tile main does not serve, or an empty one', async () => {
    expect(
      await createOnlineTileSource('mapbox-dark', reader(401).read).getTile(3, 1, 1),
    ).toBeUndefined();
    expect(
      await createOnlineTileSource('mapbox-dark', reader(200, new Uint8Array(0)).read).getTile(
        3,
        1,
        1,
      ),
    ).toBeUndefined();
  });

  it('chooses a shallower zoom for denser tiles, so the texture stays inside its budget', () => {
    const s2 = createOnlineTileSource('esri-world-imagery', reader().read);
    const mapbox = createOnlineTileSource('mapbox-streets', reader().read);
    const span = 0.06;
    // 1024 px tiles are four times as wide as 256 px ones: two zoom levels shallower
    expect(zoomFor(span, 2048, s2) - zoomFor(span, 2048, mapbox)).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run packages/tiles/src/online.test.ts`
Expected: FAIL, cannot find module `./online`.

- [ ] **Step 3: Implement**

In `packages/tiles/src/packs.ts` add to `RasterTileSource`, after `maxZoom`:

```ts
  /** Pixels along a tile's edge (absent: 256). Online Mapbox tiles are 512 or 1024. */
  readonly tilePx?: number;
```

In `packages/tiles/src/surroundings.ts` change `zoomFor`'s loop condition to use the source's tile size:

```ts
export function zoomFor(spanDeg: number, maxPx: number, source: RasterTileSource): number {
  const px = source.tilePx ?? 256;
  for (let z = Math.min(source.maxZoom, 18); z > source.minZoom; z--) {
    if ((spanDeg / 360) * 2 ** z * px <= maxPx) return z;
  }
  return source.minZoom;
}
```

Create `packages/tiles/src/online.ts`:

```ts
import { onlineSource, onlineTileUrl, type OnlineSourceId } from '@aio/schema';
import type { RasterPack, RasterTileSource } from './packs';

/**
 * An online source (ADR 0007, amendments of 10 and 14 Oct 2026) as a tile provider for the
 * imagery around the site in 3D (`buildSurroundings`). It asks the app's own address,
 * `aio://online/<id>/<z>/<x>/<y>`; main serves or refuses each tile. The source looks like one
 * pack that covers the whole Earth, so `buildSurroundings` treats it like the packs.
 */
export function createOnlineTileSource(
  id: OnlineSourceId,
  read: (url: string, signal?: AbortSignal) => Promise<Response> = (url, signal) =>
    fetch(url, signal ? { signal } : {}),
): RasterTileSource {
  const source = onlineSource(id);
  if (!source) throw new Error(`Unknown online source "${id}"`);
  const pack: RasterPack = {
    id,
    kind: 'imagery',
    bbox: [-180, -85.0511, 180, 85.0511],
    minZoom: source.minZoom,
    maxZoom: source.maxZoom,
    attribution: source.attribution,
    licence: source.licence,
    label: source.label,
  };
  return {
    kind: 'imagery',
    packs: [pack],
    minZoom: source.minZoom,
    maxZoom: source.maxZoom,
    tilePx: source.imagePx,
    async getTile(z, x, y, signal) {
      const res = await read(onlineTileUrl(id, z, x, y), signal);
      if (!res.ok) return undefined;
      const data = await res.arrayBuffer();
      return data.byteLength > 0 ? { data, pack } : undefined;
    },
    credits: () => [source.attribution],
  };
}
```

In `packages/tiles/src/index.ts` add `export { createOnlineTileSource } from './online';`.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run packages/tiles`
Expected: PASS (the existing `surroundings.test.ts` zoom tests are unchanged: packs have no `tilePx`).
Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/tiles/src/online.ts packages/tiles/src/online.test.ts packages/tiles/src/packs.ts packages/tiles/src/surroundings.ts packages/tiles/src/index.ts
git commit -m "feat(tiles): online map sources as imagery around the site" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Map menu model and strings

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it (not needed here); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Packages:** `apps/desktop` (renderer/maps), `@aio/ui` (`en.ts`).

**Files:**

- Create: `apps/desktop/src/renderer/maps/mapMenuModel.ts`, `apps/desktop/src/renderer/maps/mapMenuModel.test.ts`
- Modify: `packages/ui/src/i18n/en.ts` (add every string of this plan, after the `basemap.*` block at ~L151 and after the `g7.online.*` block at ~L3047; one `settings.*` pair beside `settings.page.maps` at ~L705)

**Interfaces:**

- Consumes: `ONLINE_SOURCES`, `onlineSource`, `isOnlineBase`, `BaseMapId`, `MapKeysStatus`, `OnlineSource` (Task 1); `BUNDLED_CREDIT` from `@aio/globe`; `MessageKey` from `@aio/ui`.
- Produces (used by Tasks 10 to 14):
  - `type MapMenuView = 'map' | 'globe' | 'scene'`
  - `type TileState = 'available' | 'needs-key' | 'offline' | 'tier'`
  - `type OnTopKey = 'streets' | 'hillshade' | 'packs' | 'terrain' | 'aroundImagery' | 'aroundTerrain' | 'issues'`
  - `type SwatchKind = 'streets' | 'natural-earth' | 'imagery' | 'imagery-labels' | 'mapbox-streets' | 'outdoors' | 'light' | 'dark'`
  - `interface MenuTile { id: BaseMapId; label: MessageKey; state: TileState; reason: MessageKey | null; badge: MessageKey | null; selected: boolean; swatch: SwatchKind }`
  - `interface MenuSection { id: 'offline' | 'satellite' | 'mapbox'; title: MessageKey; tiles: MenuTile[]; note: MessageKey | null }`
  - `interface OnTopRow { key: OnTopKey; label: MessageKey; on: boolean; disabled: boolean; reason: MessageKey | null }`
  - `interface MapMenuPrefs { base: BaseMapId; onTop: Partial<Record<OnTopKey, boolean>>; pack: string | null }`
  - `interface MenuPacks { imagery: readonly { id: string; label: string }[]; terrain: number }`
  - `interface MenuOnline { enabled: boolean; offlineOnly: boolean }`
  - `interface MenuContext { aroundOffered?: boolean; terrainOffered?: boolean; streetsCredit?: string }`
  - `interface MapMenuModel { view; sections: MenuSection[]; onTop: OnTopRow[]; packs: { id: string; label: string }[]; pack: string | null; showPackPicker: boolean; chosen: BaseMapId; drawn: BaseMapId; fallback: boolean; chip: MessageKey; chipSwatch: SwatchKind; credit: string }`
  - `tileState(source: OnlineSource, online: MenuOnline, keys: MapKeysStatus): Exclude<TileState, 'tier'>`
  - `drawnBase(chosen: BaseMapId, online: MenuOnline, keys: MapKeysStatus): { base: BaseMapId; fallback: boolean }`
  - `mapMenuModel(view: MapMenuView, prefs: MapMenuPrefs, sources: readonly OnlineSource[], packs: MenuPacks, online: MenuOnline, keys: MapKeysStatus, context?: MenuContext): MapMenuModel`
  - `BASE_LABEL: Record<BaseMapId, MessageKey>`, `STREETS_CREDIT = '© OpenStreetMap contributors'`
  - Strings: every key listed in Step 3.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/maps/mapMenuModel.test.ts`:

```ts
import { ONLINE_SOURCES, onlineSource, type MapKeysStatus } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  drawnBase,
  mapMenuModel,
  tileState,
  type MapMenuPrefs,
  type MenuOnline,
  type MenuPacks,
} from './mapMenuModel';

const ON: MenuOnline = { enabled: true, offlineOnly: false };
const OFF: MenuOnline = { enabled: false, offlineOnly: false };
const OFFLINE_ONLY: MenuOnline = { enabled: true, offlineOnly: true };
const NO_KEYS: MapKeysStatus = { esri: false, mapbox: false };
const KEYS: MapKeysStatus = { esri: false, mapbox: true };
const PACKS: MenuPacks = { imagery: [{ id: 'site', label: 'Site imagery' }], terrain: 1 };
const NONE: MenuPacks = { imagery: [], terrain: 0 };
const prefs = (over: Partial<MapMenuPrefs> = {}): MapMenuPrefs => ({
  base: 'streets',
  onTop: {},
  pack: null,
  ...over,
});
const tileOf = (m: ReturnType<typeof mapMenuModel>, id: string) =>
  m.sections.flatMap((s) => s.tiles).find((t) => t.id === id);
const row = (m: ReturnType<typeof mapMenuModel>, key: string) => m.onTop.find((r) => r.key === key);

describe('tile states', () => {
  const esri = onlineSource('esri-world-imagery');
  const mapbox = onlineSource('mapbox-streets');
  const s2 = onlineSource('s2cloudless-2016');
  if (!esri || !mapbox || !s2) throw new Error('catalog');

  it('Esri works without a key, Mapbox needs one', () => {
    expect(tileState(esri, ON, NO_KEYS)).toBe('available');
    expect(tileState(mapbox, ON, NO_KEYS)).toBe('needs-key');
    expect(tileState(mapbox, ON, KEYS)).toBe('available');
    // online maps off: still pickable, the pick asks to switch them on
    expect(tileState(esri, OFF, NO_KEYS)).toBe('available');
  });

  it('offline-only greys every source except saved Sentinel-2 while online maps are on', () => {
    expect(tileState(esri, OFFLINE_ONLY, NO_KEYS)).toBe('offline');
    expect(tileState(mapbox, OFFLINE_ONLY, KEYS)).toBe('offline');
    expect(tileState(s2, OFFLINE_ONLY, NO_KEYS)).toBe('available');
    expect(tileState(s2, { enabled: false, offlineOnly: true }, NO_KEYS)).toBe('offline');
  });
});

describe('what is drawn', () => {
  it('draws the chosen source when it can', () => {
    expect(drawnBase('esri-world-imagery', ON, NO_KEYS)).toEqual({
      base: 'esri-world-imagery',
      fallback: false,
    });
    expect(drawnBase('natural-earth', OFF, NO_KEYS)).toEqual({
      base: 'natural-earth',
      fallback: false,
    });
  });

  it('offline-only draws saved Sentinel-2 when online maps are on', () => {
    expect(drawnBase('esri-world-imagery', OFFLINE_ONLY, NO_KEYS)).toEqual({
      base: 's2cloudless-2016',
      fallback: true,
    });
    expect(drawnBase('s2cloudless-2016', OFFLINE_ONLY, NO_KEYS)).toEqual({
      base: 's2cloudless-2016',
      fallback: false,
    });
  });

  it('falls back to the street map without a key or with online maps off', () => {
    expect(drawnBase('mapbox-dark', ON, NO_KEYS)).toEqual({ base: 'streets', fallback: true });
    expect(drawnBase('esri-world-imagery', OFF, NO_KEYS)).toEqual({
      base: 'streets',
      fallback: true,
    });
    expect(drawnBase('mapbox-dark', { enabled: false, offlineOnly: true }, KEYS)).toEqual({
      base: 'streets',
      fallback: true,
    });
  });
});

describe('the menu of each view', () => {
  it('groups the tiles: Offline, Online satellite (Esri, Mapbox, Sentinel-2), Mapbox styles', () => {
    const m = mapMenuModel('map', prefs(), ONLINE_SOURCES, PACKS, ON, NO_KEYS);
    expect(m.sections.map((s) => [s.id, s.tiles.map((t) => t.id)])).toEqual([
      ['offline', ['streets']],
      ['satellite', ['esri-world-imagery', 'mapbox-satellite', 's2cloudless-2016']],
      [
        'mapbox',
        [
          'mapbox-streets',
          'mapbox-outdoors',
          'mapbox-light',
          'mapbox-dark',
          'mapbox-satellite-streets',
        ],
      ],
    ]);
    expect(tileOf(m, 'streets')?.selected).toBe(true);
    expect(
      mapMenuModel('globe', prefs(), ONLINE_SOURCES, PACKS, ON, NO_KEYS).sections[0]?.tiles.map(
        (t) => t.id,
      ),
    ).toEqual(['streets', 'natural-earth']);
  });

  it('greys a Mapbox style without a key, with the reason under its section', () => {
    const m = mapMenuModel('map', prefs(), ONLINE_SOURCES, PACKS, ON, NO_KEYS);
    expect(tileOf(m, 'mapbox-streets')).toMatchObject({
      state: 'needs-key',
      reason: 'mapMenu.reason.needsKey',
      badge: 'mapMenu.badge.needsKey',
    });
    expect(m.sections.find((s) => s.id === 'mapbox')?.note).toBe('mapMenu.reason.needsKey');
    expect(m.sections.find((s) => s.id === 'satellite')?.note).toBe('mapMenu.reason.needsKey');
    expect(tileOf(m, 'esri-world-imagery')?.state).toBe('available');
  });

  it('the 3D scene needs Medium graphics for an online base', () => {
    const m = mapMenuModel('scene', prefs(), ONLINE_SOURCES, PACKS, ON, KEYS, {
      aroundOffered: false,
    });
    expect(tileOf(m, 'esri-world-imagery')).toMatchObject({
      state: 'tier',
      reason: 'mapMenu.reason.tier',
    });
    expect(tileOf(m, 'streets')?.state).toBe('available');
    expect(row(m, 'aroundImagery')).toMatchObject({
      disabled: true,
      reason: 'mapMenu.reason.tier',
    });
  });

  it('Map view On top: street names over imagery only, shading and packs need a pack', () => {
    const streets = mapMenuModel('map', prefs(), ONLINE_SOURCES, NONE, ON, NO_KEYS);
    expect(streets.onTop.map((r) => r.key)).toEqual(['streets', 'hillshade', 'packs']);
    expect(row(streets, 'streets')).toMatchObject({
      disabled: true,
      reason: 'mapMenu.reason.noImageryUnder',
    });
    expect(row(streets, 'hillshade')).toMatchObject({
      disabled: true,
      reason: 'mapMenu.reason.noTerrain',
    });
    expect(row(streets, 'packs')).toMatchObject({
      disabled: true,
      reason: 'mapMenu.reason.noImagery',
    });

    const esri = mapMenuModel(
      'map',
      prefs({ base: 'esri-world-imagery' }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      NO_KEYS,
    );
    expect(row(esri, 'streets')).toMatchObject({ disabled: false, on: true });
    const labelled = mapMenuModel(
      'map',
      prefs({ base: 'mapbox-satellite-streets' }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      KEYS,
    );
    expect(row(labelled, 'streets')).toMatchObject({
      disabled: true,
      on: false,
      reason: 'mapMenu.reason.labelsInBase',
    });
    const packsOn = mapMenuModel(
      'map',
      prefs({ onTop: { packs: true, streets: false } }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      NO_KEYS,
    );
    expect(row(packsOn, 'streets')).toMatchObject({ disabled: false, on: false });
    expect(packsOn.showPackPicker).toBe(true);
  });

  it('Globe On top: packs, terrain and issues; terrain off on the Low preset', () => {
    const m = mapMenuModel(
      'globe',
      prefs({ onTop: { packs: true } }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      NO_KEYS,
      {
        terrainOffered: false,
      },
    );
    expect(m.onTop.map((r) => r.key)).toEqual(['packs', 'terrain', 'issues']);
    expect(row(m, 'terrain')).toMatchObject({
      disabled: true,
      on: false,
      reason: 'mapMenu.reason.lowTier',
    });
    expect(row(m, 'issues')).toMatchObject({ disabled: false, on: true });
    expect(m.showPackPicker).toBe(true);
  });

  it('the chip names the chosen map and notes a fallback; the footer credits what is drawn', () => {
    const fallback = mapMenuModel(
      'map',
      prefs({ base: 'mapbox-dark' }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      NO_KEYS,
    );
    expect(fallback).toMatchObject({
      chosen: 'mapbox-dark',
      drawn: 'streets',
      fallback: true,
      chip: 'mapMenu.tile.mapboxDark',
      chipSwatch: 'dark',
      credit: '© OpenStreetMap contributors',
    });
    const esri = mapMenuModel(
      'map',
      prefs({ base: 'esri-world-imagery' }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      NO_KEYS,
    );
    expect(esri.credit).toContain('Powered by Esri');
    const ne = mapMenuModel(
      'globe',
      prefs({ base: 'natural-earth' }),
      ONLINE_SOURCES,
      PACKS,
      ON,
      NO_KEYS,
    );
    expect(ne.credit).toBe('Natural Earth II (public domain)');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/renderer/maps/mapMenuModel.test.ts`
Expected: FAIL, cannot find module `./mapMenuModel`.

- [ ] **Step 3: Add the strings**

Add to `packages/ui/src/i18n/en.ts`, right after `'basemap.online.or': 'or turn on',` (the old `basemap.*` keys stay until Task 16):

```ts
  // The Map menu (plan 2026-10-14-satellite-providers): one menu for the Map view, the Globe and
  // the 3D scene
  'mapMenu.title': 'Map',
  'mapMenu.button': 'Map: {name}',
  'mapMenu.fallback': 'Offline map',
  'mapMenu.fallback.tip': 'The chosen map cannot be drawn now, so the offline map is shown',
  'mapMenu.section.offline': 'Offline',
  'mapMenu.section.satellite': 'Online satellite',
  'mapMenu.section.mapbox': 'Mapbox styles',
  'mapMenu.section.onTop': 'On top',
  'mapMenu.tile.streets': 'Streets',
  'mapMenu.tile.naturalEarth': 'Natural Earth',
  'mapMenu.tile.esri': 'Esri',
  'mapMenu.tile.mapboxSatellite': 'Mapbox',
  'mapMenu.tile.sentinel': 'Sentinel-2',
  'mapMenu.tile.mapboxStreets': 'Streets',
  'mapMenu.tile.mapboxOutdoors': 'Outdoors',
  'mapMenu.tile.mapboxLight': 'Light',
  'mapMenu.tile.mapboxDark': 'Dark',
  'mapMenu.tile.mapboxSatelliteStreets': 'Satellite streets',
  'mapMenu.badge.needsKey': 'Key',
  'mapMenu.badge.offline': 'Offline',
  'mapMenu.badge.tier': 'Medium',
  'mapMenu.reason.needsKey': 'Add a key in Map sources',
  'mapMenu.reason.offline': 'This workstation is offline-only',
  'mapMenu.reason.tier': 'Needs Medium graphics or higher',
  'mapMenu.reason.noImagery': 'No imagery pack covers this site',
  'mapMenu.reason.noTerrain': 'No terrain pack covers this site',
  'mapMenu.reason.labelsInBase': 'This map has its own street names',
  'mapMenu.reason.noImageryUnder': 'Shown over imagery only',
  'mapMenu.reason.lowTier': 'Terrain is off on the Low graphics preset',
  'mapMenu.onTop.streets': 'Street names and roads',
  'mapMenu.onTop.hillshade': 'Terrain shading',
  'mapMenu.onTop.packs': 'Imagery packs and orthos',
  'mapMenu.onTop.terrain': 'Terrain',
  'mapMenu.onTop.aroundImagery': 'Imagery packs around the site',
  'mapMenu.onTop.aroundTerrain': 'Terrain around the site',
  'mapMenu.onTop.issues': 'Issues of the open project',
  'mapMenu.pack': 'Imagery pack',
  'mapMenu.pack.best': 'Best available',
  'mapMenu.sources': 'Map sources',
  'mapMenu.sources.tip': 'Online maps and their keys, in Settings',
  'palette.mapBase': 'Map: {name}',
```

Add right after `'g7.online.clearCache': ...` (the old keys stay until Task 16):

```ts
  // Online maps, one notice per provider (ADR 0007, amendment of 14 Oct 2026)
  'online.notice.eox':
    "Sentinel-2 imagery is requested from EOX's servers for the areas you look at, so the areas you view are visible to that service. Nothing else is sent. The imagery is from 2016, at about 10 m per pixel, and the tiles are kept on this computer.",
  'online.notice.esri':
    "Esri World Imagery is requested from Esri's servers for the areas you look at, so the areas you view are visible to Esri. Nothing else is sent. The tiles are not kept on this computer.",
  'online.notice.mapbox':
    "Mapbox maps are requested from Mapbox's servers with your key for the areas you look at, so the areas you view are visible to Mapbox. Nothing else is sent. The tiles are not kept on this computer.",
  'online.confirm': 'Switch on',
  'online.cancel': 'Cancel',
  // Settings, Map sources
  'mapSources.master': 'Online maps',
  'mapSources.master.help':
    'Off by default. When on, the Map menu offers the online maps below in the Map view, the Globe and the 3D scene. The tiles for the areas you look at are requested from that provider.',
  'mapSources.offlineOnly':
    'This workstation is offline-only, so online maps cannot be switched on. Turn off offline-only in Privacy and cloud.',
  'mapSources.provider.eox': 'Sentinel-2 (EOX)',
  'mapSources.provider.esri': 'Esri World Imagery',
  'mapSources.provider.mapbox': 'Mapbox',
  'mapSources.status.keyless': 'Works without a key',
  'mapSources.status.noKey': 'No key',
  'mapSources.status.saved': 'Key saved',
  'mapSources.key': '{provider} key',
  'mapSources.key.placeholder': 'Paste the key',
  'mapSources.save': 'Save key',
  'mapSources.test': 'Test',
  'mapSources.remove': 'Remove',
  'mapSources.checking': 'Checking the key with one tile',
  'mapSources.tested': 'The key works.',
  'mapSources.saved': 'The key is saved on this computer.',
  'mapSources.removed': 'The key is removed from this computer.',
  'mapSources.terms.eox':
    'Sentinel-2 cloudless 2016 by EOX, CC BY 4.0. No key and no cost. Tiles are kept on this computer, up to 300 MB.',
  'mapSources.terms.esri':
    'Works without a key. A key from an ArcGIS Location Platform account uses that account and its free monthly allowance. Tiles are not kept on this computer.',
  'mapSources.terms.mapbox':
    'Mapbox Satellite and the Mapbox styles. Needs a public access token from a Mapbox account; requests beyond the free monthly allowance are billed to that account. Tiles are not kept on this computer.',
  'mapSources.clear': 'Clear saved satellite tiles ({size})',
  'mapSources.credit': 'Credit: {attribution}',
```

Add beside `'settings.page.maps': 'Offline maps',`:

```ts
  'settings.page.mapSources': 'Map sources',
```

and beside the existing `'settings.maps.text'` key:

```ts
  'settings.mapSources.text':
    'Online maps from named providers, and the keys this computer uses for them. Keys stay on this computer.',
```

- [ ] **Step 4: Implement the model**

Create `apps/desktop/src/renderer/maps/mapMenuModel.ts`:

```ts
/**
 * The Map menu as data (plan 2026-10-14-satellite-providers): which base maps each view offers,
 * whether each can be picked and why not, the On top switches, what is actually drawn and the
 * credit line. One model for the Map view, the Globe and the 3D scene; `MapMenu.tsx` draws it and
 * each view's adapter reads and writes its own choices.
 */
import { BUNDLED_CREDIT } from '@aio/globe';
import {
  isOnlineBase,
  onlineSource,
  type BaseMapId,
  type MapKeysStatus,
  type OnlineSource,
} from '@aio/schema';
import type { MessageKey } from '@aio/ui';

export type MapMenuView = 'map' | 'globe' | 'scene';
export type TileState = 'available' | 'needs-key' | 'offline' | 'tier';
export type OnTopKey =
  'streets' | 'hillshade' | 'packs' | 'terrain' | 'aroundImagery' | 'aroundTerrain' | 'issues';
export type SwatchKind =
  | 'streets'
  | 'natural-earth'
  | 'imagery'
  | 'imagery-labels'
  | 'mapbox-streets'
  | 'outdoors'
  | 'light'
  | 'dark';
export type MenuSectionId = 'offline' | 'satellite' | 'mapbox';

export interface MenuTile {
  id: BaseMapId;
  label: MessageKey;
  state: TileState;
  /** Why it cannot be picked (the section note shows it in full). */
  reason: MessageKey | null;
  /** The short word on a greyed tile. */
  badge: MessageKey | null;
  selected: boolean;
  swatch: SwatchKind;
}

export interface MenuSection {
  id: MenuSectionId;
  title: MessageKey;
  tiles: MenuTile[];
  /** The reason the greyed tiles of this section share, in full. */
  note: MessageKey | null;
}

export interface OnTopRow {
  key: OnTopKey;
  label: MessageKey;
  on: boolean;
  disabled: boolean;
  reason: MessageKey | null;
}

export interface MapMenuPrefs {
  /** The base map the person chose for this view. */
  base: BaseMapId;
  onTop: Partial<Record<OnTopKey, boolean>>;
  /** The one imagery pack to draw, or null for the best available. */
  pack: string | null;
}

export interface MenuPacks {
  /** Imagery packs that cover the site (Map view, 3D scene) or are installed (Globe). */
  imagery: readonly { id: string; label: string }[];
  /** Terrain packs that cover the site. */
  terrain: number;
}

export interface MenuOnline {
  /** Online maps are switched on (main's `online.json`). */
  enabled: boolean;
  offlineOnly: boolean;
}

export interface MenuContext {
  /** The graphics preset offers imagery and terrain around the site (3D scene; Medium and up). */
  aroundOffered?: boolean;
  /** The graphics preset offers terrain on the Globe (not Low). */
  terrainOffered?: boolean;
  /** The street map's credit for the footer. */
  streetsCredit?: string;
}

export interface MapMenuModel {
  view: MapMenuView;
  sections: MenuSection[];
  onTop: OnTopRow[];
  packs: { id: string; label: string }[];
  pack: string | null;
  showPackPicker: boolean;
  chosen: BaseMapId;
  drawn: BaseMapId;
  /** The chosen map cannot be drawn: the chip notes "Offline map". */
  fallback: boolean;
  chip: MessageKey;
  chipSwatch: SwatchKind;
  credit: string;
}

export const STREETS_CREDIT = '© OpenStreetMap contributors';

export const BASE_LABEL: Record<BaseMapId, MessageKey> = {
  streets: 'mapMenu.tile.streets',
  'natural-earth': 'mapMenu.tile.naturalEarth',
  'esri-world-imagery': 'mapMenu.tile.esri',
  'mapbox-satellite': 'mapMenu.tile.mapboxSatellite',
  's2cloudless-2016': 'mapMenu.tile.sentinel',
  'mapbox-streets': 'mapMenu.tile.mapboxStreets',
  'mapbox-outdoors': 'mapMenu.tile.mapboxOutdoors',
  'mapbox-light': 'mapMenu.tile.mapboxLight',
  'mapbox-dark': 'mapMenu.tile.mapboxDark',
  'mapbox-satellite-streets': 'mapMenu.tile.mapboxSatelliteStreets',
};

const SWATCH: Record<BaseMapId, SwatchKind> = {
  streets: 'streets',
  'natural-earth': 'natural-earth',
  'esri-world-imagery': 'imagery',
  'mapbox-satellite': 'imagery',
  's2cloudless-2016': 'imagery',
  'mapbox-streets': 'mapbox-streets',
  'mapbox-outdoors': 'outdoors',
  'mapbox-light': 'light',
  'mapbox-dark': 'dark',
  'mapbox-satellite-streets': 'imagery-labels',
};

const REASON: Record<Exclude<TileState, 'available'>, MessageKey> = {
  'needs-key': 'mapMenu.reason.needsKey',
  offline: 'mapMenu.reason.offline',
  tier: 'mapMenu.reason.tier',
};

const BADGE: Record<Exclude<TileState, 'available'>, MessageKey> = {
  'needs-key': 'mapMenu.badge.needsKey',
  offline: 'mapMenu.badge.offline',
  tier: 'mapMenu.badge.tier',
};

/**
 * Whether a source can be picked. Online maps switched off do not grey anything: picking a
 * source then asks to switch them on (with the provider's notice).
 */
export function tileState(
  source: OnlineSource,
  online: MenuOnline,
  keys: MapKeysStatus,
): Exclude<TileState, 'tier'> {
  if (online.offlineOnly) return source.diskCache && online.enabled ? 'available' : 'offline';
  if (source.keyPolicy === 'required' && source.keyProvider && !keys[source.keyProvider])
    return 'needs-key';
  return 'available';
}

/**
 * What a view draws for the chosen base map. A source that cannot be drawn gives way: to the
 * saved Sentinel-2 tiles on an offline-only workstation with online maps on, otherwise to the
 * offline street map.
 */
export function drawnBase(
  chosen: BaseMapId,
  online: MenuOnline,
  keys: MapKeysStatus,
): { base: BaseMapId; fallback: boolean } {
  if (!isOnlineBase(chosen)) return { base: chosen, fallback: false };
  const source = onlineSource(chosen);
  if (source && online.enabled && tileState(source, online, keys) === 'available')
    return { base: chosen, fallback: false };
  if (online.enabled && online.offlineOnly) return { base: 's2cloudless-2016', fallback: true };
  return { base: 'streets', fallback: true };
}

const firstReason = (tiles: readonly MenuTile[]): MessageKey | null => {
  const order: Exclude<TileState, 'available'>[] = ['offline', 'tier', 'needs-key'];
  for (const s of order) if (tiles.some((t) => t.state === s)) return REASON[s];
  return null;
};

export function mapMenuModel(
  view: MapMenuView,
  prefs: MapMenuPrefs,
  sources: readonly OnlineSource[],
  packs: MenuPacks,
  online: MenuOnline,
  keys: MapKeysStatus,
  context: MenuContext = {},
): MapMenuModel {
  const aroundOffered = context.aroundOffered ?? true;
  const tile = (id: BaseMapId, state: TileState): MenuTile => ({
    id,
    label: BASE_LABEL[id],
    state,
    reason: state === 'available' ? null : REASON[state],
    badge: state === 'available' ? null : BADGE[state],
    selected: prefs.base === id,
    swatch: SWATCH[id],
  });
  const onlineTile = (s: OnlineSource): MenuTile =>
    tile(s.id, view === 'scene' && !aroundOffered ? 'tier' : tileState(s, online, keys));
  const offline: BaseMapId[] = view === 'globe' ? ['streets', 'natural-earth'] : ['streets'];
  const satellite = sources.filter((s) => s.group === 'satellite').map(onlineTile);
  const mapbox = sources.filter((s) => s.group === 'mapbox').map(onlineTile);
  const sections: MenuSection[] = [
    {
      id: 'offline',
      title: 'mapMenu.section.offline',
      tiles: offline.map((id) => tile(id, 'available')),
      note: null,
    },
    {
      id: 'satellite',
      title: 'mapMenu.section.satellite',
      tiles: satellite,
      note: firstReason(satellite),
    },
    { id: 'mapbox', title: 'mapMenu.section.mapbox', tiles: mapbox, note: firstReason(mapbox) },
  ];

  const drawn = drawnBase(prefs.base, online, keys);
  const drawnSource = isOnlineBase(drawn.base) ? onlineSource(drawn.base) : undefined;
  const hasImagery = packs.imagery.length > 0;
  const packsOn = hasImagery && (prefs.onTop.packs ?? false);
  const rowOf = (
    key: OnTopKey,
    label: MessageKey,
    reason: MessageKey | null,
    fallbackOn: boolean,
  ): OnTopRow => ({
    key,
    label,
    disabled: reason !== null,
    reason,
    on: reason === null && (prefs.onTop[key] ?? fallbackOn),
  });

  let onTop: OnTopRow[];
  if (view === 'map') {
    const labelsInBase = drawnSource?.labels ?? false;
    const imageryUnder = (drawnSource?.imagery ?? false) || packsOn;
    onTop = [
      rowOf(
        'streets',
        'mapMenu.onTop.streets',
        labelsInBase
          ? 'mapMenu.reason.labelsInBase'
          : imageryUnder
            ? null
            : 'mapMenu.reason.noImageryUnder',
        true,
      ),
      rowOf(
        'hillshade',
        'mapMenu.onTop.hillshade',
        packs.terrain > 0 ? null : 'mapMenu.reason.noTerrain',
        false,
      ),
      rowOf('packs', 'mapMenu.onTop.packs', hasImagery ? null : 'mapMenu.reason.noImagery', false),
    ];
  } else if (view === 'scene') {
    const tier: MessageKey | null = aroundOffered ? null : 'mapMenu.reason.tier';
    onTop = [
      rowOf(
        'aroundImagery',
        'mapMenu.onTop.aroundImagery',
        tier ?? (hasImagery ? null : 'mapMenu.reason.noImagery'),
        false,
      ),
      rowOf(
        'aroundTerrain',
        'mapMenu.onTop.aroundTerrain',
        tier ?? (packs.terrain > 0 ? null : 'mapMenu.reason.noTerrain'),
        false,
      ),
    ];
  } else {
    onTop = [
      rowOf('packs', 'mapMenu.onTop.packs', hasImagery ? null : 'mapMenu.reason.noImagery', false),
      rowOf(
        'terrain',
        'mapMenu.onTop.terrain',
        (context.terrainOffered ?? true) ? null : 'mapMenu.reason.lowTier',
        true,
      ),
      rowOf('issues', 'mapMenu.onTop.issues', null, true),
    ];
  }

  const credit = drawnSource
    ? drawnSource.attribution
    : drawn.base === 'natural-earth'
      ? BUNDLED_CREDIT
      : (context.streetsCredit ?? STREETS_CREDIT);

  return {
    view,
    sections,
    onTop,
    packs: packs.imagery.map((p) => ({ id: p.id, label: p.label })),
    pack: packs.imagery.some((p) => p.id === prefs.pack) ? prefs.pack : null,
    showPackPicker: view !== 'scene' && packsOn,
    chosen: prefs.base,
    drawn: drawn.base,
    fallback: drawn.fallback,
    chip: BASE_LABEL[prefs.base],
    chipSwatch: SWATCH[prefs.base],
    credit,
  };
}
```

Run `pnpm exec prettier --write apps/desktop/src/renderer/maps/mapMenuModel.ts apps/desktop/src/renderer/maps/mapMenuModel.test.ts packages/ui/src/i18n/en.ts` (the long `rowOf` lines above are wrapped by Prettier).

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/renderer/maps/mapMenuModel.test.ts packages/ui/src/i18n`
Expected: PASS (the i18n test checks for dashes; none are used).
Run: `pnpm typecheck && pnpm lint`
Expected: exit 0. If `@aio/globe` is not yet a dependency of the renderer file's package, it is: `apps/desktop` already imports `@aio/globe` in `GlobeScreen.tsx`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/maps/mapMenuModel.ts apps/desktop/src/renderer/maps/mapMenuModel.test.ts packages/ui/src/i18n/en.ts
git commit -m "feat(desktop): one Map menu model for the Map view, the Globe and the 3D scene" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The MapMenu component (Gallery)

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it (not needed here; Task 16 covers it); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Before writing any code, load the `impeccable` skill (and `frontend-design`)** and read `docs/design/DIRECTION.md`. The layout is fixed by the founder (Gallery, mockup A of 14 Oct): keep its structure, polish within it.

**Packages:** `apps/desktop` (renderer/maps).

**Files:**

- Create: `apps/desktop/src/renderer/maps/MapSwatch.tsx`, `apps/desktop/src/renderer/maps/MapMenu.tsx`, `apps/desktop/src/renderer/maps/mapMenu.css`, `apps/desktop/src/renderer/maps/MapMenu.test.tsx`

**Interfaces:**

- Consumes: `MapMenuModel`, `MenuTile`, `OnTopKey`, `SwatchKind` (Task 9); `usePopPlacement` (`renderer/workspace/popPlacement.ts`); `Icon`, `Switch`, `useFocusTrap`, `useT` (`@aio/ui`); `BaseMapId` (Task 1).
- Produces:
  - `MapSwatch({ kind: SwatchKind; className?: string })`
  - `MapMenu(props: MapMenuProps)` with `interface MapMenuProps { model: MapMenuModel; testIds: { chip: string; pop: string }; className: string; chipClassName?: string; place: 'stage' | 'free'; dark?: boolean; onPick: (id: BaseMapId) => void; onToggle: (key: OnTopKey, on: boolean) => void; onPack: (id: string | null) => void; onOpenSources: () => void; notice?: ReactNode; extra?: ReactNode }`
  - Test ids inside the pop: `map-tile-<baseId>`, `map-menu-note-<section>`, `map-menu-add-key-<section>`, `map-ontop-<key>` (row; the `role="switch"` button inside), `map-pack`, `map-menu-credit`, `map-sources-link`; on the chip: `map-chip-fallback`.
  - The anchor never sets `position`; each view's class does.

- [ ] **Step 1: Write the failing component test**

Create `apps/desktop/src/renderer/maps/MapMenu.test.tsx`:

```tsx
// @vitest-environment jsdom
import { ONLINE_SOURCES } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MapMenu, type MapMenuProps } from './MapMenu';
import { mapMenuModel } from './mapMenuModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe = () => undefined;
  unobserve = () => undefined;
  disconnect = () => undefined;
};

const model = (base: Parameters<typeof mapMenuModel>[1]['base'] = 'streets') =>
  mapMenuModel(
    'map',
    { base, onTop: { packs: true }, pack: null },
    ONLINE_SOURCES,
    { imagery: [{ id: 'site', label: 'Site imagery' }], terrain: 0 },
    { enabled: true, offlineOnly: false },
    { esri: false, mapbox: false },
  );

let host: HTMLDivElement;
let root: Root;
const handlers = () => ({
  onPick: vi.fn(),
  onToggle: vi.fn(),
  onPack: vi.fn(),
  onOpenSources: vi.fn(),
});
const render = (over: Partial<MapMenuProps> = {}) => {
  const h = handlers();
  act(() => {
    root.render(
      <MapMenu
        model={model()}
        testIds={{ chip: 'chip', pop: 'pop' }}
        className="test-anchor"
        place="free"
        {...h}
        {...over}
      />,
    );
  });
  return h;
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const open = () => act(() => q('chip')?.click());

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the Map menu', () => {
  it('shows the chosen map on the chip and opens the gallery as a dialog', () => {
    render();
    expect(q('chip')?.textContent).toContain('Streets');
    expect(q('chip')?.getAttribute('aria-expanded')).toBe('false');
    open();
    expect(q('pop')?.getAttribute('role')).toBe('dialog');
    expect(host.querySelectorAll('[role="radio"]')).toHaveLength(9);
    expect(q('map-tile-streets')?.getAttribute('aria-checked')).toBe('true');
    // focus goes to the map in use
    expect(document.activeElement).toBe(q('map-tile-streets'));
  });

  it('greys a Mapbox style without a key, with the reason in words and a way to Map sources', () => {
    const h = render();
    open();
    const tile = q('map-tile-mapbox-streets') as HTMLButtonElement;
    expect(tile.disabled).toBe(true);
    expect(tile.textContent).toContain('Key');
    expect(q('map-menu-note-mapbox')?.textContent).toContain('Add a key in Map sources');
    expect(tile.getAttribute('aria-describedby')).toBe(q('map-menu-note-mapbox')?.id);
    act(() => q('map-menu-add-key-mapbox')?.click());
    expect(h.onOpenSources).toHaveBeenCalledOnce();
    expect(q('pop')).toBeNull();
  });

  it('picks with a click, and with the arrows over the tiles that can be picked', () => {
    const h = render();
    open();
    act(() => q('map-tile-esri-world-imagery')?.click());
    expect(h.onPick).toHaveBeenLastCalledWith('esri-world-imagery');
    q('map-tile-streets')?.focus();
    act(() => {
      q('map-tile-streets')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    // the next tile that can be picked: Esri (the Mapbox satellite needs a key)
    expect(h.onPick).toHaveBeenLastCalledWith('esri-world-imagery');
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
    });
    expect(h.onPick).toHaveBeenLastCalledWith('s2cloudless-2016');
  });

  it('has the On top switches with their reasons, the pack picker, the credit and Map sources', () => {
    const h = render();
    open();
    const shading = q('map-ontop-hillshade');
    expect(shading?.querySelector('[role="switch"]')?.hasAttribute('disabled')).toBe(true);
    expect(shading?.textContent).toContain('No terrain pack covers this site');
    act(() => (q('map-ontop-streets')?.querySelector('[role="switch"]') as HTMLElement).click());
    expect(h.onToggle).toHaveBeenCalledWith('streets', false);
    const pick = q('map-pack') as HTMLSelectElement;
    act(() => {
      pick.value = 'site';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(h.onPack).toHaveBeenCalledWith('site');
    expect(q('map-menu-credit')?.textContent).toBe('© OpenStreetMap contributors');
    act(() => q('map-sources-link')?.click());
    expect(h.onOpenSources).toHaveBeenCalledOnce();
  });

  it('notes a fallback on the chip, and closes with Esc back to the chip', () => {
    render({ model: model('mapbox-dark') });
    expect(q('map-chip-fallback')?.textContent).toBe('Offline map');
    open();
    act(() => {
      q('pop')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(q('pop')).toBeNull();
    expect(document.activeElement).toBe(q('chip'));
  });

  it('shows what a view adds: the notice and its own block', () => {
    render({
      notice: <p data-testid="the-notice">ask</p>,
      extra: <p data-testid="the-extra">key</p>,
    });
    open();
    expect(q('the-notice')).not.toBeNull();
    expect(q('the-extra')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/renderer/maps/MapMenu.test.tsx`
Expected: FAIL, cannot find module `./MapMenu`.

- [ ] **Step 3: Implement the swatches**

Create `apps/desktop/src/renderer/maps/MapSwatch.tsx`:

```tsx
/**
 * The small pictures of the Map menu. Drawn here, not rendered from tiles: they show before any
 * tile loads and for a map that cannot be drawn yet (no key, offline-only). Each keeps its map's
 * own colours, the same in both app themes.
 */
import type { ReactNode } from 'react';
import type { SwatchKind } from './mapMenuModel';

const FIELDS = (
  <>
    <rect width="44" height="44" fill="#46563a" />
    <path d="M0 0H16L13 12H0Z" fill="#5d6b40" />
    <path d="M16 0H31L29 11L13 12Z" fill="#8a7a58" />
    <path d="M31 0H44V10L29 11Z" fill="#4c5f3d" />
    <path d="M0 12H13L11 24H0Z" fill="#9a8a63" />
    <path d="M13 12L29 11L27 25L11 24Z" fill="#53663c" />
    <path d="M29 11L44 10V24L27 25Z" fill="#746f47" />
    <path d="M0 34C9 30 15 40 26 36S40 32 44 37V44H0Z" fill="#20424c" />
    <g fill="#2f4029">
      <circle cx="5" cy="5" r="2" />
      <circle cx="8" cy="7.5" r="1.6" />
      <circle cx="36" cy="18" r="2" />
      <circle cx="21" cy="20" r="1.6" />
    </g>
  </>
);

const BODY: Record<SwatchKind, ReactNode> = {
  streets: (
    <>
      <rect width="44" height="44" fill="#16191d" />
      <path d="M29 0H40V8H29Z" fill="#18241f" />
      <path d="M0 34C9 30 15 40 26 36S40 32 44 37V44H0Z" fill="#0e1d28" />
      <path d="M0 9H44M0 20H44M9 0V31M20 0V34M31 0V34" stroke="#343a40" strokeWidth="1" />
      <path d="M-1 27L16 14L45 6" fill="none" stroke="#59616a" strokeWidth="2.2" />
      <rect x="21" y="3" width="7" height="1.8" rx="0.9" fill="#8d949c" />
      <rect x="10" y="23" width="6" height="1.8" rx="0.9" fill="#8d949c" />
    </>
  ),
  'natural-earth': (
    <>
      <rect width="44" height="44" fill="#1d3a52" />
      <path d="M3 10C9 6 17 8 21 13S19 25 13 27S2 22 3 10Z" fill="#6f7d4f" />
      <path d="M24 17C30 13 40 15 42 22S36 35 29 34S20 23 24 17Z" fill="#9b8d62" />
      <path d="M27 21C31 20 35 22 35 26S31 30 28 28Z" fill="#7d8a55" />
      <path d="M0 0H44V4C34 6 12 6 0 4Z" fill="#d8dde0" />
    </>
  ),
  imagery: FIELDS,
  'imagery-labels': (
    <>
      {FIELDS}
      <path d="M-1 27L16 14L45 6" fill="none" stroke="#f2c14e" strokeWidth="1.6" />
      <path d="M20 0V44" stroke="#e8e4da" strokeWidth="1" strokeOpacity="0.8" />
      <rect x="23" y="3" width="8" height="2" rx="1" fill="#ffffff" />
      <rect x="6" y="21" width="7" height="2" rx="1" fill="#ffffff" />
    </>
  ),
  'mapbox-streets': (
    <>
      <rect width="44" height="44" fill="#f4f3ef" />
      <path d="M28 0H40V9H28Z" fill="#c8e6b5" />
      <path d="M0 34C9 30 15 40 26 36S40 32 44 37V44H0Z" fill="#aad3df" />
      <path d="M0 9H44M0 20H44M9 0V31M20 0V34M31 0V34" stroke="#ffffff" strokeWidth="2" />
      <path d="M-1 27L16 14L45 6" fill="none" stroke="#f6c86b" strokeWidth="2.6" />
      <rect x="21" y="3" width="7" height="1.8" rx="0.9" fill="#6b6b6b" />
      <rect x="10" y="23" width="6" height="1.8" rx="0.9" fill="#6b6b6b" />
    </>
  ),
  outdoors: (
    <>
      <rect width="44" height="44" fill="#eef0e6" />
      <path d="M0 0H18C14 8 6 12 0 14Z" fill="#b7d3a0" />
      <g fill="none" stroke="#c9b99a" strokeWidth="0.9">
        <path d="M6 44C10 32 22 26 34 28S44 22 44 18" />
        <path d="M12 44C15 35 24 31 34 33S44 28 44 25" />
        <path d="M19 44C21 39 27 36 35 38S44 34 44 32" />
      </g>
      <path d="M30 0C28 6 32 10 30 16" fill="none" stroke="#9ccbe0" strokeWidth="1.8" />
      <path
        d="M2 30L14 22L26 20L42 8"
        fill="none"
        stroke="#c96f53"
        strokeWidth="1.2"
        strokeDasharray="2 1.6"
      />
    </>
  ),
  light: (
    <>
      <rect width="44" height="44" fill="#f2f2f0" />
      <path d="M0 34C9 30 15 40 26 36S40 32 44 37V44H0Z" fill="#d4dadf" />
      <path d="M0 9H44M0 20H44M9 0V31M20 0V34M31 0V34" stroke="#ffffff" strokeWidth="1.6" />
      <path d="M-1 27L16 14L45 6" fill="none" stroke="#ffffff" strokeWidth="2.6" />
      <rect x="21" y="3" width="7" height="1.8" rx="0.9" fill="#9a9a9a" />
    </>
  ),
  dark: (
    <>
      <rect width="44" height="44" fill="#1f2124" />
      <path d="M0 34C9 30 15 40 26 36S40 32 44 37V44H0Z" fill="#141518" />
      <path d="M0 9H44M0 20H44M9 0V31M20 0V34M31 0V34" stroke="#2f3236" strokeWidth="1.4" />
      <path d="M-1 27L16 14L45 6" fill="none" stroke="#3d4147" strokeWidth="2.6" />
      <rect x="21" y="3" width="7" height="1.8" rx="0.9" fill="#7d8188" />
    </>
  ),
};

export function MapSwatch({ kind, className = '' }: { kind: SwatchKind; className?: string }) {
  return (
    <svg
      className={`mm-swatch ${className}`.trim()}
      viewBox="0 0 44 44"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      focusable="false"
    >
      {BODY[kind]}
    </svg>
  );
}
```

- [ ] **Step 4: Implement the component**

Create `apps/desktop/src/renderer/maps/MapMenu.tsx`:

```tsx
/**
 * The Map menu (plan 2026-10-14-satellite-providers; the founder's Gallery layout, 14 Oct 2026):
 * a chip with the current map's picture and name, and a pop with the base maps as small pictures
 * grouped by source (Offline, Online satellite, Mapbox styles), the On top switches and a footer
 * with the credit line and a way to Settings, Map sources. One component for the Map view, the
 * Globe and the 3D scene; each view hands it the model (`mapMenuModel`) and what a pick does.
 *
 * Keyboard: the tiles are one radio group (arrows and Home/End move to the next tile that can be
 * picked and pick it), Tab moves between the group, the switches and the footer, Esc closes and
 * focus returns to the chip.
 */
import type { BaseMapId } from '@aio/schema';
import { Icon, Switch, useFocusTrap, useT } from '@aio/ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { usePopPlacement } from '../workspace/popPlacement';
import { MapSwatch } from './MapSwatch';
import type { MapMenuModel, MenuTile, OnTopKey } from './mapMenuModel';
import './mapMenu.css';

export interface MapMenuProps {
  model: MapMenuModel;
  testIds: { chip: string; pop: string };
  /** The anchor's class: the view places the chip with it. */
  className: string;
  /** More classes on the chip (the Globe keeps the surface of its buttons). */
  chipClassName?: string;
  /** `stage`: the pop stays on the stage (`usePopPlacement`); `free`: the view's CSS places it. */
  place: 'stage' | 'free';
  /** Over the map or the 3D view: dark in every theme. */
  dark?: boolean;
  onPick: (id: BaseMapId) => void;
  onToggle: (key: OnTopKey, on: boolean) => void;
  onPack: (id: string | null) => void;
  onOpenSources: () => void;
  /** The provider's notice while a first pick waits for the person's answer. */
  notice?: ReactNode;
  /** The view's own block under On top (the Globe's key to its pin colours). */
  extra?: ReactNode;
}

export function MapMenu(p: MapMenuProps) {
  const t = useT();
  const { model } = p;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const ids = useId();
  usePopPlacement(open && p.place === 'stage', anchor, pop);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('pointerdown', away);
    };
  }, [open]);
  useFocusTrap(pop, open, {
    onEscape: () => {
      setOpen(false);
    },
    initial: () => pop.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') ?? null,
    returnTo: () => chip.current,
  });

  const pickable = model.sections.flatMap((s) => s.tiles).filter((x) => x.state === 'available');
  const roving = (pickable.find((x) => x.selected) ?? pickable[0])?.id;
  const leave = () => {
    setOpen(false);
    p.onOpenSources();
  };

  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    const current = (e.target as HTMLElement).dataset.base;
    const at = pickable.findIndex((x) => x.id === current);
    const next =
      e.key === 'Home'
        ? pickable[0]
        : e.key === 'End'
          ? pickable.at(-1)
          : step
            ? pickable[(at + step + pickable.length) % pickable.length]
            : undefined;
    if (!next) return;
    e.preventDefault();
    p.onPick(next.id);
    group.current?.querySelector<HTMLElement>(`[data-base="${next.id}"]`)?.focus();
  };

  const name = t(model.chip);
  return (
    <div
      ref={anchor}
      className={`mm-anchor ${p.className}`}
      data-open={open || undefined}
      data-surface={p.dark ? 'dark' : undefined}
    >
      <button
        ref={chip}
        type="button"
        className={`mm-chip ${p.chipClassName ?? ''}`.trim()}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('mapMenu.button', { name })}
        title={open ? undefined : t('mapMenu.title')}
        data-base={model.chosen}
        data-testid={p.testIds.chip}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <MapSwatch kind={model.chipSwatch} className="mm-chip-pic" />
        <span className="mm-chip-l">{name}</span>
        {model.fallback && (
          <span
            className="mm-chip-note"
            title={t('mapMenu.fallback.tip')}
            data-testid="map-chip-fallback"
          >
            {t('mapMenu.fallback')}
          </span>
        )}
        <Icon name="chevdown" size={12} className="muted" />
      </button>
      {open && (
        <div
          ref={pop}
          className="mm-pop"
          role="dialog"
          aria-label={t('mapMenu.title')}
          data-testid={p.testIds.pop}
        >
          <div
            ref={group}
            className="mm-tiles"
            role="radiogroup"
            aria-label={t('mapMenu.title')}
            onKeyDown={onKeys}
          >
            {model.sections.map((s) => {
              const noteId = s.note ? `${ids}-${s.id}-note` : undefined;
              return (
                <section key={s.id} className="mm-sec" aria-labelledby={`${ids}-${s.id}`}>
                  <h3 className="mm-sec-t" id={`${ids}-${s.id}`}>
                    {t(s.title)}
                  </h3>
                  <div className="mm-grid">
                    {s.tiles.map((tile) => (
                      <Tile
                        key={tile.id}
                        tile={tile}
                        roving={tile.id === roving}
                        noteId={noteId}
                        onPick={p.onPick}
                      />
                    ))}
                  </div>
                  {s.note && (
                    <p className="mm-note" id={noteId} data-testid={`map-menu-note-${s.id}`}>
                      {t(s.note)}
                      {s.note === 'mapMenu.reason.needsKey' && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="mm-link"
                            data-testid={`map-menu-add-key-${s.id}`}
                            onClick={leave}
                          >
                            {t('mapMenu.sources')}
                          </button>
                        </>
                      )}
                    </p>
                  )}
                </section>
              );
            })}
          </div>
          {p.notice}
          <section className="mm-sec mm-ontop" aria-labelledby={`${ids}-ontop`}>
            <h3 className="mm-sec-t" id={`${ids}-ontop`}>
              {t('mapMenu.section.onTop')}
            </h3>
            {model.onTop.map((r) => (
              <div
                key={r.key}
                className="mm-row"
                data-testid={`map-ontop-${r.key}`}
                data-disabled={r.disabled || undefined}
              >
                <span className="mm-row-l">
                  <span>{t(r.label)}</span>
                  {r.reason && <span className="mm-row-why">{t(r.reason)}</span>}
                </span>
                <Switch
                  label={t(r.label)}
                  checked={r.on}
                  disabled={r.disabled}
                  onChange={(on) => {
                    p.onToggle(r.key, on);
                  }}
                />
              </div>
            ))}
            {model.showPackPicker && (
              <label className="mm-row mm-pack">
                <span className="mm-row-l">{t('mapMenu.pack')}</span>
                <select
                  className="input"
                  data-testid="map-pack"
                  value={model.pack ?? ''}
                  onChange={(e) => {
                    p.onPack(e.target.value || null);
                  }}
                >
                  <option value="">{t('mapMenu.pack.best')}</option>
                  {model.packs.map((pk) => (
                    <option key={pk.id} value={pk.id}>
                      {pk.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>
          {p.extra}
          <footer className="mm-foot">
            <span
              className="mm-credit"
              dir="ltr"
              title={model.credit}
              data-testid="map-menu-credit"
            >
              {model.credit}
            </span>
            <button
              type="button"
              className="mm-link"
              title={t('mapMenu.sources.tip')}
              data-testid="map-sources-link"
              onClick={leave}
            >
              {t('mapMenu.sources')}
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

function Tile({
  tile,
  roving,
  noteId,
  onPick,
}: {
  tile: MenuTile;
  roving: boolean;
  noteId: string | undefined;
  onPick: (id: BaseMapId) => void;
}) {
  const t = useT();
  const off = tile.state !== 'available';
  return (
    <button
      type="button"
      role="radio"
      className="mm-tile"
      aria-checked={tile.selected}
      disabled={off}
      tabIndex={roving ? 0 : -1}
      title={tile.reason ? t(tile.reason) : t(tile.label)}
      aria-describedby={off ? noteId : undefined}
      data-base={tile.id}
      data-state={tile.state}
      data-testid={`map-tile-${tile.id}`}
      onClick={() => {
        onPick(tile.id);
      }}
    >
      <span className="mm-pic">
        <MapSwatch kind={tile.swatch} />
        {tile.badge && <span className="mm-badge">{t(tile.badge)}</span>}
      </span>
      <span className="mm-tile-l">{t(tile.label)}</span>
    </button>
  );
}
```

If `useFocusTrap`'s `initial` option does not exist under that name in `packages/ui/src/focus.ts`, read the signature there and use its equivalent (the old `BasemapPicker.tsx` passed `initial`, so it does).

- [ ] **Step 5: Style the Gallery**

Create `apps/desktop/src/renderer/maps/mapMenu.css`:

```css
/* The Map menu (MapMenu.tsx): the founder's Gallery layout of 14 Oct 2026. A chip with the
   map's picture, and a 312 px pop: sections of 44 px pictures in four columns, the On top
   switches, and a footer with the credit and Map sources. Over the map and the 3D view the
   anchor carries data-surface="dark" and is dark in every theme; the pictures keep the maps' own
   colours. Each view places the anchor with its own class (the anchor sets no position). */

.mm-anchor[data-open] {
  z-index: 21;
}

.mm-chip {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 3px 8px 3px 3px;
  border: 1px solid var(--line);
  border-radius: var(--r-6);
  background: var(--bg-1);
  color: var(--fg-0);
  font: 500 var(--t-12) / 1 var(--f-ui);
  white-space: nowrap;
  box-shadow: 0 4px 12px var(--shadow);
  transition:
    border-color 120ms var(--ease),
    background-color 120ms var(--ease);
}
.mm-chip:hover {
  border-color: var(--line-strong);
}
.mm-chip:active {
  transform: translateY(0.5px);
}
.mm-chip[aria-expanded='true'] {
  border-color: var(--acc-a40);
}
.mm-chip-pic {
  width: 38px;
  height: 24px;
  border-radius: var(--r-2);
  box-shadow: 0 0 0 1px var(--line-strong);
}
.mm-chip-note {
  padding: 2px 5px;
  border-radius: var(--r-2);
  background: var(--acc-a12);
  color: var(--fg-1);
  font-size: var(--t-11);
  font-weight: 400;
}
.mm-swatch {
  display: block;
  flex: none;
}

.mm-pop {
  position: absolute;
  top: calc(100% + 8px);
  inset-inline-end: 0;
  z-index: 20;
  display: grid;
  gap: 12px;
  width: 312px;
  max-height: min(620px, calc(100vh - 120px));
  overflow-y: auto;
  padding: 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-6);
  background: var(--bg-1);
  color: var(--fg-1);
  font: 400 var(--t-12) / 1.35 var(--f-ui);
  box-shadow: 0 12px 32px var(--shadow);
  animation: mm-in 160ms var(--ease);
  transform-origin: top right;
}
@keyframes mm-in {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
}

.mm-tiles {
  display: grid;
  gap: 12px;
}
.mm-sec {
  display: grid;
  gap: 8px;
}
.mm-sec-t {
  margin: 0;
  color: var(--fg-3);
  font: 600 var(--t-11) / 1 var(--f-ui);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.mm-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px 6px;
}

.mm-tile {
  display: grid;
  justify-items: center;
  gap: 5px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--fg-2);
  font: inherit;
  font-size: var(--t-11);
  text-align: center;
  cursor: pointer;
}
.mm-pic {
  position: relative;
  width: 44px;
  height: 44px;
  overflow: hidden;
  border-radius: var(--r-4);
  box-shadow: 0 0 0 1px var(--line);
  transition:
    box-shadow 120ms var(--ease),
    transform 120ms var(--ease);
}
.mm-pic .mm-swatch {
  width: 44px;
  height: 44px;
}
.mm-tile:hover:not(:disabled) .mm-pic {
  box-shadow: 0 0 0 1px var(--line-strong);
  transform: translateY(-1px);
}
.mm-tile[aria-checked='true'] {
  color: var(--fg-0);
}
.mm-tile[aria-checked='true'] .mm-pic {
  /* the founder's mockup: a 2 px teal outline on the chosen map */
  box-shadow:
    0 0 0 2px var(--bg-1),
    0 0 0 4px var(--acc);
}
.mm-tile:focus-visible {
  outline: none;
}
.mm-tile:focus-visible .mm-pic {
  box-shadow:
    0 0 0 2px var(--bg-1),
    0 0 0 4px var(--acc-strong);
}
.mm-tile:disabled {
  cursor: default;
}
.mm-tile:disabled .mm-pic,
.mm-tile:disabled .mm-tile-l {
  opacity: 0.45;
}
.mm-tile-l {
  display: -webkit-box;
  max-width: 100%;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-height: 1.2;
}
.mm-badge {
  position: absolute;
  inset-inline: 2px;
  bottom: 2px;
  padding: 1px 0;
  border-radius: var(--r-2);
  background: oklch(0.18 0.01 250 / 0.82);
  color: #f2f4f6;
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1.2;
}
.mm-note {
  margin: 0;
  color: var(--fg-3);
  font-size: var(--t-11);
}

.mm-ontop {
  gap: 4px;
  padding-top: 10px;
  border-top: 1px solid var(--line-soft);
}
.mm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 30px;
}
.mm-row-l {
  display: grid;
  gap: 1px;
  color: var(--fg-1);
}
.mm-row[data-disabled] .mm-row-l > span:first-child {
  color: var(--fg-3);
}
.mm-row-why {
  color: var(--fg-3);
  font-size: var(--t-11);
}
.mm-pack select {
  max-width: 160px;
}

.mm-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line-soft);
}
.mm-credit {
  min-width: 0;
  overflow: hidden;
  color: var(--fg-3);
  font-size: var(--t-11);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mm-link {
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  color: var(--acc-strong);
  font: inherit;
  font-size: var(--t-11);
  cursor: pointer;
}
.mm-link:hover {
  text-decoration: underline;
}

@media (prefers-reduced-motion: reduce) {
  .mm-pop {
    animation: none;
  }
  .mm-chip,
  .mm-pic {
    transition: none;
  }
}
@media (forced-colors: active) {
  .mm-chip,
  .mm-pop {
    border: 1px solid CanvasText;
  }
  .mm-tile[aria-checked='true'] .mm-pic {
    outline: 2px solid Highlight;
    outline-offset: 2px;
  }
  .mm-tile:disabled .mm-tile-l {
    color: GrayText;
  }
}
```

Polish within the layout with the `impeccable` skill (spacing rhythm, label clamp, badge contrast), then screenshot the component in the app (Task 12 mounts it; until then a jsdom test is enough). Check the strings: no em or en dashes.

- [ ] **Step 6: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/renderer/maps`
Expected: PASS.
Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/maps/MapSwatch.tsx apps/desktop/src/renderer/maps/MapMenu.tsx apps/desktop/src/renderer/maps/mapMenu.css apps/desktop/src/renderer/maps/MapMenu.test.tsx
git commit -m "feat(desktop): the Map menu, one Gallery for every view" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Renderer online state

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it (not needed here); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Packages:** `apps/desktop` (renderer/workspace).

**Files:**

- Modify: `apps/desktop/src/renderer/workspace/siteTiles.ts` (prefs, state, `setOnline`, `refresh`, `useBasemap`, `useGround`, `useSiteSurroundings`)
- Modify: `apps/desktop/src/renderer/workspace/siteTiles.test.ts`
- Modify: `apps/desktop/src/renderer/workspace/basemap.ts` (`BasemapPrefs`, `BasemapDraw`, `BasemapModel`, `basemapModel`, `groundModel`)
- Modify: `apps/desktop/src/renderer/workspace/basemap.test.ts`
- Modify: `apps/desktop/src/renderer/workspace/onlineSatellite.ts` (per-provider notice, `pickBase`), create `apps/desktop/src/renderer/workspace/onlineSatellite.test.ts`
- Modify: `apps/desktop/src/renderer/workspace/OnlineSatelliteNotice.tsx` (text per provider)
- Modify: `apps/desktop/src/renderer/workspace/siteBasemap.ts:216-229` (`landscapeOn`)

**Interfaces:**

- Consumes: Task 1 (`BaseMapId`, `isOnlineBase`, `onlineSource`, `DEFAULT_ONLINE_SOURCE`, `MapKeysStatus`, IPC `onlineTiles:set`, `mapKeys:status`), Task 6 (`RasterPackDisplay.online: OnlineSourceId | null`), Task 8 (`createOnlineTileSource`), Task 9 (`drawnBase`, strings `online.notice.*`, `online.confirm`, `online.cancel`).
- Produces (used by Tasks 12 to 14):
  - `RasterPrefs.mapBase: BaseMapId | null`, `RasterPrefs.sceneBase: BaseMapId | null` (stored; null until chosen in a Map menu); `RasterPrefs.onlineSatellite` keeps its name and now means "online maps on" (main's `enabled`).
  - `RasterState.online: { source: OnlineSourceId; keys: MapKeysStatus }`; `RasterState.setOnline(patch: { enabled?: boolean; source?: OnlineSourceId }): Promise<string | null>` (replaces `setOnlineSatellite`); `refresh()` also reads `mapKeys:status`.
  - `basemap.ts`: `BasemapPrefs.mapBase?: BaseMapId | null`; `interface BasemapOnline { source: OnlineSourceId; keys: MapKeysStatus; offlineOnly: boolean }`; `NO_ONLINE: BasemapOnline`; `resolveMapBase(prefs, online): BaseMapId`; `basemapModel(prefs, imagery, terrain, site, online = NO_ONLINE)` whose model adds `base: BaseMapId`, `drawn: BaseMapId`, `fallback: boolean`, and whose `draw.online` is `OnlineSourceId | null`, `draw.satellite` means "imagery packs drawn"; `groundModel(imagery, terrain, site, offered, online = false)` adds `online: boolean`.
  - `onlineSatellite.ts`: `onlineNoticeSeen(provider: OnlineProvider = 'eox'): boolean`; `onlineSatelliteSwitch` with `asking: OnlineSourceId | null`, `request(on: boolean, source?: OnlineSourceId, then?: () => void)`, `confirm()`, `cancel()`; `pickBase(id: BaseMapId, apply: (id: BaseMapId) => void): void`.
  - `useBasemap()` reads offline-only itself; `useGround()` sets `online` when the 3D scene draws an online base.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/renderer/workspace/onlineSatellite.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineNoticeSeen, onlineSatelliteSwitch, pickBase } from './onlineSatellite';
import { rasterPacks } from './siteTiles';

const g = globalThis as { aio?: unknown };

function fakeAio() {
  const sent: { channel: string; req: unknown }[] = [];
  g.aio = {
    invoke: vi.fn((channel: string, req: { enabled?: boolean; source?: string }) => {
      sent.push({ channel, req });
      if (channel === 'onlineTiles:set')
        return Promise.resolve({
          ok: true,
          enabled: req.enabled ?? true,
          source: req.source ?? 'esri-world-imagery',
        });
      return Promise.resolve(null);
    }),
    on: vi.fn(),
  };
  return sent;
}

beforeEach(() => {
  localStorage.clear();
  rasterPacks.getState().setForSession({ onlineSatellite: false });
});
afterEach(() => {
  onlineSatelliteSwitch.getState().cancel();
  delete g.aio;
});

describe('one notice per provider', () => {
  it('counts the notice of 0.11 as the EOX one only', () => {
    localStorage.setItem('stratlas.onlineSatelliteNotice', '1');
    expect(onlineNoticeSeen('eox')).toBe(true);
    expect(onlineNoticeSeen()).toBe(true);
    expect(onlineNoticeSeen('esri')).toBe(false);
  });

  it('picking Esri the first time asks, and switches online maps on with Esri only on yes', async () => {
    const sent = fakeAio();
    const apply = vi.fn();
    pickBase('esri-world-imagery', apply);
    expect(onlineSatelliteSwitch.getState().asking).toBe('esri-world-imagery');
    expect(sent).toEqual([]);
    onlineSatelliteSwitch.getState().confirm();
    await vi.waitFor(() => {
      expect(apply).toHaveBeenCalledWith('esri-world-imagery');
    });
    expect(sent).toEqual([
      { channel: 'onlineTiles:set', req: { enabled: true, source: 'esri-world-imagery' } },
    ]);
    expect(onlineNoticeSeen('esri')).toBe(true);
    expect(onlineNoticeSeen('mapbox')).toBe(false);
    expect(rasterPacks.getState().prefs.onlineSatellite).toBe(true);
  });

  it('a Mapbox style switches online maps on and keeps the online satellite as it was', async () => {
    const sent = fakeAio();
    localStorage.setItem('stratlas.onlineNotice.mapbox', '1');
    const apply = vi.fn();
    pickBase('mapbox-dark', apply);
    await vi.waitFor(() => {
      expect(apply).toHaveBeenCalledWith('mapbox-dark');
    });
    expect(sent[0]?.req).toEqual({ enabled: true });
  });

  it('Cancel switches nothing on and applies nothing', () => {
    fakeAio();
    const apply = vi.fn();
    pickBase('mapbox-satellite', apply);
    onlineSatelliteSwitch.getState().cancel();
    expect(apply).not.toHaveBeenCalled();
    expect(rasterPacks.getState().prefs.onlineSatellite).toBe(false);
  });

  it('an offline base map is applied at once, and so is a source already allowed', () => {
    const apply = vi.fn();
    pickBase('streets', apply);
    expect(apply).toHaveBeenLastCalledWith('streets');
    localStorage.setItem('stratlas.onlineNotice.esri', '1');
    rasterPacks.getState().setForSession({ onlineSatellite: true });
    pickBase('esri-world-imagery', apply);
    expect(apply).toHaveBeenLastCalledWith('esri-world-imagery');
  });
});
```

Append to `apps/desktop/src/renderer/workspace/basemap.test.ts` (and import `NO_ONLINE`, `resolveMapBase`):

```ts
describe('the base map of the Map menu', () => {
  const S2 = { ...NO_ONLINE, source: 's2cloudless-2016' as const };

  it('legacy Satellite with online on draws the preferred source; Streets draws none', () => {
    const m = basemapModel(prefs({ onlineSatellite: true }), [], [], SITE, S2);
    expect(m.base).toBe('s2cloudless-2016');
    expect(m.draw.online).toBe('s2cloudless-2016');
    expect(resolveMapBase(prefs({ satellite: false, onlineSatellite: true }), S2)).toBe('streets');
    expect(
      basemapModel(prefs({ satellite: false, onlineSatellite: true }), [], [], SITE, S2).draw
        .online,
    ).toBeNull();
  });

  it('an explicit base wins; a map with its own labels hides the street overlay', () => {
    const keys = { esri: false, mapbox: true };
    const m = basemapModel(
      prefs({ onlineSatellite: true, mapBase: 'mapbox-satellite-streets' }),
      [here],
      [],
      SITE,
      { ...NO_ONLINE, keys },
    );
    expect(m.draw).toMatchObject({
      online: 'mapbox-satellite-streets',
      streets: false,
      satellite: true,
    });
  });

  it('falls back to the street map when the key goes', () => {
    const m = basemapModel(
      prefs({ onlineSatellite: true, mapBase: 'mapbox-dark' }),
      [],
      [],
      SITE,
      NO_ONLINE,
    );
    expect(m).toMatchObject({ base: 'mapbox-dark', drawn: 'streets', fallback: true });
    expect(m.draw.online).toBeNull();
    expect(m.draw.streets).toBe(true);
  });

  it('offline-only with online maps on draws the saved Sentinel-2 tiles', () => {
    const m = basemapModel(
      prefs({ onlineSatellite: true, mapBase: 'esri-world-imagery' }),
      [],
      [],
      SITE,
      { ...NO_ONLINE, offlineOnly: true },
    );
    expect(m).toMatchObject({ drawn: 's2cloudless-2016', fallback: true });
    expect(m.draw.online).toBe('s2cloudless-2016');
  });

  it('packs on top of Esri; street names over imagery follow the switch', () => {
    const m = basemapModel(
      prefs({ onlineSatellite: true, mapBase: 'esri-world-imagery', streets: false }),
      [here],
      [],
      SITE,
      NO_ONLINE,
    );
    expect(m.draw).toMatchObject({ online: 'esri-world-imagery', satellite: true, streets: false });
    expect(m.draw.imagery.map((p) => p.id)).toEqual(['here']);
  });

  it('Place walk on a site without packs still shows imagery (Satellite for the session)', () => {
    const m = basemapModel(
      prefs({ satellite: true, onlineSatellite: true }),
      [],
      [],
      SITE,
      NO_ONLINE,
    );
    expect(m.satellite).toBe(true);
    expect(m.draw.online).toBe('esri-world-imagery');
  });
});

describe('the ground with an online base in 3D', () => {
  it('says when an online map is drawn around the site', () => {
    expect(groundModel([], [], SITE, true, true)).toMatchObject({ online: true, imagery: false });
    expect(groundModel([here], [dem], SITE, true)).toMatchObject({ online: false });
  });
});
```

Also adjust the existing expectations in `basemap.test.ts`: in `describe('with online satellite switched on')` pass `{ ...NO_ONLINE, source: 's2cloudless-2016' }` as the fifth argument of every `basemapModel` call and expect `draw.satellite` to be `true` only where a covering pack is drawn (it now means "imagery packs drawn"); in `describe('the ground around the site in 3D')` add `online: false` to the `toEqual` object.

In `apps/desktop/src/renderer/workspace/siteTiles.test.ts` rename the calls `setOnlineSatellite(true)` / `(false)` to `setOnline({ enabled: true })` / `setOnline({ enabled: false })`, and append:

```ts
it('reads the source and which map keys this computer holds on refresh', async () => {
  g.aio = {
    invoke: vi.fn((channel: string) => {
      if (channel === 'onlineTiles:status')
        return Promise.resolve({
          enabled: true,
          source: 'mapbox-satellite',
          cache: { bytes: 0, tiles: 0, capBytes: 1 },
        });
      if (channel === 'mapKeys:status') return Promise.resolve({ esri: false, mapbox: true });
      return Promise.resolve({ ok: true, packs: [] });
    }),
  };
  rasterPacks.getState().refresh();
  await vi.waitFor(() => {
    expect(rasterPacks.getState().online).toEqual({
      source: 'mapbox-satellite',
      keys: { esri: false, mapbox: true },
    });
  });
});

it('keeps the base maps chosen in the Map menus, and ignores one it does not know', () => {
  rasterPacks.getState().set({ mapBase: 'esri-world-imagery', sceneBase: 'mapbox-dark' });
  expect(JSON.parse(localStorage.getItem('stratlas.rasterPacks') ?? '{}')).toMatchObject({
    mapBase: 'esri-world-imagery',
    sceneBase: 'mapbox-dark',
  });
});
```

`siteTiles.test.ts` runs in node: add `// @vitest-environment jsdom` as its first line so `localStorage` exists (the existing tests do not depend on the environment).

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/renderer/workspace/onlineSatellite.test.ts apps/desktop/src/renderer/workspace/basemap.test.ts apps/desktop/src/renderer/workspace/siteTiles.test.ts`
Expected: FAIL (`pickBase` is not exported, `NO_ONLINE` is not exported, `setOnline` is not a function).

- [ ] **Step 3: Implement basemap.ts**

In `apps/desktop/src/renderer/workspace/basemap.ts`:

Imports become:

```ts
import { frameProjection, orderPacks, packCovers } from '@aio/maps';
import {
  DEFAULT_ONLINE_SOURCE,
  isOnlineBase,
  onlineSatelliteAvailability,
  onlineSource,
  type BaseMapId,
  type MapKeysStatus,
  type OnlineSatelliteAvailability,
  type OnlineSourceId,
  type ProjectManifest,
  type RasterPackInfo,
} from '@aio/schema';
import { drawnBase } from '../maps/mapMenuModel';
```

`BasemapPrefs` gains (and its doc lines change to say `satellite` is "imagery packs on top" and `onlineSatellite` is "online maps switched on"):

```ts
  /** The base map chosen in the Map menu; null until one is chosen there. */
  mapBase?: BaseMapId | null;
```

Add after `BasemapPrefs`:

```ts
/** What the model needs to know about online maps beside the switch. */
export interface BasemapOnline {
  /** The online satellite main has for this workstation. */
  source: OnlineSourceId;
  keys: MapKeysStatus;
  offlineOnly: boolean;
}

export const NO_ONLINE: BasemapOnline = {
  source: DEFAULT_ONLINE_SOURCE,
  keys: { esri: false, mapbox: false },
  offlineOnly: false,
};

/**
 * The Map view's base map: the one chosen in the Map menu, or, never chosen there, what 0.11's map
 * type showed: the online satellite under Satellite once online maps were on, else the street map.
 */
export function resolveMapBase(
  prefs: Pick<BasemapPrefs, 'mapBase' | 'satellite' | 'onlineSatellite'>,
  online: Pick<BasemapOnline, 'source'>,
): BaseMapId {
  if (prefs.mapBase) return prefs.mapBase;
  return prefs.satellite && prefs.onlineSatellite ? online.source : 'streets';
}
```

In `BasemapDraw` change the doc of `satellite` to "Imagery packs are drawn." and `online` to `online: OnlineSourceId | null;` ("The online source drawn under the packs, or null."). In `BasemapModel` add:

```ts
/** The base map chosen (or derived from 0.11's choices). */
base: BaseMapId;
/** The base map drawn: the chosen one, or saved Sentinel-2 or the street map in its place. */
drawn: BaseMapId;
/** The chosen base cannot be drawn now. */
fallback: boolean;
```

Replace `basemapModel` with:

```ts
export function basemapModel(
  prefs: BasemapPrefs,
  imagery: readonly RasterPackInfo[],
  terrain: readonly RasterPackInfo[],
  site: LonLat | null,
  online: BasemapOnline = NO_ONLINE,
): BasemapModel {
  const packs = coveringPacks(imagery, site);
  const relief = coveringPacks(terrain, site);
  const onlineOn = prefs.onlineSatellite;
  const satellite = packs.length > 0 || onlineOn;
  const hillshade = relief.length > 0;
  const one = packs.find((p) => p.id === prefs.imageryPack) ?? null;
  const hillshadeOn = prefs.hillshade && hillshade;
  const base = resolveMapBase(prefs, online);
  const drawn = drawnBase(
    base,
    { enabled: onlineOn, offlineOnly: online.offlineOnly },
    online.keys,
  );
  const drawnSource = isOnlineBase(drawn.base) ? onlineSource(drawn.base) : undefined;
  const packsOn = prefs.satellite && packs.length > 0;
  const imageryUnder = packsOn || (drawnSource?.imagery ?? false);
  // a map with its own street names hides ours; over imagery they follow the switch
  const streets = drawnSource?.labels ? false : imageryUnder ? prefs.streets : true;
  // 0.11's map type, for the picker and the palette until they move to the Map menu (Task 12)
  const choice: Basemap = !(prefs.satellite && satellite)
    ? 'streets'
    : prefs.streets
      ? 'satellite'
      : 'imagery';
  return {
    choice,
    satellite,
    online: onlineOn,
    packs,
    pack: one?.id ?? null,
    hillshade,
    hillshadeOn,
    base,
    drawn: drawn.base,
    fallback: drawn.fallback,
    draw: {
      imagery: !packsOn ? [] : one ? [one] : [...imagery],
      terrain: hillshadeOn ? relief : [],
      satellite: packsOn,
      hillshade: hillshadeOn,
      streets,
      online: drawnSource ? drawnSource.id : null,
    },
  };
}
```

Change `GroundModel` and `groundModel`:

```ts
export interface GroundModel {
  /** The graphics preset offers terrain and imagery around the site (Medium and up). */
  offered: boolean;
  /** A pack covers the site. */
  imagery: boolean;
  terrain: boolean;
  /** An online map is drawn around the site (the 3D scene's base map). */
  online: boolean;
}

export function groundModel(
  imagery: readonly RasterPackInfo[],
  terrain: readonly RasterPackInfo[],
  site: LonLat | null,
  offered: boolean,
  online = false,
): GroundModel {
  return {
    offered,
    imagery: site !== null && coveringPacks(imagery, site).length > 0,
    terrain: site !== null && coveringPacks(terrain, site).length > 0,
    online: offered && site !== null && online,
  };
}
```

In `apps/desktop/src/renderer/workspace/siteBasemap.ts` `landscapeOn` becomes:

```ts
export function landscapeOn(
  prefs: { aroundTerrain: boolean; aroundImagery: boolean },
  ground: GroundModel,
): boolean {
  return (
    ground.offered &&
    (ground.online ||
      (prefs.aroundTerrain && ground.terrain) ||
      (prefs.aroundImagery && ground.imagery))
  );
}
```

(and its comment: "Imagery or terrain around the site is drawn (from packs, or an online map as the 3D scene's base)").

- [ ] **Step 4: Implement siteTiles.ts**

In `apps/desktop/src/renderer/workspace/siteTiles.ts`:

- Imports: add `BaseMapId`, `DEFAULT_ONLINE_SOURCE`, `isOnlineBase`, `type MapKeysStatus`, `type OnlineSourceId` from `@aio/schema`; add `createOnlineTileSource` to the `@aio/tiles` import; add `import { workspace } from '@aio/workspace';` beside `assetUrl, useWorkspace`; add `import { drawnBase } from '../maps/mapMenuModel';` and `import { getShell, useShellStore } from '../store';` (not `../shell`, which reads `window.aio` when imported and breaks the node tests).
- `RasterPrefs` gains:

```ts
/** The Map view's base map chosen in the Map menu (null until chosen: 0.11's choices decide). */
mapBase: BaseMapId | null;
/** The 3D scene's base map chosen in its Map menu (null: the street map under the site). */
sceneBase: BaseMapId | null;
```

and the doc of `onlineSatellite` becomes "Online maps are switched on (main's `online.json`, ADR 0007 amended 10 and 14 Oct 2026); this copy follows main on every refresh. Change it with `setOnline`, which asks main first."

- `DEFAULTS` gains `mapBase: null, sceneBase: null`. In `readPrefs`: `type Flag = Exclude<keyof RasterPrefs, 'imageryPack' | 'mapBase' | 'sceneBase'>;` and add

```ts
      mapBase: BaseMapId.safeParse(v.mapBase).success ? (v.mapBase as BaseMapId) : null,
      sceneBase: BaseMapId.safeParse(v.sceneBase).success ? (v.sceneBase as BaseMapId) : null,
```

- `RasterState`: replace `setOnlineSatellite` with

```ts
  /** The online source main has and which map keys this computer holds (never a key). */
  online: { source: OnlineSourceId; keys: MapKeysStatus };
  /**
   * Switch online maps on or off, or choose the online satellite: main first (it refuses every
   * tile until its switch is on), then the layer. Answers an error message, or null when done.
   */
  setOnline(patch: { enabled?: boolean; source?: OnlineSourceId }): Promise<string | null>;
```

- In the store: initial `online: { source: DEFAULT_ONLINE_SOURCE, keys: { esri: false, mapbox: false } },`; in `set` make `const picked = 'satellite' in patch || 'streets' in patch || 'mapBase' in patch;`; replace `setOnlineSatellite` with

```ts
  async setOnline(patch) {
    const bridge = aio();
    if (!bridge) return 'Settings are not available.';
    try {
      const r = await bridge.invoke('onlineTiles:set', patch);
      if (!r.ok) return r.error;
      set({ online: { ...get().online, source: r.source } });
      get().set({ onlineSatellite: r.enabled });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },
```

and in `refresh()` add `bridge.invoke('mapKeys:status', {}).catch(() => null),` to the `Promise.all`, destructure it as `keys`, and after the existing `set({...})` add

```ts
if (status || keys)
  set({
    online: {
      source: status?.source ?? get().online.source,
      keys: keys ?? get().online.keys,
    },
  });
```

and change the switch line to `const online = status?.enabled === true;` (Task 1 did) keeping the follow-main logic.

- `useBasemap` reads the online state and offline-only:

```ts
export function useBasemap(): BasemapModel {
  const prefs = useRasterPacks((s) => s.prefs);
  const imagery = useRasterPacks((s) => s.imagery);
  const terrain = useRasterPacks((s) => s.terrain);
  const online = useRasterPacks((s) => s.online);
  const offlineOnly = useShellStore(getShell(workspace), (s) => s.settings.offlineOnly === true);
  const site = useSiteKey();
  return useMemo(
    () => basemapModel(prefs, imagery, terrain, siteOf(site), { ...online, offlineOnly }),
    [prefs, imagery, terrain, site, online, offlineOnly],
  );
}
```

- A helper for the 3D scene's drawn online source, and `useGround` uses it:

```ts
/** The online source the 3D scene draws around the site, or null (street map or packs). */
export function sceneOnline(
  prefs: Pick<RasterPrefs, 'sceneBase' | 'onlineSatellite'>,
  online: { keys: MapKeysStatus },
  offlineOnly: boolean,
): OnlineSourceId | null {
  const d = drawnBase(
    prefs.sceneBase ?? 'streets',
    { enabled: prefs.onlineSatellite, offlineOnly },
    online.keys,
  );
  return isOnlineBase(d.base) ? d.base : null;
}

export function useGround(): GroundModel {
  const tier = useGraphics((s) => s.tier);
  const imagery = useRasterPacks((s) => s.imagery);
  const terrain = useRasterPacks((s) => s.terrain);
  const prefs = useRasterPacks((s) => s.prefs);
  const online = useRasterPacks((s) => s.online);
  const offlineOnly = useShellStore(getShell(workspace), (s) => s.settings.offlineOnly === true);
  const site = useSiteKey();
  const offered = tilesBudget(tier).surroundings;
  const drawnOnline = sceneOnline(prefs, online, offlineOnly) !== null;
  return useMemo(
    () => groundModel(imagery, terrain, siteOf(site), offered, drawnOnline),
    [imagery, terrain, site, offered, drawnOnline],
  );
}
```

- `useSiteSurroundings`: read `online` and offline-only the same way, compute `const onlineId = offered ? sceneOnline(prefs, online, offlineOnly) : null;`, `const wantImagery = offered && (onlineId !== null || (prefs.aroundImagery && imagery.length > 0));`, pass

```ts
      imagery: onlineId
        ? createOnlineTileSource(onlineId)
        : wantImagery
          ? createRasterTileSource('imagery', imagery)
          : null,
```

and add `onlineId` to the effect's dependency list.

- [ ] **Step 5: Implement the per-provider notice and pickBase**

Replace `apps/desktop/src/renderer/workspace/onlineSatellite.ts` with:

```ts
/**
 * Switching online maps on and off from the renderer (ADR 0007, amendments of 10 and 14 Oct 2026),
 * for every place that offers it: Settings, Map sources, the Map menus of the three views and the
 * command palette. One switch (`rasterPacks.setOnline`, which asks main) and one notice per
 * provider: the first time a source of a provider is used, the person reads what is requested
 * and from whom, and nothing is switched on or fetched until they say yes
 * (`OnlineSatelliteNotice.tsx` shows it wherever the request came from).
 */
import {
  isOnlineBase,
  onlineSource,
  type BaseMapId,
  type OnlineProvider,
  type OnlineSourceId,
} from '@aio/schema';
import { createStore } from 'zustand/vanilla';
import { rasterPacks } from './siteTiles';

const NOTICE_KEY = 'stratlas.onlineNotice';
/** 0.11's flag: its notice named EOX only. */
const LEGACY_KEY = 'stratlas.onlineSatelliteNotice';

export function onlineNoticeSeen(provider: OnlineProvider = 'eox'): boolean {
  try {
    if (localStorage.getItem(`${NOTICE_KEY}.${provider}`) === '1') return true;
    return provider === 'eox' && localStorage.getItem(LEGACY_KEY) === '1';
  } catch {
    return false;
  }
}

function markNoticeSeen(provider: OnlineProvider): void {
  try {
    localStorage.setItem(`${NOTICE_KEY}.${provider}`, '1');
  } catch {
    // blocked storage: the notice shows again next time
  }
}

interface OnlineSwitch {
  /** The source whose provider's notice is open: the person asked for it and has not answered. */
  asking: OnlineSourceId | null;
  /** Why the last change did not happen, or null. */
  error: string | null;
  /**
   * Switch online maps on (for `source`, default the workstation's online satellite) or off. The
   * first use of a provider opens its notice instead and waits for `confirm`; `then` runs once
   * online maps are on.
   */
  request(on: boolean, source?: OnlineSourceId, then?: () => void): void;
  confirm(): void;
  cancel(): void;
}

export const onlineSatelliteSwitch = createStore<OnlineSwitch>()((set, get) => {
  let after: (() => void) | null = null;
  const apply = async (
    on: boolean,
    id: OnlineSourceId | undefined,
    then: (() => void) | null,
  ): Promise<void> => {
    // only an online satellite becomes the workstation's source; a Mapbox style is a view's pick
    const keep = id && onlineSource(id)?.group === 'satellite' ? { source: id } : {};
    const error = await rasterPacks
      .getState()
      .setOnline(on ? { enabled: true, ...keep } : { enabled: false });
    set({ error });
    if (error || !on) return;
    const provider = onlineSource(id ?? rasterPacks.getState().online.source)?.provider;
    if (provider) markNoticeSeen(provider);
    then?.();
  };
  return {
    asking: null,
    error: null,
    request(on, source, then) {
      if (!on) {
        after = null;
        set({ asking: null });
        void apply(false, undefined, null);
        return;
      }
      const id = source ?? rasterPacks.getState().online.source;
      if (!onlineNoticeSeen(onlineSource(id)?.provider ?? 'eox')) {
        after = then ?? null;
        set({ asking: id, error: null });
        return;
      }
      set({ asking: null });
      void apply(true, source, then ?? null);
    },
    confirm() {
      const id = get().asking;
      if (!id) return;
      const then = after;
      after = null;
      set({ asking: null });
      void apply(true, id, then);
    },
    cancel() {
      after = null;
      if (get().asking) set({ asking: null });
    },
  };
});

/**
 * Pick a base map in a view. An online source used for the first time asks (its provider's
 * notice) and switches online maps on; `apply` stores the view's choice once that is done.
 */
export function pickBase(id: BaseMapId, apply: (id: BaseMapId) => void): void {
  if (!isOnlineBase(id)) {
    apply(id);
    return;
  }
  const source = onlineSource(id);
  if (source && rasterPacks.getState().prefs.onlineSatellite && onlineNoticeSeen(source.provider)) {
    apply(id);
    return;
  }
  onlineSatelliteSwitch.getState().request(true, id, () => {
    apply(id);
  });
}
```

In `apps/desktop/src/renderer/workspace/OnlineSatelliteNotice.tsx`: import `onlineSource, type OnlineProvider` from `@aio/schema` and `type MessageKey` from `@aio/ui`; add

```ts
const NOTICE: Record<OnlineProvider, MessageKey> = {
  eox: 'online.notice.eox',
  esri: 'online.notice.esri',
  mapbox: 'online.notice.mapbox',
};
```

then, after the `if (!asking) return ...` early return, compute `const provider = onlineSource(asking)?.provider ?? 'eox';`, put `data-provider={provider}` on the notice `div`, and use `t(NOTICE[provider])`, `t('online.confirm')` and `t('online.cancel')` in place of the three `g7.online.*` keys. Update its top comment ("the one-time notice of each provider").

- [ ] **Step 6: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/renderer/workspace apps/desktop/src/renderer/walks apps/desktop/src/renderer/globe`
Expected: PASS (`BasemapPicker.test.tsx` still passes: the picker's API is unchanged; if a test there reads the old notice text, change it to the new EOX wording).
Run: `pnpm typecheck && pnpm lint`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/workspace/siteTiles.ts apps/desktop/src/renderer/workspace/siteTiles.test.ts apps/desktop/src/renderer/workspace/basemap.ts apps/desktop/src/renderer/workspace/basemap.test.ts apps/desktop/src/renderer/workspace/onlineSatellite.ts apps/desktop/src/renderer/workspace/onlineSatellite.test.ts apps/desktop/src/renderer/workspace/OnlineSatelliteNotice.tsx apps/desktop/src/renderer/workspace/siteBasemap.ts
git commit -m "feat(desktop): base maps per view, a notice per provider and online imagery around the site" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Map view and 3D scene menus

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it, from `apps/desktop`: `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp QUADRION_E2E_PYTHON="E:\Dev\AIO Software\python\.venv\Scripts\python.exe" npx playwright test e2e/<spec>.spec.ts --workers=1` (full runs in Task 16); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Load the `impeccable` skill first** (the chip's placement on the map and in the 3D view).

**Packages:** `apps/desktop` (renderer/workspace, renderer/shell).

**Files:**

- Create: `apps/desktop/src/renderer/workspace/MapMenus.tsx`, `apps/desktop/src/renderer/workspace/MapMenus.test.tsx`
- Move: `apps/desktop/src/renderer/workspace/basemapPicker.css` → `apps/desktop/src/renderer/workspace/mapMenus.css` (`git mv`; keep only the anchor placement rules)
- Delete: `apps/desktop/src/renderer/workspace/BasemapPicker.tsx`, `apps/desktop/src/renderer/workspace/BasemapPicker.test.tsx`
- Modify: `apps/desktop/src/renderer/workspace/Stage.tsx:127` area (imports), `:180` (scene chip), `:883` (map chip)
- Modify: `apps/desktop/src/renderer/workspace/StageTools.tsx:34`, `:489` (drop `GroundRows`)
- Modify: `apps/desktop/src/renderer/shell/Palette.tsx:243-296` (map commands)
- Modify: `apps/desktop/src/renderer/workspace/basemap.ts`, `basemap.test.ts` (remove the legacy `Basemap`, `BASEMAPS`, `basemapPatch`, `onlineRow`, `OnlineRow`, `choice`)

**Interfaces:**

- Consumes: `MapMenu` (Task 10); `mapMenuModel`, `MapMenuModel`, `OnTopKey` (Task 9); `useBasemap`, `useGround`, `rasterPacks`, `useRasterPacks` (Task 11); `pickBase`, `onlineSatelliteSwitch` (Task 11); `OnlineSatelliteNotice`; `shell.getState().openSettingsPage('map-sources')` (Task 14); `ONLINE_SOURCES`, `siteLonLat`.
- Produces: `MapViewMenu()`, `SceneMapMenu()`, `useMapViewMenuModel(): MapMenuModel`, `useSceneMenuModel(): MapMenuModel | null`; chip test ids `basemap-button` / pop `basemap-pop` (Map view, kept), `scene-map-button` / `scene-map-pop` (3D scene, new); anchor classes `bm-anchor` (Map view, kept) and `scene-map-anchor`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/workspace/MapMenus.test.tsx` (reuse the setup of the deleted `BasemapPicker.test.tsx`: the `threeDates` manifest fixture, `workspace.setState` with a project, `rasterPacks.setState` with packs, `graphics` tier):

```tsx
// @vitest-environment jsdom
import type { RasterPackInfo } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graphics } from '../graphics';
import { shell } from '../shell';
import { threeDates } from './__fixtures__/threeDates';
import { siteLonLat } from './basemap';
import { MapViewMenu, SceneMapMenu } from './MapMenus';
import { onlineSatelliteSwitch } from './onlineSatellite';
import { rasterPacks } from './siteTiles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe = () => undefined;
  unobserve = () => undefined;
  disconnect = () => undefined;
};

const [lon = 0, lat = 0] = siteLonLat(threeDates) ?? [];
const pack = (id: string, kind: 'imagery' | 'terrain' = 'imagery'): RasterPackInfo =>
  ({
    id,
    kind,
    label: id,
    bbox: [lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1],
    minZoom: 0,
    maxZoom: 16,
    tileSize: 256,
    attribution: 'Test',
    licence: 'CC0-1.0',
    sizeBytes: 1,
  }) as RasterPackInfo;

let host: HTMLDivElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  host.className = 'stage';
  document.body.append(host);
  root = createRoot(host);
  workspace.setState({ project: { id: 'p', manifest: threeDates } } as never);
  rasterPacks.setState({
    imagery: [pack('site')],
    terrain: [pack('dem', 'terrain')],
    online: { source: 'esri-world-imagery', keys: { esri: false, mapbox: false } },
  });
  rasterPacks.getState().setForSession({ onlineSatellite: false, mapBase: null, sceneBase: null });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  onlineSatelliteSwitch.getState().cancel();
});

describe('the Map view menu', () => {
  it('keeps its chip and pop ids and offers every source, Mapbox greyed without a key', () => {
    act(() => root.render(<MapViewMenu />));
    expect(q('basemap-button')?.textContent).toContain('Streets');
    act(() => q('basemap-button')?.click());
    expect(q('basemap-pop')).not.toBeNull();
    expect((q('map-tile-mapbox-streets') as HTMLButtonElement).disabled).toBe(true);
    expect((q('map-tile-esri-world-imagery') as HTMLButtonElement).disabled).toBe(false);
  });

  it('picking Esri the first time shows its notice in the menu; yes stores the choice', async () => {
    const invoke = vi.fn((channel: string, req: { enabled?: boolean; source?: string }) =>
      Promise.resolve(
        channel === 'onlineTiles:set'
          ? { ok: true, enabled: true, source: req.source ?? 'esri-world-imagery' }
          : null,
      ),
    );
    (globalThis as { aio?: unknown }).aio = { invoke, on: vi.fn() };
    act(() => root.render(<MapViewMenu />));
    act(() => q('basemap-button')?.click());
    act(() => q('map-tile-esri-world-imagery')?.click());
    const notice = q('online-satellite-notice');
    expect(notice?.getAttribute('data-provider')).toBe('esri');
    act(() => (notice?.querySelector('button') as HTMLButtonElement).click());
    await vi.waitFor(() => {
      expect(rasterPacks.getState().prefs.mapBase).toBe('esri-world-imagery');
    });
    delete (globalThis as { aio?: unknown }).aio;
  });

  it('the packs switch turns imagery packs on; Map sources opens Settings there', () => {
    act(() => root.render(<MapViewMenu />));
    act(() => q('basemap-button')?.click());
    act(() => (q('map-ontop-packs')?.querySelector('[role="switch"]') as HTMLElement).click());
    // the packs switch starts on (imagery packs on top is the default), so the click turns it off
    expect(rasterPacks.getState().prefs.satellite).toBe(false);
    act(() => q('map-sources-link')?.click());
    expect(shell.getState().settingsPage).toBe('map-sources');
  });
});

describe('the 3D scene menu', () => {
  it('has a chip of its own, with the ground rows as On top switches', () => {
    graphics.getState().setOverride('medium');
    act(() => root.render(<SceneMapMenu />));
    act(() => q('scene-map-button')?.click());
    expect(q('scene-map-pop')).not.toBeNull();
    expect(q('map-ontop-aroundImagery')).not.toBeNull();
    expect(q('map-ontop-aroundTerrain')).not.toBeNull();
    act(() => q('map-tile-streets')?.click());
    expect(rasterPacks.getState().prefs.sceneBase).toBe('streets');
  });

  it('is not shown for a project that is not placed on the Earth', () => {
    workspace.setState({
      project: { id: 'p', manifest: { ...threeDates, crs: { wkt: 'LOCAL_CS["Grid"]' } } },
    } as never);
    act(() => root.render(<SceneMapMenu />));
    expect(q('scene-map-button')).toBeNull();
  });
});
```

`graphics.getState().setOverride(tier)` is the graphics store's own override (`renderer/graphics.ts`), the one the e2e specs call through `__stratlas.graphics()`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/renderer/workspace/MapMenus.test.tsx`
Expected: FAIL, cannot find module `./MapMenus`.

- [ ] **Step 3: Implement the adapters**

Create `apps/desktop/src/renderer/workspace/MapMenus.tsx`:

```tsx
/**
 * The Map menu of the Map view and of the 3D scene (plan 2026-10-14-satellite-providers): the
 * shared `MapMenu` over each view's own choices in `rasterPacks` (`siteTiles.ts`). The Map view
 * keeps its chip under the zoom buttons; the 3D scene has a chip of its own, which took over the
 * ground rows of the Layers popover. An online source used for the first time asks first, in the
 * menu (`pickBase`, `OnlineSatelliteNotice`).
 */
import { ONLINE_SOURCES } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import { MapMenu } from '../maps/MapMenu';
import { mapMenuModel, type MapMenuModel, type OnTopKey } from '../maps/mapMenuModel';
import { shell, useShell } from '../shell';
import { siteLonLat } from './basemap';
import { pickBase } from './onlineSatellite';
import { OnlineSatelliteNotice } from './OnlineSatelliteNotice';
import { rasterPacks, useBasemap, useGround, useRasterPacks, type RasterPrefs } from './siteTiles';
import './mapMenus.css';

const openSources = () => {
  shell.getState().openSettingsPage('map-sources');
};

/** The Map view's On top switches and the choices they write. */
const MAP_TOGGLES: Partial<Record<OnTopKey, keyof RasterPrefs>> = {
  streets: 'streets',
  hillshade: 'hillshade',
  packs: 'satellite',
};
const SCENE_TOGGLES: Partial<Record<OnTopKey, keyof RasterPrefs>> = {
  aroundImagery: 'aroundImagery',
  aroundTerrain: 'aroundTerrain',
};

const toggle =
  (table: Partial<Record<OnTopKey, keyof RasterPrefs>>) => (key: OnTopKey, on: boolean) => {
    const pref = table[key];
    if (pref) rasterPacks.getState().set({ [pref]: on });
  };

export function useMapViewMenuModel(): MapMenuModel {
  const basemap = useBasemap();
  const prefs = useRasterPacks((s) => s.prefs);
  const keys = useRasterPacks((s) => s.online.keys);
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  return useMemo(
    () =>
      mapMenuModel(
        'map',
        {
          base: basemap.base,
          onTop: { streets: prefs.streets, hillshade: prefs.hillshade, packs: prefs.satellite },
          pack: prefs.imageryPack,
        },
        ONLINE_SOURCES,
        {
          imagery: basemap.packs.map((p) => ({ id: p.id, label: p.label })),
          terrain: basemap.hillshade ? 1 : 0,
        },
        { enabled: prefs.onlineSatellite, offlineOnly },
        keys,
      ),
    [basemap, prefs, keys, offlineOnly],
  );
}

export function MapViewMenu() {
  const model = useMapViewMenuModel();
  return (
    <MapMenu
      model={model}
      testIds={{ chip: 'basemap-button', pop: 'basemap-pop' }}
      className="bm-anchor"
      place="stage"
      dark
      onPick={(id) => {
        pickBase(id, (b) => {
          rasterPacks.getState().set({ mapBase: b });
        });
      }}
      onToggle={toggle(MAP_TOGGLES)}
      onPack={(id) => {
        rasterPacks.getState().set({ imageryPack: id });
      }}
      onOpenSources={openSources}
      notice={<OnlineSatelliteNotice className="mm-notice" />}
    />
  );
}

export function useSceneMenuModel(): MapMenuModel | null {
  const basemap = useBasemap();
  const ground = useGround();
  const prefs = useRasterPacks((s) => s.prefs);
  const keys = useRasterPacks((s) => s.online.keys);
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  const placed = useWorkspace((s) => siteLonLat(s.project?.manifest ?? null) !== null);
  return useMemo(
    () =>
      placed
        ? mapMenuModel(
            'scene',
            {
              base: prefs.sceneBase ?? 'streets',
              onTop: { aroundImagery: prefs.aroundImagery, aroundTerrain: prefs.aroundTerrain },
              pack: null,
            },
            ONLINE_SOURCES,
            {
              imagery: basemap.packs.map((p) => ({ id: p.id, label: p.label })),
              terrain: ground.terrain ? 1 : 0,
            },
            { enabled: prefs.onlineSatellite, offlineOnly },
            keys,
            { aroundOffered: ground.offered },
          )
        : null,
    [placed, basemap, ground, prefs, keys, offlineOnly],
  );
}

export function SceneMapMenu() {
  const model = useSceneMenuModel();
  if (!model) return null;
  return (
    <MapMenu
      model={model}
      testIds={{ chip: 'scene-map-button', pop: 'scene-map-pop' }}
      className="scene-map-anchor"
      place="stage"
      dark
      onPick={(id) => {
        pickBase(id, (b) => {
          rasterPacks.getState().set({ sceneBase: b });
        });
      }}
      onToggle={toggle(SCENE_TOGGLES)}
      onPack={() => undefined}
      onOpenSources={openSources}
      notice={<OnlineSatelliteNotice className="mm-notice" />}
    />
  );
}
```

`git mv apps/desktop/src/renderer/workspace/basemapPicker.css apps/desktop/src/renderer/workspace/mapMenus.css`, then keep only the placement rules and add the 3D one:

```css
/* Where the Map menu's chip sits in the Map view and in the 3D scene (MapMenus.tsx). The menu's
   own look is renderer/maps/mapMenu.css. */

.bm-anchor {
  position: absolute;
  /* under the zoom buttons: their corner starts at 50px, 10px margin, two 29px buttons */
  top: 126px;
  right: 10px; /* physical: the map pane keeps left-to-right geometry */
  z-index: 6;
}
/* in a split the zoom buttons sit below the pane chooser, and so does the chip */
.stage-panes[data-mode='split'] .bm-anchor {
  top: 168px;
}

/* the 3D view: under the engine's compass (top 56px, about 40px tall) */
.scene-map-anchor {
  position: absolute;
  top: 108px;
  right: 12px;
  z-index: 6;
}
/* in a split the pane chooser takes the row of the compass: one more row down */
.stage-panes[data-mode='split'] .scene-map-anchor {
  top: 150px;
}
.mm-notice {
  margin: 0;
}
```

Check the placement in the app at 1100 x 700 with both side panels open (the chip and its pop must not cover the compass, the pane chooser or the timeline); move `top` if the compass box differs, and record the value you used in the CSS comment.

- [ ] **Step 4: Mount the menus and drop the old picker**

- `Stage.tsx`: replace `import { BasemapPicker } from './BasemapPicker';` with `import { MapViewMenu, SceneMapMenu } from './MapMenus';`; replace `<BasemapPicker />` (L883) with `<MapViewMenu />`; in `ScenePane` (the main 3D view; a second 3D view of a comparison is `CompareScene` and gets no menu), right after `<ChangeLegends />` (L179), add `{!hidden && <SceneMapMenu />}`.
- `StageTools.tsx`: delete `import { GroundRows } from './BasemapPicker';` and the line `{!map && <GroundRows />}`.
- Delete `BasemapPicker.tsx` and `BasemapPicker.test.tsx` (`git rm`).
- `basemap.ts`: delete `Basemap`, `BASEMAPS`, `basemapPatch`, `OnlineRow`, `onlineRow` and the `choice` field (model and computation); delete their tests in `basemap.test.ts` (`basemapPatch`, `onlineRow` and every `choice` expectation).
- `Palette.tsx` (L243-296): replace the `for (const b of BASEMAPS)` loop with commands from the Map view model, and the online toggle with "online maps":

```tsx
for (const tile of mapMenu.sections.flatMap((sec) => sec.tiles)) {
  if (tile.state !== 'available') continue;
  list.push({
    id: `map:base:${tile.id}`,
    title: t('palette.mapBase', { name: t(tile.label) }),
    group: 'Actions',
    icon: 'map',
    keywords: ['basemap', 'map type', 'imagery', 'aerial', 'streets', 'satellite', tile.id],
    ...(mapMenu.chosen === tile.id ? { hint: t('palette.basemap.current') } : {}),
    run: onMap(() => {
      pickBase(tile.id, (b) => {
        rasterPacks.getState().set({ mapBase: b });
      });
      if (onlineSatelliteSwitch.getState().asking) s.openSettingsPage('map-sources');
    }),
  });
}
```

where `const mapMenu = useMapViewMenuModel();` replaces `const basemap = useBasemap();` at the top of the component (keep `basemap.hillshade`-style lines by reading `mapMenu.onTop`: the hillshade command becomes `const shade = mapMenu.onTop.find((r) => r.key === 'hillshade'); if (shade && !shade.disabled) list.push({ ... title: t(shade.on ? 'palette.hillshade.off' : 'palette.hillshade.on'), run: onMap(() => { rasterPacks.getState().set({ hillshade: !shade.on }); }) })`). The online command keeps its id `basemap:online` and calls `onlineSatelliteSwitch.getState().request(!rasterPacks.getState().prefs.onlineSatellite)`, then `s.openSettingsPage('map-sources')` when it is asking. Import `useMapViewMenuModel` from `../workspace/MapMenus` and `pickBase` from `../workspace/onlineSatellite`; drop the `BASEMAPS`, `basemapPatch` and `useBasemap` imports.

- [ ] **Step 5: Run the tests and look at it**

Run: `pnpm exec vitest run apps/desktop/src/renderer/workspace apps/desktop/src/renderer/shell apps/desktop/src/renderer/walks`
Expected: PASS.
Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: exit 0.
Run the existing small-window spec once to see the placement (it still uses old test ids in places and may fail on those; that is fixed in Task 16): from `apps/desktop`, `pnpm demo:build --quick` then the CI-like command for `e2e/small-window.spec.ts`. Look at the screenshots it writes for the map foot; fix the anchor CSS if the chip or its pop overlaps anything.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/workspace/MapMenus.tsx apps/desktop/src/renderer/workspace/MapMenus.test.tsx apps/desktop/src/renderer/workspace/mapMenus.css apps/desktop/src/renderer/workspace/basemapPicker.css apps/desktop/src/renderer/workspace/BasemapPicker.tsx apps/desktop/src/renderer/workspace/BasemapPicker.test.tsx apps/desktop/src/renderer/workspace/Stage.tsx apps/desktop/src/renderer/workspace/StageTools.tsx apps/desktop/src/renderer/workspace/basemap.ts apps/desktop/src/renderer/workspace/basemap.test.ts apps/desktop/src/renderer/shell/Palette.tsx
git commit -m "feat(desktop): the Map menu in the Map view and a Map chip in the 3D scene" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The Globe's Map menu

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it (full Globe specs in Task 16); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Overlap:** `fix/globe-start-view` edits `GlobeScreen.tsx` ~81-94. This task edits only ~160-185 (look, packs, online), ~266 (credits before the first frame), ~499-516 (the menu and the view's props) and the imports; do not touch `start`, `startOf` or `flyToSite`.

**Packages:** `apps/desktop` (renderer/globe).

**Files:**

- Create: `apps/desktop/src/renderer/globe/globeBase.ts`, `apps/desktop/src/renderer/globe/globeBase.test.ts`, `apps/desktop/src/renderer/globe/GlobeMenu.tsx`
- Delete: `apps/desktop/src/renderer/globe/GlobeMapMenu.tsx`
- Modify: `apps/desktop/src/renderer/globe/GlobeScreen.tsx` (lines above), `apps/desktop/src/renderer/globe/GlobeScreen.test.tsx` (the two Map dialog tests at ~480-510 and the `useRasterPacks` mock at ~88), `apps/desktop/src/renderer/globe/globe-map-menu.css` (drop `.globe-map-button` and `.globe-map-pop`; the chip and pop are `mm-*` now)

**Interfaces:**

- Consumes: `MapMenu` (Task 10); `mapMenuModel`, `drawnBase` (Task 9); `rasterPacks`, `useRasterPacks`, `pickBase`, `OnlineSatelliteNotice` (Task 11); `GlobeSettings.base/packs` (Task 1); `GlobeView` prop `online` (Task 7); `globeStyleOf`, `GlobeStyle`, `GlobeTierName` (`@aio/globe`); `shell.openSettingsPage('map-sources')` (Task 14).
- Produces: `globeBaseOf(prefs: GlobeSettings, online: { enabled: boolean; source: OnlineSourceId }): BaseMapId`, `globePacksOf(prefs: GlobeSettings): boolean`, `globeStyleFor(base: BaseMapId, packs: boolean): GlobeStyle`, `globeDraw(drawn: BaseMapId, packs: boolean): { style: GlobeStyle; online: OnlineSourceId | null }`, `withBase(prefs: GlobeSettings, base: BaseMapId, packs: boolean): GlobeSettings`; `GlobeMenu` component (chip test id `globe-map-button`, pop `globe-map-menu`, kept).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/globe/globeBase.test.ts`:

```ts
import { defaultGlobeSettings, type GlobeSettings } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { globeBaseOf, globeDraw, globePacksOf, globeStyleFor, withBase } from './globeBase';

const ON = { enabled: true, source: 's2cloudless-2016' as const };
const OFF = { enabled: false, source: 'esri-world-imagery' as const };
const prefs = (over: Partial<GlobeSettings> = {}): GlobeSettings => ({
  ...defaultGlobeSettings(),
  ...over,
});

describe('the Globe base map from globe.json', () => {
  it('globeBaseOf keeps the Satellite look of 0.11', () => {
    expect(globeBaseOf(prefs({ style: 'satellite' }), ON)).toBe('s2cloudless-2016');
    expect(globeBaseOf(prefs({ style: 'satellite' }), OFF)).toBe('streets');
    expect(globeBaseOf(prefs({ style: 'natural-earth' }), ON)).toBe('natural-earth');
    expect(globeBaseOf(prefs(), ON)).toBe('streets');
    expect(globeBaseOf(prefs({ style: 'street', base: 'mapbox-dark' }), OFF)).toBe('mapbox-dark');
  });

  it('packs are on in the Satellite and Natural Earth looks unless switched', () => {
    expect(globePacksOf(prefs())).toBe(false);
    expect(globePacksOf(prefs({ style: 'satellite' }))).toBe(true);
    expect(globePacksOf(prefs({ style: 'natural-earth' }))).toBe(true);
    expect(globePacksOf(prefs({ style: 'satellite', packs: false }))).toBe(false);
  });

  it('writes a style 0.11 understands beside the base', () => {
    expect(globeStyleFor('streets', false)).toBe('street');
    expect(globeStyleFor('streets', true)).toBe('satellite');
    expect(globeStyleFor('natural-earth', false)).toBe('natural-earth');
    expect(globeStyleFor('esri-world-imagery', false)).toBe('satellite');
    expect(withBase(prefs({ terrain: 'off' }), 'esri-world-imagery', false)).toMatchObject({
      base: 'esri-world-imagery',
      packs: false,
      style: 'satellite',
      terrain: 'off',
    });
  });

  it('draws the look and the online source of what is drawn', () => {
    expect(globeDraw('esri-world-imagery', true)).toEqual({
      style: 'satellite',
      online: 'esri-world-imagery',
    });
    expect(globeDraw('streets', false)).toEqual({ style: 'street', online: null });
    expect(globeDraw('natural-earth', true)).toEqual({ style: 'natural-earth', online: null });
  });
});
```

In `GlobeScreen.test.tsx`:

- the `useRasterPacks` mock returns `selector({ prefs: { onlineSatellite: false }, online: { source: 'esri-world-imagery', keys: { esri: false, mapbox: false } } })`;
- test `'saves a look chosen in the Map dialog, and the screen follows it'` becomes:

```tsx
it('saves a base map chosen in the Map menu, and the screen follows it', async () => {
  await mount();
  expect(q('globe-screen')?.getAttribute('data-look')).toBe('street');
  act(() => q('globe-map-button')?.click());
  expect(q('map-tile-streets')?.getAttribute('aria-checked')).toBe('true');
  act(() => q('map-tile-natural-earth')?.click());
  const saved = app.sent.filter((s) => s.channel === 'globe:setSettings');
  expect(saved).toHaveLength(1);
  expect(saved[0]?.payload).toMatchObject({
    settings: { base: 'natural-earth', style: 'natural-earth' },
  });
  expect(q('globe-screen')?.getAttribute('data-look')).toBe('natural-earth');
  expect(globe.props?.style).toBe('natural-earth');
  expect(q('map-tile-natural-earth')?.getAttribute('aria-checked')).toBe('true');
});
```

- in `'closes the card of an issue when its pin is no longer drawn'` replace the `.globe-check input` click with `act(() => (q('map-ontop-issues')?.querySelector('[role="switch"]') as HTMLElement).click());`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/renderer/globe`
Expected: FAIL (`./globeBase` missing; `map-tile-streets` not found).

- [ ] **Step 3: Implement globeBase.ts and GlobeMenu.tsx**

Create `apps/desktop/src/renderer/globe/globeBase.ts`:

```ts
/**
 * The Globe's base map in `globe.json` (plan 2026-10-14-satellite-providers): `base` and `packs`
 * are new and optional; `style` is still written, so 0.11 opens the Globe in a look it knows.
 */
import { globeStyleOf, type GlobeStyle } from '@aio/globe';
import { isOnlineBase, type BaseMapId, type GlobeSettings, type OnlineSourceId } from '@aio/schema';

/**
 * The base map: the one chosen in the Map menu, or, never chosen, what 0.11's look showed (its
 * Satellite look drew the online satellite under the packs once online maps were on).
 */
export function globeBaseOf(
  prefs: GlobeSettings,
  online: { enabled: boolean; source: OnlineSourceId },
): BaseMapId {
  if (prefs.base) return prefs.base;
  const style = globeStyleOf(prefs);
  if (style === 'natural-earth') return 'natural-earth';
  if (style === 'satellite' && online.enabled) return online.source;
  return 'streets';
}

/** Imagery packs on top: as chosen, or as 0.11's look drew them (not on the street look). */
export function globePacksOf(prefs: GlobeSettings): boolean {
  return prefs.packs ?? globeStyleOf(prefs) !== 'street';
}

/** The look to draw and to write for 0.11: street, satellite (online or packs) or natural earth. */
export function globeStyleFor(base: BaseMapId, packs: boolean): GlobeStyle {
  if (base === 'natural-earth') return 'natural-earth';
  if (isOnlineBase(base)) return 'satellite';
  return packs ? 'satellite' : 'street';
}

export function globeDraw(
  drawn: BaseMapId,
  packs: boolean,
): { style: GlobeStyle; online: OnlineSourceId | null } {
  return { style: globeStyleFor(drawn, packs), online: isOnlineBase(drawn) ? drawn : null };
}

export function withBase(prefs: GlobeSettings, base: BaseMapId, packs: boolean): GlobeSettings {
  return { ...prefs, base, packs, style: globeStyleFor(base, packs) };
}
```

Create `apps/desktop/src/renderer/globe/GlobeMenu.tsx`:

```tsx
/**
 * The Globe's Map button and menu: the shared `MapMenu` over `globe.json` (base map, packs,
 * terrain, issue pins) and the person's online maps switch, with the key to the pins' colours
 * under On top. The menu stays open while a setting changes, so a map can be tried and changed
 * again; a press away or Esc closes it.
 */
import type { GlobeTierName } from '@aio/globe';
import {
  ONLINE_SOURCES,
  type BaseMapId,
  type GlobeSettings,
  type RasterPackInfo,
} from '@aio/schema';
import { t, useT } from '@aio/ui';
import { useMemo } from 'react';
import { MapMenu } from '../maps/MapMenu';
import { mapMenuModel, type OnTopKey } from '../maps/mapMenuModel';
import { shell, useShell } from '../shell';
import { pickBase } from '../workspace/onlineSatellite';
import { OnlineSatelliteNotice } from '../workspace/OnlineSatelliteNotice';
import { useRasterPacks } from '../workspace/siteTiles';
import { withBase } from './globeBase';
import './globe-map-menu.css';

export interface GlobeMenuProps {
  prefs: GlobeSettings;
  base: BaseMapId;
  packsOn: boolean;
  tier: GlobeTierName;
  imagery: readonly RasterPackInfo[];
  streetCredit: string;
  onSave: (next: GlobeSettings) => void;
}

export function GlobeMenu({
  prefs,
  base,
  packsOn,
  tier,
  imagery,
  streetCredit,
  onSave,
}: GlobeMenuProps) {
  useT();
  const enabled = useRasterPacks((s) => s.prefs.onlineSatellite);
  const keys = useRasterPacks((s) => s.online.keys);
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  const model = useMemo(
    () =>
      mapMenuModel(
        'globe',
        {
          base,
          onTop: {
            packs: packsOn,
            terrain: prefs.terrain !== 'off',
            issues: prefs.showIssues !== false,
          },
          pack: prefs.imagery && prefs.imagery !== 'auto' ? prefs.imagery : null,
        },
        ONLINE_SOURCES,
        { imagery: imagery.map((p) => ({ id: p.id, label: p.label })), terrain: 0 },
        { enabled, offlineOnly },
        keys,
        { terrainOffered: tier !== 'low', streetsCredit: streetCredit },
      ),
    [base, packsOn, prefs, imagery, enabled, offlineOnly, keys, tier, streetCredit],
  );
  const onToggle = (key: OnTopKey, on: boolean) => {
    if (key === 'packs') onSave(withBase(prefs, base, on));
    else if (key === 'terrain') onSave({ ...prefs, terrain: on ? 'auto' : 'off' });
    else if (key === 'issues') onSave({ ...prefs, showIssues: on });
  };
  return (
    <MapMenu
      model={model}
      testIds={{ chip: 'globe-map-button', pop: 'globe-map-menu' }}
      className="globe-map"
      chipClassName="globe-map-chip"
      place="free"
      onPick={(id) => {
        pickBase(id, (b) => {
          onSave(withBase(prefs, b, packsOn));
        });
      }}
      onToggle={onToggle}
      onPack={(id) => {
        onSave({ ...prefs, imagery: id ?? 'auto' });
      }}
      onOpenSources={() => {
        shell.getState().openSettingsPage('map-sources');
      }}
      notice={<OnlineSatelliteNotice className="mm-notice" />}
      extra={
        <ul className="globe-key" aria-label={t('globe.key')}>
          <li data-tone="clear">
            <span className="globe-dot" aria-hidden="true" />
            {t('globe.keyClear')}
          </li>
          <li data-tone="attention">
            <span className="globe-dot" aria-hidden="true" />
            {t('globe.keyAttention')}
          </li>
        </ul>
      }
    />
  );
}
```

Replace `globe-map-menu.css` with:

```css
/* The Map button at the top right of the Globe (GlobeMenu.tsx). The chip and the menu are the
   shared Map menu (renderer/maps/mapMenu.css); this file places them and gives the chip the
   surface of the Globe's other floating controls. The screen positions .globe-map. */
.globe-map {
  position: relative;
  z-index: 3;
}
.globe-map-chip {
  background: color-mix(in oklch, var(--bg-1) 90%, transparent);
  backdrop-filter: blur(16px) saturate(1.15);
  box-shadow: 0 12px 32px var(--shadow);
}
.globe-map .mm-pop {
  background: color-mix(in oklch, var(--bg-1) 94%, transparent);
  backdrop-filter: blur(16px) saturate(1.15);
}
.globe-map .mm-notice {
  margin: 0;
}
```

`git rm apps/desktop/src/renderer/globe/GlobeMapMenu.tsx`.

- [ ] **Step 4: Wire GlobeScreen**

In `apps/desktop/src/renderer/globe/GlobeScreen.tsx`:

- Imports: replace `import { GlobeMapMenu } from './GlobeMapMenu';` with `import { GlobeMenu } from './GlobeMenu';` and add `import { globeBaseOf, globeDraw, globePacksOf } from './globeBase';` and `import { drawnBase } from '../maps/mapMenuModel';`. Remove `globeStyleOf` and `onlineSatelliteAvailability` from the imports if nothing else uses them.
- Replace `const look = globeStyleOf(prefs);` and the online block at ~176-180 with:

```tsx
// the base map (the Map menu, or 0.11's look), the packs switch, and what can be drawn now:
// main holds the online maps switch and serves or refuses every tile
const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
const onlineOn = useRasterPacks((s) => s.prefs.onlineSatellite);
const onlineState = useRasterPacks((s) => s.online);
const base = globeBaseOf(prefs, { enabled: onlineOn, source: onlineState.source });
const packsOn = globePacksOf(prefs);
const drawn = drawnBase(base, { enabled: onlineOn, offlineOnly }, onlineState.keys);
const { style: look, online } = globeDraw(drawn.base, packsOn);
```

Keep `const street = useStreetTiles(loaded?.street ?? null, look, tier);` after it (move the line below if needed so `look` is defined first).

- The `<GlobeMapMenu ... />` element (~499-509) becomes:

```tsx
<GlobeMenu
  prefs={prefs}
  base={base}
  packsOn={packsOn}
  tier={tier}
  imagery={loaded.imagery}
  streetCredit={street?.credit ?? '© OpenStreetMap contributors'}
  onSave={save}
/>
```

(`street` is the `GlobeTileSource` of `useStreetTiles`, whose `credit` is the street packs' line).

- On `<GlobeView>`: `online={online}` (replacing Task 7's placeholder) and `imagery={packsOn ? imagery : []}`.

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/renderer/globe packages/globe`
Expected: PASS.
Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/globe/globeBase.ts apps/desktop/src/renderer/globe/globeBase.test.ts apps/desktop/src/renderer/globe/GlobeMenu.tsx apps/desktop/src/renderer/globe/GlobeMapMenu.tsx apps/desktop/src/renderer/globe/GlobeScreen.tsx apps/desktop/src/renderer/globe/GlobeScreen.test.tsx apps/desktop/src/renderer/globe/globe-map-menu.css
git commit -m "feat(desktop): the Globe uses the shared Map menu and draws the chosen online map" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Settings, Map sources

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen; e2e as CI runs it (covered in Task 16); conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Load the `impeccable` skill first** (a Settings page with a master switch, three provider rows and key fields).

**Packages:** `apps/desktop` (renderer/screens, renderer/store).

**Files:**

- Create: `apps/desktop/src/renderer/screens/settings/mapSourcesView.ts`, `mapSourcesView.test.ts`, `MapSources.tsx`
- Modify: `apps/desktop/src/renderer/store.ts:51-64` (`SettingsPage` gains `'map-sources'`)
- Modify: `apps/desktop/src/renderer/screens/Settings.tsx:63` (nav), `:785-800` (`HEAD`), `:870` (render)
- Modify: `apps/desktop/src/renderer/screens/settings/RasterPacks.tsx` (remove the online switch, its notice, help and cache; L1-20, ~L280-315, L443-450, L465-487)
- Modify: `apps/desktop/src/renderer/screens/settings/About.tsx:2`, `:403-406`

**Interfaces:**

- Consumes: Task 1 (IPC `mapKeys:*`, `onlineTiles:status|clearCache`, `ONLINE_SOURCES`, `MapKeyProvider`, `MapKeysStatus`, `OnlineProvider`); Task 9 (strings `mapSources.*`, `settings.page.mapSources`, `settings.mapSources.text`); existing `onlineSatelliteSwitch.getState().request(on)`, `OnlineSatelliteNotice`, `rasterPacks.getState().refresh()`, `useRasterPacks((s) => s.prefs.onlineSatellite)` (their Task 11 versions keep these signatures; this task must not use `rasterPacks` state that Task 11 adds, such as `online.keys`, because both run in Batch 3); `bridge.call`, `useShell` (`../../shell`); `Switch`, `formatBytes`, `t` (`@aio/ui`).
- Produces: Settings page `'map-sources'` (`shell.getState().openSettingsPage('map-sources')` opens it; heading "Map sources"); test ids `map-sources`, `map-sources-master` (row; the `role="switch"` inside), `map-source-<provider>`, `map-source-status-<provider>`, `map-key-<provider>` (input), `map-key-save-<provider>`, `map-key-test-<provider>`, `map-key-remove-<provider>`, `map-key-msg-<provider>`, `map-sources-clear`, `map-sources-credits`; `mapSourceRows(keys: MapKeysStatus): SourceRow[]`, `masterSwitch(enabled: boolean, offlineOnly: boolean): { checked: boolean; disabled: boolean; help: MessageKey }`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/screens/settings/mapSourcesView.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapSourceRows, masterSwitch } from './mapSourcesView';

describe('Settings, Map sources', () => {
  it('lists Esri, Mapbox and Sentinel-2 with what each needs', () => {
    const rows = mapSourceRows({ esri: false, mapbox: false });
    expect(rows.map((r) => [r.provider, r.keyProvider, r.status])).toEqual([
      ['esri', 'esri', 'mapSources.status.keyless'],
      ['mapbox', 'mapbox', 'mapSources.status.noKey'],
      ['eox', null, 'mapSources.status.keyless'],
    ]);
    expect(rows.map((r) => r.terms)).toEqual([
      'mapSources.terms.esri',
      'mapSources.terms.mapbox',
      'mapSources.terms.eox',
    ]);
  });

  it('says when a key is saved', () => {
    const rows = mapSourceRows({ esri: true, mapbox: true });
    expect(rows.slice(0, 2).map((r) => [r.status, r.hasKey])).toEqual([
      ['mapSources.status.saved', true],
      ['mapSources.status.saved', true],
    ]);
  });

  it('the master switch cannot be switched on offline-only, but can always be switched off', () => {
    expect(masterSwitch(false, false)).toEqual({
      checked: false,
      disabled: false,
      help: 'mapSources.master.help',
    });
    expect(masterSwitch(false, true)).toEqual({
      checked: false,
      disabled: true,
      help: 'mapSources.offlineOnly',
    });
    expect(masterSwitch(true, true).disabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/renderer/screens/settings/mapSourcesView.test.ts`
Expected: FAIL, cannot find module `./mapSourcesView`.

- [ ] **Step 3: Implement the view and the page**

Create `apps/desktop/src/renderer/screens/settings/mapSourcesView.ts`:

```ts
/** The rows of Settings, Map sources (plan 2026-10-14-satellite-providers), as data. */
import type { MapKeyProvider, MapKeysStatus, OnlineProvider } from '@aio/schema';
import type { MessageKey } from '@aio/ui';

export interface SourceRow {
  provider: OnlineProvider;
  /** The vault account a key goes to, or null for a provider that takes none. */
  keyProvider: MapKeyProvider | null;
  name: MessageKey;
  terms: MessageKey;
  status: MessageKey;
  hasKey: boolean;
}

export function mapSourceRows(keys: MapKeysStatus): SourceRow[] {
  return [
    {
      provider: 'esri',
      keyProvider: 'esri',
      name: 'mapSources.provider.esri',
      terms: 'mapSources.terms.esri',
      status: keys.esri ? 'mapSources.status.saved' : 'mapSources.status.keyless',
      hasKey: keys.esri,
    },
    {
      provider: 'mapbox',
      keyProvider: 'mapbox',
      name: 'mapSources.provider.mapbox',
      terms: 'mapSources.terms.mapbox',
      status: keys.mapbox ? 'mapSources.status.saved' : 'mapSources.status.noKey',
      hasKey: keys.mapbox,
    },
    {
      provider: 'eox',
      keyProvider: null,
      name: 'mapSources.provider.eox',
      terms: 'mapSources.terms.eox',
      status: 'mapSources.status.keyless',
      hasKey: false,
    },
  ];
}

export function masterSwitch(
  enabled: boolean,
  offlineOnly: boolean,
): { checked: boolean; disabled: boolean; help: MessageKey } {
  return {
    checked: enabled,
    // offline-only: it cannot be switched on (it can still be switched off)
    disabled: offlineOnly && !enabled,
    help: offlineOnly ? 'mapSources.offlineOnly' : 'mapSources.master.help',
  };
}
```

Create `apps/desktop/src/renderer/screens/settings/MapSources.tsx`:

```tsx
/**
 * Settings, Map sources (plan 2026-10-14-satellite-providers; ADR 0007, amendment of 14 Oct
 * 2026): the master switch "Online maps", one row per provider with its status, a key field,
 * Test and Remove and a short note on terms and price, and "Clear saved satellite tiles". Keys
 * go to main, which checks each with one tile before it keeps it in the OS credential store; the
 * page only ever learns whether a key is there.
 */
import { ONLINE_SOURCES, type MapKeysStatus, type OnlineTileCache } from '@aio/schema';
import { formatBytes, Switch, t } from '@aio/ui';
import { useEffect, useState } from 'react';
import { bridge, useShell } from '../../shell';
import { onlineSatelliteSwitch } from '../../workspace/onlineSatellite';
import { OnlineSatelliteNotice } from '../../workspace/OnlineSatelliteNotice';
import { rasterPacks, useRasterPacks } from '../../workspace/siteTiles';
import { mapSourceRows, masterSwitch, type SourceRow } from './mapSourcesView';

export function MapSources() {
  const enabled = useRasterPacks((s) => s.prefs.onlineSatellite);
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  // read here, not from the raster store: this page lands in the same batch as Task 11
  const [keys, setKeys] = useState<MapKeysStatus>({ esri: false, mapbox: false });
  const [cache, setCache] = useState<OnlineTileCache | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadKeys = () => {
    void bridge.call('mapKeys:status', {}).then((r) => {
      if (r.ok) setKeys(r.value);
    });
  };
  useEffect(() => {
    rasterPacks.getState().refresh();
    loadKeys();
  }, []);
  useEffect(() => {
    let live = true;
    void bridge.call('onlineTiles:status', {}).then((r) => {
      if (live && r.ok) setCache(r.value.cache);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  const master = masterSwitch(enabled, offlineOnly);
  const clear = async () => {
    const r = await bridge.call('onlineTiles:clearCache', {});
    if (r.ok) setCache(r.value);
    else setError(r.error);
  };
  const credits = [...new Set(ONLINE_SOURCES.map((s) => s.attribution))];
  return (
    <div className="sblock map-sources" data-testid="map-sources">
      <div className="ms-master" data-testid="map-sources-master">
        <span className="ms-text">
          <b>{t('mapSources.master')}</b>
          <span className="help">{t(master.help)}</span>
        </span>
        <Switch
          label={t('mapSources.master')}
          checked={master.checked}
          disabled={master.disabled}
          onChange={(on) => {
            // the first time it asks first, with the notice of the workstation's source
            onlineSatelliteSwitch.getState().request(on);
          }}
        />
      </div>
      <OnlineSatelliteNotice />
      {mapSourceRows(keys).map((row) => (
        <ProviderRow key={row.provider} row={row} onChanged={loadKeys} />
      ))}
      <div className="ms-foot">
        <button
          type="button"
          className="btn sm ghost"
          data-testid="map-sources-clear"
          disabled={!cache || cache.tiles === 0}
          onClick={() => void clear()}
        >
          {t('mapSources.clear', { size: formatBytes(cache?.bytes ?? 0) })}
        </button>
        {error && (
          <p className="prov-err" role="alert">
            {error}
          </p>
        )}
      </div>
      <p className="help" dir="ltr" data-testid="map-sources-credits">
        {credits.map((c) => t('mapSources.credit', { attribution: c })).join(' ')}
      </p>
    </div>
  );
}

function ProviderRow({ row, onChanged }: { row: SourceRow; onChanged: () => void }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const provider = row.keyProvider;
  const run = async (what: 'set' | 'test' | 'clear') => {
    if (!provider) return;
    setBusy(true);
    setMsg(what === 'clear' ? null : { ok: true, text: t('mapSources.checking') });
    const r =
      what === 'set'
        ? await bridge.call('mapKeys:set', { provider, key: draft.trim() })
        : what === 'test'
          ? await bridge.call('mapKeys:test', { provider })
          : await bridge.call('mapKeys:clear', { provider });
    setBusy(false);
    const answer = r.ok ? r.value : { ok: false as const, error: r.error };
    if (!answer.ok) {
      setMsg({ ok: false, text: answer.error });
      return;
    }
    setMsg({
      ok: true,
      text: t(
        what === 'set'
          ? 'mapSources.saved'
          : what === 'test'
            ? 'mapSources.tested'
            : 'mapSources.removed',
      ),
    });
    if (what === 'set') setDraft('');
    onChanged();
    // the Map menus read the keys from the raster store
    rasterPacks.getState().refresh();
  };
  const name = t(row.name);
  const inputId = `map-key-${row.provider}`;
  return (
    <section className="ms-row" data-testid={`map-source-${row.provider}`} aria-label={name}>
      <div className="ms-head">
        <b>{name}</b>
        <span className="ms-status" data-testid={`map-source-status-${row.provider}`}>
          {t(row.status)}
        </span>
      </div>
      <p className="help">{t(row.terms)}</p>
      {provider && (
        <div className="ms-key">
          <label className="sr-only" htmlFor={inputId}>
            {t('mapSources.key', { provider: name })}
          </label>
          <input
            id={inputId}
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('mapSources.key.placeholder')}
            value={draft}
            data-testid={inputId}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
          />
          <button
            type="button"
            className="btn sm primary"
            disabled={busy || draft.trim().length < 8}
            data-testid={`map-key-save-${row.provider}`}
            onClick={() => void run('set')}
          >
            {t('mapSources.save')}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy || !row.hasKey}
            data-testid={`map-key-test-${row.provider}`}
            onClick={() => void run('test')}
          >
            {t('mapSources.test')}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy || !row.hasKey}
            data-testid={`map-key-remove-${row.provider}`}
            onClick={() => void run('clear')}
          >
            {t('mapSources.remove')}
          </button>
        </div>
      )}
      {msg && (
        <p
          className={msg.ok ? 'help' : 'prov-err'}
          role="status"
          data-testid={`map-key-msg-${row.provider}`}
        >
          {msg.text}
        </p>
      )}
    </section>
  );
}
```

Styles: add a small block to the Settings stylesheet the other settings pages use (the file that defines `.sblock`; find it with Grep for `\.sblock`): `.ms-master, .ms-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }`, `.ms-row { padding-block: 12px; border-top: 1px solid var(--line-soft); display: grid; gap: 6px; }`, `.ms-key { display: flex; gap: 6px; } .ms-key .input { flex: 1; min-width: 0; }`, `.ms-status { color: var(--fg-3); font-size: var(--t-12); }`. If `.sr-only` is not defined there, use the existing visually-hidden class the app uses (Grep `sr-only|visually-hidden`). Add that stylesheet to this task's commit.

- [ ] **Step 4: Register the page and move the switch out of Offline maps**

- `store.ts`: add `| 'map-sources'` to `SettingsPage` (after `'maps'`).
- `Settings.tsx`: `import { MapSources } from './settings/MapSources';`; after the `maps` nav entry add `{ page: 'map-sources', label: 'settings.page.mapSources', icon: 'globe', group: 'settings.group.data' },`; in `HEAD` add `'map-sources': { title: 'settings.page.mapSources', text: 'settings.mapSources.text' },`; after `{page === 'maps' && <MapPacks />}` add `{page === 'map-sources' && <MapSources />}`.
- `RasterPacks.tsx`: delete the `Online satellite (Sentinel-2)` `Toggle`, the whole `<div className="online-satellite" ...>` block, the `cache` state and its `onlineTiles:status` effect, `toggleOnline`, `clearCache`, the `online` and `offlineOnly` reads that only served them, and the imports `ONLINE_SATELLITE`, `OnlineTileCache`, `onlineSatelliteSwitch`, `OnlineSatelliteNotice`, `formatBytes` if now unused. Update its top comment: the online switch lives in Settings, Map sources.
- `About.tsx`: import `ONLINE_SOURCES` instead of `ONLINE_SATELLITE`; the paragraph becomes:

```tsx
<p className="help" data-testid="about-online-satellite">
  Online maps (off unless you switch them on in Map sources):{' '}
  <span dir="ltr">{[...new Set(ONLINE_SOURCES.map((s) => s.attribution))].join('; ')}</span>.
</p>
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/renderer/screens apps/desktop/src/renderer`
Expected: PASS.
Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/screens/settings/mapSourcesView.ts apps/desktop/src/renderer/screens/settings/mapSourcesView.test.ts apps/desktop/src/renderer/screens/settings/MapSources.tsx apps/desktop/src/renderer/store.ts apps/desktop/src/renderer/screens/Settings.tsx apps/desktop/src/renderer/screens/settings/RasterPacks.tsx apps/desktop/src/renderer/screens/settings/About.tsx
git commit -m "feat(desktop): Settings, Map sources with per-computer keys" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Add the stylesheet you changed in Step 3 to the `git add` line.)

---

### Task 15: Paperwork: ADR amendment, data sources, notices, security page

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen (none here); e2e not needed; conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Packages:** docs, `tools/release`.

**Files:**

- Modify: `docs/architecture/adr/0007-globe-architecture.md` (status line L3; L67 stale sentence; append the amendment)
- Modify: `tools/release/data-sources.json` (two entries after the Sentinel-2 one), `tools/release/data-licences.mjs:16` (comment), `tools/release/data-licences.test.mjs` (one test)
- Regenerate: `docs/release/THIRD-PARTY-NOTICES.md` (`node tools/release/notices.mjs`)
- Modify: `docs/release/SECURITY-AND-DATA.md` (table row L27, paragraphs L32 and L34)

**Interfaces:**

- Consumes: the catalog's attributions (Task 1), copied verbatim.
- Produces: nothing code depends on.

- [ ] **Step 1: Write the failing test**

Append to `tools/release/data-licences.test.mjs` (inside its top `describe`):

```js
it('lists the online providers for their terms, never judged as packs; a pack from them is still ruled out', () => {
  const sources = loadSources();
  const online = sources.filter((s) => s.kind.startsWith('online imagery'));
  expect(online.map((s) => s.name)).toEqual([
    'Sentinel-2 cloudless 2016 (EOX)',
    'Esri World Imagery (online)',
    'Mapbox maps (online)',
  ]);
  for (const s of online) expect(s.attribution, s.name).toBeTruthy();
  expect(checkSources(sources, dataPolicy())).toEqual([]);
  const fromEsri = checkPackMeta(
    { licence: 'CC-BY-4.0', attribution: 'x', provenance: 'Esri World Imagery tiles' },
    dataPolicy(),
  );
  expect(fromEsri).toContain('Esri data is ruled out by decision 4');
});
```

(`checkPackMeta` and `checkSources` are already imported by that file; add them to the import if not.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tools/release/data-licences.test.mjs`
Expected: FAIL (the two online entries are missing).

- [ ] **Step 3: Add the sources and regenerate the notices**

In `tools/release/data-sources.json`, after the "Sentinel-2 cloudless 2016 (EOX)" entry, add:

```json
    {
      "name": "Esri World Imagery (online)",
      "kind": "online imagery (optional, provider terms)",
      "use": "Online satellite in the Map view, the Globe and the 3D scene, streamed through the app's main process for the areas in view when the person switches online maps on and picks it (ADR 0007, amendment of 14 Oct 2026). Without a key the public ArcGIS Online service; with the person's ArcGIS Location Platform key, the basemap service. Kept in memory for the session only: never written to disk, a pack, a project or a package",
      "licence": "LicenseRef-Esri-Terms-of-Use",
      "attribution": "Powered by Esri. Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      "provenance": "Esri World Imagery map service (Web Mercator tiles)",
      "source": "https://www.esri.com/en-us/legal/terms/full-master-agreement"
    },
    {
      "name": "Mapbox maps (online)",
      "kind": "online imagery (optional, provider terms)",
      "use": "Mapbox Satellite and the Mapbox styles (Streets, Outdoors, Light, Dark, Satellite Streets) as raster tiles, streamed through the app's main process with the person's own Mapbox access token when they switch online maps on and pick one (ADR 0007, amendment of 14 Oct 2026). Kept in memory for the session only: never written to disk, a pack, a project or a package",
      "licence": "LicenseRef-Mapbox-Terms-of-Service",
      "attribution": "© Mapbox © OpenStreetMap © Maxar",
      "provenance": "Mapbox Raster Tiles API (mapbox.satellite) and Static Tiles API (mapbox styles)",
      "source": "https://www.mapbox.com/legal/tos"
    },
```

Change the Sentinel-2 entry's `use` to start "Online satellite in the Map view, the Globe and the 3D scene, ..." and the file's `$comment` last sentence to "The online sources (ADR 0007, amendments of 10 and 14 Oct 2026) are streamed on request and never shipped; they are listed for their licences and attributions." In `tools/release/data-licences.mjs` change the header comment's last clause to "...and the providers decision 4 rules out for packs (Cesium ion, Bing, Google, Esri, Mapbox, EOX cloudless 2018 to 2025); Esri and Mapbox may still be streamed online (ADR 0007, amendment of 14 Oct 2026), which this report does not judge."

Run: `node tools/release/notices.mjs`
Expected: `docs/release/THIRD-PARTY-NOTICES.md` rewritten with two new rows in the map data table (and nothing else changed: check with `git diff --stat docs/release/THIRD-PARTY-NOTICES.md`).

- [ ] **Step 4: Write the ADR amendment and the security page**

In `docs/architecture/adr/0007-globe-architecture.md`:

- the status line (L3) ends: "Decision 3 amended 10 Oct 2026 (founder): one online imagery source, off by default; amended again 14 Oct 2026: named online map providers through main, keys per computer; see the amendments at the end."
- in the "Where it draws" paragraph replace the stale sentence "The Globe does not draw it yet; the provider for it exists (`@aio/globe/view`, `createOnlineSatelliteProvider`) and reads the same `aio://online/` address." with "The Globe draws it in its Satellite look since 12 Oct 2026, through the same `aio://online/` address (`@aio/globe/view`, now `createOnlineTileProvider`)."
- append:

```markdown
## Amendment, 14 Oct 2026 (founder): named online map providers, keys per computer

Sentinel-2 from 2016, at about 10 m per pixel, is blurry on any site. The founder decided (plan `docs/plans/2026-10-14-satellite-providers-design.md`):

- **Esri World Imagery and Mapbox are allowed through the main proxy.** Esri World Imagery (keyless public service, or the basemap service with the person's ArcGIS Location Platform key) and Mapbox Satellite plus the Mapbox styles Streets, Outdoors, Light, Dark and Satellite Streets (Static Tiles API, raster, so the 2D map, the Globe and the 3D scene show the same thing). Mapbox Standard is not offered: the Static Tiles API does not serve it. No Custom tile URL, no Google, no Bing, no Mapbox vector styles.
- **Esri World Imagery is the default** online satellite when online maps are first switched on; a workstation that already had Sentinel-2 on keeps it.
- **Every request still goes through main.** The renderer asks `aio://online/<sourceId>/<z>/<x>/<y>` only; the CSP and `hardenSession` are unchanged; `apps/desktop/src/main/onlineUpstream.ts` is the one place that names the hosts (`tiles.maps.eox.at`, `server.arcgisonline.com`, `ibasemaps-api.arcgis.com`, `api.mapbox.com`), one set per source. The gate order is: online maps off (403); bad address or unknown source (400); key required but missing (401); Sentinel-2 disk cache hit (served, also offline-only); offline-only (404); fetch. The polite client stands for every provider: four requests at a time in all, 15 s timeout, no redirect, no cookie, no prefetch, a wait per provider after failures.
- **No disk cache for Esri or Mapbox.** Their terms forbid offline storage: their tiles are kept in memory for the session only (64 MB, the tiles used longest ago go first). Sentinel-2 keeps its 300 MB disk cache.
- **Keys per computer.** A key is kept in the OS credential store (`KeyVault`, accounts `map:esri` and `map:mapbox`), never in a project, never synced or packaged, and added to the request in main. The renderer only learns whether a key is there (`mapKeys:status`); `mapKeys:set` checks a key with one tile request through the same proxy before it is stored. Diagnostics redact `access_token=`, `token=` and the Mapbox and ArcGIS key shapes.
- **One notice per provider.** The first use of each provider names that company as the party that sees the areas viewed; nothing is requested before the person says yes.
- **One switch.** `online.json` stays `aio.online-settings/1`: `satellite` now means "online maps on" (0.11 still reads it), and the optional `source` names the online satellite. Offline-only still blocks switching on.

**What stands.** Decision 3 for CesiumJS itself: no ion token, no ion, Bing, Google, Esri or Mapbox provider of CesiumJS (our own `OnlineTileImageryProvider` reads `aio://` only), no geocoder; the lint ban (`BANNED_CESIUM_IMPORTS`) and the bundle check (no online map host in the built renderer) are unchanged. Imagery packs stay the way to have imagery offline; nothing streamed is ever written into a pack, a project or a package.
```

In `docs/release/SECURITY-AND-DATA.md`, replace the "Online satellite" table row (L27) with three rows (keep the table's column order: what, when, who, what is sent):

```markdown
| Online maps: Sentinel-2 | Off by default. Only after a person turns online maps on and picks it, and never on an offline-only workstation | EOX IT Services GmbH, `tiles.maps.eox.at` over HTTPS | Requests for the imagery tiles of the areas in view (so the areas viewed and the computer's network address are visible to that service), no project data, no key, no cookie |
| Online maps: Esri World Imagery | Off by default. Only after a person turns online maps on and picks it, and never on an offline-only workstation | Esri, `server.arcgisonline.com` (no key) or `ibasemaps-api.arcgis.com` (with the person's key) over HTTPS | Requests for the imagery tiles of the areas in view, with the person's key when one is saved; no project data, no cookie. Tiles are kept in memory only |
| Online maps: Mapbox | Off by default. Only after a person saves a Mapbox key, turns online maps on and picks a Mapbox map, and never on an offline-only workstation | Mapbox, `api.mapbox.com` over HTTPS | Requests for the tiles of the areas in view with the person's access token; no project data, no cookie. Tiles are kept in memory only |
```

In the paragraph at L32 replace "the only exception is online satellite imagery (the row above)" with "the only exception is online maps (the rows above)". In the paragraph at L34 replace "It includes online satellite imagery too: nothing is requested, and only tiles already kept on the computer (up to 300 MB in the app's settings folder, cleared from Settings) are drawn." with "It includes online maps too: nothing is requested, and only Sentinel-2 tiles already kept on the computer (up to 300 MB in the app's settings folder, cleared from Settings, Map sources) are drawn. Map keys are kept in the operating system's credential store of each computer, never in a project or a package."

- [ ] **Step 5: Run the tests and the public text check**

Run: `pnpm exec vitest run tools/release`
Expected: PASS (`notices.test.mjs` "lists every native library and data source" passes with the regenerated file).
Run: `node tools/agent/check-public-text.mjs docs/architecture/adr/0007-globe-architecture.md docs/release/SECURITY-AND-DATA.md tools/release/data-sources.json`
Expected: no findings.
Run: `pnpm format:check`
Expected: exit 0 (run `npx prettier --write` on the changed Markdown if not).

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/adr/0007-globe-architecture.md tools/release/data-sources.json tools/release/data-licences.mjs tools/release/data-licences.test.mjs docs/release/THIRD-PARTY-NOTICES.md docs/release/SECURITY-AND-DATA.md
git commit -m "docs(adr): online map providers through main, keys per computer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: End to end and cleanup

**Rules:** work only in `E:\Dev\AIO Software\.claude\worktrees\satellite-providers`; stage by path (never `git add -A`, never `git stash`); Electron windows off-screen (the fixtures' isolated profile; never start the app by hand without `QUADRION_USER_DATA`); e2e as CI runs it, from `apps/desktop`: `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp QUADRION_E2E_PYTHON="E:\Dev\AIO Software\python\.venv\Scripts\python.exe" npx playwright test e2e/<spec>.spec.ts --workers=1`, one Playwright run at a time; conventional commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Packages:** `apps/desktop` (e2e), `@aio/ui` (`en.ts` cleanup).

**Files:**

- Create: `apps/desktop/e2e/online-map-sources.spec.ts`
- Modify: `apps/desktop/e2e/online-satellite.spec.ts`, `apps/desktop/e2e/basemap-picker.spec.ts`, `apps/desktop/e2e/globe.spec.ts` (~603-634 helpers, ~854, ~954, ~986, ~1930-2023), `apps/desktop/e2e/packages-globe.spec.ts` (~330-342), `apps/desktop/e2e/small-window.spec.ts` (~363-379, one new test)
- Modify: `packages/ui/src/i18n/en.ts` (remove keys nothing uses any more)

**Interfaces:**

- Consumes: every test id produced above; `__aioOnlineTileRequests` and `QUADRION_ONLINE_TILES_TEST` (main's stand-in, unchanged); `window.__stratlas.graphics().getState().setOverride('medium')`; the Globe hook `__aioGlobe.inspect().layers` (`online:<id>` names from Task 7).
- Produces: green e2e for the specs listed.

- [ ] **Step 1: Write the new spec**

Create `apps/desktop/e2e/online-map-sources.spec.ts`:

```ts
/**
 * Online map sources (plan 2026-10-14-satellite-providers; ADR 0007, amendment of 14 Oct 2026):
 * Esri and Mapbox through main, keys per computer, one Map menu in the three views.
 *
 * No test reaches a provider: main's stand-in (QUADRION_ONLINE_TILES_TEST=1) makes flat green
 * tiles and keeps the addresses it would have asked for in `__aioOnlineTileRequests`; the
 * zero-network guard of the fixtures still fails a test on any real request.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './fixtures';

test.use({ appEnv: { QUADRION_ONLINE_TILES_TEST: '1' } });
test.setTimeout(240_000);

const ESRI =
  /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/;
const TOKEN = 'pk.e2e-fake-token-0123456789';
const ESRI_CREDIT = 'Powered by Esri';

const asked = async (app: ElectronApplication) =>
  (await app.evaluate(
    () =>
      (globalThis as { __aioOnlineTileRequests?: string[] }).__aioOnlineTileRequests?.slice() ?? [],
  )) as string[];

const tileStatus = (win: Page, path: string) =>
  win.evaluate(async (url) => {
    const res = await fetch(url);
    return { status: res.status, why: res.headers.get('x-aio-online') };
  }, `aio://online/${path}`);

const stageView = (win: Page, name: '3D' | 'Map') =>
  win
    .getByRole('toolbar', { name: 'Stage tools' })
    .getByRole('group', { name: 'Stage view' })
    .getByRole('button', { name, exact: true });

async function openProject(win: Page, view: '3D' | 'Map'): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Projects' }).click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  const button = stageView(win, view);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function openSettings(win: Page, page: string): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: page }).click();
  await expect(win.locator('.set-page h1')).toHaveText(page);
}

/** The main map's sources (MapLibre), or null before it runs. */
const mapSources = (win: Page) =>
  win.evaluate(() => {
    const host = [...document.querySelectorAll('.pane-map div')].find((d) => '__aioMap' in d) as
      | {
          __aioMap: {
            getStyle():
              { sources: Record<string, { tileSize?: number; attribution?: string }> } | undefined;
          };
        }
      | undefined;
    return host?.__aioMap.getStyle()?.sources ?? null;
  });

/** Confirm the provider's notice in the open menu. */
async function confirmNotice(win: Page, pop: string, provider: string): Promise<void> {
  const notice = win.getByTestId(pop).getByTestId('online-satellite-notice');
  await expect(notice).toHaveAttribute('data-provider', provider);
  await notice.getByRole('button', { name: 'Switch on' }).click();
  await expect(notice).toHaveCount(0);
}

test('picking Esri in the Map view asks once, draws it through main and credits it', async ({
  app,
  win,
  network,
}) => {
  await openProject(win, 'Map');
  const chip = win.getByTestId('basemap-button');
  await chip.click();
  const esri = win.getByTestId('map-tile-esri-world-imagery');
  await expect(esri).toBeEnabled();
  await esri.click();
  // nothing is asked before the person says yes
  expect(await asked(app)).toEqual([]);
  await confirmNotice(win, 'basemap-pop', 'esri');
  await expect(esri).toHaveAttribute('aria-checked', 'true');
  await expect(chip).toContainText('Esri');
  await expect
    .poll(
      async () => (await mapSources(win))?.['g7-raster-online-esri-world-imagery']?.attribution,
      {
        timeout: 30_000,
      },
    )
    .toContain(ESRI_CREDIT);
  await expect(win.getByTestId('map-menu-credit')).toContainText(ESRI_CREDIT);
  await win.keyboard.press('Escape');
  await expect(win.locator('.pane-map .maplibregl-ctrl-attrib')).toContainText(ESRI_CREDIT);
  // main asked the public Esri service only (no key saved), and nothing left the computer
  await expect.poll(async () => (await asked(app)).length, { timeout: 30_000 }).toBeGreaterThan(0);
  for (const url of await asked(app)) expect(url).toMatch(ESRI);
  expect(await network.outbound()).toEqual([]);
});

test('a Mapbox style without a key is greyed with the reason; a key in Map sources enables it', async ({
  app,
  win,
  network,
}) => {
  await openProject(win, 'Map');
  const chip = win.getByTestId('basemap-button');
  await chip.click();
  const style = win.getByTestId('map-tile-mapbox-streets');
  await expect(style).toBeDisabled();
  await expect(win.getByTestId('map-menu-note-mapbox')).toContainText('Add a key in Map sources');
  // Mapbox without a key is refused by main too, without a request
  await win.evaluate(() => window.aio.invoke('onlineTiles:set', { enabled: true }));
  expect(await tileStatus(win, 'mapbox-streets/3/4/2')).toEqual({ status: 401, why: 'no-key' });
  expect(await asked(app)).toEqual([]);

  // the way to Map sources is in the menu
  await win.getByTestId('map-menu-add-key-mapbox').click();
  await expect(win.locator('.set-page h1')).toHaveText('Map sources');
  const row = win.getByTestId('map-source-mapbox');
  await expect(row.getByTestId('map-source-status-mapbox')).toHaveText('No key');
  await row.getByTestId('map-key-mapbox').fill(TOKEN);
  await row.getByTestId('map-key-save-mapbox').click();
  await expect(row.getByTestId('map-key-msg-mapbox')).toHaveText(
    'The key is saved on this computer.',
  );
  await expect(row.getByTestId('map-source-status-mapbox')).toHaveText('Key saved');
  await expect(row.getByTestId('map-key-mapbox')).toHaveValue('');
  // main checked it with one tile, the key added in main
  expect(
    (await asked(app)).some(
      (u) => u.startsWith('https://api.mapbox.com/') && u.includes(`access_token=${TOKEN}`),
    ),
  ).toBe(true);

  await openProject(win, 'Map');
  await chip.click();
  await expect(style).toBeEnabled();
  await style.click();
  await confirmNotice(win, 'basemap-pop', 'mapbox');
  await expect
    .poll(async () => (await mapSources(win))?.['g7-raster-online-mapbox-streets']?.tileSize, {
      timeout: 30_000,
    })
    .toBe(512);
  // a map with its own street names: ours are off and say why
  await expect(win.getByTestId('map-ontop-streets')).toContainText(
    'This map has its own street names',
  );
  await win.keyboard.press('Escape');
  // the token never reaches the page: not in its markup, not in the addresses it loaded
  const leaked = await win.evaluate(
    (token) =>
      document.documentElement.outerHTML.includes(token) ||
      performance.getEntriesByType('resource').some((e) => e.name.includes(token)),
    TOKEN,
  );
  expect(leaked).toBe(false);
  expect(await network.outbound()).toEqual([]);
});

test('the Globe picks Esri from the same menu', async ({ app, win, network }) => {
  await win.locator('.sb-nav .nav-item', { hasText: 'Globe' }).click();
  await expect(win.getByTestId('globe-canvas').locator('canvas')).toBeVisible();
  await win.getByTestId('globe-map-button').click();
  const esri = win.getByTestId('globe-map-menu').getByTestId('map-tile-esri-world-imagery');
  await esri.click();
  await confirmNotice(win, 'globe-map-menu', 'esri');
  await expect
    .poll(
      () =>
        win.evaluate(() => {
          const el = document.querySelector('[data-testid="globe-canvas"]');
          const c = (el as { __aioGlobe?: { inspect(): { layers: string[] } | null } } | null)
            ?.__aioGlobe;
          return c?.inspect()?.layers ?? null;
        }),
      { timeout: 120_000 },
    )
    .toContain('online:esri-world-imagery');
  await expect(win.getByTestId('globe-credits')).toContainText(ESRI_CREDIT, { timeout: 60_000 });
  await expect.poll(async () => (await asked(app)).length, { timeout: 120_000 }).toBeGreaterThan(0);
  for (const url of await asked(app)) expect(url).toMatch(ESRI);
  expect(await network.outbound()).toEqual([]);
});

test("the 3D scene's Map chip turns on imagery around the site from Esri", async ({
  app,
  win,
  network,
}) => {
  await openProject(win, '3D');
  // imagery around the site needs Medium graphics; CI's software GPU is detected as Low
  await win.evaluate(() => {
    const g = (
      window as unknown as {
        __stratlas: { graphics(): { getState(): { tier: string; setOverride(t: string): void } } };
      }
    ).__stratlas
      .graphics()
      .getState();
    if (g.tier === 'low') g.setOverride('medium');
  });
  const chip = win.getByTestId('scene-map-button');
  await chip.click();
  await expect(
    win.getByTestId('scene-map-pop').getByTestId('map-ontop-aroundImagery'),
  ).toBeVisible();
  await win.getByTestId('scene-map-pop').getByTestId('map-tile-esri-world-imagery').click();
  await confirmNotice(win, 'scene-map-pop', 'esri');
  await expect(chip).toContainText('Esri');
  await win.keyboard.press('Escape');
  // the landscape asks main for Esri tiles at a detailed zoom around the site
  await expect
    .poll(
      async () =>
        (await asked(app)).filter((u) => ESRI.test(u) && Number(u.split('/').at(-3)) >= 12).length,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  expect(await network.outbound()).toEqual([]);
});

test('offline-only: online maps are greyed in the menu and main asks nobody', async ({
  app,
  win,
  network,
}) => {
  await openSettings(win, 'Privacy and cloud');
  const offline = win.getByRole('switch', { name: 'Offline-only workstation' });
  await offline.click();
  await expect(offline).toHaveAttribute('aria-checked', 'true');

  await openSettings(win, 'Map sources');
  await expect(win.getByTestId('map-sources-master').getByRole('switch')).toBeDisabled();
  await expect(win.getByTestId('map-sources')).toContainText(
    'This workstation is offline-only, so online maps cannot be switched on.',
  );

  await openProject(win, 'Map');
  await win.getByTestId('basemap-button').click();
  for (const id of ['esri-world-imagery', 'mapbox-satellite', 's2cloudless-2016', 'mapbox-dark'])
    await expect(win.getByTestId(`map-tile-${id}`)).toBeDisabled();
  await expect(win.getByTestId('map-menu-note-satellite')).toContainText(
    'This workstation is offline-only',
  );
  // main enforces it, even with the switch forced on behind the page's back
  expect(await tileStatus(win, 'esri-world-imagery/3/4/2')).toEqual({ status: 403, why: 'off' });
  await win.evaluate(() => window.aio.invoke('onlineTiles:set', { enabled: true }));
  expect(await tileStatus(win, 'esri-world-imagery/3/4/2')).toEqual({
    status: 404,
    why: 'offline-only',
  });
  expect(await asked(app)).toEqual([]);
  expect(await network.outbound()).toEqual([]);
});
```

- [ ] **Step 2: Update the existing specs**

`online-satellite.spec.ts`:

- `tiles: ['aio://online/s2cloudless-2016/{z}/{x}/{y}.jpg']` becomes `tiles: ['aio://online/s2cloudless-2016/{z}/{x}/{y}']`.
- `switchedOn` reads `.enabled` instead of `.satellite`.
- The first test switches on from Settings, Map sources, with Sentinel-2 as the workstation's source. Replace the block from `// Settings, Offline maps: the switch, ...` to `await expect(section.getByTestId('online-satellite')).toContainText(ONLINE_SATELLITE.attribution);` with:

```ts
// Sentinel-2 as this workstation's online satellite (a fresh one starts on Esri)
await win.evaluate(() => window.aio.invoke('onlineTiles:set', { source: 's2cloudless-2016' }));
// Settings, Map sources: the switch, and what it sends the first time
await openSettings(win, 'Map sources');
const section = win.getByTestId('map-sources');
const box = section.getByTestId('map-sources-master').getByRole('switch');
await expect(box).toBeEnabled();
await expect(box).toHaveAttribute('aria-checked', 'false');
const clear = section.getByTestId('map-sources-clear');
await expect(clear).toHaveText('Clear saved satellite tiles (0 B)');
await expect(clear).toBeDisabled();
await box.click();
const notice = section.getByTestId('online-satellite-notice');
await expect(notice).toContainText("from EOX's servers");
await expect(notice).toContainText('the areas you view are visible to that service');
await expect(notice).toContainText('from 2016, at about 10 m per pixel');
await expect(box).toHaveAttribute('aria-checked', 'false');
expect(await switchedOn(win)).toBe(false);
await notice.getByRole('button', { name: 'Switch on' }).click();
await expect(box).toHaveAttribute('aria-checked', 'true');
await expect(notice).toHaveCount(0);
expect(await switchedOn(win)).toBe(true);
expect(JSON.parse(await readFile(join(dataRoot.userData, 'online.json'), 'utf8'))).toEqual({
  schema: 'aio.online-settings/1',
  satellite: true,
  source: 's2cloudless-2016',
});
expect(await win.evaluate(() => window.aio.invoke('settings:get', {}))).not.toHaveProperty(
  'onlineSatellite',
);
await expect(section.getByTestId('map-sources-credits')).toContainText(
  ONLINE_SATELLITE.attribution,
);
```

Later in that test `await openSettings(win, 'Offline maps');` becomes `await openSettings(win, 'Map sources');` and the final `await box.click(); await expect(box).not.toBeChecked();` becomes `await box.click(); await expect(box).toHaveAttribute('aria-checked', 'false');`.

- The offline-only test: open `'Map sources'`, `const box = win.getByTestId('map-sources-master').getByRole('switch');`, expect it disabled with `aria-checked="false"`, expect `win.getByTestId('map-sources')` to contain "This workstation is offline-only, so online maps cannot be switched on.", drop the `aria-describedby` assertion, and replace the forced switch with `expect(await win.evaluate(() => window.aio.invoke('onlineTiles:set', { enabled: true }))).toEqual({ ok: true, enabled: true, source: 'esri-world-imagery' });`.

`basemap-picker.spec.ts`: the picker is now the Map menu. Add the helper `const onTop = (win: Page, key: string) => win.getByTestId(`map-ontop-${key}`).getByRole('switch');` and apply:

| Old                                                                                | New                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chip` text `'Satellite'` with packs drawn                                         | `'Streets'` (the base is the street map; packs are On top)                                                                                                                                                                                                |
| `basemap-satellite` aria-checked / focused at open                                 | `map-tile-streets` aria-checked / focused                                                                                                                                                                                                                 |
| click `basemap-streets` (imagery goes)                                             | `onTop(win, 'packs').click()` (switch off); packs `[HILLSHADE]`                                                                                                                                                                                           |
| click `basemap-imagery` (Satellite only)                                           | `onTop(win, 'packs').click()` (on) then `onTop(win, 'streets').click()` (off); streets hidden                                                                                                                                                             |
| `basemap-pack`                                                                     | `map-pack` (same three options)                                                                                                                                                                                                                           |
| `basemap-hillshade` `.uncheck()` / `.check()` / `toBeChecked()`                    | `onTop(win, 'hillshade').click()` / `toHaveAttribute('aria-checked', 'true')`                                                                                                                                                                             |
| keyboard: focus `basemap-imagery`, ArrowLeft to `basemap-satellite`                | focus `map-tile-streets`, press ArrowRight: the Esri notice opens in the pop (`online-satellite-notice` with `data-provider="esri"`); click Cancel; chip still `'Streets'`; `map-tile-streets` still checked                                              |
| Settings checkbox `/^Satellite: imagery packs/` `.check()` then chip `'Satellite'` | same checkbox `.check()` then `onTop(win, 'packs')` has `aria-checked="true"` and packs `[WORLD, DETAIL, HILLSHADE]`                                                                                                                                      |
| 3D `openLayers3d` + `ground-aroundImagery` / `ground-aroundTerrain`                | `await win.getByTestId('scene-map-button').click();` then `map-ontop-aroundImagery` and `map-ontop-aroundTerrain` visible inside `scene-map-pop`; shot `scene-map-menu`; Escape                                                                           |
| palette `'map type satellite only'` → chip `'Satellite only'`                      | type `'map: sentinel'`, expect option `'Map: Sentinel-2'`, Enter: Settings, Map sources opens with the EOX notice (`online-satellite-notice`, `data-provider="eox"`); click Cancel; go back with `win.locator('.nav-item', { hasText: 'Scene' }).click()` |
| end: `basemap-streets` click → packs `[HILLSHADE]`                                 | `onTop(win, 'packs').click()` (off) → packs `[HILLSHADE]`                                                                                                                                                                                                 |
| relaunch: `basemap-streets` aria-checked                                           | `map-tile-streets` aria-checked; packs `[HILLSHADE]`                                                                                                                                                                                                      |

Test "Satellite is greyed out ..." becomes "imagery packs and shading are greyed with the reason when no pack covers the site": chip `'Streets'`, `map-tile-streets` checked, `onTop(win, 'packs')` and `onTop(win, 'hillshade')` disabled, `map-ontop-packs` contains "No imagery pack covers this site", `map-ontop-hillshade` contains "No terrain pack covers this site", `map-pack` count 0, packs `[]`, shot and accessibility as before; the last part clicks `map-sources-link` and expects the heading "Map sources" and `map-sources` in the viewport.

Test "a site covered by imagery but no terrain pack ..." keeps its flow with: chip `'Streets'`; `onTop(win, 'packs')` enabled and on; `onTop(win, 'hillshade')` disabled with "No terrain pack covers this site"; with one covering pack the picker shows two options: `await expect(win.getByTestId('map-pack').locator('option')).toHaveCount(2);`; the light-theme part unchanged.

`describe('Online satellite')` becomes `describe('Online maps in the menu')`: `switchedOn` reads `.enabled`; `ONLINE` stays `'g7-raster-online-s2cloudless-2016-layer'`. Test 1, "Sentinel-2 asks once, then draws where no pack covers the site": open the tiny project's map; open the chip; `map-tile-s2cloudless-2016` enabled; click it, expect the notice (EOX wording as before, `toBeInViewport({ ratio: 1 })` for the notice and its Switch on button), nothing asked, Cancel; click it again, Switch on; chip `'Sentinel-2'`; packs `[ONLINE]`; credit contains `ONLINE_SATELLITE.attribution`; `onTop(win, 'streets')` off → streets hidden, packs still `[ONLINE]`; `map-tile-streets` click → packs `[]`, `switchedOn` still true; `map-tile-s2cloudless-2016` click again → no notice, packs `[ONLINE]`; Escape; every asked URL matches the EOX regex; `network.outbound()` empty; Settings, Map sources: master switch on → click → off, `switchedOn` false; back to Scene: chip `'Sentinel-2'` with `map-chip-fallback` "Offline map", packs `[]`; palette `'map: sentinel'` → Enter → `switchedOn` true (notice already read), packs `[ONLINE]`, `map-chip-fallback` gone. Test 2, offline-only: switch on Sentinel-2 from the menu as above; go offline-only in Privacy and cloud; back on the map the Sentinel-2 tile stays enabled and drawn (saved tiles), `map-tile-esri-world-imagery` disabled with `map-menu-note-satellite` "This workstation is offline-only"; Settings, Map sources: master switch click → off, then disabled; Scene: chip `'Sentinel-2'` with "Offline map", packs `[]`, `map-tile-s2cloudless-2016` disabled; palette `'map: sentinel'` offers nothing (`palette.getByText('Map: Sentinel-2')` count 0); asked count unchanged; `network.outbound()` empty. Keep the shots and accessibility checks at the same points with names `menu-online-*`.

`globe.spec.ts`:

- `chooseLook` (~623) becomes:

```ts
/**
 * Choose a look in the Map menu, which stays open: the street map or Natural Earth as the base,
 * and the imagery packs on top for the Satellite and Natural Earth looks; the menu.
 */
async function chooseLook(win: Page, style: GlobeStyle) {
  const menu = await openMap(win);
  const tile = menu.getByTestId(
    style === 'natural-earth' ? 'map-tile-natural-earth' : 'map-tile-streets',
  );
  await tile.click();
  await expect(tile).toHaveAttribute('aria-checked', 'true');
  const packs = menu.getByTestId('map-ontop-packs').getByRole('switch');
  const want = style !== 'street' ? 'true' : 'false';
  if ((await packs.isEnabled()) && (await packs.getAttribute('aria-checked')) !== want)
    await packs.click();
  return menu;
}
```

- `win.getByTestId('globe-look-street')).toHaveAttribute('aria-pressed', 'true')` (~854, ~986) becomes `win.getByTestId('map-tile-streets')).toHaveAttribute('aria-checked', 'true')`; `globe-look-natural-earth` (~954) becomes `map-tile-natural-earth` with `aria-checked`.
- In `describe('online satellite on the Globe')` (~1930): drop `HINT`; test 1 becomes "Sentinel-2 from the Map menu lies over the Earth and under the packs, and only there": after `installSyntheticPacks` and `openGlobe`, `setLook(win, 'satellite')` → layers `['earth-shapes:whole', 'pack:syn-imagery']`; then `const map = await openMap(win); await map.getByTestId('map-tile-s2cloudless-2016').click(); await map.getByTestId('online-satellite-notice').getByRole('button', { name: 'Switch on' }).click(); await closeMap(win);` → layers `['earth-shapes:whole', 'online:s2cloudless-2016', 'pack:syn-imagery']`, credits contain `ONLINE_SATELLITE.attribution` and the pack's; the green sampling unchanged; `setLook(win, 'street')` → `['earth-shapes:whole']`; `setLook(win, 'natural-earth')` → `['natural-earth-ii', 'pack:syn-imagery']`; no outbound requests. Test 2 becomes "a Mapbox map without a key is greyed in the Globe menu, Esri is not": `openGlobe`, `openMap`, `map-tile-mapbox-satellite` disabled, `map-menu-note-satellite` contains "Add a key in Map sources", `map-tile-esri-world-imagery` enabled, `asked(app)` 0.
- Run the geometry tests that box `globe-map-button` (~497, ~547): the chip is wider than the old button; if an inset assertion fails, update the expected box from the new chip (it must still clear the search field and the view buttons).

`packages-globe.spec.ts` (~330-342):

```ts
// the Map menu lists the package's pack (listed under its package id)
await pw.getByTestId('globe-map-button').click();
const menu = pw.getByTestId('globe-map-menu');
await expect(menu).toBeVisible();
const packsOn = menu.getByTestId('map-ontop-packs').getByRole('switch');
if ((await packsOn.getAttribute('aria-checked')) !== 'true') await packsOn.click();
await expect(packsOn).toHaveAttribute('aria-checked', 'true');
const option = menu.getByTestId('map-pack').locator(`option[value="${PACKAGE_RASTER_ID}"]`);
await expect(option).toHaveCount(1);
await expect(option).toHaveText(IMAGERY_LABEL);
await expect(menu.getByTestId('map-pack').locator('option')).toHaveCount(2);
await packsOn.focus();
await pw.keyboard.press('Escape');
await expect(menu).toHaveCount(0);
```

`small-window.spec.ts`: `switchOnSatellite` (~363) becomes:

```ts
/** Pick Sentinel-2 in the Map menu: the map draws it, with its long credit. */
async function switchOnSatellite(win: Page): Promise<void> {
  const chip = win.getByTestId('basemap-button');
  await chip.click();
  await win.getByTestId('map-tile-s2cloudless-2016').click();
  await win
    .getByTestId('basemap-pop')
    .getByTestId('online-satellite-notice')
    .getByRole('button', { name: 'Switch on' })
    .click();
  await expect(chip).toContainText('Sentinel-2');
  // the menu's own chip closes it again
  await chip.click();
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  await expect(win.getByTestId('basemap-pop')).toHaveCount(0);
  await expect(credits(win)).toContainText(ONLINE_SATELLITE.attribution, VIEW_READY);
}
```

and add inside `test.describe('with online satellite')` (it already runs at 1100 x 700):

```ts
test('the Map menu fits the smallest window: it scrolls inside, and nothing of it is cut off', async ({
  win,
}, info) => {
  await openMapWithoutPacks(win);
  const chip = win.getByTestId('basemap-button');
  await chip.click();
  const pop = win.getByTestId('basemap-pop');
  await expect(pop).toBeVisible();
  const box = await pop.boundingBox();
  const size = win.viewportSize();
  expect(box && size).toBeTruthy();
  if (box && size) {
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  }
  // the footer is reachable by scrolling inside the pop
  const link = pop.getByTestId('map-sources-link');
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeInViewport({ ratio: 1 });
  await shot(win, info, 'map-menu-small-window.png');
  await win.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(chip).toBeFocused();
});
```

- [ ] **Step 3: Remove the strings nothing uses**

From `apps/desktop`, list the keys of the old menus that no source file uses any more:

```bash
node -e "
const fs=require('fs'),path=require('path');
const en=fs.readFileSync('../../packages/ui/src/i18n/en.ts','utf8');
const keys=[...en.matchAll(/^\s+'((?:basemap|ground|g7\.online|globe\.look|globe\.satelliteHint|globe\.noStreetPacks|globe\.mapMenu|globe\.imagery|globe\.terrain|globe\.lowTier|globe\.showIssues|palette\.basemap|palette\.online)[^']*)'/gm)].map(m=>m[1]);
const files=[];(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()){if(e.name!=='node_modules')walk(p);}else if(/\.(tsx?)$/.test(e.name)&&!p.endsWith('en.ts'))files.push(fs.readFileSync(p,'utf8'));}})('src');
for(const d of fs.readdirSync('../../packages'))if(fs.existsSync('../../packages/'+d+'/src'))(function walk(x){for(const e of fs.readdirSync(x,{withFileTypes:true})){const p=path.join(x,e.name);if(e.isDirectory())walk(p);else if(/\.(tsx?)$/.test(e.name)&&!p.endsWith('en.ts'))files.push(fs.readFileSync(p,'utf8'));}})('../../packages/'+d+'/src');
const all=files.join('\n');
console.log(keys.filter(k=>!all.includes(\"'\"+k+\"'\")&&!all.includes('\`'+k.split('.')[0]+'.')).join('\n'));
"
```

Delete each key it prints from `packages/ui/src/i18n/en.ts` (keys built with a template, such as `basemap.${b}`, are gone with Task 12; the script also prints those). Rerun until it prints nothing, then `pnpm exec vitest run packages/ui`.

- [ ] **Step 4: Run everything the way CI does**

```bash
pnpm check
cd apps/desktop
pnpm demo:change --quick
pnpm demo:build --quick
```

Expected: `pnpm check` exit 0; both demo builds succeed.

Then each spec, one at a time (PowerShell: set `$env:QUADRION_WINDOW_SIZE = '1100x720'`, `$env:QUADRION_E2E_SCALE = '1'`, `$env:QUADRION_E2E_SWGL = 'warp'`, `$env:QUADRION_E2E_PYTHON = 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe'` first):

```bash
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp QUADRION_E2E_PYTHON="E:\Dev\AIO Software\python\.venv\Scripts\python.exe" npx playwright test e2e/online-map-sources.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp QUADRION_E2E_PYTHON="E:\Dev\AIO Software\python\.venv\Scripts\python.exe" npx playwright test e2e/online-satellite.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp QUADRION_E2E_PYTHON="E:\Dev\AIO Software\python\.venv\Scripts\python.exe" npx playwright test e2e/basemap-picker.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp QUADRION_E2E_PYTHON="E:\Dev\AIO Software\python\.venv\Scripts\python.exe" npx playwright test e2e/small-window.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp QUADRION_E2E_PYTHON="E:\Dev\AIO Software\python\.venv\Scripts\python.exe" npx playwright test e2e/globe.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp QUADRION_E2E_PYTHON="E:\Dev\AIO Software\python\.venv\Scripts\python.exe" npx playwright test e2e/packages-globe.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp QUADRION_E2E_PYTHON="E:\Dev\AIO Software\python\.venv\Scripts\python.exe" npx playwright test e2e/imagery-packs.spec.ts --workers=1
```

Expected: each run prints `[e2e] window 1100 x 720 px at display scale 1` (small-window: 1100 x 700) and passes. Run the new spec with `--repeat-each=3` once to catch timing problems. Look at every screenshot the specs write (`menu-*`, `scene-map-menu`, `map-menu-small-window.png`) before handing off.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/online-map-sources.spec.ts apps/desktop/e2e/online-satellite.spec.ts apps/desktop/e2e/basemap-picker.spec.ts apps/desktop/e2e/globe.spec.ts apps/desktop/e2e/packages-globe.spec.ts apps/desktop/e2e/small-window.spec.ts packages/ui/src/i18n/en.ts
git commit -m "test(e2e): online map sources and the one Map menu in every view" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done while writing)

**Spec coverage.** Map sources catalog: Task 1 (schema) and Task 2 (upstreams). Tile flow and security, gate order, format sniffing, memory LRU, polite client: Task 3. Per-provider notice: Task 11 (store, notice) with Tasks 12-14 rendering it. Keys, vault accounts, the four channels, the preload allowlist, redaction: Tasks 1, 4, 5. Settings (`online.json`, per-view prefs, Map sources page): Tasks 1, 11, 13, 14. The Map menu (model, Gallery component, chip per view, accessibility, small window, fallback note): Tasks 9, 10, 12, 13, 16. Views (MapLibre, Cesium, three.js): Tasks 6, 7, 8 wired in 11-13. Paperwork: Tasks 1 (contract row) and 15. Testing: unit tests in every task, e2e in Task 16. Out of scope items are not planned.

**Placeholder scan.** No TBD or "similar to"; every code step carries code. Task 16 edits existing long specs by an exact mapping table plus full code for the changed helpers and the new tests; the implementer applies the table line by line.

**Type consistency.** `OnlineSourceId`, `BaseMapId`, `MapKeyProvider`, `MapKeysStatus` (Task 1) are used with the same names everywhere; `drawnBase(chosen, online, keys)` (Task 9) is called the same way in Tasks 11 and 13; `RasterPackDisplay.online: OnlineSourceId | null` (Task 6) matches `BasemapDraw.online` (Tasks 6, 11); `setOnline(patch)` (Task 11) replaces `setOnlineSatellite` everywhere it was called (siteTiles, onlineSatellite); `onlineSatelliteSwitch.request(on, source?, then?)` keeps the one-argument form Task 14 uses; `GlobeView.online` (Task 7) is fed by `globeDraw` (Task 13).

**Review Focus.** Each of the five lines has its test in the owning task (named in the Review Focus section).

## How to test (for the founder, once merged)

1. Open Settings, **Map sources**. "Online maps" is off. Switch it on: a notice says Esri sees the areas you view; press **Switch on**.
2. Open a project, go to the **Map** view, press the map chip under the zoom buttons. The menu shows Offline / Online satellite / Mapbox styles as small pictures. Pick **Esri**: the map turns sharp, and the footer and the map's corner credit Esri.
3. In the same menu the Mapbox pictures are greyed with "Key", and the line under them says "Add a key in Map sources". Press that link, paste a Mapbox public token, press **Save key**: it says "The key is saved on this computer." Back in the menu, pick **Dark**: the Mapbox notice appears once; after **Switch on** the map is Mapbox Dark, and "Street names and roads" is greyed ("This map has its own street names").
4. Switch to the **3D** view: a new map chip sits under the compass. Pick **Esri** there (Graphics preset Medium or higher): imagery appears on the land around the site.
5. Open the **Globe**, press its Map button: the same menu. Pick **Esri**; the Globe drapes it and the credits name Esri.
6. In Settings, **Privacy and cloud**, turn on offline-only. Back on the Map: online pictures are greyed with "This workstation is offline-only"; if Sentinel-2 was used before, its saved tiles still draw and the chip says "Offline map".
7. In Settings, **Map sources**, press **Remove** on the Mapbox row: Mapbox maps fall back to the street map with the "Offline map" note.

## Risks and open points for the founder

- **Esri keyless terms.** The keyless `server.arcgisonline.com` World Imagery service is offered under Esri's terms of use, which generally expect an ArcGIS account for production or commercial apps. A key from an ArcGIS Location Platform account (the basemap service) is the clean route. The app works keyless as the founder asked; a legal read before customer use is advisable.
- **Mapbox attribution.** Mapbox's terms ask for the Mapbox wordmark and "Improve this map" as a link on maps that show its tiles. The bundle check forbids the `mapbox.com` host in the renderer, so the credit is plain text ("© Mapbox © OpenStreetMap"). Showing the wordmark (an image shipped with the app) and the feedback link (opened by main) is a follow-up.
- **Esri "Map data not yet available" tiles.** At deep zooms where there is no imagery, the keyless service answers 200 with a grey placeholder picture, which is drawn. Max zoom 19 limits this; a sniff for the placeholder is a follow-up if it shows up on sites.
- **Billing.** Mapbox Static Tiles at 512 px @2x are one request per tile (four times fewer than 256 px). With a key, requests beyond the free monthly allowance are billed to the person's account; the Settings note says so.
