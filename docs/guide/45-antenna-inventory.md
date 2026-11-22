# Antennas

**Detect antennas** finds the antennas on a telecom tower in its point cloud and measures each one: direction, downtilt, lean, size and position. The result is the **Antennas** list, which you review, correct and export as a CSV file. **Coverage** then plans sectors from the accepted antennas (see [Coverage](47-coverage.md)).

Use it on a tower project that has a point cloud. The tower must be a monopole or a lattice tower. Detection is not offered while the project has no point cloud, or in a read-only package.

The Telecom tools are part of **Telecom towers** and **Data fusion** projects, and of any project that already holds antennas. In another project, turn **Telecom** on in **Settings**, **Project settings**, **Tool sets** (see [Tools by project type](08-building-projects.md#tools-by-project-type)).

## The Antennas list

The list is the **Antennas** group of the right sidebar's **Project** tab, under **In this project**, with the number of units beside its title. A tower project lists **Antennas**, **Sectors** and **Coverage plan** there.

- The filter tabs are **Draft**, **Accepted**, **Rejected** and **All**.
- Each row shows **ID**, **Kind**, **Az °**, **Downtilt °**, **Alt m** and **Status**. A line above the rows says whether the azimuths are **True north azimuths** or **Project north azimuths**.
- Clicking a box in the 3D view selects its row. The details of the selected unit open inline under its row.
- The group header has **Flag antenna**, and **Hide all** or **Show all** for the boxes in the 3D view.
- Messages about the list show in the group, above the rows: a delete, save or flag that failed, a file that changed on disk, and the run's **Warnings**.

## Detect antennas

With an empty list, the group reads **No antennas yet** with a **Detect antennas** button. The same button is in the right sidebar's **Tools** tab, in **Measure**, under **Telecom**. Both start the same job.

1. Click **Detect antennas**. To choose the point cloud, use **Detection options** in **Tools**, **Measure**, **Telecom**, and pick the **Point cloud**, or leave it on **Automatic**.
2. Follow the progress in the jobs indicator. The button is greyed, with the reason, while a detection or a flag job runs.
3. If the app cannot tell which structure is the tower, it asks **Which one is the tower?** Click the tower once in the 3D view. Detection then runs again. **Cancel** stops it.

The measuring runs on this computer, in the processing tools. The point cloud is never sent anywhere.

If nothing is found, the list reads **Nothing found**: check the warnings, or outline a missed unit with **Flag antenna**.

## What a unit shows

| Value                             | Meaning                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Azimuth**                       | Clockwise from north, in the direction the front face points away from the tower. True north first, then grid.                                |
| **Downtilt**                      | The tilt of the unit itself below horizontal. Positive means the beam points down. Electrical tilt is inside the antenna and is not measured. |
| **Plumb**                         | Sideways lean of the unit from vertical. Positive means the top leans right, seen from the front.                                             |
| **W × H × D**                     | In metres: across the face, along the long axis, and front to back.                                                                           |
| **Centre altitude**               | Height of the box centre in the project's vertical datum, with the layer's height offset applied. The list's **Alt m** is the same value.     |
| **Elevation angle**, **Diameter** | For a dish: where it points (positive up) and its diameter. A dish has no downtilt or plumb.                                                  |

- **North.** Azimuth is given as **True** and **Grid**. When the project has no coordinate system, only **Project north** is shown, and coordinates are local metres from the project origin. Magnetic north is not available.
- **Basis.** Each value is marked **Measured**, **Observed**, **Inferred** or **Entered by you**. Hover a value to see the fit: the fit residual in millimetres, the number of points and how much of the face has points.
- **Missing values.** A value the app could not measure reads **Not measured**. A field you can type and have not reads **Not set**.
- **Kind.** The kind comes from the size of the unit (**from geometry**) unless you use **Label with AI** (**labelled by AI**) or pick one yourself (**entered by you**).
- **Other equipment.** Small radio units and similar equipment are listed with size and position but without angles.
- **Photos.** The details show the photos that see the front of the unit, with **Open full photo**. If none does, they say **No photo sees this unit.** Whether something stands in the way of the view is not checked.
- **Model, weight, frequencies** opens the equipment fields: **Model**, **Weight (kg)**, **Frequencies** and **In service**.
- **Survey dates.** Positions are stored where the scanned survey date has them. When dates are lined up (see [Line up dates](15-imagery-and-surface-change.md#line-up-dates)), the boxes are drawn where that date is drawn, like its measurements.

## Review

Every unit starts as a **Draft**. Status is shown by outline style and a text chip, not by colour alone.

One rule holds on every route: a press sets the status, and a press on units that all have that status already returns them to **Draft**.

- **Accept** and **Reject** in the details.
- The **A** and **R** keys, while a unit is selected. They are listed in **Settings**, **Keyboard shortcuts**, under **Antennas, with a unit selected**, and in the buttons' tooltips.
- The bulk bar: tick several rows, then **Accept**, **Reject** or **Delete**.
- The right-click menu, on a row or on a box in the 3D view.

You can review while a detection runs: the job keeps your review when it writes the list. Running detection again keeps your review too. A unit you accepted or edited that the new run no longer finds stays in the list as **Not found in latest run**.

The right-click menu also has **Edit azimuth**, **Edit downtilt**, **Redraw outline**, **Fly to**, **Hide** or **Show**, **Show only this kind**, **Delete** and **Open in Coverage**. **Open in Coverage** opens the Coverage tab on that unit, where its RF settings are.

## Correct a unit

- **Type a value.** Type an azimuth or a downtilt in the row, or use **Your values** in the details for the azimuth, downtilt, **Centre altitude (m)** and size. Press Enter and the box turns or resizes to match. Both places write the same value. A typed value is marked **Entered by you** and wins over the measured one. The typed azimuth is in true north when the project has a place on the Earth, so the app knows the grid convergence, and in project north otherwise.
- **Reset to measured** sits beside each typed value. It clears your value, so the measured one shows again, and the box is rebuilt. It is hidden when nothing was measured, as on a **Not measured** unit.
- **Kind** in the details changes the kind. Your pick is marked **entered by you** and stays when the project is opened again.
- **Redraw outline** draws the outline again and measures the unit again from the new points. It keeps the unit's name, status and the values you typed. A detected unit you redraw becomes a flagged one, so later runs keep your outline. Started from the right-click menu, it opens the Antennas group if it was folded, and **Cancel** always ends it.

Once you type any value on a detected unit, later runs keep its whole box as it is; use **Redraw outline** to measure it again.

## Delete and Undo

**Delete** removes a unit, detected or flagged. It is in the row's right-click menu, in the details, in the bulk bar, and on the Delete key. It always asks first, and says when the unit is in a sector of the coverage plan. A deleted unit stays gone when **Detect antennas** runs again. To keep a unit listed but out of the export, use **Reject**.

After a delete a notice says what was deleted, for example **A3 deleted**, with **Undo** and **Dismiss**. **Undo** brings the unit back whole: its place in the list, its photo crop, its sector in the coverage plan and its RF settings, and a later detection does not add a second copy. Once that delete is undone, the notice offers the one before it, up to 10 deletes back. Delete and Undo are greyed while a detection or a flag job runs.

## Flag a missed unit

When detection misses a unit, outline it yourself. **Flag antenna** is in the header of the **Antennas** group. It is greyed, with the message **Run antenna detection first**, until detection has run on the project, because the outline is measured against that run's tower axis.

1. Turn the 3D view to the unit and click **Flag antenna**.
2. Click around the unit on the point cloud. Enter or double-click closes the outline, Backspace removes the last point, Escape cancels.
3. The points kept light up and the bar says how many, nearest the camera. Only the near side is kept, so the far side of the tower is left out.
4. Click **Measure**, or **Draw again**. The jobs indicator shows the job. The unit joins the list, marked **Flagged by you**, with its measured box.

Outline the whole unit. An outline round the whole unit is measured even for a small radio, but a thin strip across only part of a unit can still come out **Not measured**. A unit with too few points gets a small box where the outline's middle meets the point cloud and reads **Not measured**. It has no made-up numbers, so type the values you know.

Flagging works on the point cloud and survey date shown in the tower view, and it runs on this computer with no network.

## Resize a box with the handles

When an antenna is selected in the 3D view, a small arrow shows at the centre of each face of its box, pointing out. An arrow grows when you hover it.

1. Drag an arrow to move only that face. The opposite face stays where it is.
2. A chip by the cursor shows the size being changed, for example **H Height 1.66 m**. The smallest size a drag allows is 5 cm.
3. Press Escape while dragging to put the box back.
4. Let go. The antenna is measured again from the points inside the new box, like **Redraw outline**, which can also correct its direction and tilt. A notice says when it is done.

- The face you dragged stays where you let go. If the points measure more than 2 cm smaller than you dragged it, your size is kept as an **Entered by you** value, and **Reset to measured** brings the measured one back.
- If the box holds too few points to measure, the box is kept as you drew it with its earlier angles, and the notice says so.
- A resized unit becomes a flagged one, so running **Detect antennas** again keeps it. Its name, status and typed values stay.
- There are no handles on dishes (use **Redraw outline**), in a read-only package, while detection or a flag job runs, or while **Flag antenna** or **Redraw outline** is drawing.
- A resize has no Undo. Use **Reset to measured** or drag the face back.

## Labels in the 3D view

**Labels** in the 3D view has **Off**, **Selected** and **All**. A selected unit shows its name with its centre altitude (for example **A14 · alt 30.0 m**), its azimuth and downtilt, and its sizes. A dish shows one label, its diameter, and no width, height or depth. The figures are the same, with the same decimals, as in the list.

## Label with AI

By default the kind comes from the geometry, and everything works offline. **Label with AI** in **Detection options** is off until you switch it on, and it needs AI settings that allow a vision model and the project's photo consent.

Before anything leaves the computer, a preview shows **Send photo crops for labelling** with the number of crops and the provider. Those crops are the only thing sent. You can allow photos of this project for this request only, then **Send**. If a requirement is not met, the run continues without AI and says **AI labelling skipped** with the reason.

The AI only sets the kind. It never changes a number.

## Measure by hand

Three hand tools measure one antenna at a time. They are in the right sidebar's **Tools** tab, in **Measure**, under **Telecom**, and work on point clouds and meshes in 3D; heights come from the picked surface. Each saved measurement is listed under **Project**, **Measurements**, apart from the Antennas list, with the tool's name.

- **Antenna azimuth**: pick three points along the top or bottom edge of the antenna's front face. Check the facing arrow, and use **Flip direction** if it points into the tower. The azimuth is clockwise from project or grid north. Grid north follows the project's coordinate system and is not true north; without a coordinate system project north is local.
- **Physical tilt**: pick the bottom and the top of one straight antenna edge. It is an unsigned lean from project vertical: 0 degrees upright, 90 degrees horizontal. It is not the list's **Downtilt**, which is signed (positive down) and measured from horizontal, and it is not electrical tilt.
- **Clearance**: pick two endpoints across a gap. It reports the direct 3D distance, the horizontal separation and the vertical gap between those two points only; it does not check that the space between them is free.

While picking, **Undo last point** and **Cancel** work, and the bar shows how many points are picked. **Save measurements** keeps them. **Edit endpoints in 3D** moves a picked point, and **Endpoint coordinates** lets you type its E, N and Z.

## Export

In the **Measure** tools, open **Site data** and click **Export antennas (CSV)**, next to **Export survey data**. **Export CSV** writes the accepted units. Tick **Include drafts** to add the drafts too. Rejected units are never written.

The E, N and Z in the CSV, and in a unit's details, are in the survey date's own coordinates, before any line-up. When dates are lined up, they can differ from where the box is drawn.

## The engineering model

The antennas in an engineering model (see [Engineering models](44-engineering-models.md)) are still approximate and are separate from this list. The list is measured; the engineering model does not read it yet.

## Known limitations

- It needs a tower axis (monopole or lattice). Rooftop and water-tower sites are not supported yet.
- On lattice towers, antennas facing more than 60 degrees away from straight out are listed as other equipment.
- Small radio units are listed as other equipment without angles and may be missed, in particular one a few centimetres from a ring or frame member. Flag it with an outline round the whole unit.
- Units side by side with no gap between them can come out as one wide unit.
- Units narrower than 0.2 m or thinner than 0.08 m are listed as other equipment, without angles. A narrow part longer than 1.5 m, or one fixed to the shaft, is taken for the structure (a pole, a frame member, a cable run) and not listed.
- Candidate boxes that are left out but could be equipment (side faces, patchy fronts, boxes overlapping other units) are counted in a warning for the run. Parts too big or too small for equipment, poles and frame members are left out without a warning.
- On sparse clouds (about 600 points per square metre of face) plumb and a dish's azimuth are less certain: within 2 and 1.5 degrees on synthetic towers, against 1.5 and 1 degree on denser clouds.
- Crops allow for a few degrees of error in a photo's recorded pose; a larger error can still cut a unit off at the crop edge.
- A dish bolted to a thick member (radius 0.1 m or more) may be missed.
- Plumb on narrow faces is less certain than azimuth.
- Accuracy has been checked on synthetic towers only, not yet against a real tower with known values.
- Magnetic north is not available, and electrical tilt is not measured.

The full list is in the known limits that come with the app's documentation.
