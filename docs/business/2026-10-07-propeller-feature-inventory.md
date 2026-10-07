# Propeller Aero: surveying and measurement feature inventory

Date: 7 Oct 2026. Sources: read-only walkthrough of the Orbitaerials portal's "Demo Sites" group (orbitaerials.prpellr.com), plus Propeller's public help centre (help.propelleraero.com, 397 articles; IDs cited as `[HC 1938...]` = `https://help.propelleraero.com/hc/en-us/articles/<id>`).

Tags: **[app]** = seen in the app. **[docs]** = from the help docs only.

## Summary

Propeller is a browser app built on Cesium (3D globe, terrain plus ortho draped, point cloud, meshes). It is organised around **site → survey (dataset) → workspace → folders of measurements/designs/media**. Its core value is **surface comparison**. Every volume tool is the same engine: "From surface" vs "To surface". The base can be the current or previous survey, any survey, any design, a Smart Volume (triangulated) base, a reference level (flat plane) or a custom base. Results come as Cut / Fill / Net / Total, with a 3D/2D heatmap, contours and deadband. On top of that engine sit:

- typed **measurement templates** (point, line and polygon families, plus org-defined custom templates with custom fields)
- **cross-sections** with multi-surface profiles
- **hydrology** (flood-to-level, runoff, catchment, direct rainfall)
- **haul road analysis** (add-on)
- **AI tools** (Magic Polygon auto-boundary, AI Cut/Fill area breakdown, Propeller CAD for generative earthwork designs)
- **QA/accuracy**: Processing Report, GCP/checkpoint RMSE, QA levels
- **outputs**: PDF/CSV reports, Takeoff map, PDF map, fly-through, timelapse, file downloads in site CRS or WGS84, and push-to integrations
- **DirtMate** machine telematics, with a live surface and utilisation tables

Units are fully switchable per measurement. Coordinates are shown as Northing/Easting/Elevation in the site CRS (NEZ/ENZ order is a setting).

---

## 1. App shell and navigation

- **Left rail** [app]: Sites, AeroPoints, Data processing (upload/processing queue), Account (profile).
- **Account menu** [app]: My profile, Notifications, Settings, Organization, Help, Sign out.
  - Organization submenu: People & teams, Sites & access, Licenses, Buy accessories (external store), All <org> settings.
  - Since the Sep-2026 release, Settings and Help sit under the profile menu [docs].
- **Settings menu** (in the viewer) [app]:
  - Appearance: Dark mode toggle.
  - Site settings link.
  - Map settings.
  - Camera settings: "Allow automatic camera transitions", "Flight animation" (fly vs jump).
  - Date and time: "Use site timezone".
  - **Geolocation layout: NEZ / ENZ** radio.
  - Graphics quality: Balanced (default).
  - About.
- **Home / site list** [app]:
  - Site groups (e.g. "Demo Sites").
  - "Create new" menu: Site, Site group.
  - Search, sort ("Last Modified"), show filter ("All sites (12)") and grid/list view toggle.
  - Site cards show: thumbnail, name, locality, Last modified, Recent survey date, "Demo Site" badge, survey count, star, and a per-card menu.
  - "Invite members" link.
  - Welcome panel with "View all tutorials".
- **Map view of sites**: not observed. Only grid and list views were seen.
- **AeroPoints** section [app]: /p/aeropoints is a dashboard (empty for this org). From the docs:
  - AeroPoint groups and sets; move, merge or copy AeroPoint surveys; manage users.
  - Processing methods: Propeller Corrections Network (PCN), Known Point (Global/Local Survey Benchmark), RINEX upload, Unreferenced [HC 19383531215895].
  - Minimum logging time: AeroPoint 2 needs 10 min (PCN) or 2 min (Known Point). AeroPoint 1 needs 45 min. Baseline up to 40 km. Max capture 5–8 h.
- **Site settings** [docs]:
  - Coordinate System page: published CRS plus vertical datum, or Local Calibration [HC 19384070089367].
  - Site Materials: material stock sheet with Name, Material ID, Density. Edited in place or imported from CSV [HC 19384724921879].
- **Org settings** [docs]:
  - Platform analytics: users, storage, sites created, surveys submitted, designs created over 12/24 months.
  - WMTS and API links. Custom SSO.
- **Viewer URL state** [app]: the view is encoded in a `view=` JSON query param. It holds selected measurements `m`, design layers `dl`, and camera `c` (ECEF position plus heading/pitch/roll). Deep-linkable views.

## 2. Site viewer

### Layout [app]

