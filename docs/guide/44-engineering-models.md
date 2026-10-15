# Engineering models

**Create engineering model** turns point clouds, models and ordinary photos of one structure into a clean model made of named components: a chimney, a flare stack, a lattice tower or a monopole. Every component (shaft, flue, band, warning light, ladder, platform, antenna and so on) carries how its values are known, so you can see what was measured and what was guessed. You review it in the Model builder, place it on the earth and export it as a checked 3D file with its component list.

The model is a review aid. It is not a fabrication drawing and not an as-built survey.

## Create a model

1. Open the project and choose **Create engineering model**.
2. Under **Sources**, tick what shows the asset: point clouds, models and photo sets of the project, or **Add photos...** from files. Several sources together are fine.
3. Optional: set a **Region of interest** (a circle or a box, **Pick on the scene**) to leave out neighbouring structures and clutter.
4. Choose the **Asset family**, or leave **Decide from the evidence**.
5. Choose **What to model**: **The asset only**, or **The asset and the equipment around it**.
6. Choose the **Detail**:

   | Detail       | AI cost cap | AI passes | File size limit   |
   | ------------ | ----------- | --------- | ----------------- |
   | **Fast**     | US$0.50     | 1         | 150 000 triangles |
   | **Standard** | US$2        | 2         | 400 000 triangles |
   | **Detailed** | US$5        | 3         | 900 000 triangles |

7. Optional: enter a **Known dimension** (the height or the diameter in metres). With photos only, this is what gives the model its true size.
8. Choose the **Placement**: **Where the sources are**, **At a point I pick** or **Not placed yet**.
9. Click **Preview what is sent**, check it (see below), then **Start**.

**Progress** shows the stages: **Inspect the sources**, **Measure the asset**, **Identify the components**, **Build the model**, **Check the model** and **Ready for review**. **Cancel** stops the run, and **Retry** starts a failed stage again. The measuring runs on this computer. A run keeps its own folder in the project, so you can come back to it.

## What is sent to the AI, and when

Only the AI step may leave this computer, and only after you see it.

- **The preview** shows exactly what the request sends: the measurement summary, the setup choices and every image as it will be sent (cut to the number of images the model takes, made smaller, with the camera data removed). It also shows the provider and model, the request size and the cost estimate. Nothing is sent until you click **Send once**. Every request to a cloud model goes through a preview, even when the project allows photos and scans.
- **Photos** and **scan views** (renders and slices of the point cloud) need separate consent. In the preview, **Allow for this project** stores it in the project (the `aiCloudPhotos` and `aiCloudScans` settings, off until you allow them). Ticking **Send photos this once** or **Send scan views this once** covers that one request only. Plan drawings keep their own setting in the Model builder.
- **A price that is not known**: when the model has no price in the app's table, the preview says **Price not known for this model**. You can only send after ticking **Send without a cost estimate**.
- **Limits per run**: the cost cap of the detail level, 10 minutes of AI time, and a fixed number of requests and tokens per pass. The run stops when one is reached and keeps the best result so far. These limits are kept in the project, so restarting the app does not reset them.
- **Never sent**: file paths, the camera position from a photo's GPS, text and labels from the photo metadata, the original photo files.
- **Offline**: on an offline-only workstation nothing is sent. The setup says so, and the AI step waits. A model on this computer (Settings, AI providers) runs offline; it must be able to read images.
- **Which AI model**: the engineering step uses the route **Engineering models** in Settings, AI providers, which follows the vision route until you set it. A cloud model that the app does not know is refused unless you turn on **Treat as vision model** for it.

## Review the components

The engineering model opens in the Model builder with the **Components** list.

- Each component shows its status: **Draft**, **Accepted** or **Rejected**. **A** accepts, **R** rejects, **D** makes a draft and **Shift+A** accepts all drafts.
- **Values** shows the component's sizes and positions, each marked **Measured** (from a scan), **Observed** (seen in photos), **Inferred** (a rule or a default) or **Entered by you**. **Evidence** lists the scan, photos or model it rests on. **Fits the scan to about ... cm** and **Seen from all sides / most sides / one side / Barely seen** say how well the scan covers it, and **Not seen** names the surfaces no source showed.
- Change a value, then **Rebuild with my edits**. Your values stay, and accepted components are kept as you accepted them. When a new run would change an accepted component, it is flagged once for you to look at instead of being changed.
- **Still to settle** lists what the run could not decide, for example an unclear count or a scale that is only assumed. **Photos that may show another asset** lists images that seem to show a different structure; the run stops before building so you can leave them out.
- **The size is assumed. Enter one known dimension to fix it.** appears on a model made from photos without a known dimension: its lengths are not yet true metres.

**Corrections through the AI agent**: in the agent panel you can say, for example, "there are four flues, not three" or "move the first light level to 45 m". The agent changes counts, levels and values, adds or removes components and accepts or rejects them through the same rules: only the affected components change and ids stay. Each change asks for your approval first. Removing an accepted component also needs your confirmation.

## Place a model

**Place model** puts any model (GLB or OBJ, engineering or not) where it belongs.

1. Choose **Place model...** on the model's layer, or **Place model** after an import.
2. Under **Put it at**, **Click a point** in the 3D view, **Pick on the map**, or type the **Position of the model origin** as E N H in the project coordinate system or as lat, lon, h.
3. Use the handle (**Move**, **Turn**, **Tilt**, **Scale**) or the fields (**East offset**, **North offset**, **Up offset**, **Heading**, **Tilt forward**, **Tilt sideways**, **Scale**). **Drop to ground** sets the height to what is under the origin.
4. Click **Done**. The previous manifest is kept as `manifest.json.bak`. **Undo** and **Reset** are there until then.

A model that carries its own georeference (see Exports) is placed where it belongs when you import it. A model from another project in a different coordinate system is converted on import. A model whose position cannot be read is put at the project origin and marked as needing placement. A model made from photos only is placed provisionally, and the photos' GPS positions are never taken as the asset's position.

## Exports

The export writes a folder per model with:

- the 3D file (`.glb`), one named node per component with its record, and the georeference in the file;
- the model file (`.procmodel.json`);
- the component list (`.components.json`);
- the georeference (`.georeference.json`): the coordinate system, the anchor point, the heading, the scale, the height datum (or "unknown") and how the placement was obtained.

Choose a full folder path for the export. Only accepted components are written. If the file would be larger than the detail level allows, small parts are simplified first, and the export says which.

## Known limitations

- Not fabrication-ready and not as-built: the model shows the structure as the sources show it, with rules filling what they do not.
- A model made from one set of photos without a known dimension has a provisional scale.
- Point cloud files in COPC format have not been tested on this computer without the PDAL tools.
- The tuning was done on synthetic assets only.
- The check that photos show the same asset uses colour and camera distance only.
- Models in the 3D view draw each component separately (about 1.7 draws per component), not yet merged into one batch.
- Meshes used as a source are sampled without their colours.
- Warning light lenses are red only.
- Joint rings on a shaft are drawn with flat facets.
- On towers the ladder follows the nearest axis of the structure.
- Placement through Web Mercator (EPSG:3857) is approximate away from the anchor, about 3 mm at 100 m at mid latitudes; the app says so.
- When two people change components of the same model at the same time on different computers, the later change keeps the whole component list and the other change is lost: the project journal records the list as one value, not one entry per component.
- Heights are taken as the model gives them: a project does not name a height datum to compare with. Check the height, and set it with **Place model** when it is off.

The full list is in the known limits that come with the app's documentation.
