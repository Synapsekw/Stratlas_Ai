# Add-on builder

`build-addon.mjs` packs a folder of model files into an add-on archive, `<id>-<version>.aioaddon`: a gzipped tar with `addon.json` (`aio.addon/1`, `packages/schema/src/addons.ts`) and the files at its root. It also writes the add-on's entry in a catalogue (`catalogue.json`, `aio.addon-catalogue/1`), which the app reads from the add-on address (Settings `addons.baseUrl`, or `QUADRION_ADDONS_URL`).

```bash
node tools/addons/build-addon.mjs <folder> --info info.json --out dist/addons \
  --catalogue dist/addons/catalogue.json --url-prefix https://downloads.example/addons/
```

`info.json` holds `id`, `name`, `version`, `kind` (`detector`, `segmenter` or `point-classifier`), `licence`, `source`, and optionally `description` and `minPipelinePack`. Every file under the folder is listed with its size and SHA-256. Each kind needs its own files:

- `detector`: `model.onnx` and `model.json` (an `aio.detector/1` card whose `sha256` is the model's).
- `segmenter`: `encoder.onnx`, `decoder.onnx` and `model.json` (name, licence, `input`).
- `point-classifier`: `classifier.json` (`aio.point-classifier/1`, PDAL SMRF settings).

Every `.onnx` file must hold its own weights: the app refuses a model with ONNX external data (a tensor whose `data_location` is EXTERNAL or that has `external_data` entries), since onnxruntime would then open files the manifest does not list. Save such a model with its data inside (`onnx.save_model(m, path, save_as_external_data=False)`, under 2 GB).

Without `--catalogue` the entry is printed. Without `--url-prefix` the archive's address is its file name, relative to the catalogue. Upload the archive and `catalogue.json` side by side.

Tests build fake archives with `apps/desktop/src/main/addons/addon.fakes.ts` (`fakeAddonArchive`), which also writes what this builder never does: a tampered file, an unlisted entry, a `..`.

## A local test address

`pnpm addons:serve [--port 4747] [--out <dir>] [--sam <folder>]` (`serve.mjs`) builds three test add-ons with this builder and serves them with their `catalogue.json` on 127.0.0.1 only, for trying Settings, Models and detection, Add-ons before anything is published:

- Road defects: the synthetic marker detector of the demos (`tools/demo/onnx-test-model.mjs`), not a road model.
- Ground classifier: `classifier.json` with PDAL SMRF settings.
- Segmentation: the real MobileSAM files from `--sam`, `QUADRION_SAM_DIR`, or the newest `runtime/pipeline-pack-*/models/sam` in the data folder the app's settings name; otherwise the synthetic colour segmenter of the tests. The output says which.

The archives go to `--out` (default `quadrion-addons-serve` in the system temp folder), never into the repository. The port is `--port`, `QUADRION_ADDONS_PORT` or 4747. Give the printed address to the app with `$env:QUADRION_ADDONS_URL = '<address>'; pnpm dev`, or paste it into Add-ons, Add-on address. `serve.test.mjs` starts it, reads the catalogue and installs one add-on with the app's installer.
