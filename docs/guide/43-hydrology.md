# Hydrology

**Site data**, **Hydrology** shows where water collects and flows on a survey. Pick a prepared **Surface** first. Results draw on the map, so open the **Map** view to pick points and see them. Each run is a job and is kept with the project.

## Flood to level

Floods the surface to a water level and reports the flooded area, the stored volume and the deepest point.

1. Type the **Water level (m)**, or **Pick on map** to take the ground height of a point.
2. Choose **Water**: **Connected to a point** (only water connected to the point you pick, for example a pit sump) or **Every cell below the level**.
3. Click **Flood**.

**Download outline (DXF)** saves the outline for CAD; the depth grid and a GeoJSON outline are offered too.

## Runoff

Pick a **Drop point** and click **Show flow path**: the path water takes from there, with its length and fall. **Flow direction** is **D8** or **D-infinity**; **Depressions** are breached or filled first.

## Catchment

Pick one or more outlets (or leave them empty to use the point where most water leaves the site), set the **Stream threshold (m²)** and click **Delineate**: the catchment of each outlet and the stream network, downloadable as GeoJSON.

## Direct rainfall

Rain falls on every cell and runs over the surface.

1. Choose a **Rainfall** CSV: time in minutes and intensity in mm/h, one row per step.
2. Set **Manning's n**, **Infiltration (mm/h)**, the **Cell** (2, 1 or 0.5 m) and, if you like, a **Duration (min)**.
3. Click **Run rainfall**. The **Time** slider then shows the water depth over time. **Hydrograph (CSV)** and **Maximum depth grid** download the results.

Direct rainfall is a simplified model: one roughness and one infiltration rate for the whole area, and no pipes or culverts.

## Size limits

Each tool reads a bounded number of cells: 25 million for flood to level, 4 million for runoff, catchments and direct rainfall. Above that a run is refused; use a coarser surface or a coarser rainfall cell.
