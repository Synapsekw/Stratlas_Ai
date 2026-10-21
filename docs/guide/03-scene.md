# The scene

**Scene** shows everything a project holds in one place: 3D models, point clouds, maps and orthos, video with the drone's flight, photos and panoramas, and the issues on them.

![The scene in 3D](images/scene-3d.png)

## Move around in 3D

- Drag with the left mouse button to orbit, with the right button to pan; the wheel zooms.
- **H** or **Whole site**: frame the whole project.
- **G** or **Centre on project**: frame the models and clouds, or without them what lies within 10 km of the project origin, so photos with a wrong GPS far away do not pull the view off the site.
- **F** or **Fly to selection**: fly to what you picked.
- **View presets**: **Iso**, **Top** or **North**. Clicking the compass also turns the view north-up from the top.
- **Esc**, or clicking the active tool again, returns to the pointer.

{product} remembers the camera for each project when you leave Scene and come back.

## The island: the stage tools and the date

The stage has no toolbar and no date bar. At the top centre of the view sits the island. At rest it shows the survey date you are viewing, for example "13 Apr", in the survey's colour; move the pointer near the top of the view and it grows to the date's arrows, the view and **Tools**.

- Click the date for the calendar: the month with the survey days marked, the survey list and **Compare the two dates**. **Alt ←** and **Alt →** step through the dates.
- Click the island, or press **T**, to open the stage tools: the **3D**, **Map** and **Split** switch, and a tab per group: **View**, **Measure**, **Display** and **Annotate**, and where the project has them **Point cloud**, **Volumes**, **Video** and **Road**. Pointing at a tab shows the group's quick tiles; clicking it opens the group's workbench, its full set, as a tab in the right panel (see [The right panel](#the-right-panel)), and the island goes back to rest. **All tools** at the end of a row does the same.
- The arrow keys move between the tiles, **Tab** moves between the rows, and **Esc** closes the tools.
- While something is going on, the island says it beside the date: a measurement and its reading, the playing clip with its telemetry, a processing job with its progress, or **Offline** when the network is down. Click the reading, or press **Space** on it, to bring its tab to the front of the right panel. When two things are going on, the second one is a small bubble beside the island; click it to swap them.

**T** no longer shows or hides the timeline: the timeline is the **Timeline** tile in the island's **View** group, and has no key.

## 3D, Map and Split

The switch at the start of the open island changes the view:

- **3D** (key **1**): the 3D view.
- **Map** (key **2**): a flat map with the orthos, plans and the offline street map.
- **Split** (key **3**): two views side by side. Each side has a header strip under the island: the survey date it shows, and what it shows, **Left side shows** and **Right side shows**: **3D view**, **Map**, **Video**, **Photos**, **Ortho and plans** or **Report**. Only what the project has is offered, and the 3D view can be on one side only.
  - Drag the divider between the two sides to give one more room, or focus it and use the **←** and **→** keys; a double-click puts it back in the middle. The share is remembered on this computer.
  - The island's date is the date of the side you used last: **‹** **›** and **Alt ←** **Alt →** step that side, and the other keeps its date.

Projects with more than one survey date also have **Compare dates**. See [Compare dates](04-compare-dates.md).

## What stands on the view

Around the island, each overlay keeps a corner of the view to itself, so none covers another: the survey dates on screen, a status such as the cutaway or a comparison notice, the **Map** chip, the volumes hint, and the coordinates readout at the foot of the 3D view. Where the floating video window rests, or the open island reaches down, what wanted that corner takes a free one, or waits until one is free. In **Split**, each side's header strip stands under the island and no overlay covers it.

## Show and hide layers

- In the sidebar, **Datasets** has an eye per layer, one per group (Models, Point clouds, Maps, Video) and one at the top for everything. A half-filled eye means some layers in the group are hidden.
- In the island, the **Display** group's workbench (**Layers** at the end of its row) has **Layers and issue pins**, which turns kinds on and off: **Models**, **Point clouds**, **Photo cameras**, **Maps and rasters** and **Video clips**.
- The 3D view sits on the offline street map wherever an installed map pack covers the site: sharp under the site and running out to the horizon. The **Street map** tile in the island's **Display** row (**Hide the street map under the site**) takes it away and brings it back; the choice is remembered for the project on this computer. The **Map** chip at the top right of the 3D view puts an online map (Esri, Mapbox or Sentinel-2) or your imagery and terrain packs on the ground instead. See [The ground in 3D](06-maps.md#the-ground-in-3d).
- If you delete a layer you were looking at, for example photos placed far away by a wrong GPS, and the view is left on empty ground, the 3D view frames the project again.
- **I** or the **Issue pins** tile in **Display** turns the issue tags off and back on. **Issue pins** in the Display group's full set shows **All**, only issues at or above a severity, or **Off**, and the **Severity heat map**.
- **L** or **Labels** cycles the component labels: **Off**, **Key** (one per group) and **All**.

## Delete datasets and the project trash

In **Datasets**, right-click a dataset, a group heading (for example **Video**) or a survey date folder and choose **Delete…**. A dialog lists what goes:

- **Deletes:** the datasets you picked.
- **Also removes:** what was made from them, for example the map layers of a processing run, comparisons and 3D tilesets.
- **Keeps:** what stays, for example "3 issues will show 'Dataset removed'", or "Your original photos are not touched." A survey date that a volume, a survey check or a measurement still uses stays, and the dialog says so.

Click **Delete** to go ahead, or **Cancel**. "Everything goes to the project trash and is deleted for good after seven days." Deleting a survey date folder takes everything filed under it.

To delete several at once, mark the rows first:

- **Ctrl**-click a row to mark or unmark it; **Shift**-click marks every row from the last one you marked.
- From the keyboard: **Shift ↑** and **Shift ↓** extend the marks, **Ctrl Space** marks or unmarks the focused row, **Esc** clears the marks.
- While rows are marked, the header of Datasets reads, for example, **3 selected · Delete…**. Click it, or press **Delete**. **Delete** on a focused row with nothing marked deletes that row.

The project trash is a folder inside the project. While it holds something, a line at the foot of Datasets says how much, for example **Trash 12.3 MB · Empty**. **Empty** asks "Delete the project trash for good?" and **Delete for good** frees the space at once. The same is in the project's menu in the library: **Empty project trash**.

Deleting and marking are not offered in a read-only package or to a reviewer who may only look.

<!-- screenshot: delete-datasets.png | The Delete dialog over Scene in a demo project with a photo processing run: Deletes, Also removes (the run's map layers) and Keeps, with the seven-day trash note; the Trash line at the foot of Datasets in the background -->

## Data far from the project

When an import brings data that lies more than 10 km from the project origin, a notice **Far from the project origin** names each far layer and its distance:

- **Re-centre project here** moves the project origin to that data. Everything already in the project shifts with it, so nothing moves on the ground, and the project opens again. The notice then says where the origin is now; the previous `manifest.json` is kept as `manifest.json.bak`. A re-centre cannot be undone.
- **Keep** leaves the project as it is.
- When only photos lie far from survey data that is already in place, the camera's GPS is the likely culprit (a handheld camera's GPS can be kilometres out). The notice then offers **Ignore their GPS** instead: the photos stay in **Media** without a place on the map.

Re-centring is not offered when the project holds things that cannot move with it, such as issues, flights, walks, panoramas, drawings, photo processing runs, procedural models or a job that has not finished; the notice names them. **Ctrl K**, **Check where layers lie against the project origin** runs the same check at any time.

<!-- screenshot: far-data-notice.png | The "Far from the project origin" notice after importing a layer more than 10 km from the origin of a test project, with Re-centre project here and Keep -->

## Measure and cut

- **M** or **Measure a distance**: click two points. **Esc** clears it.
- **X** or **Section plane**: turn on **Section**, pick **Vertical** or **Horizontal**, set **Bearing** and **Offset**. **Keep other half** flips the side that stays.

## Point clouds

The island's **Point cloud** row has **Show** and the colour switch **RGB**, **Elevation**, **Intensity** and **Flight**. Click the **Point cloud** tab in the island for its workbench in the right panel, with every setting under **Colour, size and EDL**:

- **Colour by**: **RGB**, **Elevation**, **Intensity**, **Classification** or **Flight**.
- **Point size**: 1x is the normal size; 2x and 4x make points at least 2 and 4 pixels.
- **Point budget**: how many million points draw at once. More looks denser and needs a stronger graphics card.
- **Eye-dome lighting**: shades edges so shapes read better.
- **Elevation range** (with Elevation colouring): drag the sliders to stretch the colours; **Auto** resets them.

Detail streams in as you move: coarse first, finer after. The default budget follows the graphics preset (see [Graphics quality](12-settings.md#graphics-quality)).

### Put a floating cloud on the ground

A cloud whose heights are off (for example a cloud built from photo altitudes that the project corrects only for the photos) floats above the site or sinks below it. Fix it without changing its file:

- Right-click the cloud in **Datasets** and pick **Drop to ground**. The cloud's lowest point goes onto the ground, and a notice says how far it moved, with **Undo**. Press **Ctrl+Z** to take it back. You can mark several datasets and drop them together.
- The ground is the DSM under the item's footprint if there is one, otherwise the project ground level.
- In **Properties**, **Height offset (m)** shows the offset and can be edited. Type a value and click **Save offset**; the cloud moves at once, and **Undo** or **Ctrl+Z** takes it back. The street map lowers under the cloud as it does under a model, an orthophoto or an elevation model.
- The file is never rewritten. A cloud from a Bentley `.zpc` that names no height datum takes the project's photo altitude correction when imported, because it was built from the same uncorrected photo altitudes. The photos of a Bentley AT export take the same correction, so they stay with that cloud. A generic LAS or LAZ gets none, so use **Drop to ground** on it. Clouds in the kit format cannot be moved: convert them to COPC first.

## Clean up a point cloud

Click **Clean up** in the island's **Point cloud** group, or right-click a point cloud in **Datasets** and pick **Clean up...**. The panel opens as the **Point cloud cleanup** tab of the right panel and works on the selected cloud; with several clouds, pick one at the top. Cleanup works on COPC clouds only: convert others first.

Nothing is rewritten while you clean up. Every change is one step you can undo with **Undo** (**Ctrl+Z**) and redo with **Redo** (**Ctrl+Y** or **Ctrl+Shift+Z**), and the points come back when you undo.

- **Clip box**: **Fit to layer** puts a box around the cloud. **Edit box** shows handles: drag a face to move it (in steps of 10 cm), drag the ring above the box to turn it. **Keep** **Inside** or **Outside**. **Remove box** takes it away. The box works together with the section plane.
- **Height range**: type the lowest and highest elevation, or drag the two handles of the slider. Points outside are hidden.
- **Select points**: pick **Box** or **Lasso** and drag over the view (**Esc** cancels). The bar says how many of the loaded points you caught, then **Hide** (only in the view), **Delete** (left out of saves and exports) or **Set class**. A selection reaches through the whole cloud along your view, also the points not loaded yet.
- **Remove noise**: finds stray points in the air and under the ground and marks them as class 7 (Low noise), which is then hidden. It runs as a job; the panel then says how many points it marked. **Settings** has the number of neighbours, the distance limit and **Also mark low points**. **Undo** takes the run back.
- **Save cleaned copy**: writes a new point cloud layer, "<name> (cleaned)", without the deleted, clipped and hidden-class points. The original is hidden and its file is never changed.
- **Reset all cleanup** starts over (also one step you can undo). While the panel is open, the Classification legend shows and hides the classes of the cloud you clean up.

Right-click a point cloud in **Datasets** for **Clean up...**, **Remove noise...** and **Save cleaned copy...** (each opens the panel at its section), and **Reset cleanup** once you changed something.

Exporting a cloud with a cleanup (**Site data**, **Export survey data**) has **Apply cleanup**, on by default, with a line that says what it removes.

**Remove noise** and **Save cleaned copy** need the processing tools 0.12.0 or later (see [Processing tools](12-settings.md#processing-tools)).

## Sky, sun and water

Click **Sky and time** (**Environment and time of day**) in the island's **View** group (3D only):

- **Backdrop**: **Sky** (daylight from the real sun over the site) or **Studio** (a neutral dark backdrop for a single asset).
- **Time of day** slider and **Date**. **Capture time** jumps to when the data was captured; **Now** to the present.
- **Water** on or off and its **Level**, when the site has a sea level.
- **Project defaults** puts everything back.

Your choices are remembered per project.

## See inside the asset

For tanks, vessels and buildings flown inside, click **See inside** in the island's **View** group (**C**):

- **Off**: the asset is solid. Nothing is cut automatically.
- **Cut**: cuts the asset open toward you, at the drone while it is inside.
- **Transparent**: draws the asset see-through; set **Opacity**.

Point clouds hide while Cut or Transparent is on. **Inside view** flies behind the drone and looks where it looks.

## Video and the drone

Projects with video have a **Timeline** at the bottom. The **Timeline** tile in the island's **View** group shows or hides it; it has no key.

1. Click a clip bar on the timeline: the clip is selected and the playhead goes to that point. It does not play yet: **Space** (or the play button) plays and pauses, and playback runs on to the next clip of the same date. **Previous clip** and **Next clip** step through the clips.
2. The video window floats over the stage. Drag it by its title bar, resize it from the edges (it keeps 16:9), double-click the title to reset. **Dock beside the stage** docks it beside the view, with a divider between them: drag the divider, or focus it and use the arrow keys, to share the stage, and double-click it to reset. In the docked window's header, **Dock the video at the bottom** puts it under the view instead, and **Dock the video at the side** back beside it; on a narrow stage (a wide tab in front of the right panel) it docks under the view. **W** hides it.
3. **P** shows the flight paths (**All**, **Active clip** or **Off**).
4. **Follow the drone** keeps the drone in view. **Drone eye (through the camera)** looks through the drone's camera, so the video lines up with the model.

In the video window: **K** or **Space** pauses, **L** plays (press again for faster), **J** slows down, **,** and **.** step one frame.

On the timeline, the wheel scrolls along it and **Ctrl** with the wheel zooms at the pointer; **Zoom in**, **Zoom out** and **Fit** are in its header. The rate button cycles from 0.25x to 8x.

### One lane per survey date

In a project with video and survey dates (road surveys aside), the timeline has one lane per survey date, all on one time-of-day axis in site time (the header shows, for example, "site time ≈ UTC+3"), so flights flown at the same hour on different days line up.

- The lane of the date you are viewing is bright and tall, with clip names, issue diamonds, photo ticks and camera direction keyframes. The other lanes are dimmed and show a faint playhead at the same time of day.
- The date you view and two dates either side are shown. The others fold into **+2 earlier** or **+3 later**; click one to unfold that side.
- Clips that overlap on one date stack in rows. A date without video keeps a thin lane with its photos and issues.
- Click a date's label, or drag in its lane, to view that date. The time of day stays: if the new date has a clip at that time, it is selected, ready to play.
- The date you view sits in the top left corner of the timeline, and in the island. Click either for the calendar; **Alt ←** and **Alt →** step through the dates as before.
- The **Timeline** tile in **View** folds the timeline away and brings it back. The date stays in the island.

Projects without video, and road surveys, have the single timeline, and their date is in the island.

<!-- screenshot: timeline-date-lanes.png | Scene in a demo project with video on three or more survey dates: the lane timeline at the bottom with the bright focused lane, dimmed lanes with ghost playheads, a "+N earlier" fold and the date button in the top left corner -->

### Drone telemetry

**D** or the telemetry button turns it on and off (on by default):

- The flown path is solid up to the playhead, dashed after it.
- A shadow track on the ground with drop lines, and distance ticks from START.
- The readings are not drawn on the model: while the clip plays, the island shows its altitude and speed beside the date (for example "ALT 31 m · SPD 3.2 m/s"), and the player card of the **Video** workbench shows them too.

## Photos and panoramas

- Photos show as small rounded squares with a camera; panoramas as circles. Photos taken within 1.5 m share one marker with a count.
- Hover a marker for the count and the time span. Click it to open the photo; click a merged marker for a list with thumbnails.
- A panorama opens in an immersive view. The arrow keys look around; **Esc** or **Back to 3D** leaves.
- **Media** lists every flight, clip, photo set and panorama set. See [Media and findings](05-annotation-and-issues.md#media-and-findings).
- On the map, photos and 360s show as the same markers as in 3D. Hover one for its thumbnail. Click a photo to open it beside the map, or click a 360 to enter it with the 3D view beside the map.

## Photos and 360s without GPS

A ground photo or a 360 taken without GPS still comes in. Its Media tile says **Not placed** until you pin it on the site.

### Import

- **Add data** finds 360s by their shape (an image twice as wide as it is high). If some have no GPS, the offer says so: they import as not placed, ready to pin. A 360 with no GPS imports on any project, including one with a plain site grid. A 360 with GPS, and drone spheres to stitch, are placed on the map, so they need a coordinate system given as an EPSG code; on a site grid the import lists them as needing one and leaves them out.
- Insta360 `.insp` stills import like JPEGs. A still the camera has not stitched yet is two fisheye circles, not a 360. It is left out, and the offer says why: export it as a 360 photo from Insta360 Studio first, then add the exported file.

### Place on site

1. Right-click the photo or 360 (its Media tile, its row, or its marker) and choose **Place on site**. A click on an unplaced 360's Media tile does the same. A strip at the bottom of the scene says what to click next.
2. Click where it was taken: on the model, the point cloud or the map. The pin sits on the surface you clicked, and the camera sits **Eye height** above it (1.6 m unless you change it on the strip). On the map with no model under the point, the strip says the height is unknown and the pin sits at 0 m.
3. For a 360, line it up with landmarks. The 360 opens beside the view. Click a landmark in the 360, then the same landmark in the 3D view or on the map. One pair lines it up. A second pair refines it (the two are averaged). If the two pairs disagree by a lot, the first one is kept and the strip says so.
4. For a photo, click the direction it looks, or press **Done** to leave it without one. In 3D you can also drag the pin's arrow to turn it.
5. **Done** ends placing. Each click saves straight away. **Cancel** or **Esc** keeps what is saved.

A pinned 360 that is not lined up yet says **Not lined up yet** on its tile. Once placed, a photo or 360 has a marker like any other: hover for a preview, click to open.

### Move, turn or remove a pin

Right-click the pin (in 3D or on the map) or the tile:

- **Move pin**: click the new place. The heading stays.
- **Set direction**: line a 360 up again, or aim a photo again.
- **Remove pin**: the item is **Not placed** again. A photo or 360 that came with GPS goes back to its GPS place and direction.

### Treat as 360, Treat as photo

A photo whose image is twice as wide as it is high shows **Looks like a 360** on its tile. **Treat as 360** (on the tile or in the photo's menu) moves it to the 360s of its survey date. **Treat as photo** on a 360 moves it back. The file stays where it is, and a pin goes with it. Neither is offered in a package. A photo with marks on it must have them removed first, and a stitched drone panorama cannot become a photo.

## Edit a photo's position

A photo that came in at the wrong place or height (a drone whose altitude reading is off, for example) can be moved by typing where it should be. The photo file and its imported position are never changed: the edit is kept beside them, the photo shows **Edited**, and **Reset to original** puts it back.

1. Right-click a photo (its Media tile, its marker in 3D or on the map) and choose **Edit position**. The panel shows **X east**, **Y north** (site metres from the project origin) and **Z height** (in the project's height system), and the original values under them.
2. Type the new values and press **Save** (or **Enter**). The marker on the map and the camera in 3D move, and the tile shows **Edited**. **Esc** or **Cancel** leaves the photo as it was.
3. To move many photos together, pick them in Media first: **Ctrl**-click adds or removes a photo, **Shift**-click adds the range up to it. Right-click one of the picked photos and choose **Edit position**. The panel says "Shift N photos": the values you type are added to every picked photo, so they keep their spacing. Type only the axis you need (for example Z 46 to raise them all 46 m); an empty field counts as 0.
4. The notice after a save has **Undo** (and then **Redo**); **Ctrl+Z** and **Ctrl+Y** work while it shows.
5. **Reset to original** (on the photo's menu, or on the panel of an edited photo) puts it back where it was imported. A direction set with **Align photo to map** stays.

A pinned photo cannot be edited this way (its pin is its place: use **Move pin**), and neither can a photo that is **Not placed** (use **Place on site**). 360s are not covered yet. Processing uses the edited positions: the photos go to the photogrammetry run at the place you gave them.

### Re-read photo positions

Projects imported with an older build may hold drone photos at the wrong height and without a view direction (DJI Zenmuse XT2 photos in particular). Right-click the photos dataset in the sidebar and choose **Re-read photo positions**: heights and view directions are read again from the photo files. If the project's copies carry no metadata, it asks for the folder with the original photos. Photos you moved by hand stay where you put them. A photo you turned with **Align photo to map** keeps its turn, which now applies on top of the re-read view direction, so check its direction afterwards. The notice says how many were re-read. Running it again changes nothing.

### Thermal photos placed at their visual twin

A thermal photo (a name ending `_R`) that carries no drone metadata takes the place and view direction of its visual twin from the same capture: the photo numbered one after it (or one before), taken within 3 seconds. It shows **Edited**, and **Reset to original** puts it at the place its own file gives. A thermal photo with no twin keeps its own place, and the import says to check it.

## Analyse thermal photos

Radiometric photos from a drone's thermal camera carry a temperature for every pixel. {product} reads two kinds: FLIR-core cameras such as the DJI Zenmuse XT2, and the DJI thermal cameras that DJI's Thermal SDK reads (such as the H20T, H30T, M30T, Mavic 3T and Matrice 4T).

1. Right-click a photo set that holds thermal photos (its row in the sidebar), or a thermal photo, and choose **Analyse thermal**. The **Thermal** tab opens in the right panel.
2. The first time, **Reading temperatures of** a number of photos shows while {product} reads them. This needs processing tools 0.22.0 or later (**Settings**, **Processing tools**).
3. Point at the photo: the temperature under the pointer shows beside it, in °C to one decimal.
4. Under the photo, the palette bar shows the colours from the coldest to the hottest temperature in view. Pick another palette (**Iron**, **Rainbow**, **White hot**, **Black hot**, **Arctic**), or **Auto range** to fit the colours to this photo again.
5. The line under it gives the settings the temperatures are worked out with: emissivity, distance, air temperature and humidity. **Edit** changes them, with the reflected temperature too (the same as the air unless you set it). Save with **This photo**, the photos you marked in the filmstrip, or **Whole dataset**; those photos are read again with the new settings.
6. The filmstrip at the bottom lists the set's thermal photos only, not their visual twins. Click one to show it; **Ctrl** and a click marks it for **Edit**.

Unless you change them, the settings are emissivity 0.95, the drone's height above its take-off point as the distance (10 m when the photo does not say), air 25 °C and humidity 50 %.

A photo {product} cannot read reliably shows no temperatures, only why: a camera it does not support shows as an ordinary photo, and temperatures that do not match the reference tool or are outside physical limits are held back. In a package, or when you may only look, the tab shows the temperatures already worked out and says **Open the project folder to analyse thermal photos.**

The settings and temperatures are kept in the project's `thermal/` folder. The temperatures can always be worked out again from the photos.

## The right panel

The right panel (the right sidebar) is the workbench: one row of tabs over the front tab's content, and the AI agent below it.

- **The tabs.** From the left: what is live (a measurement being drawn, the annotation tools, the playing clip, the jobs running), each with a small dot; the workbench or panel you opened from the island; then **Selection**, **Issues**, and on the projects that have them **Volumes** and **Changes**. A tab that does not fit goes into the **More tabs** menu at the end of the row; its count says how many are there.
- **Following what you do.** A tool you start brings its tab to the front: **M** opens **Measure**, **A** opens **Annotate**. Picking an issue shows its card in **Selection**, and **Show changes** brings **Changes**. While an issue's **Edit issue** form is open, a tool that starts does not take the front from it: its tab waits beside it with its dot, and you click it when you want it. When the tool stops, the tab it opened closes again.
- **Pin.** A workbench or panel opened from the island replaces the one opened before it, and closes when a tool starts. **Pin** on its tab keeps it: a pinned tab stays until you close it with its **X**, and it is there again the next time you start {product} on this computer.
- **Sections.** A workbench is made of sections with a title and a count; click a title to fold it. **Collapse all** at the top folds every section, and **Expand all** opens them again. The open sections are remembered per workbench on this computer. In **Measure**, **Search tools** keeps only the tools whose names match, for example "slope" leaves **Grade and slope** under **Line**.
- **Width.** Drag the panel's inner edge to make it wider or narrower; it keeps that width the next time. **Volumes** and **Changes** open at least 470 px wide while they are in front, so their tables fit.
- **The agent.** It sits below the workbench. While the AI is off it is one row, **Agent off · Turn on**. **Maximise** in its header gives it the whole panel; **Restore**, or a click on a tab, brings the workbench back. **Minimise** folds it to one line, **Ask about** and what is in view; click the line to open it again. Drag the divider between the workbench and the agent to share the height; a double-click on it goes back to the usual share. While a tool is live the agent folds to its line, unless you have sized it.

The tab on its left edge, **Ctrl Alt B**, the right-panel button at the top right of the stage or **Right panel** in the island's **View** group folds the panel away and brings it back; folded, the panel is a thin strip at the edge of the window, a click on the strip opens it, and the right-panel button sits to the left of the window's own buttons. **Ctrl J** opens the panel and puts the cursor in the agent. The 3D view, the map and the video take the room. Picking an issue or clicking **Show changes** opens the panel again, because they show their result there; selecting a layer does not.

**The drawer.** With the panel folded, a tool you start, or a workbench you open from the island, slides its tab in over the right edge of the view as a drawer, without the agent. The panel stays folded and the view is not resized. **Esc** slides the drawer out, and it goes by itself when the tool ends.