- **Left module rail**: Measure, Survey, Designs, Media, Outputs, Hydro, Crew, Machines. Docs also mention CAD and Road (haul road) tabs when licensed.
- **Top bar**: site switcher, Survey picker, measurement toolbar, Share and Upload.
- **Right-side panel**: properties of the selected measurement.
- **Bottom bar**: Map / Photo viewer / Timeline / Cross Section.

### Map controls (right edge) [app]

- Reset view (home), compass/orbit control, Zoom in/out.
- **Fly mode** (FPS-style camera navigation).
- **X-ray mode** (clip terrain at distance).
- Toggle full screen, Screenshot mode.
- **Hide objects behind terrain** (depth test toggle).
- Collapse sidebar.

### Map settings popover [app]

- Base map: Road / Satellite / Hybrid / None.
- View settings: "Measurement values" (show labels on map), with label options "Only show when selected" and "Show property name".
- Data attribution: Maxar, Cesium.

### Survey picker [app]

- "Datasets" list, grouped by Year or Month, with a "Show hidden" toggle.
- Shows the survey name and capture date. These can differ, e.g. "07 July 2026" was captured July 30, 2026.
- Groups seen: "2026 Surveys", "Other" (non-drone data such as TIN/handheld), and special datasets like "grade-check-ex207".
- Composite surveys are created from the survey picker ("Create composite") [docs, HC 19383191734039].

### Survey tab: Analysis overlays [app]

- **Elevation Map**:
  - Smooth Colors / Step Colors.
  - Editable colour stops with values in site units (ft): add/remove a stop, Reset, Apply.
  - Vertical range slider.
- **Gradient Map**:
  - Smooth/Step mode; unit selector (percent seen).
  - Default stops: 0, 57.74, 100, 173.21, ∞ %. These equal 0°, 30°, 45°, 60°.
- **Shaded Relief Map**:
  - Sun intensity (default 90), Sun azimuth slider (S-W-N-E-S, 38), Sun altitude (horizon–zenith, 50).
  - Colour swatches (white, yellow, orange, teal, blue, red, purple, plus custom).
- **Shadows**:
  - Time of day (slider, "midday").
  - Time of year (Jan–Jan).
  - Date/time picker with site timezone (PDT shown).
- **Contour Lines**:
  - Minor interval (default 1 ft), Major interval (default 10 ft).
  - Colour swatches, line thickness slider.
- When Timeline is open, Elevation, Gradient and Contours are disabled.

### Survey tab: Crop and cleanups [app]

- Shows status ("No crop applied" / "No cleanups available"), with Crop and Cleanup toolbar icons.
- The Mine site has a Cleanups toggle.
- From the docs [HC 23324269774231, 19383377153431]:
  - **Crop**: draw a boundary, copy one from a previous flight, or upload a KML. Needs Process permission.
  - **Terrain cleanups**: remove equipment, vehicles, stockpiles or structures from the DEM by drawing a polygon (Magic polygon or manual), or via "Copy as cleanup" from a measurement. Several can be made per session. Toggle on/off.

### Survey tab: Layers [app]

- Orthophoto, with opacity.
- Terrain (the DEM mesh).
- Camera Positions.
- **Vertical Face Imagery** (Mine site).
- **Point cloud**: point size slider (default 3).
  - On the Lidar site this adds "Classification color" plus per-class toggles (Unassigned, Ground).
- Ground Control and Checkpoints.
- Trimmed DTM Survey Boundary.
- On the Terrestrial site, a "Surveys" sub-group overlays other datasets, e.g. "03 April 2026 – Original Ground / TIN Surface" and "14 February 2025 – Footbridge iPhone Lidar / Point cloud".

### Survey Explorer [app + docs]

- Collapsible list of all surveys at the bottom of the Survey tab, with Sort, Filter and Search.
- Turn on orthophoto, point cloud or VFI layers from any combination of surveys at once.
- "View Selected", filter-by-map-view, and fly-to-survey [HC 25628038005399].

### Timeline [app]

- Bottom slider listing every survey date (May 14 2025 … Jul 30 2026). Scrub orthophotos over time.
- Loads up to 100 surveys around the primary survey [docs].

### Photo viewer [app]

- Thumbnail strip of the raw source images (100_0001_0001.JPG …).
- "Click on the 3D view or a thumbnail to reveal an image" picks the source photo for a clicked point.

### Designs tab [app]

