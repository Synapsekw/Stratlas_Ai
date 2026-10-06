# Volumes and roads

## Volumes (stockpiles)

A volumetric project holds one or more survey dates of a yard: an elevation model (DSM) or point cloud and an orthomosaic for each date. {product} finds the piles, their toe lines, four bases under each pile, the volumes and the change between dates.

### Build a stockpile project

1. **New project**, type **Volumetric**. Set the origin and click **Next** twice.
2. **Survey data**: enter the **Survey date**, pick the **DSM GeoTIFF** (or **Point cloud**) and **Pick orthomosaic**.
3. **Add a second survey date** for a comparison. Every survey needs a DSM or a point cloud, and no two surveys can share a date.
4. **Create project**. {product} starts the **Volumetric survey** job and shows **Jobs**. When it is **Done**, open **Scene**.

### Read the volumes

The right panel has a **Volumes** tab with the **Pile register**: **Pile**, **Fill**, **Cut**, **Net** and **Change** per pile.

- Pick the survey date and the **Base**: **Triangulated toe**, a best-fit toe plane, the average toe height, or the lowest toe point. The volumes follow.
- **CSV** saves the register.

When the project opens, the piles are hidden: "Click a pile to see its outline and volume. Esc hides it."

1. Click a pile on the terrain or in the register. The camera flies to it and shows its outline, body and a callout with volume, tonnage and height.
2. Hover a pile for its name only. **Esc** or a click on empty ground hides it.
3. The eye on a row keeps that pile visible; the eye at the top shows every pile.

### Surfaces, swipe and sections

In the stage toolbar:

- The survey date buttons switch the date. Only one date shows at a time.
- **Photo**, **Elevation** or **Cut / fill** colours the terrain. With **Elevation**: **Colour ramp** (**Turbo**, **Spectral**, **Viridis**, **Terrain**, **Inferno**, **Greyscale**), **Low** and **High** in metres, **Auto**, and **Hillshade**.
- **Swipe** slides between the first and the last survey.
- **Section line between the surveys**: click the first point, then the second. The profile of both dates appears.
- **Volume bodies**: **Lifted**, **In place** or **Hidden**.

### Correct a toe line

1. Select the pile, then **Edit boundary** in its detail.
2. Drag a point to move it; drag a midpoint to add one. **Delete** removes the selected point, **Ctrl Z** undoes.
3. **Save** (or **Enter**). **Cancel** (or **Esc**) leaves it as it was.

The detail shows **Last edit**. **Revert to automatic** goes back to the computed line.

## Roads

A road survey maps pavement distresses along a centreline and rates the road with the pavement condition index (PCI, ASTM D6433).

### Build a road project

1. **New project**, type **Road**. The severity step preselects **Road distress (ASTM D6433)**. **Create project**: it opens in **Road setup**.
2. **Import files**: the orthomosaic GeoTIFF.
3. Optional, **Draw centreline**: the stage switches to the map. Click along the road from its start (km 0); **Backspace** removes the last point; **Finish** saves it. **Run the road builder** opens the job with it filled in.
4. **Jobs**, **New job**, **Road survey**: pick the **Centreline**, the **Orthomosaic GeoTIFF**, the **Defect polygons**, the **Sample units** (**Along the road** or **Square grid**) and, optionally, the **Pavement raster**. **Start job**.

### Work along the road

- The **Chainage** ruler: click to go to a chainage, drag to filter a range, **Clear range** to reset. Left and Right step along.
- **Defects**: search by code, type or km; sort **Worst first**, **Chainage**, **Largest area** or **Code**. Click a row for its card.
- **PCI grid** (**P**) colours the sample units by rating, with a legend. **Defect density** (**D**) shows where defects cluster.
- **Close-up of the selected defect** (**C**) and **Measure on the map** (**M**, distance or area) work on the map.
- **Road layers**: the centreline, **Defects coloured by** severity or type, the **Area overlay** and its **Opacity**.
