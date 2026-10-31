# Survey dates

Projects that are flown again and again (weekly or monthly progress flights) keep every flight in one project. Each flight is a survey date.

## The date folders

The Datasets list on the left shows one folder per survey date, newest first. Inside each folder are the usual groups: models, maps, video, photos and panoramas. Layers that belong to no date, such as a design drawing, sit in **Every date** at the top.

A project with a single survey date still shows its date folder and the date in the island at the top of the view, without the arrows. A project with no survey dates keeps the plain list grouped by type, and the island rests as three dots, with no date.

The highlighted folder is the date you are viewing. Click a date's name to view it. Click only the arrow beside it to open the folder without switching, for example to pick one layer from another date.

## Moving a dataset to another date

Drag a dataset from the list and drop it on another date folder to file it under that date. While you drag, the folders that can take it get a dashed outline and the one under the pointer lights up in its colour. Dropping a dataset on the folder it is already in does nothing. A flight row carries all of its clips with it.

To move everything of one kind at once, drag the group's heading instead: **Video**, **Photos**, **Panoramas**, **Models**, **Point clouds** or **Maps and rasters** inside a date folder. Every dataset of the group goes to the folder you drop it on, the ones behind "more" too. An offline basemap in the group stays where it is.

In a small window the list can be longer than the sidebar. If the folder you want is out of view, hold the dataset at the top or bottom edge of the list and the list scrolls under it.

Drop a dataset on **Every date** to take its date off. When every dataset has a date the Every date folder is not in the list, so while you drag it appears at the foot of the list as a place to drop.

Without dragging: right-click a dataset or a group heading (or focus it and press the menu key or **Shift+F10**), then pick a date or **Every date (no date)** under **File under**. The same menu has **Compare with another date...** and **Delete…**. The **Belongs to date...** box in the **Selection** tab of the right panel does the same for one dataset.

After a move of more than one dataset, a note at the top of the list says how many were moved and offers **Undo**, which puts them back under the date they had. Undo covers the last move only, until you dismiss the note, make another move or close the project. A dataset you filed under a different date since stays where you put it.

Moving a dataset only changes which survey date it is filed under. Its files stay where they are, with the same names and contents, and the layer's own settings (position, colours, calibration) are not touched. A few things to know:

- A dataset whose name carries a date, such as "Ortho 2024-11-06", is filed by that name when it has no date of its own. Taking its date off therefore leaves it under the date in its name, and the list says so. Move it to another date to override the name.
- Results worked out earlier keep the dates they were worked out for: change detection results, survey quality checks, prepared survey surfaces and their measurements, and the stockpile volumes. After you move a surface, a point cloud or a model that such results use, run them again for the dates involved.
- Offline basemaps never belong to a date and cannot be dragged.

## The folder menu: name, colour and icon

Right-click a date folder, or use the three dots that show when you point at it:

