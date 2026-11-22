# Coverage

**Coverage** predicts where a tower's sectors give a phone signal. It starts from the accepted antennas of the **Antennas** list (see [Antennas](45-antenna-inventory.md)), groups them into sectors, gives each antenna its equipment and radio values, and computes a coverage map you can read on the Map and in 3D and export.

Coverage is part of the **Telecom** tool set (see [Tools by project type](08-building-projects.md#tools-by-project-type)). It needs the processing tools, a project with a coordinate system (without one true north is unknown and the coverage would face the wrong way) and accepted panel antennas. The run is computed on this computer.

The results are indicative: flat ground, no buildings, an untuned model, about 8 dB either way. Check them against a drive test before relying on them.

## Open Coverage

Each of these shows the same **Coverage** panel:

- the **Coverage** section of the right sidebar's **Tools** tab (in a project with a point cloud or a model); **Expand panel** in its header widens it;
- the project menu's **Coverage...**, also while a run is going;
- **Ctrl+K**, then **Open in Coverage** or **Auto-plan coverage**;
- the **Coverage** chip on the stage;
- **Open in Coverage** on an antenna (right-click it in the list or in 3D), which opens the panel on that unit;
- **Open in Coverage** on a sector in **Project**, **Sectors**, or on the row of **Project**, **Coverage plan**.

The Coverage tab opens pinned, so the next panel you open does not replace it. The panel has a save bar at the top while there are unsaved changes, the chip's status line, the **Plan coverage with AI** card, then three steps: **Antennas**, **Sectors & equipment** and **Coverage**, and **Advanced** at the bottom. With no antennas yet it reads **No antennas yet**: run **Detect antennas** first.

## Plan the sectors

The **Plan coverage with AI** card offers three ways in.

### Auto-plan

**Auto-plan and run** groups the antennas into sectors, picks equipment and a band for each from what was measured, and opens a review, **Auto-plan coverage · review before applying**. Nothing is saved before you choose.

- **Plan from** is **AI provider** or **Rules only**. **Rules only** sends nothing. With an AI provider, a confirm (**Send to** the provider) says what goes: the measured size, tilt and height of the accepted antennas, any model and frequencies entered by you, and the catalogue list. The project or site name is never sent.
- Each row says its sector, antenna, equipment, band and why, with a confidence. Rows left out say why, for example a draft or a unit that is not a panel.
- **Apply and run** applies the plan, saves it and starts a run. **Apply only** applies it and leaves it unsaved. **Cancel** changes nothing.

Auto-plan plans accepted antennas only. When none is accepted it says **Review antennas first**, and **Review antennas** opens the list. The stage chip has **Auto-plan** and **Re-plan** for the same review.

### Use cell export

**Use cell export** reads a cell export (CSV) of the operator's plan; you can also drop the file on the card. The line under the card says what it does: it plans sectors, equipment and bands from the file, matching rows to antennas by name, then by sector and azimuth, and you review the plan before it is applied. The review names the columns it did not use (**Cell export columns not used**) and shows each row that matches no antenna with its own text (**Line 4 matches no antenna: ...**). A file that cannot be read says why.

The other importer is **Import cell export (CSV)** under **Advanced**. It sets the RF settings of the antennas a cell export names, matching rows by antenna name only, and plans nothing for you. It shows each row with what it would change, names the columns it does not use (**Columns not used**), and writes nothing until you **Apply** the rows and save.

### By hand

**set up by hand** opens the first sector in step 2.

## Step 1: Antennas

Step 1 counts the accepted antennas and the drafts, with **Review in Antennas** to go back to the list. Coverage uses accepted antennas. **Include drafts** adds the drafts; a run made with them says so in its results. The tower and its highest antenna above ground are shown here too.

## Step 2: Sectors & equipment

- **Group by azimuth** puts panels within 30 degrees of each other into one sector, named clockwise from north. RF settings are kept. **Add sector** adds an empty one.
- Each sector has a switch, **Takes part in coverage**, a name you can change and a delete. A rename here and in **Project**, **Sectors** is one rename: the name shows in both and nothing else unsaved is lost.
- Open a sector to set its antennas, one at a time (**Antenna shown**):
  - **Measured geometry**: the **Azimuth** (true and grid) and the **Downtilt**, read only. Correct them in the Antennas list.
  - **Height above ground**: the box centre above the tower base ground. Type another value if needed; **Use measured** goes back to the detected one.
  - **Sector**, and **Takes part in coverage** for the antenna.
  - **Band and equipment**: **Band**, **Technology** (LTE or NR), **Carrier bandwidth**, and the **AAU**, or a separate **Antenna** with its **Radio (RRU)** and **Antenna port**.
  - **Pointing**: the **Electrical tilt**, in the antenna's range.
  - **Power and losses**: the power, and the **Feeder or jumper loss**. **Defaults the run applies** lists what the run fills in for an empty field.
- **Choose equipment** opens the catalogue: search by model or vendor, filter by vendor and band. Its values are typical values from public datasheets, each marked **verified** or **check the datasheet**. **Import catalogue** adds a catalogue file and **Import MSI pattern** a vendor pattern file for an antenna. Warnings from reading the catalogue, and a catalogue that cannot be read, are shown here.
- **Settings for antennas no longer found** lists RF settings whose antenna was removed, rejected or not found again; move them to another antenna or remove them.

## Save

The save bar says **RF settings changed and not saved yet.** with **Save** and **Undo changes**. Nothing is written to the project until you save. A save with warnings lists them under **Saved, with warnings:**.

While Coverage holds unsaved changes, **Project**, **Sectors** says **Unsaved changes in Coverage** and still lists the saved sectors.

## Step 3: Run coverage

Step 3 has one button, **Run coverage**. Every run is a new run; the step counts them. When a run cannot start, the button is greyed and its reason says what is missing, for example no accepted panel, no band, no height above ground or no coordinate system. Before a run, a live preview follows the settings on the Map and in 3D; a study too large to preview says so and can still be run. **Advanced** holds the study: **Model**, **Environment**, **Where people are**, **Radius** and **Grid**.

The jobs indicator follows the run. Closing the panel does not stop it.

## Read the results

- **Coverage view**: **RSRP** (signal strength of the best sector), **Best server** (the strongest sector at each point) or **Overlap** (where two or more sectors are close to the best).
- **Run** picks one of the runs, newest first.
- The class table, **Coverage by class**, gives each class (**Excellent**, **Good**, **Fair**, **Poor**, **No service**) with its RSRP range, area and share.
- The step says how many antennas take part and lists those **Left out of a run** with the reason.
- **The plan changed since this run. Run coverage again to see it.** shows when the saved plan differs from the plan that run used. It is worked out from what is saved, so it is still there after the project is opened again, and the stage chip says **plan changed since this run** too.
- The note under the results starts **Indicative:** and gives the assumptions. It also says when antennas used the generic pattern because no pattern file was found, when the run used draft antennas, and **Equipment values not checked against datasheets** when the run used catalogue values that are not checked yet.

The **Coverage** layer draws the chosen run, or the live preview, on the Map and in 3D. Its eye is in the layers list, on the stage chip and on the legend. The legend sits in the stage's bottom right corner and has **Opacity**, **Show from** (all classes, fair and better, good and better), **Hatch the classes** and **Details**.

## Export

**Export** in step 3 writes the chosen run as a **GeoTIFF of the grid**, **GeoJSON coverage areas** or a **CSV of sector areas**, for a GIS or a planning tool. It is greyed with **Choose a finished run to export.** until a finished run is chosen.

## In the Project tab

- **Sectors** lists the saved sectors, each with its azimuth and antenna count, **Rename**, **Fly to** and **Open in Coverage**. **Fly to** is greyed when none of the sector's antennas is left. A sector without an azimuth reads **Not measured**.
- **Coverage plan** counts the finished runs and says **not planned** or **last run** with its date, with **Open in Coverage**.

## Known limitations

- A run does not record which survey date it belongs to, so an old run is drawn with today's line-up.
- The catalogue values are not checked against datasheets yet.
- The two cell export importers match rows by different rules.
- **Include drafts** is forgotten when the project is opened again.

The full list is in the known limits that come with the app's documentation.
