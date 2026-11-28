# Quadrion AI / Atlas website

The current site is the dark Quadrion AI product presentation. The selected homepage is atlas.html; index.html, mission.html and precision.html redirect to it. Identity comes from packages/brand/brand.json and the outlined Quadrion identity kit.

## Build and preview

Run from the repository root:

1. `node docs/design/landing-options/build-site.mjs` renders all eight pages, applies the shared Quadrion shell, and builds the scene modules. Use this entry point instead of individual legacy render scripts. It needs the two screenshot variables listed under "Private sources".
2. `node docs/design/landing-options/build-sample.mjs` regenerates the four-page PDF from the original F01, F02 and F05 records and photographs. The PDF is git-ignored; see "What is not in the repository".
3. `node docs/design/landing-options/pack-assets.mjs` creates losslessly compressed transfer copies. Original model geometry, data and source packages are unchanged.
4. `node docs/design/landing-options/serve.mjs` serves the local preview on 127.0.0.1:8766.
5. `node docs/design/landing-options/check-quadrion.mjs` verifies the current branding, guided scenes, real-data controls, downloads, mobile navigation, overflow and optional-cloud failure recovery. Older check scripts below describe earlier design stages.

## Private sources

The preview is built from source projects and prepared assets that are not in the repository. No script names them. Each script reads the folder it needs from the environment and stops with one line naming the variable when it is not set. The helper is private-sources.mjs. The variables are one family, `QUADRION_PREVIEW_<NAME>`; the older `STRATLAS_PREVIEW_<NAME>` spelling works too.

| Variable                             | Points at                                                                                                           | Read by                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `QUADRION_PREVIEW_PROJECTS`          | The folder that holds the source projects. Needed when a project variable below is a folder name, not a path.       | the prepare scripts, check-corrosion.mjs        |
| `QUADRION_PREVIEW_PLANT_PROJECT`     | The plant source project (a path, or a folder name under the projects folder).                                      | prepare-fusion.mjs                              |
| `QUADRION_PREVIEW_PLANT_ASSETS`      | The prepared plant assets (a folder name under docs/design/assets, or a path).                                      | prepare-fusion.mjs                              |
| `QUADRION_PREVIEW_PLANT_CLIP_LAYER`  | The id of the flight clip layer in the plant project manifest.                                                      | prepare-fusion.mjs                              |
| `QUADRION_PREVIEW_PLANT_CLOUD_INDEX` | Optional. The cloud index inside the plant project. The default is `clouds/<project folder name>/index.json`.       | prepare-fusion.mjs                              |
| `QUADRION_PREVIEW_TANK_ASSETS`       | The prepared tank assets (a folder name under docs/design/assets, or a path).                                       | prepare-inspection.mjs                          |
| `QUADRION_PREVIEW_FLARE_PROJECT`     | The flare-stack source project (a path, or a folder name). The earlier `STRATLAS_FLARE_SOURCE` path is still read.  | prepare-corrosion.mjs, check-corrosion.mjs      |
| `QUADRION_PREVIEW_ROAD_PROJECT`      | The road source project (a path, or a folder name).                                                                 | prepare-use-cases.mjs                           |
| `QUADRION_PREVIEW_STOCKPILE_PROJECT` | The stockpile source project (a path, or a folder name).                                                            | prepare-use-cases.mjs                           |
| `QUADRION_PREVIEW_FACADE_ASSETS`     | The prepared facade assets (a folder name under docs/design/assets, or a path).                                     | prepare-use-cases.mjs                           |
| `QUADRION_PREVIEW_WORKSPACE_SHOT`    | The file name of the workspace screenshot in docs/design/assets/landing-2026-10-05.                                 | render-directions.mjs, and so build-site.mjs    |
| `QUADRION_PREVIEW_INSPECTION_SHOT`   | The file name of the inspection screenshot in the same folder.                                                      | render-directions.mjs, and so build-site.mjs    |
| `QUADRION_PREVIEW_PORT`              | Optional. The port of the local preview server. The default is 8766.                                                | serve.mjs                                       |
| `QUADRION_PREVIEW_URL`               | Optional. The address the checks open.                                                                              | check-transitions.mjs, check-quadrion.mjs       |

The check scripts guard the pages against client and site names. They hold no list of their own: private-sources.mjs asks tools/agent/check-public-text.mjs, which knows the repository's list and the names in the local project manifests under `QUADRION_DATA`.

## What is not in the repository

