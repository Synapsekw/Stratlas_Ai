import { describe, expect, it } from 'vitest';
import { describeGlobe, globeProbeProblem } from './globe-probe.mjs';

const BASE = 'file:///C:/Program%20Files/App/resources/app.asar/out/renderer/';
const good = {
  globe: {
    url: `${BASE}index.html`,
    ready: true,
    workers: [`${BASE}cesium/Workers/createVerticesFromHeightmap.js`],
    workerErrors: [],
    errors: [],
    wasm: { url: `${BASE}cesium/ThirdParty/draco_decoder.wasm`, bytes: 285000, exports: 12 },
  },
};
const with_ = (patch) => ({ globe: { ...good.globe, ...patch } });

describe('packaged Globe probe', () => {
  it('passes a Globe that drew with the package workers and compiled the decoder', () => {
    expect(globeProbeProblem(good)).toBeNull();
    expect(describeGlobe(good)).toBe(
      'the Globe drew its first tiles with 1 Cesium workers (createVerticesFromHeightmap.js) and compiled draco_decoder.wasm (285000 bytes)',
    );
  });

  it.each([
    [{}, /no Globe answer/],
    [
      { globe: { error: 'The Globe probe did not answer within 60 s.' } },
      /probe failed: The Globe/,
    ],
    [with_({ workers: [] }), /started no CesiumJS worker/],
    [with_({ workers: ['blob:file:///1234'] }), /not one of the package's: blob:/],
    [with_({ workers: ['https://cdn.example/w.js'] }), /not one of the package's/],
    [with_({ workerErrors: ['w.js: failed to load'] }), /worker failed: w\.js/],
    [with_({ errors: ['CSP worker-src file:///x'] }), /raised errors: CSP/],
    [with_({ ready: false }), /did not draw its first tiles/],
    [with_({ wasm: null }), /did not try the WebAssembly/],
    [with_({ wasm: { url: 'x.wasm', error: 'could not be read' } }), /did not load \(x\.wasm\)/],
    [with_({ wasm: { url: 'x.wasm', bytes: 0, exports: 0 } }), /is empty/],
  ])('fails %#', (report, message) => {
    expect(globeProbeProblem(report)).toMatch(message);
  });
});
