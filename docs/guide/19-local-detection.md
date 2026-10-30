# Local detection with ONNX models

{product} can find defects in photos and in 360 video with a detection model on this computer, instead of cloud vision. Nothing leaves this computer and there is no cost. No model comes with {product}: you import one, with a model card that states its licence.

## Detection models in Settings

Open **Settings**, **Models and detection**. **Detection models** comes first.

- The first line says whether local detection can run, for example "onnxruntime 1.30.0 on DirectML (graphics card)". Without a usable graphics card it runs on **CPU**.
- **Run on**: **Graphics card when available** (the default) or **CPU only**. If the graphics card cannot load a model, {product} uses the CPU.
- The models you imported are listed below. "No detection model is installed yet." means there are none.

## The model card

A model is two files in one folder: `model.onnx` and its card `model.json`. The card gives the model's name and version, its output layout (`yolo-v8`, `yolo-v5`, `detr`, `ssd` or `generic`), its input size, its classes, the SPDX licence of the weights, where the weights come from, and the SHA-256 of `model.onnx`. For example:

```
{
  "schema": "aio.detector/1",
  "name": "Marker test detector",
  "version": "1.0.0",
  "layout": "yolo-v8",
  "input": { "width": 640, "height": 640 },
  "classes": ["marker"],
  "licence": "MIT",
  "source": "{product} test fixture",
  "sha256": "..."
}
```

Every model needs a licence on its card: a card with no licence is refused.

- Licences that allow use in a commercial app (for example MIT, BSD or Apache-2.0) import with no note.
- Copyleft licences (for example AGPL-3.0 or GPL-3.0), non-commercial licences (for example CC-BY-NC-4.0) and licences {product} does not know also import, for use inside your own company. The model's row in **Settings** then carries a warning chip, for example "AGPL-3.0 · internal use" or "check its terms", and the import says why. Check those terms before you sell {product} or hand it out with such a model.

Weights trained with Ultralytics YOLO are AGPL-3.0 unless you hold an Ultralytics Enterprise licence. Without one, they import with the "internal use" chip. With one, set the card's licence to `LicenseRef-Ultralytics-Enterprise`: a `LicenseRef-` licence imports with no note.

## Import a model

1. Read the note under the import button, then tick **I may use the model I import under the licence on its model card**.
2. Click **Import model** and pick `model.onnx` or `model.json`.
3. {product} checks the card, the file and its checksum, and loads the model once. Then it reads, for example, "Imported Marker test detector."

The model's card shows its layout, input size and file size, **Classes**, **Licence** and **Source**. **Remove** takes the model away again.

A model that does not load gives an exact reason, for example "The model could not be loaded: ...". {product} keeps running.

The demo change site has a small test detector in its `sources/marker-detector` folder. It finds the magenta survey markers painted on the ground in the demo photos.

## Detect with a local model

1. Click **Inspect** in the sidebar. **Ctrl**+click a few photos, or select none.
2. Click **Ask AI** and pick **This photo**, **Selected** or **All**. With **Automatic** (the default in **Settings**, **AI providers**, **AI for Ask AI**), a local detector for your check runs first, then the local model. Choose **Local only** there to be sure nothing leaves this computer. Nothing is asked and nothing is sent: local runs start at once.
3. The strip at the top counts "k done" as each photo finishes. **Stop** finishes the photo in hand. **Try the n left again** checks the photos that were not reached.

The model, the **Lowest confidence the local model keeps**, **Look at large photos in tiles** with **Tile size (px)** and **Tile overlap (px)**, and the **Local model classes** (each model class mapped to a class of this project, or **Keep the name**) are set once in **Settings**, **AI providers**, **AI for Ask AI**. The photos are not asked about on each run.

When it is done, click **Review n suggestions**. The proposals are AI suggestions with their confidence. Accept or dismiss them as usual (see [Review the AI's suggestions](05-annotation-and-issues.md#review-the-ais-suggestions)). Nothing counts until you accept it.

## Detect on 360 video

A local model also checks frames of a 360 video (a walk under **360 walks** in **Datasets**).

1. Click **Inspect** in the sidebar, then **Ask AI**, and pick **Frames...**.
2. Pick the **Clip or walk**: the **360 video**.
3. Pick **One frame every** 1, 2, 5 or 10 seconds. The dialog shows how many frames that makes, for example "30 frames". A run takes at most 2000 frames; pick a longer interval to cover a longer video. Or pick **Current frame**: the frame the **360 video** pane shows now. It is offered while that pane plays the same video.
4. The model, the lowest confidence and the classes are the ones set in **Settings**, **AI for Ask AI**. Walk frames need the local model. Start the run.

The model looks at the whole 360 frame as it is, the equirectangular picture of the 360 video, not at cut-out views. That keeps one detection per object: a cut-out view would cut objects at its edges and see others twice where views overlap.

- **Tiles across the 360 frame (for small, distant people)** is off by default. On, the model also checks the frame in tiles, so small objects far away are found. The tiles run on across the left and right edge of the frame. It is slower: the model checks every tile of each frame.
- The left and right edges of a 360 frame are the same place behind the camera. An object cut by that seam is found as two halves; {product} joins them into one detection whose box runs across the seam.

The strip counts the frames checked. **Stop** finishes the frame in hand, and **Try the n left again** checks the frames that were not reached.

The suggestions wait in the review queue like those on photos, one per frame, named after the video and the time, for example "Ground floor walk 12.0 s". A box across the seam shows in two parts, at both edges of the frame. Accept or dismiss them as usual; nothing counts until you accept it.

The **360 video** pane draws the detections of the frame nearest to the time you watch, within a second of it, as boxes in the view. Turn to look at them; **Show detections** hides and shows them. The boxes are drawn on the video as it was recorded. While **Level horizon** is on, the pane plays the levelled copy and draws no boxes; a note says to turn **Level horizon** off to see them.

Ordinary video clips (drone or phone video that is not 360) are not checked by local models yet. Use cloud vision for them.

## Not available

"Local detection is not available: ..." says why. In **Inspect**, **Ask AI** then reads "No AI can look at this" with the reason and **Open AI settings**. Use cloud vision instead if the project allows it: pick **Cloud** in **AI for Ask AI** (see [Ask AI](05-annotation-and-issues.md#ask-ai)).
