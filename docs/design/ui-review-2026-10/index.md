# Quadrion AI UI review screenshots

Taken 30 Oct 2026 from `main` @ d13e6a6b9 (app rebuilt with `pnpm build`), demo projects from `apps/desktop/demo` (built 21 Oct), off-screen Electron via the e2e fixtures, one worker. Window 1280x800 unless the name ends in `-1100x720`. Throwaway spec: `zz-ui-review-shots.spec.ts` in this folder (copied into `apps/desktop/e2e` only for the run, deleted after).

Numbering: 0x library, 1x scene / island / right sidebar, 2x scene tools, 3x other screens, 40 settings, 5x change site (2 dates), 6x road, 7x photo-only project.

| File | Shows | Reached by | Notes / visibly broken |
|---|---|---|---|
| 01-first-start.png | First start screen, no data folder yet | Launch with no data folder | Library cards row at the bottom is cut by the window edge (cards only partly visible, needs scroll). Welcome card is very text-dense. |
| 02-library.png | Project library with the 4 demo projects | Launch with empty data folder + demo | Same welcome card as first start; project cards pushed below the fold at 1280x800. |
| 03-library-card-menu.png | Project card menu (... on a card) | Click project-menu-button on first card | Menu opens over the welcome card; Rename disabled with a hint. |
| 04-new-project.png | New project dialog, step 1 | Click new-project |  |
| 05-no-project-scene.png | Scene with no project open (empty state) | Click Scene nav with no project | Empty state; fine. |
| 06-no-project-issues.png | Issues with no project open (empty state) | Click Issues nav with no project | Empty state; fine. |
| 10-scene-default-1100x720.png | Scene, demo tank farm, default view | Open Demo tank farm from library | Very crowded: stage only ~280 px wide; Show control wraps "Cut & fill" onto 2 lines; pile labels cut by the right sidebar; video window covers half the stage. |
| 10-scene-default.png | Scene, demo tank farm, default view | Open Demo tank farm from library | Crowded: floating drone-video window covers the lower-left third of the stage; "Preparing survey surfaces" toast overlaps the video window; a lingering "Collapse the timeline" tooltip; left dataset tree cut off ("Annotations" half visible) above the status rows. |
| 11-left-sidebar-collapsed.png | Left sidebar collapsed | Click sidebar-toggle | Hint card "Click a pile to see its outline..." floats mid-stage. |
| 13-island-annotate.png | Stage island (notch) open, annotate group quick row | Island Enter, hover annotate tab | Island tools panel covers the stage Show control (Photo/Elevation/Cut & fill) under it. |
| 13-island-clouds.png | Stage island (notch) open, clouds group quick row | Island Enter, hover clouds tab |  |
| 13-island-display.png | Stage island (notch) open, display group quick row | Island Enter, hover display tab |  |
| 13-island-measure.png | Stage island (notch) open, measure group quick row | Island Enter, hover measure tab |  |
| 13-island-video.png | Stage island (notch) open, video group quick row | Island Enter, hover video tab |  |
| 13-island-view-1100x720.png | Stage island opened (tools row, View group) | Focus island, Enter | Island tools panel covers most of the stage width. |
| 13-island-view.png | Stage island (notch) open, view group quick row | Island Enter, hover view tab | Same overlap of the Show control. |
| 13-island-volumes.png | Stage island (notch) open, volumes group quick row | Island Enter, hover volumes tab |  |
| 14-bench-annotate.png | Right sidebar workbench tab for annotate | Island Enter, focus annotate tab, Enter | Annotate bench nearly empty (one button + Drafts), large blank panel. |
| 14-bench-clouds.png | Right sidebar workbench tab for clouds | Island Enter, focus clouds tab, Enter |  |
| 14-bench-display.png | Right sidebar workbench tab for display | Island Enter, focus display tab, Enter |  |
| 14-bench-measure.png | Right sidebar workbench tab for measure | Island Enter, focus measure tab, Enter |  |
| 14-bench-video.png | Right sidebar workbench tab for video | Island Enter, focus video tab, Enter |  |
| 14-bench-volumes.png | Right sidebar workbench tab for volumes | Island Enter, focus volumes tab, Enter |  |
| 15-wb-more-tabs.png | Right sidebar "More tabs" overflow menu | Click More tabs | Overflow menu ("... 3") lists Issues, Volumes, Changes: only three tabs fit the bar. |
| 15-wbtab-annotate.png | Right sidebar tab wb-tab-annotate | Click #wb-tab-annotate |  |
| 15-wbtab-measure.png | Right sidebar tab wb-tab-measure | Click #wb-tab-measure |  |
| 15-wbtab-selection.png | Right sidebar tab wb-tab-selection | Click #wb-tab-selection |  |
| 16-context-menu-date.png | Right-click menu on a survey date folder | Right-click first date-folder row |  |
| 16-context-menu-layer.png | Right-click menu on a sidebar dataset row | Right-click first tree-row | Long menu runs to the bottom edge of the window. |
| 17-project-switch-menu.png | Project menu in the sidebar top (title bar) | Click .proj-switch | BROKEN: project names in the switcher are truncated to one letter ("D...", "P...") while the customer column takes the width. |
| 18-command-palette-query.png | Command palette with query "measure" | Ctrl+K, type measure | "measure" finds only two export actions, not the measure tools. |
| 18-command-palette.png | Command palette (Ctrl+K), empty query | Ctrl+K |  |
| 20-map-view.png | 2D Map view of the stage | Island Stage view: Map | No map pack: notice "...ayers only. Add a pack in Settings, Offline maps." is cut off behind the floating video window. |
| 21-split-view.png | Split view (3D + Map) | Island Stage view: Split | Pile labels clipped at the 3D/Map pane boundary; "No map pack" notice wraps in the narrow map pane. |
| 22-bottom-strip-dates.png | Bottom strip, Dates switch (timeline) | Click bottom-switch-dates |  |
| 22-bottom-strip-footage.png | Bottom strip, Footage switch | Click bottom-switch-footage | Clock "09:20:0..." and clip name truncated in the footage bar; an "Annotate 0:00.0" chip sits on the video. |
| 23-measure-distance-tool.png | Distance tool armed from the Project tab tool list | Project tab > Distance | Distance tool armed (island shows a "Distance" chip, Project tab shows the tool card). |
| 24-issue-card.png | Issue card F01 over the scene | Palette F01 | Palette "F01" jumps to the Issues screen with F01 open (not a card over the scene). A "Search projects..." tooltip lingers over the header. |
| 25-agent-pane-off.png | AI agent pane, why-off explanation | Click "Agent off · Turn on" | Agent docks at the bottom of the right sidebar: "Agent is off" with a small composer. |
| 25-agent-pane.png | AI agent pane opened from the right header | Scene, click agent-open | Agent button pressed but the pane is not visibly open in this frame; "Preparing survey surfaces" toast overlaps the video window. |
| 27-measurement-row-menu.png | Right-click menu on a measurement row (Project tab) | Right-click measure-row | Menu covers the Datasets tree; fine otherwise. |
| 28-video-row-open.png | Drone video opened in the bench (video row clicked) | Click Video dataset row | Docked agent squeezes the Project tab list to half height. |
| 30-issues.png | Issues screen (issue register) | Nav Issues | Detail column photos are large; bottom metadata row clipped at the window edge. |
| 31-inspect-1100x720.png | Inspect screen (photos & findings) | Nav Inspect | Findings column collapses to a "Findings (0)" button; fine. |
| 31-inspect.png | Inspect screen (photos & findings) | Nav Inspect |  |
| 32-inspect-ask-ai.png | Inspect: Ask AI checks menu (analytics) | Click ask-ai-checks |  |
| 33-analytics-custom.png | Custom analytics panel | ask-ai-checks then ask-ai-custom | Custom request form crammed in the right column; "Class: Pick at acc" and "Severity: Pick at a" dropdown labels truncated. |
| 34-reports.png | Reports screen | Nav Reports | Large empty centre (no PDF yet) beside a long, cramped options column. |
| 35-package-export.png | Export project package dialog | Palette "Export project package" | Dialog fits; footer close to the bottom edge. |
| 36-globe.png | Globe screen | Nav Globe | BROKEN: site cluster marker dot drawn on top of its label ("3 sites" reads "3*tes"). |
| 37-projects-with-open.png | Projects library while a project is open | Nav Projects |  |
| 38-help.png | User guide (F1) | F1 | Guide dialog over the library; fine. |
| 40-settings-01-ai-providers.png | Settings: AI providers | Settings > AI providers |  |
| 40-settings-02-usage-and-cost.png | Settings: Usage and cost | Settings > Usage and cost |  |
| 40-settings-03-privacy-and-cloud.png | Settings: Privacy and cloud | Settings > Privacy and cloud |  |
| 40-settings-04-identity-and-team.png | Settings: Identity and team | Settings > Identity and team |  |
| 40-settings-05-data-folder.png | Settings: Data folder | Settings > Data folder |  |
| 40-settings-06-processing-tools.png | Settings: Processing tools | Settings > Processing tools | BROKEN: missing space between title and description ("...when a project opensRuns in the background..."). |
| 40-settings-07-offline-maps.png | Settings: Offline maps | Settings > Offline maps |  |
| 40-settings-08-map-sources.png | Settings: Map sources | Settings > Map sources | Long attribution paragraph at the bottom runs to the edge. |
| 40-settings-09-severity-models.png | Settings: Severity models | Settings > Severity models |  |
| 40-settings-10-classes.png | Settings: Classes | Settings > Classes |  |
| 40-settings-11-report-branding.png | Settings: Report branding | Settings > Report branding |  |
| 40-settings-12-graphics-quality.png | Settings: Graphics quality | Settings > Graphics quality |  |
| 40-settings-13-appearance.png | Settings: Appearance | Settings > Appearance |  |
| 40-settings-14-keyboard.png | Settings: Keyboard | Settings > Keyboard | Search field placeholder truncated ("Type a key, an action c"). |
| 40-settings-15-about-and-updates.png | Settings: About and updates | Settings > About and updates |  |
| 50-change-scene-1100x720.png | Scene, demo change site (2 dates), default | Open Demo change site | Timeline clock and "site time" label truncated. |
| 50-change-scene.png | Scene, demo change site (2 dates), default | Open Demo change site | Video window and the "Site settings" coordinate card overlap the bottom of the stage; timeline clock truncated. |
| 51-changes-tab-1100x720.png | Right sidebar Changes tab | Click tab-changes |  |
| 51-changes-tab.png | Right sidebar Changes tab | Click tab-changes | Empty state "No changes found yet" in a mostly blank panel. |
| 52-compare-dates-1100x720.png | Compare dates (side by side) | Island View row: compare-dates | BROKEN-ish: each compare pane ~140 px wide; island clipped at the stage top-left; pane header "3D view" truncated to "3..."; change buttons wrap. |
| 52-compare-dates.png | Compare dates (side by side) | Island View row: compare-dates | "Can't line up" chip floats under the island; island sits off-centre over the divider. |
| 53-compare-dates-island.png | Compare dates with island tools open | Island Enter while comparing | "Hide the timeline" tooltip overlaps the island panel. |
| 54-dates-strip.png | Timeline / dates strip with two dates | Click bottom-switch-dates |  |
| 55-change-map.png | Change site in Map view | Stage view Map | Site fitted small in a large dark map; vector labels ("East fence", "Main track", "Drain") overlap each other and the site edge. |
| 56-inspect-change.png | Inspect screen on the change site (detections) | Nav Inspect | Empty state "Pick a photo on the left" with blank centre and right column. |
| 58-issues-change.png | Issues on the change site | Nav Issues |  |
| 60-road-scene.png | Scene, demo access road (ortho only) | Open Demo access road | Road project opens in Map: corridor is a thin strip in the top-left, most of the stage empty black; "km 0.0" label overlaps the strip edge. |
| 61-road-bench.png | Road group / workbench | Island Road tab Enter |  |
| 62-road-map.png | Access road in Map view | Stage view Map | Same as 60. |
| 70-photo-processing-scene.png | Scene, photo-only project (unprocessed: empty/progress state) | Open Demo photo processing | Photo-only project defaults to Split with camera markers only; "No map pack" notice. |
| 71-processing-panel.png | Processing panel (jobs/progress) | Click processing-chip | Error/blocked state: "Processing cannot run yet" warning. Panel overlays the Map pane and cuts the "Streets" button at its edge. |

## Not captured

- 360 walk view: none of the four demo projects contains a walk (their `walks/` folders are empty); building one needs the walk fixture plus ffmpeg (detect-walk spec), over the time budget.
- Stockpile picked in the scene: clicking the "Pile 01" label did not respond within 4 s; the Volumes bench (14-bench-volumes, 10-scene-default) shows the pile table instead.
- Inspect review queue: the change site has 0 photos waiting for review, so the `inspect-review` button is not shown.
- Thermal, Coverage (RF), Hydrology, Survey QA, Terrain overlays, Point cloud cleanup, Model review, Environment and Cutaway right-sidebar tabs: they open from tools/data the demo projects do not carry.
- Agent pane with a conversation: AI is off with no provider key; only the off state is shown.
