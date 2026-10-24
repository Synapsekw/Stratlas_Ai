# Volumes and roads

## Volumes (stockpiles)

A volumetric project holds one or more survey dates of a yard: an elevation model (DSM) or point cloud and an orthomosaic for each date. {product} finds the piles and makes each one a volume measurement in the **Stockpiles** folder. Its volume, its volume over time and its base work as for any other volume measurement (see [Volumes, bases and comparisons](36-volumes-bases-and-comparisons.md)).

### Build a stockpile project

1. **New project**, type **Survey**. Set the origin and click **Next** twice.
2. **Survey data**: enter the **Survey date**, pick the **DSM GeoTIFF** (or **Point cloud**) and **Pick orthomosaic**.
3. **Add a second survey date** for a comparison. Every survey needs a DSM or a point cloud, and no two surveys can share a date.
4. **Create project**. {product} opens the new project and starts the **Volumetric survey**; the **Processing** drawer opens on it. When it says **Done**, close the drawer.

### The Volumes view

The **Volumes** tab of the right panel is the stockpile inventory; a stockpile project opens on it. Its figures are those of the survey date in focus (the notch, the dates strip or the sidebar's date folders set it).

- The header: **Stockpile inventory**, the date in focus, the site's **Volume** (with the number of piles), **Tonnes** by material, and the change since the previous survey. **Export** saves the volume of each pile on every survey date as CSV (see [Volume over time](36-volumes-bases-and-comparisons.md#volume-over-time)).
- **Inventory | Cut & fill | Materials** picks the pane.
- **Inventory** groups the piles by material, each group with its subtotal (volume, tonnes and change) and its first four piles ("+ 2 more" shows the rest), then **Site total**. **Not counted** names every pile left out, and why: stale, no survey data, not computed yet, could not compute, or no comparison. A pile left out is never counted as zero.
- Click a pile's row to open it in the pile panel; **‹ Inventory** comes back.
- **Cut & fill** compares two surveys (**From** and **To**): **Inside piles** or **Whole site**, and **Ignore under** a height change in metres. The tiles show the cut, the fill and the net; under them a bar per pile, the piles that barely changed folded into one line. Click a bar to open its pile.
- **Materials** lists the site materials with their density, swell, piles, volume and tonnes on the date in focus. Click a material to edit it: its colour, its name, its density from a survey date (the dates before keep theirs, and **History** lists each density with the date it applies from), the tonnes it changes, and **Assign piles**. Nothing is kept until **Save**; **Cancel** drops the edits. **Import CSV** and **Export CSV** are here too.

Without a volume measurement the view says "No stockpiles yet" and offers **Draw volume** and **Detect piles**.

### The dates strip

With two or more dated surveys, the **Survey dates chart** under the stage draws the site's stockpiles through time: a marker per survey, month gridlines, and the volume stacked by material.

- Click a marker, or drag the playhead, to put that survey in focus: the notch, the sidebar's **Stockpiles** group, the pile labels and the Volumes tab follow. The arrow keys step the playhead.
- **Volume**, **Tonnes** or **Cut & fill** (a bar between each pair of surveys: fill above zero, cut below). While a density edit is unsaved, **Tonnes** previews it.
- **Compare** shades the band between two surveys with its change; drag a bracket to move it. **Fit** zooms to the band, and again to every survey.
- With a pile open, the strip draws that pile's line over the site total, faded; the pile chip's **×** clears it.
- **Play** steps through the surveys (the speed and **Loop** are beside it). The notch reads "Playing · ..."; the map crossfades from one survey's photo to the next, and the corners of the stage show the two surveys and the site total. Figures change only at survey dates. **Esc**, a click on a pile or another date stops it.
- The arrow at the right folds the strip to its bar; it stays folded for the project. In a project with video, **Dates | Footage** at the left of the bar switches to the footage timeline.

### Detect piles

**Detect piles** runs the stockpile pipeline on the project's surveys, in the **Processing** drawer. Each pile it finds becomes a volume measurement in the **Stockpiles** folder, computed when it is shown. Run it again after a new survey: a pile it finds again keeps its measurement, matched by its outline (at least half of the smaller outline in common), even when the run numbers the piles differently. Only a pile with no measurement under it is added. **Detect piles** is greyed out, with the reason, when the project has no stockpile job.

To correct a pile's outline, edit its vertices in the measurement panel (**Vertices**, **Edit vertices in the view**). A pile has one outline for every date.

### Piles from an earlier version

A project from an earlier version kept its piles and their figures in the old stockpile register. When it opens, each pile becomes a volume measurement in **Stockpiles** that keeps the old figures on every date, marked "From an earlier version (kit, Triangulated toe)" with the base the register used. Nothing is recomputed, and nothing shows as unsaved.

- **Recompute with the standard base** on the card replaces the old figure with the engine's, on the **Triangulated toe** base. The card keeps the old figure as "was ...".
- Editing the pile's outline accepts the standard base too.
- The old register's base was a smooth surface over the toe, while the engine's **Triangulated toe** triangulates the toe line, so the two figures can differ a little.

### Piles in 3D

When the project opens, the piles are hidden: "Click a pile to see its outline and volume. Esc hides it."

1. Click a pile on the terrain. The camera flies to it and shows its outline, its body and a callout with the volume of its measurement and its tonnage. A stale figure reads "..., stale", as on the card.
2. Hover a pile for its name only. **Esc** or a click on empty ground hides it.

### Surfaces, swipe and sections

While the **Volumes** tab is open, the **Show** control at the top left of the stage sets what the terrain shows and what is drawn of the piles:

- **Photo**, **Elevation** or **Cut & fill** colours the terrain. With **Elevation**: **Colour ramp** (**Turbo**, **Spectral**, **Viridis**, **Terrain**, **Inferno**, **Greyscale**), **Low** and **High** in metres, **Auto**, and **Hillshade**.
- **Outlines** and **Labels** show or hide the piles' outlines and labels.

The island's **Volumes** row has **Swipe**, the section line and the volume bodies (the survey date is the notch's and the dates strip's):

- **Swipe between surveys** slides between the first and the last survey.
- **Section line between the surveys**: click the first point, then the second. The profile of both dates appears on the profile chart, shaded cut and fill, with their areas under it (see [The profile and section chart](37-cross-sections-and-terrain-overlays.md#the-profile-and-section-chart)).
- **Volume bodies**: **Lifted**, **In place** or **Hidden**. The bodies stand on the old register's base, as a picture only.

## Roads

A road survey maps pavement distresses along a centreline and rates the road with the pavement condition index (PCI, ASTM D6433).

### Build a road project

1. **New project**, type **Road**. The severity step preselects **Road distress (ASTM D6433)**. **Create project**: it opens in **Road setup**.
2. **Import files**: the orthomosaic GeoTIFF.
3. Optional, **Draw centreline**: the stage switches to the map. Click along the road from its start (km 0); **Backspace** removes the last point; **Finish** saves it.
4. In the road setup panel, click **Run the road builder**. A small dialog opens, with the drawn centreline filled in. Pick the **Centreline**, the **Orthomosaic GeoTIFF**, the **Defect polygons**, the **Sample units** (**Along the road** or **Square grid**) and, optionally, the **Pavement raster**. **Start**.

### Work along the road

- The **Chainage** ruler: click to go to a chainage, drag to filter a range, **Clear range** to reset. Left and Right step along.
- **Defects**: search by code, type or km; sort **Worst first**, **Chainage**, **Largest area** or **Code**. Click a row for its card.
- **PCI grid** (**P**) colours the sample units by rating, with a legend. **Defect density** (**D**) shows where defects cluster.
- **Close-up of the selected defect** (**C**) and **Measure on the map** (**M**, distance or area) work on the map.
- **Road layers**: the centreline, **Defects coloured by** severity or type, the **Area overlay** and its **Opacity**.