- **The assets folder.** Everything under docs/design/assets is git-ignored: the prepared source assets, the application screenshots, the generated presentation assets and the bundles. They are private previews under the data-use restrictions in docs/design/assets/MANIFEST.md and must not be published. Without that folder the pages open but show no model, photograph or video.
- **The sample PDF.** build-sample.mjs writes quadrion-inspection-sample.pdf into this folder from private photographs and finding records. The file is git-ignored by name, so a local build never stages it. The "Download sample PDF" link on reporting.html works only after a local build.
- **Names.** The pages hard-code anonymised figures and finding text taken from the source data. They carry no client, site, asset or person names. Keeping them was decided by the merge coordinator under the founder's delegation on 28 Nov 2026.

## Current presentation

### Scene motion verification

The homepage blends cloud, flight markers and projected footage over 850 ms. Camera moves preserve the displayed position, orientation and field of view, including when a visitor changes chapters mid-transition or takes over by dragging. The visible scene follows requestAnimationFrame without a fixed 30 fps gate. Reduced motion finishes transitions immediately.

Run `node docs/design/landing-options/check-transitions.mjs` after building. This checks intermediate layer opacity, camera handoffs, orbit interruption, rapid chapter selection, explicit overview reset, reduced motion and mobile layout. Screenshots and verification logs can be kept in the ignored `.superpowers/scene-verification/` directory.

For a second local preview, set `QUADRION_PREVIEW_PORT=8786` when starting `serve.mjs`, and `QUADRION_PREVIEW_URL=http://127.0.0.1:8786/landing-options/` for both `check-transitions.mjs` and `check-quadrion.mjs`.

- A five-chapter Atlas transformation: engineering model, measured height cloud, recorded drone flight, projected footage, drone-eye view. A single desktop autoplay pass, manual chapters, pause/replay, user-interruption handling and reduced-motion support. Mobile starts under visitor control.
- Independent on-demand point-cloud loading; model rendering remains available when the cloud fails.
- Shared software navigation and product-focused calls to action across eight pages. No lead-generation or inspection-service inquiry flow.
- Guided confined-space and corrosion chapters; road observations linked to source close-ups; fixed-camera survey-date comparisons; facade navigation by original elevation metadata.
- A light, branded report preview inside the dark site, a fixed anonymized sample PDF, and a selection-based CSV export.
- Customer names excluded from rendered page text and the generated sample deliverable. The sample data is still local preview material governed by the existing asset manifest.

---

The notes below record the earlier preview and its source-data provenance.

# Stratlas: data fusion landing concepts

Atlas is the selected direction, now in dark mode with an interactive plant hero. Reality remains available as the earlier comparison direction.

- Reality: index.html. Cinematic, full-screen drone-eye comparison.
- Atlas: atlas.html. Rotating plant model, height-coloured survey points, and a recorded drone flight projected onto the actual model surfaces.

The prior Mission and Precision URLs redirect here. Evidence is now a dedicated interactive page. The visible copy and displayed screenshot regions omit customer and project identities. Nothing has been published.

## Run

From the repository root, with existing node_modules:

1. node docs/design/landing-options/render-directions.mjs
2. node docs/design/landing-options/prepare-fusion.mjs
3. node docs/design/landing-options/serve.mjs
4. Open http://127.0.0.1:8766/landing-options/atlas.html
5. If rebuilding the scene assets, run node docs/design/landing-options/capture-layers.mjs with the server running.
6. Verify with node docs/design/landing-options/check.mjs.

## Shared dark theme

atlas-theme.css owns the shared Atlas palette: charcoal page and scene backgrounds, raised dark panels, sage secondary text, pale lime actions and quiet borders. Both landing directions and all four product pages load it. Component styles consume those tokens for navigation, inspection controls, findings, corrosion evidence and the report preview. Photographs, footage, height colours and corrosion classifications retain their data colours. The product-page footer returns to the selected Atlas overview.

## Dark Atlas hero

The hero starts with the engineering model rotating slowly. The corner controls add a measured point cloud, coloured by model-frame elevation with a metre legend, and a drone-video layer. Video mode reveals the flight path, an enlarged drone marker at the recorded camera position, the camera footprint and a source-video panel with playback and seeking. Flight overview and Drone eye use the same clock. Both layers can be enabled together. Visitors can drag to orbit, pause rotation, compare video on/off from the same overview, and reset the view. Reduced motion starts with rotation off.

