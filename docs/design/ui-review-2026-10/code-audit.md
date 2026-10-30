# Code-level UI audit (renderer, read-only): agent report

Scores: Accessibility 3, Performance 2, Responsive (1100x720+) 2, Theming 3, Anti-patterns 3 → 13/20 (Acceptable).
Detector (impeccable detect.mjs) could not run: bundle missing from skill install. Grep-based anti-pattern pass below stands in.

## Shell map
- Root `apps/desktop/src/renderer/App.tsx:700`: `.app` grid: left Sidebar | main (Screen + AgentDock) + ~25 always-mounted overlays (Palette, ProcessingDrawer, Toasts, Builder, Modeller, Engineer/Rf layers, HelpPanel...).
- Left sidebar `shell/Sidebar.tsx:1351` (252px / 52px rail; auto-folds <1280 via `shell/autoFold.ts`): SidebarTop (wordmark + project switcher); Nav: Projects, Globe, Scene, Issues, Inspect, Reports (+ Settings foot); dataset tree, survey dates, Create maps, status.
- Scene `workspace/WorkspaceScreen.tsx`: Stage + Island notch (`workspace/island/`, groups View, Measure, Display, Point cloud, Volumes, Video, Road, Annotate; modes 3D/Map/Split). Bottom `.tl-wrap`: Dates strip / Footage timeline / road ChainageRuler.
- Right panel `workspace/workbench/RightSidebar.tsx`: RightHeader → TabBar → AgentPane. Fixed tabs (`workbenchStore.ts:25`): Project (id `measure`), Selection, Issues, Volumes, Changes. Panel tabs: Display, Point cloud, Video, Road, Annotate, Jobs, Survey QA, Terrain overlays, Hydrology, Point cloud cleanup, Model review, Environment, Cutaway, Coverage, Thermal; 20 tab ids (`tabsModel.ts:5`).
- Settings (`screens/Settings.tsx:56-110`): 15 pages, 3 groups.

## Findings
Placement
- P1 "In this project" list lives in the Measure bench (`MeasureBench.tsx:894`); tab labelled Project but id + island group = Measure. Fix: own Project tab, Measure tools behind Measure group.
- P1 20 workbench tabs on one row + More overflow; Volumes/Changes/Coverage/Thermal force panel to 470px → at 1100px with sidebar open stage ≈378px. Fix: group into 4-5 benches; auto-collapse right panel <1280 like the left.
- P2 Issues has two lookalike entry points: nav screen (`screens/Issues.tsx:40`) and fixed right tab (`RightSidebar.tsx:231`). Fix: one canonical, other deep-links.
- P2 Settings scattered: detection models on AI providers page (`Settings.tsx:911`) but detector library + Analytics pack under Processing tools (`ProcessingTools.tsx:342-343`); geoid packs under Offline maps (`MapPacks.tsx:616`); project-scoped Privacy (`Settings.tsx:654`) and project maps (`MapPacks.tsx:420`) in global Settings. Fix: "Models and detection" page, "Datums" page, a Project settings entry.
- P2 AI page stacks 5 sections (Providers, Local model, Routing, Detection, Ask AI; `Settings.tsx:896-912`); "Providers … supported" heading hard-coded English.

Tokens (`packages/ui/src/tokens.css`, ~199 vars)
- P2 270 colour literals outside tokens: house.css 57, viewer.css 31, styles.css 24, map.css 23, modeller.css 16, MapSwatch.tsx 47.
- P2 Spacing: 1,580 raw px padding/margin/gap vs 561 `--sp-*` (styles.css 332, mission.css 91, photo.css 80, builder.css 79).
- P2 Radius: tokens 2/4/6/pill; off-scale 3px×31, 8px×10, 10px×5, 9px, 12px, 99px vs 999px.
- P3 101 px font sizes vs 671 tokens; 75 raw z-index; 241 inline style={{}}; 30,213 CSS lines in 116 files, styles.css 4,970 lines.

Component consistency
- P1 No shared Dialog: ~27 hand-rolled dlg-scrim copies + sv-dialog, b-scrim, surface-dlg, one native <dialog>. `report/volumetric/PictureProgress.tsx` scrim has no focus trap / Escape. Fix: one <Dialog> in @aio/ui on useFocusTrap.
- P1 Toasts: 19 files hand-build `.toast`; only `exports/Toasts.tsx` uses the stack; most lack role="status". Fix: shared toast host.
- P2 Buttons: 1,185 raw <button> (686 .btn) vs 172 <Button>, 35 <IconButton>.
- P2 Menus: shared <Menu> used 3×, 18 hand-rolled role="menu".
- P3 Empty states: <EmptyState> 32× plus pane-empty/side-empty/ann-empty; progress bars ×11 each with own CSS.

Accessibility
- P2 `packages/annotate/src/components/IssueRegister.tsx:372` select toggle is aria-hidden span with onClick (mouse only).
- P2 `island/Island.tsx:643`, `survey/volumes/InventoryPane.tsx:274` clicks on div/tr.
- P3 21 `outline: none/0` rules.

Anti-patterns
- P2 8 side-stripe accents: help.css:277, askAi.css:128,186, findingsPanel.css:46, package.css:247, road.css:148,351, styles.css:2623,4621, mission.css:1130.
- P2 Decorative backdrop-filter blur(16px) on globe (globe.css:37, globe-map-menu.css:10,15, globe-search.css:13).
- P3 Width/padding transitions (builder.css:440, askAi.css:213, package.css:192, styles.css:4174,4716,741).
- None: gradient text, bounce easing, nested cards.

Copy
- P2 AI named 5 ways: Agent, "Ask agent", "Ask AI", "AI for Ask AI", Cloud AI.
- P2 "Cloud" = point cloud AND online. Fix: always "point cloud".
- P3 Nav "Inspect" uses media icon; code calls it media/photos.

Strengths: global :focus-visible (mission.css:63), no unlabeled icon buttons, dark/light/high-contrast/system themes, cssGuard ratchet.
