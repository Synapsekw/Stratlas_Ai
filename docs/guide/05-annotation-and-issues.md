# Annotation and issues

An issue is one defect or finding: a code, a title, a class, a severity and a status, marked on the model, the map, photos or video frames.

## Mark a new issue in 3D

1. On **Scene**, click **Annotate: pins, lines, areas, cloud regions** (or press **A**). A tool bar opens under the stage toolbar.
2. Pick a tool: **Pin**, **Line**, **Area**, **Cloud pt** or **Cloud box** (point clouds).
3. Click on the model. For a line or an area, click each point and finish with **Enter** or a double click.
4. In **New issue**, pick the **Class** and the **Severity** (number keys; **U** for uncertain).
5. Click **Create issue** (or press **Enter**). **Add to** an existing issue code instead adds the mark as another sighting of that issue.

On the **Map**, the tools are **Point**, **Line** and **Area**.

To close the tools, click **Close the annotation tools** or press **A** again. Packages opened read-only have no annotation tools.

In a project with survey dates, an issue belongs to the date of the layers it is marked on. Its pin and shape go off the 3D view and the map when that date is hidden and come back when it is shown; the **Issues** list always holds every issue. See [Survey dates](28-survey-dates.md).

## Mark an issue on a photo or a video frame

1. Open the photo from **Media** or from a marker in the scene.
2. Pick **Box** (**B**), **Rotated box** (**R**), **Polygon** (**P**) or **Point** (**O**) and draw on the defect.
3. Pick the class and severity as above.

On a video frame, pause the clip and use **Box** or **Polygon**.

## The issue card

Pick an issue anywhere: a pin or code label in 3D, a map marker, a timeline mark, a row in **Issues**, or **Ctrl K**. The right panel opens with its card:

- Code, title, severity, status (**Draft**, **Reviewed**, **Approved**, **Closed**), class, **Zone** and its place in the list ("4 of 31").
- The best photo cropped around the defect with its box drawn; the other photos in a strip. A video frame has **Jump to** with the time: the clip plays from there.
- **Recommended action** (from the severity model) and **Note**.
- **Previous issue**, **Next issue** and **Fly to the issue**.

![The issue card](images/issue-card.png)

### Edit an issue

Open **Edit issue** at the bottom of the card:

- Change **Title**, **Class** and **Severity**, and write the note.
- Move the status on with **Mark reviewed**, **Approve** or **Close** (**Back to** returns it a step).
- Merge two records of the same defect.

Changes save into the project at once.

### Look at the photos full size

1. Click the photo on the card. It opens over the app.
2. Wheel to zoom, drag to pan, **F** to fit.
3. **M** turns the markings off and on. Left and Right step through the issue's photos.
4. **Open in Media** shows the photo with every issue marked on it. **Esc** closes.

### Evidence beside the 3D view

When you pick an issue in the 3D view, the stage switches to **Split** with the issue's photo (or video frame) on the other side, and the 3D view flies to the issue. **Esc** or **×** restores your layout.

To open only the card, switch off **Open evidence in split** on the card.

## The issue register

Click **Issues** in the sidebar.

- Filter by severity, **Search code, title, note**, class, status and dataset. The filters stay as you set them while the project is open, on this screen and in the issue list of the **Scene** panel alike, and reset when you open another project.
- When the agent opens the register on one asset or area, a chip above the list names it. Click the **x** on the chip to clear it. See [Show me](07-ai-agent.md#show-me).
- Sort by **Code**, **Severity**, **Status**, **Last change** or **Class**; group by severity, class, zone or status.
- Tick several rows for **Set status**, **Set class** or **Merge**.
- Up and Down (or **J** and **K**) move through the list; **Enter** opens the issue. **Ctrl Z** undoes, **Ctrl Y** redoes.
- **Export** saves the issues. See [Reports and exports](10-reports-and-exports.md).

![The issue register](images/issues.png)

## Media and findings

**Media** lists the flights and clips (**Play in the scene**), the photo sets and the panoramas.

- A photo with findings has a count badge in its worst severity colour, a tinted border and the boxes drawn on the thumbnail. The bar reads, for example, "12 photos with findings".
- **Only with findings** hides the other photos.
- **Order**: **As captured**, **Worst first** or **Most findings first**.
- **Severity**: **Any**, or one level of the project's severity models, worst first (and **Uncertain** when a model has it). A project with several severity models lists the levels of all of them, each value once. Only the photos with a finding of that level stay. When none match, the list reads "No photos match this filter."
- A chip above the photos, for example `On Tank T-101`, shows a filter the agent set on an asset, an area or one finding. Click its **x** to clear it. See [Show me](07-ai-agent.md#show-me).
- The filters stay while the app runs. The level and the chip clear when you open another project.
- Click a photo to open it beside the list; mark issues on it as above.

## Severity models

Each project grades issues with its own severity model: levels with a colour, criteria and a recommended action. **Settings**, **Severity models** shows the models of the open project. You choose the first model when you create a project. While you annotate, **New class** can also generate another scale, **1 to 3** or **1 to 5**, and you can rename the grades before it is saved. Scales already in the project are not edited here.

## Classes

Each project sorts findings into classes: a name, a colour, an optional hotkey and the severity scale its issues are graded on. **Settings**, **Classes** lists the classes of the open project.

- **Rename** a class in its name field and press Enter. **Colour** opens the palette. **Hotkey** takes one letter, not `a` or `u` (the sighting picker uses those) and not a digit (digits pick severity).
- **Severity scale** can be changed while no issue uses the class.
- **Delete** a class nobody uses at once. When issues or waiting detections use it, you pick the class that takes them over; their severities move to the nearest level of that class's scale.
- **Save to my class library** keeps the class on this computer. A new project offers library classes under **From your class library**.
- **Ctrl+Z** in the page, or **Undo** on the notice, takes the last class change back.

You can also make a class while you work. After a shape, the class panel lists the classes with room to search them and shows each grade of the selected class by name. **New class** asks for a name, a colour, an optional hotkey and a severity scale (one the project has, or a new one). **+ New class...** in **Set class** of the Issues register, in the class field of a detection, or in the class mapping of a local model still takes just the name: type it and press Enter.
