# Local detection with ONNX models

{product} can find defects in photos with a detection model on this computer, instead of cloud vision. Nothing leaves this computer and there is no cost. No model comes with {product}: you import one, with a model card that states its licence.

## Detection models in Settings

Open **Settings**, **AI providers** and scroll to **Detection models**.

- The first line says whether local detection can run, for example "onnxruntime 1.30.0 on DirectML (graphics card)". On a Mac it runs on **Core ML**; without a usable graphics card, on **CPU**.
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

Licences that allow use in a commercial app pass (for example MIT, BSD or Apache-2.0). Copyleft and non-commercial licences are refused. Weights trained with Ultralytics YOLO are AGPL-3.0 unless you hold an Ultralytics Enterprise licence; then set the card's licence to `LicenseRef-Ultralytics-Enterprise`.

## Import a model

1. Read the note under the import button, then tick **I may use the model I import under the licence on its model card**.
2. Click **Import model** and pick `model.onnx` or `model.json`.
3. {product} checks the card, the file and its checksum, and loads the model once. Then it reads, for example, "Imported Marker test detector."

The model's card shows its layout, input size and file size, **Classes**, **Licence** and **Source**. **Remove** takes the model away again.

A model that does not load gives an exact reason, for example "The model could not be loaded: ...". {product} keeps running.

The demo change site has a small test detector in its `sources/marker-detector` folder. It finds the magenta survey markers painted on the ground in the demo photos.

## Detect with a local model

1. Click **Detections** in the sidebar. **Ctrl**+click a few photos, or select none.
2. Click **Detect with AI**.
3. Under **Detect with**, pick **Local model**. {product} remembers the choice. The dialog reads, for example, "Runs on this computer with DirectML (graphics card). Nothing leaves this computer. Free."
4. Pick the **Photos to check**: the selected photos, the photo in the editor, or all photos without detections.
5. Pick the **Model** and set the **Lowest confidence**.
6. For large photos, keep **Split large photos into tiles** on and set the **Tile size** and **Overlap** in pixels.
7. Under **Classes**, map each model class to a class of this project, or **Keep the model's name**.
8. Click **Run on** N **photos**.

The dialog counts "x of N photos checked" with the proposals found, and "Cost: free, on this computer". **Stop** finishes the photo in hand ("Stopping after this photo"). **Run the remaining** N checks the photos that were not reached.

When it is **Done**, click **Review the results**. The proposals are waiting detections from the model, with their confidence. Accept or reject them as usual (see [Review detections](08-building-projects.md#review-detections)). Nothing counts until you accept it.

Local models check photos only, not video frames.

## Not available

"Local detection is not available: ..." says why. On a Mac with an Intel processor local detection does not run. Use cloud vision instead (see [Detect with AI](08-building-projects.md#detect-with-ai)).
