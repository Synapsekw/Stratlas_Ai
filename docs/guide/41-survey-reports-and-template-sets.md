# Survey reports and industry template sets

## Industry template sets

Each industry has a set of ready templates. Turn sets on in **Templates**, **Industry template sets**; the choice is saved with the site and the toolbar shows their templates.

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
