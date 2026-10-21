# Volumes and roads

## Volumes (stockpiles)

A volumetric project holds one or more survey dates of a yard: an elevation model (DSM) or point cloud and an orthomosaic for each date. {product} finds the piles and makes each one a volume measurement in the **Stockpiles** folder. Its volume, its volume over time and its base work as for any other volume measurement (see [Volumes, bases and comparisons](36-volumes-bases-and-comparisons.md)).

### Build a stockpile project

1. **New project**, type **Survey**. Set the origin and click **Next** twice.
2. **Survey data**: enter the **Survey date**, pick the **DSM GeoTIFF** (or **Point cloud**) and **Pick orthomosaic**.
3. **Add a second survey date** for a comparison. Every survey needs a DSM or a point cloud, and no two surveys can share a date.
4. **Create project**. {product} opens the new project and starts the **Volumetric survey**; the **Processing** drawer opens on it. When it says **Done**, close the drawer.

### The Volumes view

The **Volumes** tab of the right panel shows every volume measurement of the project; a stockpile project opens on it.

- **Piles to show**: **All piles**, or the piles of one folder.
- Each pile is a card with its volume on the latest survey. Click a card to open the pile under the list in its detail card, the same card as in the measurement panel: its chips, its comparisons, **Material and calculators** and its actions (see [The measurement card](35-measuring-and-templates.md#the-measurement-card)).
- Under the cards, **Total on** the latest survey date adds the piles counted on that date, for example "3 of 4 piles". **Not counted** names every pile left out, and why: stale, no survey data, not computed yet, could not compute, or no comparison. A pile left out is never counted as zero.
- **Site inventory over time** stacks the piles on every survey date, in a chart and a table, with the change since the previous date over the piles counted on both.
- **CSV** saves the volume of each pile shown on every survey date (see [Volume over time](36-volumes-bases-and-comparisons.md#volume-over-time)).

Without a volume measurement the view says "No stockpiles yet" and offers **Draw volume** and **Detect piles**.

### Detect piles

**Detect piles** runs the stockpile pipeline on the project's surveys, in the **Processing** drawer. Each pile it finds becomes a volume measurement in the **Stockpiles** folder, computed when it is shown. Run it again after a new survey: a pile it finds again keeps its measurement, matched by its outline (at least half of the smaller outline in common), even when the run numbers the piles differently. Only a pile with no measurement under it is added. **Detect piles** is greyed out, with the reason, when the project has no stockpile job.

To correct a pile's outline, edit its vertices in the measurement panel (**Vertices**, **Edit vertices in the view**). A pile has one outline for every date.

### Piles from an earlier version

A project from an earlier version kept its piles and their figures in the old stockpile register. When it opens, each pile becomes a volume measurement in **Stockpiles** that keeps the old figures on every date, marked "From an earlier version (kit, Triangulated)" with the base the register used. Nothing is recomputed, and nothing shows as unsaved.

- **Recompute with the standard base** on the card replaces the old figure with the engine's, on the **Triangulated toe** base. The card keeps the old figure as "was ...".
- Editing the pile's outline accepts the standard base too.
- The old register's **Triangulated** base was a smooth surface over the toe, while **Triangulated toe** triangulates the toe line, so the two figures can differ a little.

### Piles in 3D

When the project opens, the piles are hidden: "Click a pile to see its outline and volume. Esc hides it."

1. Click a pile on the terrain. The camera flies to it and shows its outline, its body and a callout with the volume of its measurement and its tonnage. A stale figure reads "..., stale", as on the card.
2. Hover a pile for its name only. **Esc** or a click on empty ground hides it.

### Surfaces, swipe and sections

The island's **Volumes** row has the survey date and **Swipe**, the surface colours and the volume bodies:

- The survey date buttons switch the date. Only one date shows at a time.
- **Photo**, **Elevation** or **Cut / fill** colours the terrain. With **Elevation**: **Colour ramp** (**Turbo**, **Spectral**, **Viridis**, **Terrain**, **Inferno**, **Greyscale**), **Low** and **High** in metres, **Auto**, and **Hillshade**.
- **Swipe** slides between the first and the last survey.
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