- Hierarchy: folder → file → layer. Each has a visibility checkbox, expand, and a "view more" menu.
- **File menu**: Download source file, Clamp all layers, Restore archived layers (n), Rename, Link to another workspace, Delete. Metadata shown: file type, uploaded at, uploaded by.
- **Layer menu**: Fly to layer, Clamp layer to terrain, Rename, **Apply vertical offset**, Archive layer. Shows the entity count by type (e.g. 3DFACE: 39,847; POLYLINE; LINE: 84; TEXT; MESH).
- **Alignment layer** (LandXML) menu: Fly to layer, **Edit station intervals**, **Activate alignment**, Rename, Archive layer.
- **PDF layer** menu: **Overlay on map** (georeference by point pairs, or by entering coordinates since Sep 2026), Adjust opacity.
- Folder menu: Rename, Create subfolder, Delete, Link to another workspace.
- **Formats seen**: .dxf, .ttm (Trimble), .xml (LandXML alignment), .pdf, .ifc.
- **Formats from the docs** [HC 19384315657751]:
  - DXF (ASCII only). Entities: Arc, Circle, Dimension, Ellipse, Face, Leader, Line, LWPolyline, Mesh, MText, Point, Polyline, Solid, Spline, Text.
  - TTM, IFC, KML/KMZ (folders, styles, placemarks, ExtendedData).
  - LandXML: CgPoints, Surfaces, Alignments (horizontal only; clothoid spirals; no vertical alignments).
  - PDF (first page only).
  - Limits: 500 MB per file. Surfaces over 1,000,000 faces are not displayed or measured.

### Workspaces [app + docs]

- Named workspaces per site ("Design", "Default"). Search, add, and "More actions".
- List tools: Expand/collapse all, folder-first toggle, sort (A–Z, Z–A, recently created, recently updated), create folder, search.
- Filters: Tool (template), Dropdown list, Material, Only created by me, Created in last 7 days, Converted designs, Site level, Zone filter.
- Private workspaces are a paid add-on [docs].

### Coordinate systems [docs]

- Published CRS plus vertical datum, or a local grid from a Trimble .jxl, .dc or .cal file, or a Topcon .gc3 file [HC 19383374174103].
- Geoids: AUSGeoid09/2020, GEOID03–18 (CONUS/Hawaii/Alaska), NZGeoid2016, CGG2013, HT2_0, Swiss, Nordic, ITALGEO90, KNGeoid14, GSIGEO11, among others [HC 19383987278871].
- Displays orthometric heights.
- Downloads come in WGS84 and in the site CRS.

### Units [app]

- Per-measurement **Units** dialog with Distance, Area, Volume and Density selectors. Each has "Default" (site units). Cancel/APPLY.
  - **Distance**: cm, m, km, ft, mi, yd, US survey ft, US survey mi.
  - **Area**: m², km², ha, ft², mi², yd², acres, US survey ft², US survey mi².
  - **Volume**: m³, L, ft³, yd³, gal, acre-ft.
  - **Density**: kg/m³, t/m³, short tons per ft³, short tons per yd³, lb/ft³, lb/yd³, lb/gal.
- Imperial sites show ft (US). Metric sites show m with space-grouped coordinates ("6 452 427.271 m").

## 3. Measurement tools

### Toolbar [app]

- **Order**: AI Cut/Fill · Point ▾ · Line ▾ · Polygon ▾ · Draw · then bookmarked quick tools (Grade/Slope, Cross-section, Stockpile, Cut/Fill from Survey).
- **Bookmarks**: each template in a dropdown has an "i" (tool description) and a bookmark pin that adds it to the toolbar.

### Templates by family [app]

- **Point**:
  - Elevation: track height at a point across surveys.
  - Hazard: severity level.
  - Annotation.
  - Elevation Difference: point vs surface.
  - Radius: buffer around a point, radius set in the STYLE tab.
  - Storm Drain Outlet (org custom).
  - Custom Point.
- **Line**:
  - Distance: terrain, slope and horizontal distance.
  - Berm Check: height and widths across a barrier.
  - Cross-section.
  - Vertex Difference: elevation difference between vertices.
  - Grade/Slope: grade as degrees, percent or ratio.
  - Horizontal and vertical.
  - Road Cracks and SWPPP Flow Line (org custom).
  - Custom Line.
- **Polygon**:
  - Terrain Area.
  - Slope Area.
  - Bench Volume: wall/bench and blast volumes.
  - Cut/Fill from Survey: vs previous survey.
  - Cut/Fill to Design: vs latest active design.
  - Area Progress: vs previous survey and remaining to design.
  - Stockpile: smart, reference or custom base.
  - ZaxStockpile (org custom).
  - Custom Polygon.
- **Draw**: freehand markup.
- Site-specific custom templates appear too, e.g. "Elevation checks", "Cell Progress", "Cell EOM", "Media".

### Drawing aids (shown while a tool is active) [app]

