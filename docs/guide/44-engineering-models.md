# Engineering models

**Create engineering model** turns point clouds, models, drawings and photos of one structure into a model made of named components: a chimney, a flare stack, a lattice tower or a monopole. Every component carries how its values are known, so you can see what was measured and what was inferred. Review opens beside the actual 3D model, with controls to compare it with the source cloud, inspect individual parts and add accepted parts to the project.

The model is a review aid. It is not a fabrication drawing and not an as-built survey.

Creating a new component model requires processing tools **0.16.0 or later**. If the app asks for an update, open **Settings, Processing tools** before starting a new run.

## Create a model

1. Open the project and choose **Create engineering model**.
2. Under **Sources**, tick what shows the asset: point clouds, models and photo sets of the project, or **Add photos...** from files. Add a DXF drawing and calibrated camera-pose XML when available. These help associate individual components with the drawing and select useful photo crops.
3. Optional: set a **Region of interest** (a circle or a box, **Pick on the scene**) to leave out neighbouring structures and clutter.
4. Continue to **Modelling options**. Choose the **Asset family**, or leave **Decide from the evidence**.
5. Choose **What to model**: **The asset only**, or **The asset and the equipment around it**.
6. Choose the **Detail**:

   | Detail       | AI cost cap | AI passes | File size limit   |
   | ------------ | ----------- | --------- | ----------------- |
   | **Fast**     | US$0.50     | 1         | 150 000 triangles |
   | **Standard** | US$2        | 2         | 400 000 triangles |
   | **Detailed** | US$5        | 3         | 900 000 triangles |

7. Optional: enter a **Known dimension** (the height or the diameter in metres). With photos only, this gives the model a reference scale. A calibrated point cloud remains authoritative: the reference is a consistency check and does not rescale measured geometry. Check that the reference describes the same asset as the selected sources.
8. Choose the **Placement**: **Where the sources are**, **At a point I pick** or **Not placed yet**.
9. Check the inputs and spending limit, then choose **Analyse sources**. Local measurement prepares the evidence before any AI request. The next screen asks you to approve the evidence and budget for this run.

**Progress** shows the stages: **Inspect the sources**, **Measure the asset**, **Identify the components**, **Build the model**, **Check the model** and **Ready for review**. **Cancel** stops the run, and **Retry** starts a failed stage again. Measurement runs on this computer. **Saved runs** lets you reopen a previous run and its model review without starting a new AI request.

## What is sent to the AI, and when

Only the AI step may leave this computer, and only after you see it.

- **Run approval** shows the prepared evidence pool, summary, permitted categories, provider/model and spending limit. **Approve and build** authorizes those inputs for this run, including later permitted passes. Changing sources, their effective frame, provider/model or budget requires renewed approval. Approval expires after 24 hours. It does not authorize unrelated files.
- **Later passes** select images from the approved pool and may include generated comparison views. The AI can read bounded component records by their IDs. Camera crops and geometric fits are prepared locally; the AI does not receive arbitrary filesystem or code-execution access. More passes do not mean every original photo is sent.
- **Photos** and **scan views** have separate permissions. A run can temporarily authorize either category without changing the project's long-term settings. Cloud AI being disabled, offline policy, revoked permissions or cancellation stops further requests.
- **A price that is not known** blocks the run until a model with a known price is selected. There is no bypass for sending without a cost estimate.
- **Limits per run**: the chosen estimated cost cap, 10 / 20 / 30 minutes of AI time for Fast / Standard / Detailed, and bounded requests, tool steps and tokens per pass. Each AI call has a ten-minute timeout. Limits and accumulated spend persist across restart. The cap uses the app's token and pricing estimates; it is not a guarantee of the provider's final bill.
- **Interrupted requests** keep a reserved allowance until complete usage is available. Reservations are separate from known spending, survive restart, and reduce what the run may send next. If the allowance cannot be saved, the app stops further requests.
- **Never sent**: file paths, the camera position from a photo's GPS, text and labels from the photo metadata, the original photo files.
- **Offline**: on an offline-only workstation nothing is sent. The setup says so, and the AI step waits. A model on this computer (Settings, AI providers) runs offline; it must be able to read images.
- **Which AI model**: the engineering step uses the route **Engineering models** in Settings, AI providers, which follows the vision route until you set it. A cloud model that the app does not know is refused unless you turn on **Treat as vision model** for it.

