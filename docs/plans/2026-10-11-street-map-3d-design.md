# The 3D scene sits on the street map: design

11 Oct 2026. Branch `feat/street-map-3d`.

## What the founder asked for

The 3D scene of a project stands alone and looks empty. One button should layer it on the street map the app already has.

Decided with the founder: it happens in the project's 3D scene (not on the Globe), and it is on by default wherever a street map pack covers the site. Decided with the Orchestrator (acting for the founder on 11 Oct): nested rings for the ground, flat under the content, a toolbar button that replaces the Layers checkbox, no new shortcut.

## What is there today

- A checkbox, **Street map under the site**, in the **Layers and issue pins** popover (`StageTools.tsx`, state in `siteBasemap.ts`). It starts off for any project with its own ortho, model or point cloud, so most projects never show it.
- The ground is one 2048 px picture over about 5 km (`packages/maps/src/groundRender.ts`): about 2.4 m per pixel, soft up close (listed in `docs/KNOWN-LIMITS.md`).

## What changes

### 1. The ground: nested rings

The street map is drawn as up to three squares around the content, each its own picture:

| Ring   | Half size                                  | Metres per pixel at 2048 px |
| ------ | ------------------------------------------ | --------------------------- |
| Near   | what the content covers, 400 m to 6 km     | 0.4 to 5.9                  |
| Middle | four times the near ring, at most 12 km    | 1.6 and up                  |
| Far    | sixteen times the near ring, at most 12 km | 6.3 and up                  |

A ring that would be less than one and a half times the ring inside it is left out (a site 6 km across gets two rings). For a typical site of a few hundred metres the rings are 500 m, 2 km and 8 km.

- **No overlap.** The near ring is a quad. Each further ring is a frame with a hole exactly where the ring inside it lies, at the same height, so nothing is drawn twice and nothing flickers (depth precision at a kilometre is worse than any small height offset between stacked quads).
- **Picture coordinates.** Each vertex takes its place in the picture from its longitude and its Web Mercator latitude, so a frame's inner edge shows the same streets as the edge of the ring inside it.
- **One hidden map.** One hidden MapLibre map draws the rings one after another (near first) and is removed when the last is copied. Each ring is added to the scene when it is ready.
- **After the scene is up.** Drawing starts when the stage's content box has stopped changing (two readings 300 ms apart), or after 2.5 s. That box also sizes the near ring, so a model or cloud is measured (today only flights and photos are; projects with their own ground got a fixed 5 km square).
- **Low tier.** The pictures are 1024 px on the Low graphics tier (the software renderer), 2048 px otherwise.
- **Freed** when the button is off, the project closes or the view goes: textures, geometry and the hidden map.
- **Height** as today: flat, just under the lowest model (`contentFloor`), settling as terrain loads.
- The plain ground is hidden only once the near ring is in the scene, so there is no empty frame while it is drawn.

The manifest's own `basemap` layers (`createGround`) are not touched.

### 2. On by default

`siteBasemapOn(choices, projectId)` is the remembered choice, else **on**. The choice stays in `localStorage` (`stratlas.streetMap3d`), per project, as today: no schema field, so no contract change. A project where somebody turned it off stays off.

Nothing is drawn, and nothing fails, when the project has no projected CRS, has a `basemap` layer of its own, or no installed pack reaches zoom 12 over the site (as today).

### 3. Hidden under the landscape

While **Imagery around the site** or **Terrain around the site** is on and a pack covers the site (the landscape of `surroundings.ts`), the street map is not drawn: the landscape follows the terrain and a flat map would cut through it. Turning the landscape off brings the street map back. Draping streets on terrain is a follow-up.

### 4. The button

A toggle in the stage toolbar's **Labels and layers** group, 3D and split views only, after the issue pins toggle:

- Pressed while the choice is on. Label: **Hide the street map** or **Show the street map under the site**.
- Disabled with the reason as its label when no pack covers the site ("No installed map pack covers this site") or the landscape is on ("Hidden while imagery or terrain around the site is on (Layers)").
- Not shown for projects that cannot have it (no projected CRS, own `basemap` layer).
- Reached by Tab and the arrow keys like every stage tool; no shortcut. It folds into **More tools** with its group when the window is narrow.
- The checkbox in the Layers popover goes.

### 5. Compare dates and split

The second view of **Compare dates** reads the same choice and the main view's rings (their extents are kept in the store beside `covered`), so both panes show the same ground or neither.

## Units

| Unit          | File                                                    | What it does                                                                                                                                                     |
| ------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ring geometry | `packages/maps/src/ground.ts`                           | `ringGeometry(bbox, hole, proj, y)`: positions, picture coordinates and triangles of a quad or a frame. Pure.                                                    |
| Ring renderer | `packages/maps/src/groundRings.ts`                      | `createGroundRings(layer, ctx, { extents, sizePx, onRing })`: one hidden map, one mesh per ring in a group named `basemap:<id>`, a handle to hide and free them. |
| Model         | `apps/desktop/src/renderer/workspace/siteBasemap.ts`    | Default on, `streetMapRings(extent)`, `landscapeOn(prefs, ground)`, `useStreetMap3d()` (wanted, choice, covered, landscape, shown), `useSiteBasemapLayer`.       |
| Button        | `apps/desktop/src/renderer/workspace/StreetMapTool.tsx` | The toolbar toggle.                                                                                                                                              |

## Tests

- Unit: ring geometry (quad, frame, picture coordinates, shared corners); ring sizes; default on and a stored choice; the landscape hides it; the button's states (pressed, disabled with each reason, absent).
- End to end, new `street-map-3d.spec.ts`: a synthetic project with a model and a synthetic street pack opens on the street map (rings in the scene, the plain ground hidden, the button pressed); the button takes it away and brings the plain ground back; the choice survives reopening the project; the button is on the bar or under **More tools** in the small window.
- `video-first.spec.ts` and the stockpile spec keep passing unchanged (the group keeps the name `basemap:site-street-map`).
- Before the hand-off, the CI way, one run at a time: perf, shell, small-window, panels, measure-tools, compare, video-first and the new spec.

## Not in this change

- A tiled quadtree with level of detail (the upgrade behind the same button).
- Streets draped on terrain.
- Labels that face the camera (they are part of the picture, as on the Globe).
- The street map for projects in a CRS the maps package cannot project (UTM and WGS 84 only today).
