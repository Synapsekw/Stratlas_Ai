# Designs, alignments and compliance

Design surfaces, linework, points and alignments come from Civil 3D, Trimble Business Center, 12d or any program that writes LandXML, DXF, 12da or CSV points. The original file is kept with the project byte for byte and never changed.

## Import a design

**Site data**, **Designs**, **Import design**, and pick a LandXML (`.xml`), DXF, 12da or CSV file. The options open under the button, filled from a quick look at the file:

- **Name**: the file's name; change it if you like.
- **Format**: **Automatic** says what the file was recognised as. Pick another only when the file name misleads.
- **Coordinate system of the file**: by default the CRS the file states, else the project's. Search by name, place or EPSG code to say the file is in another CRS: the design is moved into the project CRS on import. **Use the default** goes back.
- **Place it through the site calibration**, offered when a calibration is applied: for a design drawn in local site coordinates (apply the calibration first, see [Site coordinates and calibration](34-site-coordinates-and-calibration.md)).
- **Units**: when the file states its units (DXF drawing units, LandXML units) they are used and shown. When it states none, choose metres, millimetres, centimetres, feet, US survey feet or inches; a DXF without drawing units is refused until you choose them.
- **Layers to import**: every layer of the file, ticked. Untick the ones you do not want. For a file over 64 MB, type the layer names, separated by commas, or leave it empty for every layer.

**Import** runs the import as a job; the design appears in the list with its layers. **Jobs**, **New job**, **Advanced: run a pipeline directly**, **Import design** offers the same import as a job.

Files that cannot be read safely are refused with the reason: DWG (save it as ASCII DXF), binary DXF, LandXML with a document type or entities, files over 500 MB, and Trimble TTM (no published specification; export the surface as LandXML from Trimble Business Center).

## The design list

Each design shows its name (click to rename), its source file to download, its format, units and placement, and its layers: **Surface**, **Linework**, **Points** and **Alignment**, with their counts.

- Tick a layer to show it, **Fly to** it, or **Archive** it (archived layers hide under **Show archived layers**; **Restore** brings them back).
- On a surface layer, **Vertical offset (m)** and **Apply vertical offset** lower or raise it, for example to subgrade or below the pavement depth. Results that use it turn **Stale, recompute**, and the selected polygon is computed again.
- On linework, **Clamp to terrain** drapes it on the survey.

## Designs in the views

Every ticked layer is drawn in the 3D view and on the map, whether or not the Designs panel is open:

- surfaces as translucent triangles at their vertical offset (on the map, their outline);
- linework at its heights, or on the survey when clamped;
- points at their heights;
- alignments on the terrain, with a tick and a station label at every station interval.

Untick a layer to take it out of both views. Design layers are also used in comparisons, sections, snapping, the station readout and exports.

## Compliance to design

Select the polygon to check (for example the pad's outline), then **Designs**, **Compliance to design**:

1. **Design surface**: the layer to compare to.
2. **Tolerance, plus or minus (mm)**, for example 50.
3. **Cut/Fill to design** adds a comparison from the current survey to the design and computes it: fill is material still to place, cut is material still to remove. **Remaining to design** does the same but leaves out the area within the tolerance (the tolerance is its deadband), so it gives what is still to move.

Under the results, the comparison says how much of the area is within the tolerance, for example "87.5% in tolerance (plus or minus 0.050 m)", with the areas cut and fill beyond it. The survey report gives the same share.

With no polygon selected, the button asks you to draw the area first: click its corners, then **Finish** (or double-click). The new polygon gets the comparison.

You can also set up a design comparison by hand in a polygon's **Comparisons**: **From** **Current survey** and **To** the design layer. With **From** the original ground survey, it gives the full cut and fill of the design. Design to design works the same way: pick a design layer on both sides. For a tolerance heat map, set the stops to minus and plus your tolerance in **Colours and stops**: the area within tolerance is left clear.

## Alignments

On an alignment layer, **Activate alignment**. The cursor readout then adds the station and offset, for example "Sta 1+234.567 Off 2.500 R", or says when the pointer is off the alignment. **Station interval (m)** with **Set interval** sets the spacing of the stations and of the labels in the views. Station equations come from the LandXML file. Use the active alignment for sections at stations (see [Cross-sections and terrain overlays](37-cross-sections-and-terrain-overlays.md)).

Only horizontal alignments are read; vertical profiles are not.