- **Magic polygon** (AI auto-boundary): "Suggest boundaries?" toggle; Buffer slider (keys U/I, default 0.1); Vertices slider (keys J/K, default 2) [docs: HC 19383694415639].
  - Not available for composites, BYOD without an ortho, lidar, or surveys before 28 Sep 2023.
- **Clamp to terrain** toggle (default off). The tooltip says you can measure on point clouds, vertical faces and designs.
- **Snap to**: Designs, Measurements, Guidelines (all on).
- **Lock to**: Angle (hold Shift), Distance (type digits).
- Advanced: Sensitivity 1.0×, "Show angle lock hints".
- **Autosave** toggle (default off).
- Esc cancels.

### Measurement properties panel [app]

- **Header**: editable label, created by/date, "(edited)" flag, minimize/close.
- **Template selector**: the template can be changed after creation.
- **Units button**.
- **Tabs**: PROPERTIES / STYLE.
- **Footer**: Delete, **Promote to site / Demote from site** (site-level vs survey-level scope), Export, View more.
- **View more menu**: Fly to measurement, Share measurement, Promote/Demote, Rename, Duplicate, **Copy to another dataset**, Export, **Copy as cleanup**, Edit shape, Delete. Metadata: template, created/updated at/by.
- **STYLE tab**: colour palette; fill (none / partial / filled); border (none / solid / dashed; small / medium / large); Icon (place/add); Label toggle; Transparent background; label size S–XXL.
- **Description** (free text). **Add/Edit Items** opens the "Customize" dialog: drag-drop measurement items plus custom fields (Description, Dropdown list). Cancel/Save.
  - Line items: Gradient, Vertex elevation, Horizontal and vertical, Horizontal distance, Slope distance, Terrain distance, Cross section.
  - Polygon items: Horizontal area, Vertex elevation, Slope area, Terrain area, Remaining to design, Material properties, Surface comparison.
  - A measurement can hold **several Surface comparison items**. A Landfill lift showed three: vs previous survey, vs an older survey, and vs the design surface.

### Values seen

- **Point / Annotation / Elevation checks** [app]: Location as Northing, Easting, Elevation (m, 3 dp). Media points add Comments, Category, Media type (360 Photo), Created date and Created by fields.
- **Berm Check** [app]:
  - Vertex elevation: Max 108.24 m, Min 107.41 m. Horizontal distance 2.45 m.
  - Cross-section block: Download as DXF File, Show cross section, Enable cutaway view.

### Surface comparison / volume [app]

- **From Surface / To Surface** pickers. Options: Current Survey, Previous Survey, Surveys ▸ (any), Designs ▸ (any surface layer), **Smart Volume Surface**, **Reference Surface**, **Custom Surface**. There is a Swap surfaces button in AI Cut/Fill.
- Warning: "No reference to current terrain" when neither surface is the current survey.
- Result tabs: **3D Cut/Fill** (heatmap), **2D Cut/Fill**, **Contours**.
  - Results: Cut, Net, Fill, Total, e.g. 115,978.5 / 11,919.1 / 127,897.6 / 243,876.1 yd³.
- **Heatmap**: Smooth/Step colours; default stops −1, −0.1, 0.1, 1 ft (or m); Add colour; Reset; **"Use deadband in calculations"** checkbox; Apply.
- **Contours** (of the difference surface): Minor 1, Major 5, Invert colours, Apply.
- **Reference level**:
  - Reference Elevation Level number field, with "Set to highest level" and "Set to lowest level" buttons.
  - Example: Blast Area, Bench Volume vs Reference Level 101.08 m gave Cut 5,183 m³.
- **Smart Volume Surface** [docs]: triangulates a base from the polygon perimeter. Good on sloped ground.
- **Custom Surface** [docs]: edit base vertices individually (N/E/elevation/offset), multi-select with Shift, or move the whole polygon.
- **Calculators** (toggles):
  - **Shrink/swell** (bank / loose / compacted factors) [docs HC 28452401313559].
  - **Weight**: enter tonnage to get density for cut/net/fill. This is how landfill compaction (t/m³) is reported.
  - **Density**: enter t/m³ to get tonnes.
- **Material properties**: pick from the site materials list. Drives density and the aggregated material reports [docs].
- **Area Progress** [app]: surface comparison plus "Remaining to design" item with a "Select design" picker.
- **Bulk select** (Sep 2026) [docs]: running totals across selected measurements of the same type. Change surface or unit for all at once.

### Cross-section [app]

