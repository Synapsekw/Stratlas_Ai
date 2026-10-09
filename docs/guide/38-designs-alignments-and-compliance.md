# Designs, alignments and compliance

Design surfaces, linework, points and alignments come from Civil 3D, Trimble Business Center, 12d or any program that writes LandXML, DXF, 12da or CSV points. The original file is kept with the project byte for byte and never changed.

## Import a design

**Site data**, **Designs**, **Import design**, and pick a LandXML (`.xml`), DXF, 12da or CSV file. The import runs as a job and the design appears in the list with its layers.

For more control, use **Jobs**, **New job**, **Import design**:

- **Format**, when the file name does not say it;
- **Design units**, when the file does not state them (metres, millimetres, centimetres, feet, US survey feet or inches). A DXF without drawing units is refused until you choose them;
- **Local coordinates**: **Place through the site calibration** for a design drawn in local site coordinates (apply the calibration first, see [Site coordinates and calibration](34-site-coordinates-and-calibration.md)).

Files that cannot be read safely are refused with the reason: DWG (save it as ASCII DXF), binary DXF, LandXML with a document type or entities, files over 500 MB, and Trimble TTM (no published specification; export the surface as LandXML from Trimble Business Center).

## The design list

Each design shows its name (click to rename), its source file to download, its format, units and placement, and its layers: **Surface**, **Linework**, **Points** and **Alignment**, with their counts.

- Tick a layer to show it, **Fly to** it, or **Archive** it (archived layers hide under **Show archived layers**; **Restore** brings them back).
- On a surface layer, **Vertical offset (m)** and **Apply vertical offset** lower or raise it, for example to subgrade or below the pavement depth. Results that use it turn **Stale, recompute**.
- On linework, **Clamp to terrain** drapes it on the survey.

Design layers are used in comparisons, sections, snapping, the station readout and exports.

## Cut and fill to design

In a polygon's **Comparisons**, set **From** to **Current survey** and **To** to the design surface layer. Fill is material still to place and cut is material still to remove: this is the remaining volume to design. With **From** the original ground survey and **To** the design, the comparison gives the full cut and fill of the design.

For a tolerance check, set the heat map stops to minus and plus your tolerance (for example 0.05 m) in **Colours and stops**: the area within tolerance is left clear. The survey report gives the share of the area within tolerance.

Design to design works the same way: pick a design layer on both sides.

## Alignments

On an alignment layer, **Activate alignment**. The cursor readout then adds the station and offset, for example "Sta 1+234.567 Off 2.500 R", or says when the pointer is off the alignment. **Station interval (m)** with **Set interval** sets the spacing of the stations. Station equations come from the LandXML file. Use the active alignment for sections at stations (see [Cross-sections and terrain overlays](37-cross-sections-and-terrain-overlays.md)).

Only horizontal alignments are read; vertical profiles are not.