atlas.js imports Projector directly from packages/video/src/projector.ts. The preview therefore uses the application's projective texturing, lens mapping and depth-map occlusion, rather than a screen-space video overlay. A preview-local shader adapter applies Three's standard sRGB video decode to the custom projector sampler, preserving the source footage's colours. The existing exported flight poses include the source project's position and orientation calibration. Registration remains approximate. Point colours use the actual cloud elevations (-12 to approximately 76 metres relative to the site datum); they are not inferred from the model.

Static geometry is batched into five material groups to reduce rendering work. All 442,691 visible source triangles are preserved, with world transforms baked into their positions. The drone symbol is enlarged for readability and does not represent the aircraft's dimensions.

After changing only the Atlas UI, run node docs/design/landing-options/render-directions.mjs and node docs/design/landing-options/build-atlas.mjs. prepare-fusion.mjs also builds Atlas when regenerating assets. Verify this direction with node docs/design/landing-options/check-atlas.mjs. The check covers source-pose linkage, actual pixel changes in the WebGL projection, occlusion, elevation controls, combined layers, rotation, playback, seeking, keyboard use, mobile layouts and reduced motion. It saves screenshots in docs/design/assets/fusion.

For the confined-space pages, also run:

1. node docs/design/landing-options/render-inspection.mjs
2. node docs/design/landing-options/prepare-inspection.mjs
3. With the preview server running, node docs/design/landing-options/check-inspection.mjs

The existing prepared tank assets, the folder `QUADRION_PREVIEW_TANK_ASSETS` names under docs/design/assets, are required by prepare-inspection.mjs. It copies neutral-named presentation assets and bundles the interactive viewer into the ignored docs/design/assets/inspection directory.

## Confined-space product pages

Both landing directions link to three connected pages:

- confined-spaces.html: section the real tank model vertically or horizontally, switch surface treatments, overlay 280,000 captured LiDAR points, select spatial findings, and play a recorded interior flight in orbit, follow or drone-eye mode.
- evidence.html: explore six source findings with search and severity filters, inspect their original photos, add temporary point or box annotations, measure between recorded finding positions, mark records reviewed and select them for reporting.
- reporting.html: build a sample report from those selections, toggle its sections, browse source evidence, download a working CSV and explore the content scope of a project handover.

Review and report selections persist in sessionStorage for this browser tab. Draft photo annotations remain in memory and are explicitly marked as preview annotations. They do not alter source photos or findings. Measurements are straight-line distances between recorded finding positions, not defect dimensions.

The tank scene, scan, clip, camera samples, six findings and photos come from existing project assets. The six records are labeled as a curated excerpt, not the full issue register. The viewer uses the tank's local metre-based frame. Drone-eye rendering is a pinhole approximation of the source f-theta lens; external geolocation and optical registration are approximate.

The pages also explain production capabilities including video projection, annotation back-projection, multiple sightings, keyframes, contextual AI, PDF reports and protected project packages. The standalone preview generates CSV; PDF and .aio package creation remain desktop product capabilities, not simulated downloads.

Capability references: packages/video/README.md, packages/engine/README.md, packages/annotate/README.md, packages/ai/README.md, packages/project/README.md, apps/desktop/src/renderer/workspace/StageTools.tsx and apps/desktop/src/renderer/screens/Reports.tsx.

check-inspection.mjs verifies source-pose synchronization, playback, section and layer controls, cross-view selection, filters and empty states, photo zoom, draft point/box/undo, source-coordinate measurements, session review, report selection, CSV contents, mobile navigation, image loading, visible identity exclusions and reduced-motion behavior. It saves desktop and mobile screenshots beside the generated inspection assets.

## Flare-stack corrosion explorer

corrosion.html adds the original flare-stack model and all 78 mapped surface patches. It supports orbit navigation, whole-stack and detail views, the source photo camera, mask visibility and opacity, rust/oxidation filters, isolated patches, direct surface picking, and linked source photos with matching class overlays. Both landing directions and every product page link to it; the confined-space page also includes a visual feature.

Build with:

1. node docs/design/landing-options/render-corrosion.mjs
2. node docs/design/landing-options/prepare-corrosion.mjs
3. With the server running, node docs/design/landing-options/check-corrosion.mjs

The preparation script reads the existing imported project that `QUADRION_PREVIEW_FLARE_PROJECT` points at and writes only to the ignored docs/design/assets/corrosion directory. It preserves the source model, mesh transform, surface-patch positions, UV coordinates and patch textures. Source photos are resized for the browser, and label masks use nearest-neighbour resizing. Identifying project metadata is excluded from the presentation data. The teaser.webp asset is a browser capture of this actual scene.

