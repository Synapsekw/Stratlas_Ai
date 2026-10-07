# @aio/globe

The Globe view (M10 stream G6, decision 3): CesiumJS (`@cesium/engine` and `@cesium/core` only,
never `@cesium/widgets`) as a lazily loaded renderer view for overview and navigation. Every
library project is a site on the Earth, over offline imagery and terrain packs; a project's orthos,
tilesets and issues show when you fly in, and **Open site here** hands over to the site view.
Nothing is edited or measured here beyond a geodesic read-out. Public API: `src/index.ts`.
Depends on `@aio/schema`.

## Offline rules (G0, `offline.ts`)

- No Cesium ion token, no default imagery or terrain, no geocoder and no base layer picker
  (`OFFLINE_CESIUM`). The base layer is Natural Earth II from the app's own copy of Cesium's assets
  (`CESIUM_BASE_PATH`, served from `'self'`).
- `BANNED_CESIUM_IMPORTS` and `BANNED_CESIUM_PACKAGES` feed the lint rule in `eslint.config.js`;
  `ONLINE_GLOBE_HOSTS` feeds the bundle check (`tools/release/check-bundle.mjs`).
- Credits come from pack metadata (`creditLines`), customer imagery marked as such.

## Planned modules (G6)

`GlobeView.tsx`, `setup.ts`, `imagery.ts` (`PmtilesImageryProvider`, `KitPyramidImageryProvider`),
`terrain.ts` (Terrarium heightmaps with the geoid offset), `sites.ts`, `pins.ts`, `tilesets.ts`,
`camera.ts`. CesiumJS is added as a dependency by G6, after its day-one spike.
