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
- **Online satellite** (`view/onlineSatellite.ts`): Sentinel-2 through `aio://online/...`, in the
  Satellite look only, above the street globe and under the packs, while the host says the
  person switched it on. Main serves or refuses every tile.
- **Imagery packs** (`view/providers.ts`): raster PMTiles, in the Satellite and Natural Earth
  looks.
- **Natural Earth II**: the painted raster of the first Globe, the Natural Earth look.

## Light, pins and motion (`view/`)

- `aura.ts`: one post-process pass for the street looks: soft shading of the whole Earth, a haze
  along the limb, a glow around it and a sparse star field, all fading out near the ground. Not
  on the Low preset. The Natural Earth look keeps CesiumJS's star box and atmosphere.
- `pins.ts`: what is drawn on canvases and shown as billboards. A site is a chip: a dot in its
  tone (the site itself: the billboard is anchored there, so `pinPosition` is the dot), its name
  cut to a width, and a badge with the open issues. Issue and measuring pins are small sprites.
  The sizes and the cutting are pure (`../chips.ts`: `chipMetrics`, `fitLabel`, `issueBadge`).
- A site stands on the ground, and one position says where: with terrain the controller puts the
  site's entity at the height of the terrain under it (`Globe.getHeight`, exaggeration
  included) and looks again after a frame in which terrain tiles came in, the view came to rest
  or the exaggeration changed; without terrain it is on the ellipsoid and nothing is looked at.
  The chip has no height reference of its own (a billboard CesiumJS clamps keeps its ground
  place to itself), so the chip, `pinPosition`, the rings, the label, the card and the
  gathering all read that one position.
- Gathering is the package's own pass, not CesiumJS's `EntityCluster` (which only asks whether a
  neighbour's anchor lies in a chip's box, and misses overlaps once north is not up). After a
  frame in which the view moved, the controller hands every chip's place and size to
  `groupChips` (`../chips.ts`, pure, the same answer at any heading) and draws one chip
  ("3 sites", from the host's `clusterLabel`) for each group in a billboard collection of its
  own, hiding the members' chips. A click on it flies to its sites, where they part (sites at
  the same place cannot). `inspect().clusters` lists the groups, `inspect().chips` the box of
  every chip drawn.
- A flight that frames sites (`flyHome`, a click on a gathered chip) frames their chips, not
  their points: `padBounds` (`../camera.ts`, pure) grows the sites' box by what the host's
  `cardInsets` and a chip's size around its dot are worth on the ground, so every chip lands
  whole in the view and clear of the host's controls.
- Three HTML elements the controller moves after each frame (`bindTag`): the rings of the
  selected site (no label: its chip and its card say the name), the label under the pointer or
  of the site lit from the host's list, and the `card` slot. The host fills the slot through
  `GlobeView`'s `card` and `cardPick` (a site's pin or an issue's); `placeCard` keeps it by the
  pin and inside the view less `cardInsets`, the room the host's own controls take (which the
  flights that frame sites leave free as well).
- `look.ts`: what each graphics preset buys (pixel ratio, screen-space error, the aura, the idle
  turn). The scene draws on demand; the idle turn and the zoom step ask for frames only while
  they run.
