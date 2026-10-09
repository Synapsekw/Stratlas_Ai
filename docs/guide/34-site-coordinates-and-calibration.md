# Site coordinates and calibration

Every survey tool reads and writes coordinates the way your surveyor's controller does: in the site's grid, with its vertical datum and geoid, and with a local site calibration when the site has one. The data itself stays as it was delivered; the site settings decide how numbers are shown and exported.

## Open the site settings

The cursor readout at the bottom of the 3D view and the map has a small globe button, **Site settings**. The readout shows three lines:

- the **Site settings** button;
- the coordinate system with its EPSG code, the kind of heights (for example "orthometric, geoid AUSGeoid2020", "ellipsoidal" or "site calibration") and the unit;
- the coordinates under the pointer, for example "N 3 179 597.120 E 245 884.940 Z 12.300 m", in the order and precision you set.

If the readout says "Site tables are not prepared yet: showing project coordinates.", the site's coordinate tables are written the next time surfaces are prepared.

## Coordinate system and heights

In **Site settings**, section **Coordinate system**:

1. Type a name, a place or an EPSG code in the search box ("Search by name, place or EPSG code"). Each result shows its code, name and unit; withdrawn systems are marked "deprecated".
2. Pick the grid your surveyor uses. The units switch to that grid's unit: a US state plane zone in US survey feet gets US survey feet.
3. Choose **Heights**: **Project heights (as stored)**, **Ellipsoidal**, a geoid that is installed (for example "AUSGeoid2020 geoid"), or **Site calibration** once a calibration is applied. A geoid that is named but missing shows "(pack not installed)".
4. Choose **Distances**: **Grid** or **Ground**. A grid scale factor of 0.9996 is 40 cm per kilometre, so say which one you report.
5. **Save**.

Heights that need a geoid grid which is not installed are refused with the pack's name, never shown on the ellipsoid and never downloaded. Regional geoids (AUSGeoid2020, GEOID18, OSGM15 with OSTN15, NZGeoid2016, CGG2013a) come as optional geoid packs.

## Geoid packs

**Settings**, **Offline maps**, **Geoid packs** lists the geoid grids heights can use: EGM96 and EGM2008 from the pipeline pack (tagged **Pipeline pack**), and regional grids. Each row shows the **Region** it covers, the **Vertical datum** (an EPSG code, or "Not stated"), the **Licence**, the attribution and the size.

To add a regional grid, for example the geoid model of your country:

1. Click **Import geoid grid** and pick the grid: a GeoTIFF (`.tif`) or a GTX (`.gtx`) file in longitude and latitude.
2. Give it a **Name**, and state its **Licence** and the **Attribution** the licence asks for. **Import** stays greyed out until both are filled in. Add the **Vertical datum (EPSG)** if you know it, for example 5711.
3. Click **Import**: "... is imported. Site settings, Heights now offers it."

**Remove** (then **Remove** _name_ to confirm) deletes a regional grid. EGM96 and EGM2008 stay. Nothing is ever downloaded.

## Units and precision

Section **Units and precision** sets the site's **Distance**, **Area**, **Volume**, **Density**, **Mass** and **Grade** units, the **Order** (**North, East, Z** or **East, North, Z**) and the decimals for coordinates, distances, areas, volumes and grades.

The international foot and the US survey foot are different units: the readout writes "ft" for the international foot and "US ft" for the US survey foot. Values are always stored in metres; units only change how they are shown and exported. One measurement can have its own units (see [Measuring and templates](35-measuring-and-templates.md)).

## Import a site calibration

A site calibration ties the grid to the control on site the way the controller does: a projection, a horizontal shift, rotation and scale, and a vertical adjustment (a constant and an inclined plane).

1. In **Site settings**, section **Site calibration**, click **Import calibration…**.
2. Pick the controller job as Trimble JobXML (`.jxl`), or a text file with the parameters 12d reports (one key and value per line).
3. "Calibration read. Check the residuals, then Apply." The table lists each **Point** with its **H** and **V** residuals beside the controller's own (**Controller H**, **Controller V**), whether it is **Used**, and the **RMS**.
4. When the residuals match the controller's, click **Apply**.

Applying a calibration is recorded in the project history. Volumes, sections and other results computed before show **Stale, recompute** until you recompute them, so a number never changes silently. To use another calibration, **Remove calibration** first.

Trimble `.dc` files are not read: they have no public specification. Export the job from the controller as JobXML instead, or compute the calibration from point pairs.

## Compute from point pairs

When there is no controller file, compute the calibration from points measured both ways: their global position and their local site coordinates.

1. In **Site settings**, section **Site calibration**, click **Compute from point pairs…**.
2. Choose what the **Global positions** are: **WGS84 latitude, longitude, ellipsoidal height**, or **Grid N, E, Z in the site coordinate system**.
3. Type the pairs in the table (**Add a pair** adds a row), or **Import CSV**: one pair per line with a name, the three global values, then local N, E and Z, and optionally H and V (1 or 0). A header line is skipped; a header that names "latitude" or "grid" sets the global positions for you.
4. Clear **H** or **V** on a pair to leave it out of the horizontal or the vertical adjustment. The horizontal needs at least two pairs.
5. Click **Compute**. The residual table and **Apply** work as for an imported job; a computed calibration has no controller columns.

If the site's **Heights** use a geoid, WGS84 heights are taken to that geoid first, as a controller does.

> Check the residuals against the controller's before you apply. If they differ, the controller job may use a convention the importer did not expect; tell us which job it was.
