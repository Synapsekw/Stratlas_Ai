# Cross-sections and terrain overlays

## Cross-sections

Draw a line with **Line**, **Cross-section**. The section opens docked under the view.

- Under **Surfaces**, tick the surveys and design surfaces to show; each gets its own coloured line.
- Click the chart to add a pin. Each pin lists every surface's elevation at that chainage, the difference ("Δ") to the surface you click, and the grade in degrees, percent and ratio.
- **Exaggeration** stretches the heights from 1:1 to 1:20.
- **Shade** fills the cut and fill between two of the lines.
- **Enable cutaway** cuts the 3D view along the line.
- The maximise button opens the section in a large window; **Esc** returns to the dock.

**Download** saves the section as **DXF 2D (XZ plane)**, **DXF 2D (XY plane)**, **DXF 2D (YZ plane)**, **DXF 3D (Z up)**, **DXF 3D (Y up)** or **CSV**, with one layer per surface and the chainage and elevation text.

### Sections along an alignment

With an alignment active (see [Designs, alignments and compliance](38-designs-alignments-and-compliance.md)) and a section open, **Stations of the active alignment** cuts sections across the alignment: set **Every (m)**, **Left (m)** and **Right (m)**, click **Section at stations**, then step with **Next** and **Previous**.

## Terrain overlays

**Site data**, **Terrain overlays** makes overlays from a prepared survey, or from the difference to another survey (**Difference from**):

- **Contours**: **Minor (m)** and **Major (m)** intervals;
- **Gradient**: shown as **Degrees (0, 30, 45, 60)**, **Percent** or **Ratio 1:n**;
- **Elevation**: an elevation ramp, smooth or **Stepped colours**, over a range you type or the whole surface;
- **Shaded relief**: **Sun azimuth**, **Altitude** and **Intensity**.

Click **Make overlay**. The overlay is listed under **On this site** with its legend, a switch to show it and a remove button. Overlays draw on the map; open the **Map** view to see them. Contours can also be exported as DXF, shapefile, GeoJSON or KMZ (see [Exports to Civil 3D, TBC and 12d](39-exports-to-civil-3d-tbc-and-12d.md)).

Contour intervals and ranges are typed in metres, whatever the site's units.
