# Compare dates

Projects surveyed more than once (for example a stockpile yard flown every month) can show two survey dates side by side.

To step through all survey dates of a project, see [Survey dates](28-survey-dates.md).

## Compare two dates

1. Open the project on **Scene**.
2. Click **Compare dates**, next to **3D**, **Map** and **Split**.
   - From **3D** or **Split** you get two 3D views. From **Map** you get two maps.
   - The first date is on the left, the last on the right.
3. Pick another date on either side with **Survey date on the left** or **Survey date on the right**. Picking the date the other side shows swaps the two.
4. Orbit, pan or zoom. With **Link the two views** on, both sides move together. Click it again to **Unlink the two views**.
5. Click a pile or an object on one side: it is outlined on both.

Each side draws the issues of its own date, and the issues that belong to no date. See [Survey dates](28-survey-dates.md#issues-and-measurements-belong-to-their-date).

To stop, click **Stop comparing dates**. {product} remembers the comparison per project.

## Compare from the tree

You can start a comparison from the sidebar, without the **Compare dates** button. Right-click:

- **A date folder**, then **Compare with...**. The menu lists the other dates, newest first. Pick one: the folder's date is on the left and the picked date on the right. The views follow what the stage shows now: two maps from **Map**, two 3D views otherwise (two maps on the **Low** graphics tier).
- **A dataset or a group**, then **Compare with another date...**. The views follow the kind of data:

| Kind of data              | What opens                                              |
| ------------------------- | ------------------------------------------------------- |
| Panoramas                 | Two **Panoramas** panes                                 |
| Ortho or other raster     | Two **Ortho and plans** panes                           |
| Model, point cloud, tiles | Two 3D views                                            |
| Vector layers             | Two maps                                                |
| Video or photos           | The **Frames** pane, with the other date as the compare |

A date that has no matching data is listed but greyed, with the reason, for example "No panoramas". The menu also shows on a project you cannot edit, because comparing changes nothing. The older **File under** entry stays below **Compare with another date...**.

## Panoramas side by side

1. Right-click **Panoramas** under a date and choose **Compare with another date...**, then the other date.
2. The newest date is on the left, the other on the right, each with its date tag.

The right pane shows the panorama of the other date nearest to the one on the left, if one was taken within 25 m. It says how far apart the two are. If none is that close, it says so and offers **Show the nearest**, which shows the closest one anyway.

- Both panoramas turn together, and the bearing shows as **HDG**. The link button in the right pane's corner unlinks the look, so each pane turns on its own. Press it again to link them.
- Step with **Previous panorama** and **Next panorama** in the left pane. The right pane follows to the nearest panorama of its date. It has no stepper of its own.
- The date bar moves the left pane to another date and keeps it at the same spot.
- Pick a panorama somewhere else (a marker in 3D, or the Media screen) and it goes to the left pane, and the right pane pairs again.

## What changed

While you compare, **Show changes** beside **Compare dates** lists what changed between the two dates and marks it on both views. See [Changes between two dates](14-changes.md).

- Orthos and surfaces: [Imagery and surface change](15-imagery-and-surface-change.md).
- Point clouds and 3D models: [Point cloud and 3D model change](16-cloud-and-model-change.md).
- Video frames and photos of the same view: [Same view on another date](17-frames.md).

> While you compare, the **?** next to **Stop comparing dates** opens this page.

## Two orthos side by side

1. Click **Split**.
2. Set **Left side shows** and **Right side shows** to **Ortho and plans**.
3. Pick a date on each side.

The picker on each side is one list grouped by survey date, newest first. Each date lists what it has (**3D**, **Map**, **Ortho and plans**, **Panoramas**), and the last group, **Any date**, holds the panes that do not follow a date (for example **Video**, **Photos**, **Report**). Picking an entry sets the view and the date in one step. A project with one survey date shows a plain list.

With two maps or two orthos of different dates, a bar at the top of the views offers **Side by side**, **Swipe** and **Blend**. See [Swipe and blend two dates](15-imagery-and-surface-change.md#swipe-and-blend-two-dates).

## What works on which side

Both sides show the same things, each for its own date:

- On a stockpile project: the surface colours (**Photo**, **Elevation**, **Cut / fill**), the pile bodies, the toe lines and the callouts. One switch in the stage toolbar sets both sides. The legend on the left sets the elevation ramp and range for both sides; the right view shows the same legend without the controls.
- The point cloud legends (elevation, classification, change), on each side that shows the colouring.
- Saved survey measurements. A measurement of the whole site is drawn on both sides, a measurement of one survey date on the side that shows that date. This also holds for two maps.

The same rule holds in the ordinary **Split** (the 3D view beside the map) on a project with two or more survey dates: a measurement that belongs to one survey is drawn on the pane that shows that date, so it can show on one side and not on the other when the two sides are set to different dates.

These still work in the left (main) view only: measuring, drawing, editing a pile boundary, picking a section line, the swipe, the AI agent and video. Designs, the haul road and terrain overlays are drawn there only. The right view follows the camera, and a click on it selects.

If the graphics card cannot hold the surface colours for the right view, that view keeps the photo and its legend says: "Not enough graphics memory to colour this view. It shows the photo."

## Low graphics tier

Two 3D views need more graphics memory than the **Low** tier allows. On Low, **Compare dates** shows a swipe between the dates on stockpile projects, or the two dates on maps, with a short notice. See [Graphics quality](12-settings.md#graphics-quality).

## Swipe between dates (stockpiles)

On a stockpile project, **Swipe** in the stage toolbar slides between the first and the last survey in one 3D view. Drag the divider, or use the Left and Right keys. See [Volumes](09-volumes-and-roads.md#volumes-stockpiles).
