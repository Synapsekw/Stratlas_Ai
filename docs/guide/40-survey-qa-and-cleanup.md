# Survey QA and cleanup

**Site data**, **Survey QA and cleanup** checks a delivered survey before anyone reports from it, cleans up the terrain without touching the delivered data, and shows the surveys and the history of a point.

## Check against points

1. Open **Check against points** and pick the **Survey**.
2. Choose the **Checkpoints**: a **CSV file** of name, easting, northing and elevation (up to 10,000 points), the **Ground control of a processing run**, or **None (compare to the previous survey only)**.
3. Set the **QA level (site settings)**: **Strict**, **Moderate**, **Lenient** or **Off** (see the table below).
4. Click **Check the survey**.

| Level    | Checkpoint RMSE up to | Change since the previous survey      |
| -------- | --------------------- | ------------------------------------- |
| Strict   | 5.0 cm                | at most 50% of the area beyond 0.10 m |
| Moderate | 10.0 cm               | at most 60% of the area beyond 0.20 m |
| Lenient  | 20.0 cm               | at most 60% of the area beyond 0.40 m |
| Off      | no verdict            | no verdict                            |

The result shows the **RMSE**, **Mean**, **Largest** and how many **Points** were on the surface, a histogram, and each point's surface minus surveyed height (points over 10 cm are highlighted). It also gives the share of the area that changed since the previous survey.

## Surveys on hold

A survey that fails its QA level goes on hold. A banner over the view names it and the reason, and its measurements read "Survey on hold". Nothing is deleted.

To use the survey anyway, click **Review and release**, type a **Release note** (for example "checked against the GNSS log") and click **Release the survey**. The release, with your note and name, is recorded in the project history.

## Cleanup and crop

A cleanup replaces the terrain inside an area with a surface carried across from its edge, for example to remove a parked excavator. A crop cuts the surface to a boundary. Both write a new cleaned surface; the delivered surface stays as it is.

1. Open **Cleanup and crop** and pick the **Surface** (prepare it first if asked).
2. **Draw an area**, or use an existing polygon measurement: **Copy as cleanup** or **Copy as crop**. **Crop to another survey's extent** crops to the extent of another survey.
3. Choose how a cleanup is filled: **TIN (flat between the edge points)** or **Thin-plate (follows the curve of the ground)**. Untick an edit to leave it out.
4. Click **Make the cleaned surface**.

The cleaned surface is named after the survey with `-clean` at the end. Pick it in a comparison to use it; comparisons on the original are unchanged.

## Surveys and elevation history

**Surveys** lists the survey dates by year and month, newest first, with their QA status. Click one to view it. **Show hidden** also lists helper surfaces such as cleaned surfaces.

**Elevation history** shows the height of one point in every survey: type an easting and northing or **Use the selected point**, then **Show the history** for a chart and a table of the height and its change.
