# Design brief: UI direction and brand exploration

## Round 2 (supersedes conflicting rules below)

Round 1 was rejected by the founder: "not really nice", "much better UI needed". Hard requirements now:

1. **Dark mode first.** The app is dark. A light theme is optional and secondary.
2. **Collapsible sidebar** on the left: expanded state with the wordmark, primary navigation with labels, a project switcher, the project's dataset tree (layers grouped by type: Models, Point clouds, Maps and rasters, Video, Photos, Annotations), and the user/settings at the bottom; collapsed state is a slim icon rail with tooltips. Smooth animated collapse, keyboard toggle (Ctrl+B), remembered state.
3. **References the founder picked:** Palantir Gotham / Anduril Lattice (mission-ops command centre, map-centric dark, tactical overlays, serious and defence-grade), DJI FlightHub 2 / DJI Terra (drone-native dark workspace, live video tiles, flight paths, mission panels), Unreal Engine 5 / Blender 4 (pro 3D editor: viewports, outliner, properties, timeline). Not consumer, not "SaaS dashboard", not cards-everywhere.
4. **Balanced density:** big 3D/map stage, panels that collapse away, 13 to 14 px UI type, comfortable but serious.
5. **Real assets, not drawn placeholders.** Real models, video, ortho and photos are being prepared in `docs/design/assets/` (see `docs/design/assets/MANIFEST.md` when it appears). Use them. Video windows play real drone footage; the 3D stage loads the real GLBs; the ground uses the real ortho. Canvas-drawn fake maps and video frames are not acceptable in the final file.
6. **Working name:** "Stratlas" (not final). Use a layered-strata mark: 3 to 4 stacked offset parallelogram layers, monochrome with one accent layer.
7. **Annotation suite is a core feature** (PRD 6.4): show annotation tools on mesh, photo and video, with issues that carry a severity from a severity model and appear across views.
8. **Craft bar:** this must look like a premium shipped product someone would pay for. Use the `impeccable` skill (or `example-skills:frontend-design`) for craft. Precise 1 px borders, consistent 4/8 px spacing grid, a disciplined type scale, tabular numerals, real icon set drawn as consistent inline SVG (1.5 px stroke, 20 px grid), subtle depth (layered surfaces, not drop-shadow soup), purposeful motion (sidebar, panel docking, playhead), clear focus and hover states.
9. **Review loop:** render every screen in the built-in browser at 1440 x 900, screenshot it, critique it against this brief like a demanding design lead, fix, and repeat at least twice before reporting.

Mockup files may now reference sibling asset files by relative path (`../assets/...`), so the 2 MB single-file limit no longer applies; keep the HTML itself lean.

Working title: **the product** (name not chosen yet; a parallel naming exercise runs now). Owner: Synapse Solutions.

## What the product is

An installed, offline-first desktop application (Windows + macOS, Electron) for drone and reality-capture deliverables. It opens, fuses and reviews spatial datasets of industrial assets, and later builds new deliverables from raw data. It replaces six one-off web review pages with one professional tool.

Users: an internal team who builds and edits projects (power users, engineers, surveyors, inspectors), and customers who receive a read-only player or an exported package (asset owners, HSE and integrity managers).

## Core idea: fusion

Every project is a set of georeferenced layers in one scene and one timeline:

- 3D models (GLB meshes: plant models, tank models, building shells)
- point clouds (LiDAR or photogrammetry; up to hundreds of millions of points)
- maps (offline OSM street basemap for the GCC + world overview; orthomosaics; plot plans)
- drone video with a flight log (pose per frame), synced to the 3D view and projected onto the model or ground
- photos with camera poses, masks and findings
- findings / defects / volumes / measurements, and the PDF report

The two must-have reference experiences:

1. **Al-Zour LNG terminal (KIPIC, Kuwait).** 3D plant model of 909 nodes (tanks, process, utilities, buildings, jetty) on the orthomosaic and a street map; 25 drone video clips whose flight paths are drawn in 3D; playing a clip moves a drone marker along its path and projects the video footprint on the ground; 12 panoramas; asset tree of 12 areas; point cloud (842 M points, thinned) streamed by distance.
2. **HCl Tank 710-D-130335 (KOC, Kuwait).** Rubber-lined tank mesh (shell, lining, nozzles, internals) plus a 1.4 M point LiDAR cloud from 10 Elios flights; the inspection video is projected onto the tank wall from the drone pose (f-theta lens); flight scrub bar, follow-cam and drone-eye views; section cut; 11 findings F01 to F11 with severity 3 to 5; nozzle schedule.

