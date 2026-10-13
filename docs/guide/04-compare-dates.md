# Compare dates

Projects surveyed more than once (for example a stockpile yard flown every month) can show two survey dates side by side.

To step through all survey dates of a project, see [Survey dates](28-survey-dates.md).

## Compare two dates

1. Open the project on **Scene**.
2. Click **Compare dates**, next to **3D**, **Map** and **Split**.
   - From **3D** or **Split** you get two 3D views. From **Map** you get two maps.
   - The first date is on the left, the last on the right.
3. To show another date on a side, open the picker above that side and pick the view under that date. The picker is one list grouped by survey date (see [Two orthos side by side](#two-orthos-side-by-side)). The view and date the other side shows is greyed, so both sides never show the same thing. To swap the two dates, right-click the right date's folder in the tree and choose **Compare with...**, then the left date.
4. Orbit, pan or zoom. With **Link the two views** on, both sides move together. Click it again to **Unlink the two views**.
5. Click a pile or an object on one side: it is outlined on both.

Each side draws the issues of its own date, and the issues that belong to no date. See [Survey dates](28-survey-dates.md#issues-and-measurements-belong-to-their-date).

To stop, click **Stop comparing dates**. {product} remembers the comparison per project.

## Compare from the tree

You can start a comparison from the sidebar, without the **Compare dates** button. Right-click:

- **A date folder**, then **Compare with...**. The menu lists the other dates, newest first. Pick one: the folder's date is on the left and the picked date on the right. The views follow what the stage shows now: two maps from **Map**, two 3D views otherwise (two maps on the **Low** graphics tier).
- **A dataset or a group**, then **Compare with another date...**. The views follow the kind of data:

| Kind of data          | What opens                                              |
| --------------------- | ------------------------------------------------------- |
| Panoramas             | Two **Panoramas** panes                                 |
| Ortho or other raster | Two **Ortho and plans** panes                           |
| Model or point cloud  | Two 3D views                                            |
| Vector layers         | Two maps                                                |
| Video or photos       | The **Frames** pane, with the other date as the compare |

A date that has no matching data is listed but greyed, with the reason, for example "No panoramas". The menu also shows on a project you cannot edit, because comparing changes nothing. The older **File under** entry stays below **Compare with another date...**.

## Panoramas side by side

1. Right-click **Panoramas** under a date and choose **Compare with another date...**, then the other date.
2. The newest date is on the left, the other on the right, each with its date tag.

The right pane shows the panorama of the other date nearest to the one on the left, if one was taken within 25 m. It says how far apart the two are. If none is that close, it says so and offers **Show the nearest**, which shows the closest one anyway.

- Both panoramas turn together, and the bearing shows as **HDG**. The link button in the right pane's corner unlinks the look, so each pane turns on its own. Press it again to link them.
- Step with **Previous panorama** and **Next panorama** (or Page Up and Page Down) in the left pane. The right pane follows to the nearest panorama of its date. It has no stepper of its own.
- A **Panoramas** pane on one side only (the other side shows 3D or a map, for example) has the stepper itself and steps through the panoramas of its date. So does the right pane when the left date has no panoramas.
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
2. Open **Left side shows** and pick **Ortho and plans** under one date.
3. Open **Right side shows** and pick **Ortho and plans** under another date.

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

## Other dates of one spot

Pick any placed photo, drone photo, 360, walk frame or video frame and see the same spot on every other survey date, without leaving the screen you are on. The project needs two or more survey dates.

1. Click the image. In **Media**, a strip under the photo shows one slot per survey date, oldest on the left, each in its date colour.
2. Click **Other dates** (the clock-arrow button). A viewer opens on the image you clicked.

The **Other dates** button is in:

- the photo panel of **Media**, with the strip under the photo;
- the photo pane of the **Split**;
- the **Selection** card of a photo or a 360;
- the **Frames** pane, for the frame on screen;
- the walk player, for the walk frame on screen.

An image without a position has no other dates to match. The viewer says so instead of guessing.

### What a slot shows

- A thumbnail, the date colour and the kind: **Photo**, **Drone**, **360**, **Walk** or **Video**.
- **+n** when that date has more than one image near the spot. The best match shows first.
- A hatched slot when the date has nothing: **Nothing within 15 m** (or 25 m for a 360), or **Not seen** for a drone spot that no flight of that date saw.
- A tooltip when items of that date were left out because they could not be placed: a photo without a position, a walk that is not placed, or a video whose flight log cannot be read.

### In the viewer

| Key         | What it does                                    |
| ----------- | ----------------------------------------------- |
| Left, Right | Previous or next date that has an image         |
| Up, Down    | Other images of the same date (the **+n** ones) |
| C           | Compare two dates                               |
| Esc         | Leave Compare, then close the viewer            |

When a date chip (a select) or a video has the focus, the arrow keys are left to it; Esc still works as in the table, leaving Compare first and then closing the viewer. The header shows the name, date and kind of the image, how far it is from the one you clicked, and the angle when it is turned. A 360 or a walk frame opens turned towards the spot. A video frame opens paused at the moment that saw the spot, and plays when you press play.

### Compare

**Compare...** is available when two or more dates have a match. It shows two dates of the spot. In Compare the arrow keys move the left side. Pick the dates with the chips above each side.

- **Side by side** puts the two images next to each other. The mouse wheel zooms both on the same place, a drag pans both, and a double-click fits them. For 360s the two views look the same way.
- **Swipe** puts one image over the other under a divider. Drag the handle, or focus it and use the arrow keys. The zoom and pan stay.

**One image**, or the first Esc, leaves Compare and shows the left date alone. A second Esc closes the viewer. The viewer only reads: the date bar, the layers and the selection behind it do not change.

### How images are matched

| Clicked image | The same spot on another date                                                       |
| ------------- | ----------------------------------------------------------------------------------- |
| Ground photo  | A photo within 15 m that looks the same way (within 45 degrees)                     |
| Drone photo   | A drone photo, from any flight of that date, whose view covers the same ground      |
| 360           | The nearest 360 of that date within 25 m, turned towards the same spot              |
| Walk frame    | A walk frame within 15 m                                                            |
| Video frame   | A frame of a video of that date, checked once a second, that looks at the same spot |

A drone photo is told from a ground photo by its height: above 10 m over the spot it counts as aerial.
