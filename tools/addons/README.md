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

Without `--catalogue` the entry is printed. Without `--url-prefix` the archive's address is its file name, relative to the catalogue. Upload the archive and `catalogue.json` side by side.

Tests build fake archives with `apps/desktop/src/main/addons/addon.fakes.ts` (`fakeAddonArchive`), which also writes what this builder never does: a tampered file, an unlisted entry, a `..`.
