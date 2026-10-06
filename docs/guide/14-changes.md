# Changes between two dates

A project surveyed twice can list what changed between the two surveys: new, grown and resolved issues, new or missing objects, moved fences, cut and fill. {product} proposes each change. Nothing changes an issue until you confirm it.

Everything runs on this computer. Nothing is sent anywhere.

## Try it on the demo

The library has a synthetic project, **Demo change site (2 dates)**, surveyed on 2 March 2026 and 13 April 2026. Between the dates a shelter was built, a container was taken away, a pump skid moved, a stockpile grew, a pit was dug and a new track was laid. One issue was repaired, one grew and one is new.

Open it and follow the steps in this chapter.

## Survey dates of layers

Changes compare the layers of one survey date with the layers of another. {product} reads a layer's date from its name, or from the date you give it. In a project with two or more dates:

- After an import, pick the **Survey date** the new layers belong to. **Not dated** leaves the date to the layer names.
- For a layer already in the project, select it in **Datasets** and pick its date in **Belongs to date...** on the **Selection** card. **Work it out from the name** goes back to the date in the name.

A project with one survey date shows "This project has one survey date. Changes need two."

## Show changes

1. Open the project on **Scene** and click **Compare dates** (see [Compare dates](04-compare-dates.md)).
2. Click **Show changes** (the flag) beside **Compare dates**. The right panel opens on the **Changes** tab.
3. Pick the dates in **Earlier survey** and **Later survey**. They start on the two dates the views show.

Pins and outlines of the changes show on both views. On the earlier view, an item that only the later date has shows faint. **Hide changes** takes them off.

## Find changes

Click **Find changes**. It compares the issues, the detections and the map layers of the two dates. While it runs the panel reads "Finding changes" with the step; **Cancel** stops it.

The other buttons compare the data itself. Each runs as a job (see [Run a job](08-building-projects.md#run-a-job)) and adds its results to the list when it finishes:

- **Run imagery change** and **Run surface change**: see [Imagery and surface change](15-imagery-and-surface-change.md).
- **Run cloud change** and **Run model change**: see [Point cloud and 3D model change](16-cloud-and-model-change.md).
- **Find changes in matched frames**: see [Same view on another date](17-frames.md#find-changes-in-matched-frames).

A greyed button says why in its tool tip, for example "Not available for these dates: Imagery change needs an ortho on each date."

When you run a comparison again, your reviews of the same changes are kept.

## Read the list

The top of the panel reads, for example, "9 changes · 6 to review", with a count per verdict.

Each row shows the verdict, the name and the review state (**To review**, **Confirmed** or **Dismissed**). A second line gives the detail: the issue codes on each date, "Size 0.4 to 0.6 m²", "Severity 2 to 3", or how the dates were matched ("Matched by ...").

| Kind        | Verdicts                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Issues      | **New**, **Resolved**, **Not seen**, **Grown**, **Smaller**, **Worse**, **Better**, **Unchanged**             |
| Detections  | **New**, **Resolved**, **Grown**, **Smaller**, **Unchanged**: counts per class on each date                   |
| Map layers  | **Added**, **Removed**, **Moved** (with the distance), **Reshaped**, **Details changed** (a property changed) |
| Regions     | **Changed** (imagery), **Cut** and **Fill** (surfaces), **Added**, **Removed** and **Changed** (point clouds) |
| Model parts | **Added**, **Removed**, **Moved**, **Changed**, **Unchanged**                                                 |
| Frames      | **Changed**: a difference between two photos of the same view                                                 |

**Not seen** means the later survey did not look at the place, so {product} cannot tell whether the issue is still there. It never reports such an issue as resolved.

Narrow the list with **Kind**, **Change**, **Review**, **Hide unchanged** and **Search changes**. **Sort** orders it **By change**, **By kind**, **By strength** or **By name**.

## Review a change

Click a row (or select it and press **Enter**). The view flies to it; while you compare, both views go there. Then:

- **Confirm**: you agree with the change. Matched issues get one track across the dates ("Tracked across both dates").
- **Close as resolved** (on a **Resolved** issue): {product} asks "Close ... as resolved on ...?". Click **Yes, close it** to close the issue on the later date. Only you can do this; {product} never closes an issue on its own.
- **Make issue**: makes a draft issue on the later date from the change, for example a new object or a moved fence. Issue rows already have their issue, so they do not offer it. **Open issue** shows the issue.
- **Dismiss**: not a real change. **Review again** takes a decision back.
- **Note**: type why, or what to do next, and click **Save note**.

Reviews are saved with the project and are still there when you open it again.

## Ask the agent

The agent can read the changes too. Ask, for example, "What changed between the two surveys?" or "Show me the new issues". It lists the changes, flies to one, and runs **Find changes** after you approve the step. See [AI agent](07-ai-agent.md).

## Changes in a package

A package carries the changes found before it was exported. When it opens read-only, the panel shows **Read only**: you can read and filter the changes, but not run comparisons or review them.