- Properties: Download as DXF File, Show cross section, Enable cutaway view. "Add Design/Survey" multi-select of any surveys and design surfaces, each with its own coloured line.
- Bottom **Cross Section chart** (canvas):
  - Elevation vs chainage in site units, e.g. ft (US).
  - **Pin values** selector: Elevation, Horizontal, Grade (degrees), Grade (ratio), Grade (percent).
  - "Click chart to add pins": pins show per-surface values and deltas (e.g. "9,217.358 (US) (+5.99)").
  - **Ratio** (vertical exaggeration) 1:N, defaults 1:4 / 1:2.
  - "Open in new window".
- Map shows the section line and a corridor band.
- Export [docs]: 2D DXF in XY/XZ/YZ, 3D DXF Z-up/Y-up. Cross sections along any line since Sep 2026.

### AI Cut/Fill [app]

- Heatmap area: "Whole site" or any polygon.
- From/To surface (defaulted to the previous and current survey), Swap.
- **AI Volume Breakdown** button: auto-segments areas of change into volume polygons [docs HC 30544925967895].
- Heatmap Settings: deadband 0.1 ft (US) "used in calculations"; stops −5, −0.1, 0.1, 5 ft.

### Other tools

- **Grade/Slope** [app], as a bookmark. Shows grade as degrees, percent or ratio.
- **Haul road analysis** [docs HC 19383642995735], an add-on (seen as a "Road Analysis" folder of centerlines on the Mine site):
  - Inputs: simulation region, auto-detected centerline (or an existing one), min/max road width.
  - Smoothing: iterations, sensitivity, preservation.
  - Distance between cross sections, berm sampling points.
  - Source elevation: DEM or point cloud.
  - Surface profile: Flat, Hill, Steep, Rock berms. "Include safety berms" threshold (m²).
  - Outputs: road width, gradient, cross fall, superelevation and berm height, each with compliance thresholds in % or degrees. PDF "Road analysis report".

## 4. Design surfaces and compliance

- **Cut/Fill to Design, Area Progress, Remaining to design** [app]: survey vs design volume and heatmap.
- Design-vs-design compare [docs]: "Design Volume Compare", used for landfill cell revisions.
- **Heatmaps with tolerance bands**: deadband stops act as the ± tolerance. "Use deadband in calculations" excludes the tolerance band from volumes [app].
- **Progress tracking**:
  - Templates/folders like "Phase 1 Progress": "01 OG Topo to Subgrade Design", "02 Drone topo to OG Topo", "03 Drone topo to Subgrade Design", "04 Compare to Previous Survey" [app].
  - Landfill: "Cell Progress", "Monthly Cell Report", "Lift Heights" (80/85/90 RL), "Progress Claims", "Compaction Reporting" [app].
  - Highway: "Total Project Progress", "North/South Bank – Existing to Final Grade", "Compare to Previous Year" [app].
- **Takeoff Map** output [app]:
  - From/To Surface (defaults: current survey → design surface).
  - **Grid Spacing (ft)**, default 150: samples are taken in a "plus sign formation", and spacing is approximate.
  - Heatmap stops and deadband; contours (minor 1 / major 10).
  - Paper size: A0–A4, ARCH E, ARCH D, ANSI D, Tabloid, Letter.
  - "Export Takeoff Map".
- **Vertical offset** on design layers [app], used to model subgrade or pavement depth.
- **Propeller CAD** [docs HC 41445180799767]:
  - AI chat creates preliminary earthwork designs (road, ramp, pad, trench, stepped pit) from a sketch (polygon/point/line) on the survey terrain.
  - Can attach a PDF of standards.
  - Output is a 3D design surface you can publish or export. Not engineer-approved.
  - Not visible in the demo nav.

## 5. Ground control and accuracy

- **GCP layer** [app]: "Ground Control and Checkpoints" toggle. Files include GCPs.csv and a CZML of GCP/checkpoint locations [app].
- **Upload-time QA** [docs HC 19384160338199]:
  - QA level Strict / Moderate / Lenient / Skip sets the GCP RMSE threshold: 5 cm / 10 cm / 20 cm / none. Surveys over the threshold are put on hold for a geospatial specialist.
  - Optional "compare to past surveys" check:
    - Strict flags if more than 50% of the area changed by more than 0.10 m.
    - Moderate: more than 60% of the area changed by more than 0.20 m.
    - Lenient: more than 60% of the area changed by more than 0.40 m.
  - The user picks the comparison survey.
- **Processing Report** [docs HC 19383147854231; app link opens /p/processing-report/<datasetId> in a new tab]:
  - Survey info: date, uploader, CRS, filter, correction method, AeroPoint method, photo count, QA level, allowable GCP error.
  - Quality overview messages.
  - Map of GCPs and checkpoints; filter-difference overlay.
  - Image-quality histogram, plus alignment and error tables.
  - **Expected Ground Control Accuracy** table: X/Y/Z and total error per GCP. Target under 3 cm / 0.1 ft.
  - **Ground Control Summary**: model vs control elevation per point. Unused/disabled points; auto-disabling of excess GCPs.
  - Printable to PDF.
