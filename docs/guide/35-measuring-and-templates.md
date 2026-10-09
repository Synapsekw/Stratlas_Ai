# Measuring and templates

Survey measurements are points, lines and polygons saved with the project, each with its own results, style, folder and fields. They work the same in the 3D view and on the map.

## The Survey measurements toolbar

Open the **Survey measurements** popover on the stage toolbar. It holds:

- **Site data**: **Designs**, **Survey QA and cleanup**, **Terrain overlays**, **Hydrology**, **Haul road** and **Export survey data**.
- The tools, by family:
  - **Point**: **Elevation**, **Elevation difference** (to another surface) and **Annotation**.
  - **Line**: **Distance** (terrain, slope and horizontal lengths), **Grade and slope** (degrees, percent and ratio), **Vertex differences**, **Berm check** (crest and toe heights and widths across a berm) and **Cross-section** (see [Cross-sections and terrain overlays](37-cross-sections-and-terrain-overlays.md)).
  - **Polygon**: **Area** (horizontal, terrain and slope area) and **Volume** (see [Volumes, bases and comparisons](36-volumes-bases-and-comparisons.md)).
  - **Markup**: **Freehand markup**.
- Your bookmarked templates, **Drawing aids**, and the buttons **Measurements**, **Templates**, **Units**, **Materials** and **Whole site cut and fill**.

## Drawing

Pick a tool and click on the site. Points sit on the terrain under the pointer.

- Type a distance and press **Enter** to place the next point exactly that far. **Tab** lets you type a bearing.
- Hold **Shift** to lock the angle to 15 degree steps or to the last segment's bearing.
- **Backspace** with nothing typed removes the last point. **Enter** with nothing typed, or a double-click, finishes.
- **Esc** first clears what you typed, then cancels the drawing. With no tool active, **Esc** returns to selecting.

**Drawing aids** switch snapping on: **Snap to vertices** and **Snap to edges**, the sources to snap to (**Measurements**, **Designs**, **Alignments**, **Guidelines**) and the **Snap distance** in screen pixels. The drawing bar says what you snapped to, for example "snapped to a design vertex".

## Saving and the list

New and changed measurements are kept until you save: the bar shows "Unsaved measurement changes." with **Save measurements**. **Autosave** in the **Measurements** list is off by default.

The **Measurements** list has a search box, sorting, **Filters** (template, scope, a field value, **Created by me**, **Last 7 days**) and folders. Select several to move them to a folder, delete them, **Fly to** them or see their totals.

## The measurement panel

Click a measurement to open its panel:

- the results, then **Details** (template, folder, description and the template's custom fields);
- **Style and label**: colour, fill, border, label size, **Label only when selected** and **Show the property name**;
- **Units**: **Site units**, or **Units for this measurement** to give this one its own units (for example US survey feet and cubic yards);
- **Scope**: a measurement belongs to the whole site ("Whole site: shown with every survey") or to one survey ("Only in ..."). **Promote to the whole site** and **Copy to another survey** move it between the two;
- **Vertices**: **Edit vertices in the view** (drag a vertex, **Alt**+click deletes it, the blue dots insert one), or type N, E and Z in the table;
- for polygons, **Comparisons** and **Material and calculators**.

## Templates

**Templates** opens **Measurement templates**, with tabs **This project** and **My library**. A template sets the tool, the result rows and their order, custom fields (**Text**, **Number** or **Dropdown** with its choices), the default comparisons of a polygon, the colour, and a description. Tick **Bookmark on the toolbar** to put it in the popover. **Copy to my library** keeps a template for other projects.

The industry template sets (construction, mining and quarry, landfill) are switched on in the same dialog; see [Survey reports and industry template sets](41-survey-reports-and-template-sets.md).