## Review the components

If the AI stage was skipped, **Run AI pass** continues the measured draft through the evidence approval step. It retains the run's measurements and spending history.

**Review model** opens the **Model review** workbench tab beside the generated model. If the sidebar is folded, review opens in its drawer. The **Components** list and **Corrections** view share this tab. **Model**, **Point cloud** and **Overlay** preserve the camera while switching what is visible. **Fit model** frames the whole result. **Labels on / Labels off** toggles all model callouts together, including the selected-part callout; selection and the component details remain available. If the GLB cannot load, review shows an error and a retry action rather than an empty successful review.

Switching workbench tabs preserves the review camera. Closing the review tab leaves the saved run intact; choose **Review model** to return. When a run completes while you are editing an issue, it offers **Show it** instead of replacing the issue editor.

- Each component shows its status: **Draft**, **Accepted** or **Rejected**. **A** accepts, **R** rejects, **D** makes a draft and **Shift+A** accepts all drafts.
- Click a part in the model or the list to highlight the same component and bring its details into view. **Focus** frames just that part.
- **Values** shows dimensions and position, with **Measured**, **Observed**, **Inferred** or **Entered by you** provenance. Vector dimensions and centres are currently read-only; scalar fields can be edited. **Evidence** lists supporting sources; click a thumbnail to enlarge it. Fit residuals and coverage describe the observed surfaces, not hidden backs or inferred cable routes.
- Drawing-associated panels and radios keep their individual positions, dimensions and face bearings. Ambiguous or partially observed measurements remain review items. Low or oversized scan candidates are not sufficient evidence of warning lights on their own.
- For a monopole without a drawing, the point cloud can identify separate panels and enclosures. Each detected device keeps its own position, dimensions, bearing and inclination. Uncertain enclosures remain equipment boxes; an AI review can classify one as a panel or radio only with supporting original-photo evidence. A generated model view cannot establish that identity. Missing backs and inferred depth remain marked for review. A known or photo-classified device with a supported mounting pipe can receive inferred clamps and service cables; cable counts, ports and electrical connections are not measured. Unknown devices or devices without a supported pipe receive no invented brackets or cables.
- Drawing-free support fitting can recover upright circular mounting pipes and near-horizontal platform outlines where enough source points support them. A device is attached only when one measured pipe and a connecting region of points support that relationship. Hidden extensions, platform thickness and construction details remain inferred. An incomplete or ambiguous platform may be omitted.
- Climbing-step heights can be measured from repeated scan features while their width, bearing and distance from the shaft remain inferred. Those pose values are marked inferred when the cloud does not support the full bar in three dimensions.
- Change a value, then **Rebuild with my edits**. Your values stay, and accepted components are kept as you accepted them. When a new run would change an accepted component, it is flagged once for you to look at instead of being changed.
- **Still to settle** lists what the run could not decide, for example an unclear count or a scale that is only assumed. **Photos that may show another asset** lists images that seem to show a different structure; the run stops before building so you can leave them out.
- **The size is assumed. Enter one known dimension to fix it.** appears on a model made from photos without a known dimension: its lengths are not yet true metres.

**Corrections through the AI agent**: in the agent (below the workbench in the right panel, or **Ctrl J**) you can say, for example, "there are four flues, not three" or "move the first light level to 45 m". The agent changes counts, levels and values, adds or removes components and accepts or rejects them through the same rules: only the affected components change and ids stay. Each change asks for your approval first. Removing an accepted component also needs your confirmation.

## Place a model

**Place model** puts any model (GLB or OBJ, engineering or not) where it belongs.

1. Choose **Place model...** on the model's layer, or **Place model** after an import.
2. Under **Put it at**, **Click a point** in the 3D view, **Pick on the map**, or type the **Position of the model origin** as E N H in the project coordinate system or as lat, lon, h.
3. Use the handle (**Move**, **Turn**, **Tilt**, **Scale**) or the fields (**East offset**, **North offset**, **Up offset**, **Heading**, **Tilt forward**, **Tilt sideways**, **Scale**). **Drop to ground** sets the height to what is under the origin.
4. Click **Done**. The previous manifest is kept as `manifest.json.bak`. **Undo** and **Reset** are there until then.