- **Checkpoints** [docs]: any uploaded points can be flagged as checkpoints. They don't influence the model and are used for validation.
- **GCP inputs** [docs]: AeroPoints flight, CSV, both, or none.
- **Elevation model filters** [docs HC 19384032988823]:
  - Presets: No filter, Equipment, Equipment & vegetation, Equipment/vegetation/structures, Everything.
  - Parameters: point distance, hold size, point angle.

## 6. Annotations, issues, collaboration, sharing

- **Annotation** point template, **Hazard** (severity), **Draw** markup and media pins [app]. Mine-site examples: "Fire Hazard!", "Power Lines 80ft", "Avg. Slope 3% Too steep!", "Move This Pile" arrows.
- **Media tab** [app]:
  - Geotagged photos, 360 photos and walkthrough videos in folders.
  - Each media point has category, type, created date/by and comments.
  - Docs: stamping, media reports, zone filters (paid add-on); alignment station/offset per media item.
- **Share** button (site) and "Share Measurement" [app]. Not used.
- **Crew** [app]:
  - Time-limited shareable map links for field crews ("Create crew link"), with active and expired lists and expiry dates.
  - Supports DXF layers, PDF overlays and volume measurements [docs HC 19384350126999].
- Workspaces and private workspaces; "Link to another workspace" for designs and folders [app].
- Mobile app [docs]: measurements, photos, GCP viewing, alignment station/offset, offline linework, and DirtMate RTK stake-out.
- Notifications settings page [app].

## 7. Reports, exports and integrations

### Outputs tab [app]

- **REPORTS**:
  - Stockpile and Measurement Report: PDF with crop-to-view, Edit and Preview, title, reference labels (Number/Letter/Name/None), paper size, totals row [docs].
  - Stockpile Inventory Report – CSV.
  - Measurement Report – CSV.
  - Processing Report.
- **MAPS**:
  - Takeoff Map (see §4).
  - PDF Map: high-resolution aerial print. Paper size (default A4), Portrait/Landscape, Preview, Print.
  - Export view as JPEG.
- **VIDEOS**:
  - Fly-through: waypoint camera path; "Fly", then download the video.
  - Timelapse: base map (Road), length 10 s, checklist of surveys, "Generate timelapse".
- **SURVEY FILES → Files**: categories ALL / 3D MODEL / CONTOURS / ORTHOPHOTO / POINT CLOUD / TERRAIN. Each file has Download, Delete and **Push to**. Seen on Subdivision:
  - GCPs.csv
  - GeoTIFF DSM and DTM (WGS84 and Local Grid)
  - Orthophoto GeoTIFF (WGS84 and Local Grid, 1.9 GB)
  - LAZ (UTM 10N and Local Grid, 30.6 M points), plus a reduced LAZ (315k points)
  - CZML GCP locations
  - DXF meshes at 84k / 231k / 6.0 M faces (low/med/high)
  - DXF contours at 1 and 2 units
  - GeoJSON terrain boundary mask
  - JPEG orthos (17192×33310 and 2580×5000)
  - "Polygons of interest"
- Lidar site files: imported DJI Terra GCPs, point cloud, PDF processing report, ortho TIFF, DTM, contours.
- **OTHER**: Export measurement (from the Measure tab).

### Custom export from a measurement [docs HC 19384143799703, 19384832463895]

- Ortho (GeoTIFF/JPEG/JP2/PNG/KML) and DEM GeoTIFF are emailed.
- Contours (SHP/DXF) are emailed.
- Point cloud (LAZ, configurable resolution) goes to Files.
- Outline (DXF/KML) and Surface (DXF 3D faces, DXF mesh, TTM, including cleanups) download directly.
- Point measurements export as CSV. Bulk export works per folder.

### Imports

- Points from CSV, up to 500 points per file [app upload menu].

### Integrations [docs HC 21227366608279]

- Push to / import from: Procore, Trimble Connect, OneDrive/SharePoint (Business). Docs also list BIM 360, Aconex and Autodesk Build.
- **WMTS** streaming to ArcGIS/QGIS (premium).
- **Public API** (scale tier).
- HCSS HeavyJob ortho; viDoc rover.
- "Connections" upload source [app].

### Analytics

- Org platform analytics [docs].
- DirtMate daily emails [docs].

## 8. Special site types

