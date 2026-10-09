# Haul roads

**Site data**, **Haul road** checks a haul road on a survey against your limits: running width, grade along the road, cross fall either side, and berm heights.

## Run a check

1. Pick the **Surface** (a prepared survey; **Prepare the DSMs** if there is none).
2. Pick the **Centreline**: a design alignment, a design polyline, or a line you drew with the measurement tools. To import one, use **Designs** (see [Designs, alignments and compliance](38-designs-alignments-and-compliance.md)).
3. Set **Sections every (m)**.
4. Under **Limits**, fill in what to check: **Minimum width (m)**, **Maximum grade (%)**, **Cross fall from (%)** and **to (%)**, and **Minimum berm height (m)**. A limit left empty is not checked. To set the berm height from your largest truck, type its **Largest wheel height (m)** and the **Share (%)**, then **Set berm height**.
5. Click **Run analysis**. The run is a job; its results show when it is done.

**Save as site defaults** keeps the limits for the next run on this site.

## Read the results

The summary gives the number of stations that pass, fail or have no data, and lists the failing stretches. The table shows each station's width, grade, cross fall left and right, berm heights and result; failing values are marked, and clicking a station flies to it. **Colour the centreline by pass or fail** colours the road green and red in the 3D view and on the map.

When the surface changes after a run, the run shows **Stale, recompute**. The **Survey report (PDF)** includes the **Haul-road compliance** section with the limits used and the failing stretches.