- **View this date** does the same as clicking its name.
- **Expand** or **Collapse** opens or closes the folder without switching date.
- **Show all layers** and **Hide all layers** switch every layer of the date on or off.
- **Rename** puts a name field beside the date. Type a name, such as "Baseline" or "After the blast", and press **Enter**. **Escape** leaves it as it was, and an empty field removes the name. **F2** on a focused folder starts renaming too. The date itself stays: the name is shown beside it, and it is the name used for that survey in the date pickers and in reports.
- **Colour** picks one of the eight date colours. The colour changes everywhere the date is shown: the folder, the island, the calendar, the video and photo headers and the date chips.
- **Icon** swaps the colour square for an icon in the date's colour. The first choice, the square, removes the icon.
- **Reset colour and icon** goes back to the colour the date gets from its place in date order, and to the square.
- **Compare with...** puts this date beside another. See [Compare from the tree](04-compare-dates.md#compare-from-the-tree).
- **Delete…** removes the date and everything filed under it, to the project trash. See [Delete datasets and the project trash](03-scene.md#delete-datasets-and-the-project-trash).

The Every date folder has the same menu without a name, colour, icon or **Delete…**.

The name, colour and icon are saved in the project, so they are there when you open it again and travel with it when you share it. In a read-only package, and for a reviewer who may only look, datasets cannot be dragged and the menu has only the view, expand and show or hide entries.

## Moving between dates

- The island at the top of the view shows the date you are viewing, with its arrows beside it. Click them, or press **Alt+Left** and **Alt+Right** on the workspace screen. The shortcuts are ignored while you are typing in a text field. In a project with video, the date also sits in the top left corner of the timeline, which has one lane per date (see [One lane per survey date](03-scene.md#one-lane-per-survey-date)).
- Click the date to open the calendar. Days with a survey are coloured, and other days are shown but can't be selected. The month arrows and **Page Up** and **Page Down** skip months without a survey, the arrow keys move day by day, **Enter** picks the day, and **Escape** closes the calendar and returns you to the island.
- Press Ctrl+K and type "survey" to list **Go to previous survey**, **Go to next survey** and one command per date, such as **Go to survey 6 Nov 2024**.

When you move to another date, that date's layers come on and the previous date's layers go off. Anything you switched on by hand from a third date stays on, so you can keep, say, the 1 November orthomosaic on screen while you step through later surveys. A closed folder shows how many of its layers are on ("1 on").

When you move to another date, the playhead keeps its time of day. If the new date has a clip at that time, that clip is selected, ready to play with **Space**.

In stockpile projects the Volumes date buttons and the island's date move together.

## Issues and measurements belong to their date

An issue belongs to the survey date of the layers it is marked on, and its **Issues** row sits in that date's folder. A measurement set to **Only in** one survey belongs to that survey. Both go off screen with their date and come back with it, in the 3D view and on the map:

- The eye on a date folder ("Hide everything from ...") hides the date's layers and, with them, its issue pins, shapes, heat map and measurements. Click it again to show them.
- Moving to another date does the same for the date you leave.
- An issue shows while at least one layer it is marked on is shown. So if you switch on a single layer of a hidden date, the issues marked on that layer come back, and hiding only the model an issue is pinned to hides that issue. An issue that names its date without being marked on one of its layers shows while any layer of that date is shown.
- A photo or a video clip you open always shows the issues of its own date, whatever is hidden elsewhere.

Issues on layers in **Every date**, and measurements for the whole site, are always shown. Nothing is removed: the **Issues** list, counts, reports and exports still hold every issue.

## Which date am I looking at?

Each date has a colour. It appears on the folder, in the island, on the calendar, in the header of the floating video and of the split video and photo panes (and on the date pickers in the split panes), and in a small chip at the top of the 3D view or map whenever more than one date is on screen. The chip is hidden while the split view is open. The panorama overlay shows the survey date as YYYY-MM-DD.

To put two dates side by side, use [Compare dates](04-compare-dates.md). The left side of the compare split follows the island's date.

## Adding a survey date

A flight comes into the project as its own survey date, with every dataset it brings filed under it. Click the calendar-plus button in the header of Datasets, or press Ctrl+K and type "survey" (**Add survey date...**).

- **By hand.** Pick a date (a future day is fine, to plan the next flight), type a name if you like (it shows beside the date, "Survey" otherwise) and click **Add date**. The new, empty date folder becomes the date you are viewing. If the day is already a survey date, a note says so and that date is shown instead; two dates on one day are not made.
- **From a flight folder.** In the same popover click **Import a flight folder...** (Ctrl+K: **Import a flight folder...**), or drag a folder from Explorer onto the window. The folder is read with everything inside it. Photos, video with their SRT files, models, maps and drawings are listed in the import card; the files the app does not use (DJI LRF proxies, Thumbs.db, text files) are summed up in one row per folder.
- **The import card.** Under the list, **Survey date** shows the day read from the photos and video, marked "(new)" when the project has no date for it yet. Pick another survey date from the list, or **New survey date...** to set a day of your own, and click **Add**. Every dataset of the import goes under that date, picture drawings (PNG, and JPEG or TIFF added through Add drawing) included. PDF, SVG and WebP drawings and DXF plans are filed later, so they arrive without a date. A date the import made and the choice then left empty, including one you made with **New survey date...** and changed again, is tidied away; a date that was there before is never removed. Files of several days in one import all go under one date, the day most of them carry.
- **Photos.** Each import puts its photos in a photos set of its own, so two flights' photos stay apart, also two flights of one day. Projects made before keep their single photos layer.
- **Datasets that were recorded earlier.** In a project whose photos and video sit in **Every date** although they carry a recording day, a note at the top of Datasets says how many were recorded on survey days and under which dates they would go. Click **File them** to move them, or **Not now**. Only photos and video are filed this way; models, maps and drawings stay where they are. The note comes once per project on a machine. A photos dataset holding pictures from several days is never filed under one of them: the note says how many there are, and you move them by hand.

A shared package opened for review has no calendar-plus button and no note: dates are not added there.