- **Lidar (Charlotte Motor Speedway)** [app]:
  - One survey, "Lidar 16/05/2023", processed externally (DJI Terra).
  - Point-cloud layer with **classification colouring and per-class toggles** (Unassigned, Ground).
  - No GCP layer.
  - Designs: .ttm surfaces and .dxf grading.
  - Docs: upload LAS/LAZ as pre-processed data; option to use the cloud's own ground class or apply a filter to build the DEM. L1/L2/L3 upload flow.
- **Landings Park (Terrestrial Survey)** [app]:
  - Datasets: "25 June 2026 – EG and Footbridge", "24 June 2026 – Handheld Scan", "Other" group.
  - Overlay of "Original Ground – TIN Surface" and "Footbridge iPhone Lidar – Point cloud".
  - Designs: DXF, TTM, **LandXML alignment** (station intervals, activate), **PDF site plan overlay**, **IFC** model (MESH).
  - Docs: TIN surface upload (from GPS/total station) can be standalone or merged into a **composite**.
- **DirtMate Civil Demo** (Machines tab) [app]:
  - "DirtMate surface" with a date and time window ("6:00 AM–Now, updated at 1:56 PM").
  - LIST / TABLE / UTILIZATION views.
  - Load & dump refinements: loading machine, load zone, dump zone. Utilization by area; sort and group by machine type.
  - TABLE columns per machine: Run time, Moving, Idling, Idle %, Truck loading, Smart cycles, Est. cycle volume (yd³), Loads, Est. load volume, Dumps, Machine capacity, Avg smart cycle duration and length, Avg haul duration and length (ft), Avg load and dump duration, dump/load zones, loading machines, trucks, type, model. Example models: Scraper 621F/G, HD465 trucks.
  - UTILIZATION: per-machine timeline bars (Move / Truck loading / Off) grouped by Scraper, Hard Body Truck, Excavator, Bulldozer, Compactor.
  - Docs: "DirtMate Measurement" timeframes (Today, Yesterday, This week, Last week); DirtMate RTK in-cab guidance and stake-out in the mobile app.
  - The Machines tab on other sites shows an upsell ("Unlock machine utilization", "Talk to Sales").
- **Mine Site** [app]:
  - Folders: Berm Checks, Blasting (Elevation history, Blast Area as Bench Volume vs reference level, Exclusion Zone, Post Blast as Stockpile vs reference level), Cross Sections, Hydro (Haul Road Watershed), Markup / Field Ops / Material Issues / Safety, Media, **Road Analysis** (centerlines), Stockpiles (aggregates, Asphalt as Smart Volume Surface 812.9 m³, Sand, Zircon).
  - Layers include **Vertical Face Imagery**.
  - Designs: Blasting, Mine Life Plans, RL, Safety.
- **Landfill** [app]:
  - Folders: Cell Progress, Compaction Reporting, Cross Sections – Design Checks, Daily change, Hydro (Rain Event Planning), Lift Heights, Progress Claims.
  - **Compaction/airspace** is done by entering waste tonnage in the Weight calculator, which gives the achieved density in t/m³ per comparison, e.g. 63,000 t over a 70,104 m³ fill gives 0.899 t/m³.
  - A measurement can compare against a previous survey, an older survey and the cell design at once ("remaining airspace" = fill to design, e.g. 308,789 m³ to "EndOfLCell4.dxf:CELL_DESIGN").
  - No dedicated "airspace" tool was seen.
- **Road / highway (Small Highway Project)** [app]:
  - Designs: bridge structural (abutments, deck, piers, railings), "Alignment & Centerlines" (DXF with CENTERLINES / ROAD / STATIONS text layers), final grade TTM, drainage, pit strings.
  - Cross-sections against nine surveys plus the final grade.
  - Docs: true **station/offset readout** comes from an activated LandXML alignment ("Edit station intervals"). The cursor shows station/offset; media get station/offset. Vertical alignments are not supported.
- **Hydro tab** (all sites) [app + docs HC 19383844801559]:
  - **Flood to Level**: simulation region, "Pick flood level from map", flood level (ft), "Download outline as DXF".
  - **Surface Runoff**: region, "Show preferential flow path", liquid drop location (circle or polygon), animate.
  - **Catchment/Watershed**: breached stream network, outflow points.
  - **Direct Rainfall**:
    - Inputs: simulation length (h), rainfall CSV (e.g. 10- or 50-year event), quality Faster (2 m grid) / Average (1 m) / More accurate (0.5 m).
    - Constant Manning's n and infiltration.
    - Time slider of water depth.
    - Saved simulations are listed.

## 9. Upload and processing flow

