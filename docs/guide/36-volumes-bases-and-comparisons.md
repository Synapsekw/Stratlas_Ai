# Volumes, bases and comparisons

Every polygon can hold one or more comparisons, each from one surface to another. The same engine serves stockpiles, earthworks to design and landfill airspace.

## How a volume is computed

A comparison takes the height difference **To** minus **From** over the polygon. Where **To** is higher it is fill, where it is lower it is cut. **Net** is fill minus cut and **Total** is fill plus cut. Cells at the polygon's edge count by the share of the cell inside it. Where either surface has no data, the area shows as **Not covered**: a comparison that is partly outside the survey says so, and one mostly outside it is refused.

Surveys are prepared once as height tiles. If a comparison says "No survey surface is prepared yet", click **Prepare surfaces** and wait for the job: the island shows its progress beside the date, and the **Jobs** section of the right panel's **Project** tab lists it.

## Add a comparison

In a polygon's panel, **Comparisons** holds the volume card. Each comparison has a chip for what it is measured from and, unless it is a volume on a base under the current survey, a **To** chip:

- The first chip reads "Base: ..." or "From: ...". Click it for the seven bases, computed from the polygon (see [The base](#the-base)); **Previous survey or design** in that list opens the prepared surveys and the design surface layers, each design with its vertical offset.
- **To** lists the **Surveys** (**Current survey**, the date you are viewing, **Previous survey**, or any prepared survey) and the **Designs**.
- **Fixed level** shows its level field under the chips. **Custom** shows **Custom base vertices**: your own level or offset at each vertex; select several and move them together, or set them all to one level.

The swap button (**Swap From and To**) exchanges the two sides. One side must be a survey or a design, never a base on both; with no survey on either side the card warns "Neither side reads a survey". **+ Compare date** adds another comparison: a landfill lift, for example, against the previous survey, an older survey and the cell design at once.

Results show **Cut**, **Fill**, **Net**, **Cut and fill together** and the area of each. They update live while you edit the polygon. When a surface, offset, base, deadband or calibration changes, the result shows **Stale, recompute** until you click **Recompute**.

## Heat maps and the deadband

**Heat map of the difference** shows the change **On the terrain (3D)**, **On the map (2D)** or as **Contours**. **Colours and stops** sets the colour stops, smooth or **Stepped colours**, and **Invert colours**.

Stops either side of zero make a deadband: small changes inside it are left clear. They still count in the volumes unless you tick **Ignore changes smaller than** in the comparison; the line under the result then names it with its value.

## Materials and calculators

**Materials**, under **Site data** in the **Measure** section of the right panel's **Tools** tab, opens the **Volumes** section of the **Project** tab on its **Materials** pane: each material's name, density in t/m³ (from a survey date, with its history), its loose factor, its piles and tonnes, with **Import CSV** and **Export CSV** (see [The Volumes view](09-volumes-and-roads.md#the-volumes-view)).

In a polygon's **Material and calculators**, pick the material and which volume to use (net, fill or cut). The panel shows the volume as bank, loose and compacted, and the weight. Type a **Weighed tonnage (t)** to get the **Achieved density**: 63,000 t over 70,104 m³ is 0.899 t/m³. Calculators are for display only; the stored volume never changes, and a note under the field says "The weighed tonnage is not saved with the project."

## Several measurements at once

Select several measurements in the list: the totals add their comparisons up. **Change for all** sets one surface or base on every selected measurement, with the bases under the same names as on the card, and the unit choices apply to all of them.

## Whole site cut and fill

**Find cut and fill regions** ("Whole site cut and fill" until November 2026), under **Site data** in the **Measure** section of the **Tools** tab, compares two surveys or designs over their whole overlap in a background job. It then suggests cut and fill regions as drafts. **Keep** the ones you want: they become volume measurements in the folder "Whole-site regions". For the cut and fill totals between two surveys, use **Cut & fill** in the Volumes view ([The Volumes view](09-volumes-and-roads.md#the-volumes-view)).

**Snap to ortho edges** moves the ticked regions' boundaries to the edges seen in the ortho, with the same local model as **Suggest boundaries** ([Measuring and templates](35-measuring-and-templates.md)). A region is snapped only when the edge in the ortho matches it; otherwise it stays as it was, and the panel says why. Snapped regions are still drafts.

## The base

A volume's card names its base in a chip, for example "Base: Toe surface". Click it to pick another. A base has one name everywhere it is read: the card, the pile panel, **Change for all**, the inventory, the CSV files and the reports.

- **Toe surface**, the default, a surface triangulated through the toe line: the surveying norm for piles on uneven ground. Where a pile's edge runs along another pile's, that stretch is the saddle between the two heaps, not the ground, so the base stands on the rest of the toe there (the edge-based bases below do the same);
- **Lowest point**: bins, bunkers, piles against walls;
- **Best-fit plane**: a flat, level pad;
- **Fixed level**: a known floor height;
- **Average edge level**: a rough check against the toe's average height;
- **Previous survey or design**: the measured ground underneath, the most accurate when it exists;
- **Custom**: edit the base's points.

The volume, its volume over time and the totals follow. Next to a pile's volume, "±3% across bases" says how far the figure moves between the bases that suit a pile.

**Recompute** works the volume out again; "Stale, recompute" on a card means a surface, a base or the outline changed since. When a recompute cannot run, the card says why, for example while the volume engine is still starting, or when the outline has fewer than three points.

## Volume over time

A volume measurement with **Current survey** on one side has a volume on every survey date: the same comparison, worked out against each survey in turn. It shows in four places, with the same figures:

- **The card**: **Volume over time**, a chart and a table with the volume, the change since the previous date and, with a material, the tonnage. A date without survey data is left blank, never 0; a stale figure is drawn hollow and marked.
- **The dates strip**: the site's volume or tonnes stacked by material on every survey date, under the stage (see [The dates strip](09-volumes-and-roads.md#the-dates-strip)).
- **The report**: the **Volume over time** section prints each pile's dates and the totals.
- **The CSV**: **Export** in the header of the Volumes view saves "Volume-over-time.csv", one row per pile and date, in the site's units, with its status ("ok", "stale", "partial", "refused" or "missing") and whether the figure came from an earlier version.

A total adds current figures only: a stale, refused or missing figure is named, never added. A pile whose figures were carried from an earlier version keeps them on their own dates until **Recompute with the standard base**.

## Stockpile projects

The piles of a stockpile project are volume measurements in the **Stockpiles** folder, with the bases above. A project from an earlier version keeps the old register's figures, marked "From an earlier version", until you choose **Recompute with the standard base** (see [Volumes and roads](09-volumes-and-roads.md#piles-from-an-earlier-version)).
