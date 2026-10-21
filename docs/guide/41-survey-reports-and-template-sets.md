# Survey reports and industry template sets

## Industry template sets

Each industry has a set of ready templates. Turn sets on in **Templates**, **Industry template sets** (in the **Measure** workbench); the choice is saved with the site and the workbench lists their templates under **Templates**.

| Set                   | Templates                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Construction (6)      | OG to subgrade design, Survey to OG, Survey to subgrade, Compare to previous, Pad check, Area progress                              |
| Mining and quarry (7) | Stockpile (smart base), Bench volume to reference level, Blast area, Post-blast, Berm check, End-of-month inventory, Exclusion zone |
| Landfill (6)          | Cell progress, Lift heights, Airspace remaining, Compaction, Monthly cell report, Daily change                                      |

Templates that compare to a design ask which design layer each role means on this site the first time you use them, for example the original ground and the subgrade, the pad, or the cell base and the final cap. Pick a layer for each and click **Use these layers**; the choice is kept. **Without design comparisons** uses the template without them. Import the design first (see [Designs, alignments and compliance](38-designs-alignments-and-compliance.md)).

## Survey reports

On the **Issues** screen, **Export** offers:

- **Survey report (PDF)**: the stockpile, earthworks and landfill sections, plus haul-road and hydrology runs;
- **Stockpile inventory (CSV)**: every survey, by material, with volumes and tonnes;
- **Survey measurements (CSV)**: every comparison item of every measurement, in the units shown and in SI units.

The report's sections:

- **Survey measurements**: a plan of the measurements and a table with totals;
- **Earthworks to design**: cut and fill to design, the share of the area within tolerance, and cross-sections;
- **Stockpile inventory**: each pile with its material, density and tonnes, the change since the last survey, and a materials summary;
- **Landfill airspace and compaction**: the airspace remaining to the cell design, the compaction of each lift from the weighbridge tonnage;
- **Haul-road compliance** and **Hydrology**: the saved runs.

Each section states the coordinate system, datum, geoid, calibration and units it was computed with. A result that is out of date shows **Stale, recompute** in the report too.

The same sections can be part of the project report: **Reports**, **Project report**, **Sections**. See also [Reports and exports](10-reports-and-exports.md).

**Volume over time** prints each volume measurement's volume on every survey date, with the site totals per date and the piles each total leaves out. A date without survey data is left blank, never 0.

## Add to report and the report template

**Add to report**, in a measurement card's "⋯" menu or under its chart, puts the measurement on the project's report list. It says "Added to the report", or "Already in the report" when it is there. The list is kept with the project, in `report/template.json`, and travels in a package.

- The first **Add to report** switches the **Survey measurements** section from every measurement to the report list: from then on the section prints only the measurements added, in the order you added them.
- The list prints in the **Survey measurements** section only. With that section off, the measurements added print nowhere.
- There is no editor for the list yet. If the list cannot be read, the report prints every measurement, as before the first add.
