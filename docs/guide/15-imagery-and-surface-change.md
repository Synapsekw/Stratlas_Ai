# Imagery and surface change

Two orthos of the same area show what changed on the ground: a new building, a container taken away, a new track. Two surfaces (DSMs or point clouds) show where ground was cut or filled, and how much. Both run on this computer as jobs and add their results as new layers. Your own layers are never changed.

## Before you start

- **Imagery change** needs an ortho on each date.
- **Surface change** needs a DSM or a point cloud on each date.
- Each layer must belong to its survey date (see [Survey dates of layers](14-changes.md#survey-dates-of-layers)).

Open the **Changes** tab (see [Show changes](14-changes.md#show-changes)) and pick the two dates. A button that cannot run for these dates is greyed; its tool tip says what is missing.

## Run imagery change

1. Click **Run imagery change**. **Processing** in the title bar shows it while it runs.
2. When it finishes, two layers are added:
   - "Imagery change heat map, ..." with the two dates: yellow where the change is weak, red where it is strong.
   - "Imagery change areas, ...": an outline around each changed area.
3. Each area is listed as **Changed** in the **Changes** tab, for example "Changed area of 48.0 m²".

Sun angle, shadows, exposure and a seasonal tint should not show as change. On the demo, the new shelter and the missing container are outlined; the shadow of a passing cloud is not.

## Run surface change

1. Click **Run surface change**.
2. When it finishes, two layers are added:
   - "Surface change heat map, ...": blue where the ground is lower (cut), red where it is higher (fill).
   - "Cut and fill areas, ...": an outline around each area deeper or higher than 10 cm and larger than 1 m².
3. Each area is listed as **Cut** or **Fill** with its volume and size, for example "Fill of 41.2 m³ over 190.0 m²".

On the demo, the grown stockpile shows as fill and the new pit as cut. For stockpiles surveyed every month, the volumes workflow is still the place for pile volumes (see [Volumes](09-volumes-and-roads.md#volumes-stockpiles)).

## The two dates must line up

Before comparing, {product} checks how well the two dates line up. Otherwise the whole site would show as changed. It does not run, and says by how much, when:

- the two dates are shifted sideways by more than 2 pixels (or 2 cells of a surface), for example "The two dates are 4.3 px (0.21 m) apart; the largest shift allowed is 2 px. Line up the dates first.". The **Changes** tab then shows the gap with **Line up dates** (see [Line up dates](#line-up-dates));
- one surface is more than 5 cm higher or lower than the other over unchanged ground. Check that both surfaces use the same height datum.

It compares only where both dates have data. "The two orthos do not overlap" means there is nothing to compare.

## Line up dates

Two surveys of one site often sit a little apart, because each was placed on its own. **Line up dates** saves a sideways correction for one date so that it lies on the other. Every view and every job then uses it: the map, the 3D view, swipe and blend, and the change runs. Your files are never changed.

There are two ways in:

- **A notice.** When a new survey arrives and its ortho or DSM sits too far from another date's, a notice says so with **Line up dates** and **Not now**.
- **On demand.** In the **Changes** tab, after a change run is refused for a gap, click **Line up dates**, or use the menu of a survey date.

In the step:

1. Under **Keep in place**, choose the date that stays where it is. The other date moves onto it.
2. {product} measures the gap and shows it as a shift to the east or west and to the north or south, with the total. A line says how confident the measurement is. If it cannot be trusted, the step says why and does not line up.
3. A line lists what moves with the date: its datasets and the items drawn on it.
4. Drag the divider in the preview to compare **Before** and **After**.
5. Click **Line up**. A notice confirms it.

After a change run was refused for a gap, it starts again by itself once the line-up is saved.

**Undo.** The notice has **Undo**, or press Ctrl+Z. Ctrl+Y does it again. Undo also works after **Remove line-up**.

**Remove line-up.** A lined-up date's folder shows "Lined up with ..." as its tool tip. **Remove line-up** is an item in the date's menu: use it to put the date back at its file position.

**What never moves:** common layers (those with no survey date), basemaps, terrain, and change results made before the line-up. Those results are marked out of date; click **Run again** to make them in the lined-up frame.

## Read the heat map legend

While a change heat map is visible, its legend shows on the map and in the 3D view:

- **Change score**: 35% (yellow) to 100% (red). Below 35% the heat map is clear.
- **Height change**: -2 m (blue, lower) through 0 m to +2 m (red, higher).

In 3D the heat map lies on the ground like an ortho. Turn it on and off in **Datasets** like any layer.

## Swipe and blend two dates

While **Compare dates** shows two maps, or **Split** shows **Ortho and plans** on both sides with two different dates, a bar at the top of the views offers:

- **Side by side**: the two views next to each other.
- **Swipe**: one view, the earlier date left of a divider and the later date right of it. Drag the divider, or focus it and use the Left and Right keys (with **Shift** for bigger steps, **Home** and **End** for the edges).
- **Blend**: the later date over the earlier one. Move the slider from **Earlier** to **Later**.

Swipe and Blend link the two views, so they always line up. Leaving the comparison goes back to side by side.