- **Upload menu** [app]:
  - Surveys ("drone and ground captures")
  - Designs
  - Media
  - Points (CSV, 500-point limit)
  - Connections (other platforms)
  - "Learn more"
  - The demo account lacks **Process permission**, so Survey upload was disabled ("You require Process permission…"). The wizard could not be opened.
- **Survey upload wizard** [docs HC 19383712758551]:
  - PROCESSING: Photogrammetry.
    - Corrections: PPK drone (Propeller PPK) or "Use my drone photos".
    - Validation: ≥10 geotagged JPEGs; same aspect ratio; ≥8 MP; motion blur, ISO and course alignment checks; single connected area; bypass allowed with acknowledgement.
  - PRE-PROCESSED: Point Cloud (LAS/LAZ), TIN Surface, DEM plus ortho GeoTIFF (4-band, 32-bit float DEM, same CRS), local-grid GeoTIFF.
- **Then**: photo map review → dataset name and capture date → GCPs/checkpoints (AeroPoints and/or CSV) → QA level and comparison survey → elevation-model filter → outputs list (incl. optional **VFI**) → summary.
- **Supported drone PPK workflows** [docs]: DJI M3E/M4E/M300/350/400 + P1, P4RTK, L1/L2/L3 lidar, Wingtra, Trinity F90+, Skydio X10, Freefly Astro, Anzu Raptor, Autel EVO II RTK, DJI Dock 2/3 automated uploads. Onsite base RINEX is supported.
- Composite surveys merge several flights or TIN datasets into one measurable map [docs].
- The Data processing button (left rail) shows the processing queue [app; contents not inspected].

---

## Notable UX patterns

- **One comparison engine everywhere**: every volume-like tool is a "Surface comparison" item. Templates only preset its From/To. Users can stack several comparisons in one polygon.
- **Templates as the unit of customisation**: point, line and polygon families plus org custom templates. Items are drag-dropped into templates (measurement items plus custom Description/Dropdown fields). Favourite templates are bookmarked onto the toolbar.
- **Per-measurement units override** with a full imperial/metric/US-survey matrix, including density units for tonnage.
- **Deep-linkable view state** in the URL: selected measurements, design layers, camera.
- **Survey-scoped vs site-scoped measurements** (Promote/Demote), and copying a measurement to another dataset.
- **Inline tool descriptions** (the "i" in the dropdown) and keyboard-driven drawing: Magic polygon U/I/J/K, Shift angle lock, typed distances, Esc to cancel. Autosave is off by default.
- **Bottom dock** (Map / Photo viewer / Timeline / Cross Section) shares the viewport with the 3D map. The cross-section can pop out to a new window.
- **Heatmap stops double as tolerance**, with "use deadband in calculations" as an explicit opt-in.
- **Hidden datasets** ("Show hidden") keep TIN and handheld helper datasets out of the main survey picker.
- **Dark UI** with a yellow accent; dense, collapsible left panels.

## Couldn't verify

- **Upload wizard screens**: Process permission is missing on the demo account. Steps above are from the docs.
- **Processing Report contents in-app**: the report opens in a new tab, which the pane blocked. Navigating directly redirected to home. Details are from the docs.
- **Stockpile and Measurement Report**: clicking did nothing visible, probably because measurements must be selected. **Export view as JPEG**, **CSV reports** and measurement **Export** menus were not clicked (risk of download).
- **"Push to" integration list**: blocked by the safety classifier. The list comes from the docs.
- **Haul road analysis UI and Propeller CAD tab**: not present in the demo nav (add-ons). Docs only.
- **Hazard severity options, Elevation history chart, Grade/Slope and Distance result panels**: no existing instance was opened. Values are from tool descriptions.
- **Map view of sites on the home page; AeroPoints dashboard contents** (empty for this org); **Data processing queue**.
- **Station/offset cursor readout**: no LandXML alignment was activated (it may persist). Behaviour is from the docs.
- **Hydro simulation parameters for saved runs**: settings buttons and run details didn't reveal values read-only.
- **2D/3D toggle**: the viewer is always a 3D globe. There is no separate 2D mode, only a top-down camera.
- **Survey metadata panel per survey** (GSD, image count, area): not found outside the Processing Report.

## Side effects of this session (for transparency)

All of these were view-state changes. No data was created, saved, exported or shared.

- Analysis overlays and layers were toggled on Subdivision Build and Mine Site, then returned to their original state.
- Selected measurements are encoded in the URL only.
- The measurement-list search box keeps its text between visits. It was cleared at the end.
- The cut/fill display tab on "01 OG Topo to Subgrade Design" was toggled between 2D/Contours and set back to 3D Cut/Fill. If this display mode persists, it was restored.
