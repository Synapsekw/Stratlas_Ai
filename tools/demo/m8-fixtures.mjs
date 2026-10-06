#!/usr/bin/env node
/* eslint-disable no-console -- CLI output */
// Small M8 test files for any stream's tests, written into a folder of the test's own (never the
// data folder): the marker test detector and its error-path twins, a 640 x 640 marker image with
// its exact boxes, and the plot plan DXF with its unitless and broken twins and its raster.
//
//   node tools/demo/m8-fixtures.mjs <dir>
//   import { writeM8Fixtures } from '<repo>/tools/demo/m8-fixtures.mjs';
//
// Everything is synthetic and the same bytes on every run.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTROL,
  brokenDxf,
  planRaster,
  plotPlan,
  plotPlanDxf,
  unitlessDxf,
} from './change-drawing.mjs';
import { encodePng } from './formats.mjs';
import {
  buildMarkerDetector,
  buildWrongLayoutDetector,
  corruptOnnx,
  markerCard,
  markerImage,
} from './onnx-test-model.mjs';

/** Markers of the test image: { x, y, size } top-left pixels, at least 100 px apart. */
export const IMAGE_MARKERS = [
  { x: 40, y: 50, size: 12 },
  { x: 300, y: 310, size: 20 },
  { x: 520, y: 90, size: 28 },
  { x: 150, y: 560, size: 16 },
];

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * Write the fixtures into `dir` and return their paths (relative to `dir`):
 * `detector/`, `detector-wrong-layout/`, `detector-corrupt/` and `detector-no-card/` (each a
 * model.onnx, and a model.json card except the last), `markers.png` with `markers.json`
 * (`{ width, height, boxes: [x0, y0, x1, y1][] }`), and `plot-plan.dxf`, `plot-plan-unitless.dxf`,
 * `plot-plan-broken.dxf`, `plot-plan.png` with `plot-plan.json` (control points, raster placement
 * and the parts a model builder should make).
 */
export async function writeM8Fixtures(dir) {
  const files = {};
  const put = async (rel, data) => {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), data);
    files[rel] = rel;
  };
  const good = buildMarkerDetector();
  await put('detector/model.onnx', good.onnx);
  await put('detector/model.json', json(good.card));
  const wrong = buildWrongLayoutDetector();
  await put('detector-wrong-layout/model.onnx', wrong.onnx);
  await put('detector-wrong-layout/model.json', json(wrong.card));
  const bad = corruptOnnx();
  await put('detector-corrupt/model.onnx', bad);
  await put('detector-corrupt/model.json', json(markerCard(bad, 'Marker test detector (corrupt)')));
  await put('detector-no-card/model.onnx', good.onnx);

  const img = markerImage({ width: 640, height: 640, markers: IMAGE_MARKERS, seed: 3 });
  await put('markers.png', encodePng({ width: 640, height: 640, channels: 3, data: img.rgb }));
  await put('markers.json', json({ width: 640, height: 640, class: 'marker', boxes: img.boxes }));

  await put('plot-plan.dxf', plotPlanDxf());
  await put('plot-plan-unitless.dxf', unitlessDxf());
  await put('plot-plan-broken.dxf', brokenDxf());
  const raster = planRaster();
  await put('plot-plan.png', raster.png);
  await put(
    'plot-plan.json',
    json({
      units: 'm',
      unitless: { file: 'plot-plan-unitless.dxf', units: 'mm' },
      grid: 'drawing X = 1000 + x, drawing Y = 2000 - z (metres)',
      control: CONTROL,
      raster: {
        file: 'plot-plan.png',
        width: raster.width,
        height: raster.height,
        pxM: raster.px,
        topLeftDrawing: raster.origin,
      },
      parts: plotPlan().parts,
    }),
  );
  return files;
}

async function cli() {
  const dir = resolve(process.argv[2] ?? '.');
  const files = await writeM8Fixtures(dir);
  console.log(`M8 fixtures written to ${dir}: ${Object.keys(files).length} files.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
