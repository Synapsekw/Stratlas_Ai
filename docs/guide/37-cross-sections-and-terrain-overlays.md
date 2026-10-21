# Cross-sections and terrain overlays

## Cross-sections

In the **Measure** workbench, draw a line with **Line**, **Cross-section**. The section opens docked under the view.

- Under **Surfaces**, tick the surveys and design surfaces to show; each gets its own coloured line.
- Click the chart to add a pin. Each pin lists every surface's elevation at that chainage, the difference ("Δ") to the surface you click, and the grade in degrees, percent and ratio.
- **Exaggeration** stretches the heights from 1:1 to 1:20.
- **Shade** fills the cut and fill between two of the lines.
- **Enable cutaway** cuts the 3D view along the line.
- The maximise button opens the section in a large window; **Esc** returns to the dock.

**Download** saves the section as **DXF 2D (XZ plane)**, **DXF 2D (XY plane)**, **DXF 2D (YZ plane)**, **DXF 3D (Z up)**, **DXF 3D (Y up)** or **CSV**, with one layer per surface and the chainage and elevation text.

### The profile and section chart

A cross-section, a line's profile on its card and the section line of a stockpile project are drawn on one chart:

- **Chips** above the chart (on a cross-section and on a line's card) switch each survey and design on and off; **+ Add survey or design** adds one. The current survey is a solid line, earlier surveys are grey and designs dashed.
- **Shade vs** shades the cut and fill between the current survey and the line you pick, and prints the cut and fill areas under the chart. **None** turns the shading off.
- Hover the chart, or focus it and use the arrow keys, for a readout at that chainage: each line's elevation, the difference and the grade. **Esc** clears it.
- **Export** saves the chart as **PNG**, **DXF** or **CSV**, and **Add to report** puts the measurement on the report list (see [Survey reports](41-survey-reports-and-template-sets.md#add-to-report-and-the-report-template)).
- Numbers follow the site's units and number style, as on the cards.

### Sections along an alignment

With an alignment active (see [Designs, alignments and compliance](38-designs-alignments-and-compliance.md)) and a section open, **Stations of the active alignment** cuts sections across the alignment: set **Every (m)**, **Left (m)** and **Right (m)**, click **Section at stations**, then step with **Next** and **Previous**.

## Terrain overlays

In the **Measure** workbench, **Site data**, **Terrain overlays** opens the **Terrain overlays** tab of the right panel. It makes overlays from a prepared survey, or from the difference to another survey (**Difference from**):

- **Contours**: **Minor (m)** and **Major (m)** intervals;
- **Gradient**: shown as **Degrees (0, 30, 45, 60)**, **Percent** or **Ratio 1:n**;
- **Elevation**: an elevation ramp, smooth or **Stepped colours**, over a range you type or the whole surface;
- **Shaded relief**: **Sun azimuth**, **Altitude** and **Intensity**.

Click **Make overlay**. The overlay is listed under **On this site** with its legend, a switch to show it and a remove button. Overlays draw on the map; open the **Map** view to see them. Contours can also be exported as DXF, shapefile, GeoJSON or KMZ (see [Exports to Civil 3D, TBC and 12d](39-exports-to-civil-3d-tbc-and-12d.md)).

Contour intervals and ranges are typed in metres, whatever the site's units.
