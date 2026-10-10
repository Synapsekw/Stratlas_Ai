# Survey dates

Projects that are flown again and again (weekly or monthly progress flights) keep every flight in one project. Each flight is a survey date.

## The date folders

The Datasets list on the left shows one folder per survey date, newest first. Inside each folder are the usual groups: models, maps, video, photos and panoramas. Layers that belong to no date, such as a design drawing, sit in **Every date** at the top.

A project with a single survey date still shows its date folder and the date bar, without the arrows. A project with no survey dates keeps the plain list grouped by type, and has no date bar.

The highlighted folder is the date you are viewing. Click a date's name to view it. Click only the arrow beside it to open the folder without switching, for example to pick one layer from another date.

## Moving a dataset to another date

Drag a dataset from the list and drop it on another date folder to file it under that date. While you drag, the folders that can take it get a dashed outline and the one under the pointer lights up in its colour. Dropping a dataset on the folder it is already in does nothing. A flight row carries all of its clips with it.

Drop a dataset on **Every date** to take its date off. When every dataset has a date the Every date folder is not in the list, so while you drag it appears at the foot of the list as a place to drop.

Without dragging: right-click a dataset (or focus it and press the menu key or **Shift+F10**), then pick a date or **Every date (no date)** under **Move to date**. The **Belongs to date...** box in the Selection panel does the same.

Moving a dataset only changes which survey date it is filed under. Its files stay where they are, with the same names and contents, and the layer's own settings (position, colours, calibration) are not touched. A few things to know:

- A dataset whose name carries a date, such as "Ortho 2024-11-06", is filed by that name when it has no date of its own. Taking its date off therefore leaves it under the date in its name, and the list says so. Move it to another date to override the name.
- Results worked out earlier keep the dates they were worked out for: change detection results, survey quality checks, prepared survey surfaces and their measurements, and the stockpile volumes. After you move a surface, a point cloud or a model that such results use, run them again for the dates involved.
- Offline basemaps and original reviews never belong to a date and cannot be dragged.

## The folder menu: name, colour and icon

Right-click a date folder, or use the three dots that show when you point at it:

- **View this date** does the same as clicking its name.
- **Expand** or **Collapse** opens or closes the folder without switching date.
- **Show all layers** and **Hide all layers** switch every layer of the date on or off.
- **Rename** puts a name field beside the date. Type a name, such as "Baseline" or "After the blast", and press **Enter**. **Escape** leaves it as it was, and an empty field removes the name. **F2** on a focused folder starts renaming too. The date itself stays: the name is shown beside it, and it is the name used for that survey in the date pickers and in reports.
- **Colour** picks one of the eight date colours. The colour changes everywhere the date is shown: the folder, the date bar, the calendar, the video and photo headers and the date chips.
- **Icon** swaps the colour square for an icon in the date's colour. The first choice, the square, removes the icon.
- **Reset colour and icon** goes back to the colour the date gets from its place in date order, and to the square.

The Every date folder has the same menu without a name, colour or icon.

The name, colour and icon are saved in the project, so they are there when you open it again and travel with it when you share it. In a read-only package, and for a reviewer who may only look, datasets cannot be dragged and the menu has only the view, expand and show or hide entries.

## Moving between dates

- The bar above the views shows the date you are viewing. Use the arrows, or press **Alt+Left** and **Alt+Right** on the workspace screen. The shortcuts are ignored while you are typing in a text field.
- Click the date to open the calendar. Days with a survey are coloured, and other days are shown but can't be selected. The month arrows and **Page Up** and **Page Down** skip months without a survey, the arrow keys move day by day, **Enter** picks the day, and **Escape** closes the calendar and returns you to the date bar.
- Press Ctrl+K and type "survey" to list **Go to previous survey**, **Go to next survey** and one command per date, such as **Go to survey 6 Nov 2024**.

When you move to another date, that date's layers come on and the previous date's layers go off. Anything you switched on by hand from a third date stays on, so you can keep, say, the 1 November orthomosaic on screen while you step through later surveys. A closed folder shows how many of its layers are on ("1 on").

If a video clip is playing when you move to another date, it switches to the matching clip of the new date.

In stockpile projects the Volumes date buttons and the date bar move together.

## Issues and measurements belong to their date

An issue belongs to the survey date of the layers it is marked on, and its **Issues** row sits in that date's folder. A measurement set to **Only in** one survey belongs to that survey. Both go off screen with their date and come back with it, in the 3D view and on the map:

- The eye on a date folder ("Hide everything from ...") hides the date's layers and, with them, its issue pins, shapes, heat map and measurements. Click it again to show them.
- Moving to another date does the same for the date you leave.
- An issue shows while at least one layer it is marked on is shown. So if you switch on a single layer of a hidden date, the issues marked on that layer come back, and hiding only the model an issue is pinned to hides that issue. An issue that names its date without being marked on one of its layers shows while any layer of that date is shown.
- A photo or a video clip you open always shows the issues of its own date, whatever is hidden elsewhere.

Issues on layers in **Every date**, and measurements for the whole site, are always shown. Nothing is removed: the **Issues** list, counts, reports and exports still hold every issue.

## Which date am I looking at?

Each date has a colour. It appears on the folder, in the date bar, on the calendar, in the header of the floating video and of the split video and photo panes (and on the date pickers in the split panes), and in a small chip at the top of the 3D view or map whenever more than one date is on screen. The chip is hidden while the split view is open. The panorama overlay shows the survey date as YYYY-MM-DD.

To put two dates side by side, use [Compare dates](04-compare-dates.md). The left side of the compare split follows the date bar.
