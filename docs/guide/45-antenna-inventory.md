# Antenna inventory

**Detect antennas** finds the antennas on a telecom tower in its point cloud and measures each one: direction, tilt, lean, size and position. The result is an inventory you review, correct and export as a CSV file.

Use it on a tower project that has a point cloud. The tower must be a monopole or a lattice tower. The button is hidden while the project has no point cloud, and in read-only packages. For now it sits in the telecom measurement tools strip; it moves into the Measure tool bar and sidebar later.

## Run a detection

1. Open the project and go to the telecom measurement tools.
2. Click **Detect antennas**. If the project has several point clouds, open **Detection options** and choose the **Point cloud**, or leave it on **Automatic**.
3. Follow the progress in the jobs indicator (**Detecting antennas**). The button is disabled while a run is going and while the point cloud is still loading.
4. If the app cannot tell which structure is the tower, it asks **Which one is the tower?** Click the tower once in the 3D view. Detection then runs again. **Cancel** stops it.

The measuring runs on this computer, in the processing tools. The point cloud is never sent anywhere.

## Read the inventory

Units are grouped as **Panel antennas**, **Short antennas**, **Microwave dishes** and **Other equipment**. The summary line counts antennas, other equipment and units that need review.

| Value                       | Meaning                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Azimuth**                 | Clockwise from north, in the direction the front face points away from the tower. True north first, then grid. |
| **Downtilt**                | Mechanical tilt of the face below horizontal. Positive means the beam points down.                             |
| **Plumb**                   | Sideways lean of the unit from vertical. Positive means the top leans right, seen from the front.              |
| **Width, Height, Depth**    | In metres: across the face, along the long axis, and front to back.                                            |
| **Centre altitude**         | Height of the box centre, in the project's vertical datum, with the layer's height offset applied.             |
| **Centre E, N**             | Position of the box centre in the project coordinate system.                                                   |
| **Elevation**, **Diameter** | For a dish: the pointing elevation (positive up) and the diameter. A dish has no downtilt or plumb.            |

- **North.** Azimuth is given as **True** and **Grid**. When the project has no coordinate system, only **Project north** is shown, and coordinates are local metres from the project origin.
- **Basis.** Each value is marked **Measured**, **Observed**, **Inferred** or **Entered by you**. Hover a value to see the fit quality: the fit residual in millimetres, the number of points and the coverage.
- **Electrical tilt** is not measured. The downtilt is the mechanical one. Magnetic north is not available.
- **Type.** The type comes from the size of the unit unless you use **Label with AI**. **Type from geometry**, **Type labelled by AI** and **Type set by you** tell which.
- **Other equipment.** Small radio units and similar equipment are listed as **Other equipment** with size and position but without angles.
- **Warnings** lists anything the run wants you to check.

## Review

Every unit starts as a **Draft**. Status is shown by outline style and a text chip, not by colour alone.

- **Accept** and **Reject** set the status. **Show in 3D** and **Hide in 3D** toggle a unit in the 3D view.
- **Open details** shows all values and the equipment fields: **Model**, **Weight (kg)**, **Frequencies** and **In service**. Whatever you enter is marked **Entered by you**.
- Running detection again keeps your review. A unit you accepted or edited that the new run no longer finds stays in the list as **Not found in latest run**, so nothing you decided is lost silently.
- **Best photos** shows up to three photos that see the front of the unit. If none does, it says **No photo sees this unit.** Whether something stands in the way of the view is not checked.

## Label with AI

By default the type comes from the geometry, and everything works offline. **Label with AI** is off until you switch it on, and it needs AI settings that allow a vision model and the project's photo consent.

Before anything leaves the computer, a preview shows **Send photo crops for labelling** with the number of crops and the provider. Those crops are the only thing sent. You can allow photos for this request only, then **Send**. If a requirement is not met, the run continues without AI and says **AI labelling skipped** with the reason.

The AI only sets the type label. It never changes a number.

## Export

**Export CSV** writes the accepted units. Tick **Include drafts** to add the drafts too. Rejected units are never written.

## The engineering model

The antennas in an engineering model (see Engineering models) are still approximate and are separate from this inventory. The inventory is measured; the engineering model does not read it yet.

## Known limitations

- It needs a tower axis (monopole or lattice). Rooftop and water-tower sites are not supported yet.
- On lattice towers, antennas facing more than 60 degrees away from straight out are listed as other equipment.
- Small radio units are listed as other equipment without angles and may be missed.
- A dish bolted to a thick member (radius 0.1 m or more) may be missed.
- Plumb on narrow faces is less certain than azimuth.
- Magnetic north is not available, and electrical tilt is not measured.

The full list is in the known limits that come with the app's documentation.