The source dataset contains 77 Moderate and one Light graded findings; it does not contain Heavy graded findings. The photo overlay displays rust and oxidation classes. No new corrosion inference is run. Surface registration remains approximate, and marked photo percentages are not a measurement of asset-wide corrosion or metal loss.

The check verifies source geometry and texture preservation, visibly rendered 3D masks, class filtering, opacity, isolation, exact source camera pose, orbit, direct surface picking, evidence switching, mobile navigation, reduced motion and links from the existing pages. Screenshots are saved alongside the generated assets.

## Fusion data

The experience loads the actual engineering GLB, drone clip, orthomosaic and survey points. The point cloud contains 757,579 captured points, subsampled from the existing survey cloud. No points are synthesized from the model. Each view uses the same recorded camera position and orientation, interpolated against video.currentTime. The lens and orientation/position calibration come from the current project manifest, with the inverse model transform applied to the native flight and cloud data. The 11 second excerpt starts 5 seconds into its source flight clip.

The model uses a deliberate monochrome material treatment. The orthomosaic is a flat registered ground layer; it is not a new 3D reconstruction. Registration remains approximate. The landing experience is a Three.js presentation of the real data, not the production workspace embedded in a website. The workspace and tank cutaway sections are actual application screenshots. CSS viewport crops exclude customer headers and identifying report text.

## Assets and scope

Generated assets and bundle are in the ignored docs/design/assets/fusion directory. Source assets and application screenshots remain in the existing ignored asset directory. These are internal design previews, subject to the data-use restrictions in docs/design/assets/MANIFEST.md. Do not publish the client assets.

Only the local design artifacts were changed. The app, project manifests, calibration and source data were read, not edited.

## Earlier Reality direction

Five layer modes; keyboard-accessible fusion slider; pointer-drag divider; play, pause and seek; drone-eye and spatial overview; subtle pointer parallax; scroll separation of the four spatial layers; real-workspace lightbox; reduced-motion support; desktop and mobile layouts.

check-fusion.mjs verifies Reality's five modes, exact camera linkage to the exported calibrated poses, playback, slider keyboard control, spatial camera switching, dialog dismissal, image loading, visible customer-name exclusions, horizontal overflow and reduced motion. check.mjs runs that check and the separate Atlas check in sequence. Screenshots are saved beside generated assets for review.


## Dedicated inspection disciplines

The confined-space page now stays on the interior inspection workflow. It uses confined-content.mjs and confined.css for six expandable capability chapters, source-photo finding selection linked to the tank pins, and point-cloud colours by intensity, actual height and the two capture flights. The former flare-stack promotion is removed from its main content.

Three additional pages share the dark Atlas theme and the Use cases menu on every route:

- roads.html: the source corridor centreline and 31 condition sections, PCI severity assumptions, chainage navigation, 28 original defect close-ups drawn from 2,115 source defects, class filters and registered polygon outlines.

- volumetric.html: both original textured survey GLBs, all 19 stockpiles, two dates, four source base methods, linked toe outlines, inventory totals and source cut/fill. All captured terrain remains visible when selecting a pile; selection highlights its boundary. This preview reads source-computed quantities rather than deriving new volumes from display meshes.

- facades.html: six original visual/thermal images, class-mask overlays with opacity control, source detection outlines, photo zoom and linked findings with component/elevation metadata. Source masks are region fills, not fine segmentation.

Prepare assets with node docs/design/landing-options/prepare-use-cases.mjs. It reads the road and stockpile projects that `QUADRION_PREVIEW_ROAD_PROJECT` and `QUADRION_PREVIEW_STOCKPILE_PROJECT` point at and the prepared facade assets that `QUADRION_PREVIEW_FACADE_ASSETS` names, copies presentation assets into the ignored assets/use-cases directory, excludes customer metadata and bundles the interactive code. Render with node docs/design/landing-options/render-use-cases.mjs. For code-only rebuilds use build-use-cases.mjs. No source package is modified.

Run check-use-cases.mjs with the local preview server running. It checks source PCI values, filters and polygon visibility, both 3D survey dates, all four bases for a reference pile, stockpile selection, facade masks and thermal sources, confined-space scope and new controls, mobile layouts, navigation and visible customer-name exclusions. Existing check-inspection.mjs continues to verify the original tank, evidence and reporting workflows.

Capability references: docs/guide/09-volumes-and-roads.md, apps/desktop/src/renderer/road, packages/volumetric/README.md, packages/pointcloud/README.md, packages/annotate/README.md, packages/ai/README.md and packages/video/README.md.
