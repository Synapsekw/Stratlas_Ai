# @aio/globe

The Globe view (M10 stream G6, decision 3): CesiumJS (`@cesium/engine` and `@cesium/core` only,
never `@cesium/widgets`) as a lazily loaded renderer view for overview and navigation. Every
library project is a site on the Earth, over the app's street map, offline imagery and terrain
packs; a project's tilesets and issues show when you fly in, and **Open site here** hands over to
the site view. Nothing is edited or measured here beyond a geodesic read-out. Public API:
`src/index.ts` (no CesiumJS) and `src/view/index.ts` (the CesiumJS view). Depends on `@aio/schema`
and `@aio/geo`.

## Offline rules (G0, `offline.ts`)

- No Cesium ion token, no default imagery or terrain, no geocoder and no base layer picker
  (`OFFLINE_CESIUM`). The Earth is drawn from what the app ships or the person installed: the
  bundled land and border shapes, street tiles the app draws from its street packs, imagery
  packs, and Natural Earth II from the app's own copy of Cesium's assets (`CESIUM_BASE_PATH`,
  served from `'self'`).
- `BANNED_CESIUM_IMPORTS` and `BANNED_CESIUM_PACKAGES` feed the lint rule in `eslint.config.js`;
  `ONLINE_GLOBE_HOSTS` feeds the bundle check (`tools/release/check-bundle.mjs`).
- Credits come from the layer plan and pack metadata (`planCredits`, `creditLines`), customer
  imagery marked as such.

## Looks and layers (`style.ts`, `layers.ts`)

`GlobeSettings.style` chooses the look: `street` (the default), `satellite` or `natural-earth`.
`planGlobeLayers` is the one function that decides which imagery layers a look draws, bottom
first; the view (`view/controller.ts`) builds exactly what the plan lists. A further source is one
more kind of plan entry and one more case in the view.

- **Land and borders** (`earth/`): Natural Earth 1:50m vectors (public domain, the `world-atlas`
  package, about 750 kB) decoded once and painted per tile on a 2D canvas in the street style's
  colours. The Earth of a fresh install, and the layer under the street tiles.
- **Street tiles** (`GlobeTileSource`): Web Mercator raster tiles the host draws. The app renders
  its street style from the installed street packs with a hidden MapLibre map (`@aio/maps`
  `createStreetTiles`); this package knows neither MapLibre nor the packs. CesiumJS mixes tile
  levels in one view, and a street style draws each zoom differently, so with the view at rest
  every street tile in view is drawn again in the style of the deepest one (`styleZoomFor`,
  `TileSourceImageryProvider.syncView`): labels and line widths agree across tile edges.
- **Imagery packs** (`view/providers.ts`): raster PMTiles, in the Satellite and Natural Earth
  looks.
- **Natural Earth II**: the painted raster of the first Globe, the Natural Earth look.

## Light, pins and motion (`view/`)

- `aura.ts`: one post-process pass for the street looks: soft shading of the whole Earth, a haze
  along the limb, a glow around it and a sparse star field, all fading out near the ground. Not
  on the Low preset. The Natural Earth look keeps CesiumJS's star box and atmosphere.
- `pins.ts`: site, cluster, issue and measuring pins drawn on canvases. The label beside the
  selected site and under the pointer is an HTML element the controller moves (`bindTag`).
- `look.ts`: what each graphics preset buys (pixel ratio, screen-space error, the aura, the idle
  turn). The scene draws on demand; the idle turn and the zoom step ask for frames only while
  they run.
