# Measuring and templates

Survey measurements are points, lines and polygons saved with the project, each with its own results, style, folder and fields. They work the same in the 3D view and on the map.

## The Measure workbench

Open the island's tools (click the island at the top of the view, or press **T**) and click the **Measure** tab. The **Measure** workbench opens as a tab of the right panel; with the panel folded, it slides in over the right edge of the view as a drawer. **M** starts **Distance** straight away. From the top, the workbench holds:

- **Search tools**: type part of a name, for example "slope", to keep only what matches.
- **Favourites and recent**: the tools you starred, and the ones you used last.
- The tools, by family:
  - **Point**: **Elevation**, **Elevation difference** (to another surface) and **Annotation**.
  - **Line**: **Distance** (terrain, slope and horizontal lengths), **Grade and slope** (degrees, percent and ratio), **Vertex differences**, **Berm check** (crest and toe heights and widths across a berm) and **Cross-section** (see [Cross-sections and terrain overlays](37-cross-sections-and-terrain-overlays.md)).
  - **Polygon**: **Area** (horizontal, terrain and slope area) and **Volume** (see [Volumes, bases and comparisons](36-volumes-bases-and-comparisons.md)).
  - **Markup**: **Freehand**.
  - **Section plane** (key **X**).
- **Site data**: **Designs**, **Survey QA and cleanup**, **Terrain overlays**, **Hydrology**, **Haul road** and **Export survey data**, then **Materials**, **Whole site cut and fill** and **Units**.
- **Drawing aids**: snapping, and a note of the drawing keys.
- **Templates**: your bookmarked templates, and **Templates** to edit them.
- **Saved in this project**: the measurements list.

Each section folds by its title. While a tool is live, the workbench shows the live card on top (the reading, the points, **Undo**, **Stop** and **Save**) and the catalogue folds to a strip of tool buttons; the island shows the reading beside the date. **Stop**, or **Esc**, puts the tool away and the workbench comes back.

## Drawing

Pick a tool and click on the site. Points sit on the terrain under the pointer.

- Type a distance and press **Enter** to place the next point exactly that far. **Tab** lets you type a bearing.
- Hold **Shift** to lock the angle to 15 degree steps or to the last segment's bearing.
- **Backspace** with nothing typed removes the last point. **Enter** with nothing typed, or a double-click, finishes.
- **Esc** first clears what you typed, then cancels the drawing. With no tool active, **Esc** returns to selecting.

**Drawing aids** switch snapping on: **Snap to vertices** and **Snap to edges**, the sources to snap to (**Measurements**, **Designs**, **Alignments**, **Guidelines**) and the **Snap distance** in screen pixels. The live card says what you snapped to, for example "snapped to a design vertex".

## Suggest boundaries

While you draw a polygon (**Area**, **Volume** or a polygon template), the live card has **Suggest boundaries**. Switch it on and click an object on the ortho, for example a stockpile: a draft outline appears around it in about a second. It is a draft until you accept it.

- **Buffer** (keys **U** and **I**) shrinks or grows the draft. **Vertices** (keys **J** and **K**) gives it fewer or more points.
- **Next click** says what a further click does. **New outline** (the default) starts again where you click. **Remove area** takes what you click out of the draft: use it when the draft also took a pile that touches yours. **Add area** adds what you click: use it when the draft covers only part of the object.
- **Finish**, **Enter** or a double-click accepts the draft as the polygon; **Esc** cancels.
- The outline comes from a model that runs on this computer, inside the pipeline pack. Nothing is sent anywhere. Without the pack, the button tells you what to add.
- It reads the ortho that is shown under the click, so show the ortho of the survey you are measuring. It works in the 3D view and on the map.

A draft is a suggestion from a picture: check it against the terrain before you rely on the volume. Where two piles touch, the first draft often runs around both; one **Remove area** click on the other pile usually fixes it.

## Saving and the list

New and changed measurements are kept until you save: the top of the **Measure** workbench shows "Unsaved measurement changes." with **Save measurements**. **Autosave** in the measurements list is off by default.

The measurements list, under **Saved in this project**, has a search box, sorting, **Filters** (template, scope, a field value, **Created by me**, **Last 7 days**) and folders. Select several to move them to a folder, delete them, **Fly to** them or see their totals.

## The measurement panel

Click a measurement, in the view or in the list, to open its panel under **Selected measurement** in the **Measure** workbench:

- the results, then **Details** (template, folder, description and the template's custom fields);
- **Style and label**: colour, fill, border, label size, **Label only when selected** and **Show the property name**;
- **Units**: **Site units**, or **Units for this measurement** to give this one its own units (for example US survey feet and cubic yards);
- **Scope**: a measurement belongs to the whole site ("Whole site: shown with every survey") or to one survey ("Only in ..."). **Promote to the whole site** and **Copy to another survey** move it between the two. A measurement of one survey is drawn while that survey is on screen: hide the survey's layers, or move to another date, and it goes with them;
- **Vertices**: **Edit vertices in the view** (drag a vertex, **Alt**+click deletes it, the blue dots insert one), or type N, E and Z in the table;
- for polygons, **Comparisons** and **Material and calculators**.

## Templates

**Templates** opens **Measurement templates**, with tabs **This project** and **My library**. A template sets the tool, the result rows and their order, custom fields (**Text**, **Number** or **Dropdown** with its choices), the default comparisons of a polygon, the colour, and a description. Tick **Bookmark on the toolbar** to list it under **Templates** in the **Measure** workbench. **Copy to my library** keeps a template for other projects.

The industry template sets (construction, mining and quarry, landfill) are switched on in the same dialog; see [Survey reports and industry template sets](41-survey-reports-and-template-sets.md).
