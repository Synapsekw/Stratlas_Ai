# Ground control and accuracy

Without ground control, a run is as accurate as the drone's GPS: a few metres for a standard drone, a few centimetres with RTK. Ground control points (GCPs) tie the model to surveyed coordinates. Checkpoints are surveyed points that are measured but never used to fit the model, so the accuracy report is honest.

## Import the points

1. In the wizard, tick **I have ground control points**, or open a run and click **Ground control**.
2. Choose the **GCP file**: a CSV or TXT of points, a Pix4D point file, or an ODM `gcp_list.txt`.
3. Map the columns (point name, easting, northing, height, and optionally the role and accuracy) and set the **Coordinate system of the file**. Set **Accuracy when the file has none (cm)**.
4. Set each point's **Role**: **Control** (used in the adjustment) or **Check** (measured only).
5. The points show on the map. Click **Save**.

## Mark the targets

Marking tells {product} where each target is in the photos. Open **Mark** on a point: the photos that should see it open with a dashed ring where the current model predicts the target.

- Click the centre of the target to place a mark, then press **Enter** to confirm it. Press **C** to confirm a predicted mark as it is.
- **S** skips a photo, **N** and **P** go to the next and previous photo, **+** and **-** zoom, **Esc** closes the marker.
- A point needs marks in at least three photos; the marker counts them, for example "3 of 3 marks confirmed".

Marks are saved in the run as you go. Photos stay where they are: when a run reads photos from folders outside the project, the marker opens them read-only from those folders.

## Adjust and read the report

Click **Adjust**. The adjustment fits the model to the control points; checkpoints are measured afterwards. The **Accuracy** report shows:

- **RMSE by role:** horizontal and vertical RMSE for control and for check points, against targets based on the ground sampling distance, with **Within** or **Outside** for each.
- **Residuals per point:** how far each point is from its surveyed position, its reprojection error in pixels, its number of marks, and whether it was used in the adjustment.
- Warnings, for example a control point that does not fit the others ("GCP6 is 1.0 m off") and is left out as an outlier, or photos that could not be aligned.
- The overlap map: how many photos see each part of the ground.

**Save as CSV** writes the residual table. **Issues**, **Export**, **Processing accuracy report (PDF)** writes the latest run's report as a PDF. The house report has a **Processing accuracy** section after **Site and data**, with the RMSE by role, the residuals per point and the warnings; turn it on or off in Settings, **Report contents**.

## Good practice

- Spread at least five control points around the edge and the middle of the site, and keep three or more checkpoints away from them.
- Use the same coordinate system and height datum as the survey.
- Mark each target in photos from different flight lines.
- If a point is named as an outlier, check its coordinates and marks before you disable it.