Other projects in the library (use them as realistic data): EBSM flare stack, EQUATE, Kuwait (80 m, 299 photos, 78 findings); DAMAC Hills residential tower facade, Dubai (1,182 photos, 656 defects, 206-page PDF); Masafi stockpile yard, Kuwait (19 piles, two survey dates 31 Dec 2020 and 10 Jan 2021, volumes and cut/fill); 1st Ring Road survey, Kuwait (road defects, PCI per ASTM D6433, 1.25 cm GSD orthomosaic, chainage).

## AI everywhere

- Settings has **AI providers**: Anthropic, OpenAI, Google Gemini. The user enters API keys themselves; keys live in the OS credential vault. Per-task model routing (for example: agent chat, vision/detection on photos, report writing, model building from drawings/point clouds). A global "offline only / allow cloud AI" switch, and a per-project data-sharing policy.
- **Every window has an agent available**: the 3D view, map, point cloud, photo, video and report windows can each open an agent panel that sees that window's context (selection, current frame, visible layers) and can act in the app (filter findings, fly to an asset, measure, draft a finding note, compare survey dates). Show tool actions the agent took as chips or steps, with approve/undo.
- Future (show as a roadmap item, not a working feature): build 3D models from 2D drawings / plot plans and from point clouds.

## Screens every UI option must show (same four, so options compare fairly)

1. **Projects home**: library of the six projects as cards or rows (type, site, date, size, layers present, offline-ready state), new project / import, recent activity, offline map packs status.
2. **Fusion workspace: Al-Zour.** 3D plant + map + a playing drone video synced to its flight path + timeline + layers/asset tree + agent panel in use (realistic conversation, e.g. "Show me every clip that passes over Tank T-02 and the frames where the roof is visible").
3. **Inspection workspace: HCl tank.** Tank mesh with the video projected onto it, point cloud on, flight scrubber, findings list with severity, the agent attached to the video window.
4. **Settings: AI and agents** (providers, keys masked, model routing table, agent per window, privacy) plus an **Offline maps** section (GCC packs, sizes, download/update).

## Mockup technical rules (these become claude.ai Artifact pages)

- One self-contained `.html` file per option. Start it with `<!doctype html>`, `<meta charset="utf-8">`, a viewport meta with `viewport-fit=cover`, and a `<title>`. Switch between the four screens with an in-page screen switcher (tabs or a strip), all four reachable without reload.
- External scripts only from `https://cdnjs.cloudflare.com` (pin exact versions; e.g. three.js `https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`). Fonts only via Google Fonts link. No other hosts, no iframes, no remote images: draw maps, video frames and imagery with Canvas/WebGL/SVG/CSS gradients. A live three.js scene for the 3D stage is encouraged (procedural tanks, pipe racks, jetty; a cylinder tank with nozzles) and makes the options convincing.
- Colors as CSS tokens on `:root`. A desktop pro tool may be deliberately dark-first: then put dark values and `color-scheme: dark` on bare `:root`, and give it a light theme under `@media (prefers-color-scheme: light)` guarded by `:root:not([data-theme="dark"])` and again under `:root[data-theme="light"]`. `body` gets an explicit token background.
- It is a desktop app, so design for 1440 x 900 first, but at phone width (about 400 px) it must not scroll the page sideways: stack panels, keep a 16 px gutter.
- Use the real project data above (names, counts, dates, severities). No lorem ipsum. Placeholder wordmark: show the product name as a neutral text mark "Product" in the title bar.
- Avoid the generic AI look: no cream + serif + terracotta, no purple-blue gradient hero, no Inter / Space Grotesk as the main face, no emoji icons, no rounded-card-with-accent-rail everywhere. Use line icons drawn as inline SVG.
- Keep the file under 2 MB. No `alert`/`confirm`/`prompt`, no downloads, no print.
- Add a small fixed caption on each screen: "Option X: <direction name>, screen n of 4".
