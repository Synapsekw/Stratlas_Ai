# Volumes, bases and comparisons

Every polygon can hold one or more comparisons, each from one surface to another. The same engine serves stockpiles, earthworks to design and landfill airspace.

## How a volume is computed

A comparison takes the height difference **To** minus **From** over the polygon. Where **To** is higher it is fill, where it is lower it is cut. **Net** is fill minus cut and **Total** is fill plus cut. Cells at the polygon's edge count by the share of the cell inside it. Where either surface has no data, the area shows as **Not covered**: a comparison that is partly outside the survey says so, and one mostly outside it is refused.

Surveys are prepared once as height tiles. If a comparison says "No survey surface is prepared yet", click **Prepare surfaces** and wait for the job in **Jobs**.

## Add a comparison

In a polygon's panel, open **Comparisons** and pick **From** and **To**:

- **Surveys**: **Current survey** (the date you are viewing), **Previous survey**, or any prepared survey;
- **Designs**: any design surface layer, with its vertical offset;
- **Bases**, computed from the polygon:
  - **Reference level**: a typed level, or **Set to highest** and **Set to lowest** along the perimeter;
  - **Smart (triangulated perimeter)**: a triangulated surface through the perimeter;
  - **Best-fit plane**: a plane fitted to the perimeter;
  - **Mean perimeter level**: a flat level at the mean perimeter height;
  - **Custom base (edit vertices)**: your own level or offset at each vertex, in **Custom base vertices**; select several and move them together, or set them all to one level.

The swap button exchanges **From** and **To**. At least one side must be a surface; with no survey on either side the panel warns "No reference to current terrain". **Add a comparison** adds another item: a landfill lift, for example, against the previous survey, an older survey and the cell design at once.

Results show **Cut**, **Fill**, **Net**, **Total** and the area of each. They update live while you edit the polygon. When a surface, offset, base, deadband or calibration changes, the result shows **Stale, recompute** until you click **Recompute**.

## Heat maps and the deadband

**Heat map of the difference** shows the change **On the terrain (3D)**, **On the map (2D)** or as **Contours**. **Colours and stops** sets the colour stops, smooth or **Stepped colours**, and **Invert colours**.

Stops either side of zero make a deadband: small changes inside it are left clear. They still count in the volumes unless you tick **Use deadband in calculations** in the comparison, and the result then says "Deadband used".

## Materials and calculators

**Materials** opens **Site materials**: each material's name, code, density in t/m³ and its loose and compacted factors, with **Import CSV** and **Export CSV**.

In a polygon's **Material and calculators**, pick the material and which volume to use (net, fill or cut). The panel shows the volume as bank, loose and compacted, and the weight. Type a **Weighed tonnage (t)** to get the **Achieved density**: 63,000 t over 70,104 m³ is 0.899 t/m³. Calculators are for display only; the stored volume never changes.

## Several measurements at once

Select several measurements in the list: the totals add their comparisons up. **Change for all** sets one surface or base on every selected measurement, and the unit choices apply to all of them.

## Whole site cut and fill

**Whole site cut and fill** compares two surveys or designs over their whole overlap in a background job. It then suggests cut and fill regions as drafts. **Keep** the ones you want: they become volume measurements in the folder "Whole-site regions".

**Snap to ortho edges** moves the ticked regions' boundaries to the edges seen in the ortho, with the same local model as **Suggest boundaries** ([Measuring and templates](35-measuring-and-templates.md)). A region is snapped only when the edge in the ortho matches it; otherwise it stays as it was, and the panel says why. Snapped regions are still drafts.

## Stockpile projects

Stockpile projects keep their four bases and their figures. In a pile's details, **More bases (survey engine)** adds the engine's bases as extra choices. The engine's smart base is a triangulation of the toe line, while the kit's TIN base is a smooth surface over the toe, so their figures differ. The register and the totals keep the four original bases.