**Drop to ground** is the quick way to set a model's height: right-click the model in **Datasets** and pick **Drop to ground**. It uses the same placement as **Place model**: the model's lowest point goes onto the ground, and the georeference and the placed state are saved as **Place model** saves them. The ground is the DSM under the model's footprint if there is one, otherwise the project ground level. Use **Place model** for the rest (**Move**, **Turn**, **Tilt**, **Scale**); it keeps its own **Drop to ground** for the height under the origin.

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
- Dense clutter, partial scans and ambiguous shaft sections can still need a tighter region of interest and manual review. A valid 3D file does not establish that its proportions or component counts match the asset.
- The check that photos show the same asset uses colour and camera distance only.
- Models in the 3D view draw each component separately (about 1.7 draws per component), not yet merged into one batch.
- Meshes used as a source are sampled without their colours.
- Warning light lenses are red only.
- Joint rings on a shaft are drawn with flat facets.
- On towers the ladder follows the nearest axis of the structure.
- Placement through Web Mercator (EPSG:3857) is approximate away from the anchor, about 3 mm at 100 m at mid latitudes; the app says so.
- When two people change components of the same model at the same time on different computers, the later change keeps the whole component list and the other change is lost: the project journal records the list as one value, not one entry per component.
- Source-based placement retains the cloud's coordinate system, project origin and effective height offset once. Reopening or importing into a project with another origin re-expresses those coordinates. The project still does not establish a surveyed vertical datum; inspect the overlay when the source datum is uncertain.
- Detailed cabling, enclosure backs, roof shapes and obscured equipment can remain simplified. A valid, selectable GLB does not establish parity with a manually detailed reference model or validate a live AI provider run.
- Drawing-free component discovery currently targets monopole equipment. Partial views, small devices and dense crowns can leave components missing or unclassified; the result does not establish an exact inventory. Sideways roll is not represented and remains a review warning when detected.

The full list is in the known limits that come with the app's documentation.

Drawing-free platform fitting separates nearby observed horizontal layers before building an outline. Close overlapping faces may be a deck's upper and lower surfaces; these are reconciled as one platform with an ambiguity note. Thickness, grating construction and obscured connections remain inferred. Short mount gaps are checked against the observable span between the enclosure and support, while unsupported or ambiguous relationships remain unresolved.

## Request a model correction

Open the engineering model review and select **Corrections**. The scene stays visible alongside the request and the proposed change.

Unsaved comments and location pins remain when you switch workbench tabs or fold the sidebar. **Discard draft** clears unsaved feedback. If you leave before placing a pin, **Place pin** lets you resume picking a location.

1. Select a component in the scene or the part list. For missing equipment, choose **Location pin**, show the source cloud if needed, and click a real model or cloud surface. Set a small review radius around the missing item.
2. Describe the discrepancy and select relevant prepared source images. **Save request** stores the comment, target, camera and evidence references in this modelling run. Saving alone does not send anything to AI.
3. Choose **Send to AI**. Review the normal AI send preview. Cloud AI must be permitted for the source types used by this model; local models keep those inputs on the computer. Only the submitted requests and their selected component records are exposed through the correction tools. Attached prepared images have their own send approval.
4. When a proposal arrives, switch between **Before** and **After** in the same camera view. Changed parts are highlighted. The current model stays unchanged until **Accept correction**. **Reject correction** leaves it unchanged; a reply reopens the request for another proposal.
5. Acceptance saves the corrected geometry and rebuilds the GLB while retaining component IDs and the model coordinate frame. Older proposals become stale if the model changes and must be requested again. Requests and replies remain available when reopening the run.

A part request can replace or remove that selected component. A pin request can add components inside its review radius. This workflow uses the app's parametric engineering models; an arbitrary imported GLB without those component records must first be modelled. Corrections preserve the existing placement and scale, including any uncertainty in the height datum. Acceptance is a human review decision, not a new survey measurement. Geometry-dependent validation results are cleared after acceptance and require validation again.
