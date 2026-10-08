// The packaged smoke check's Globe answer (apps/desktop/src/main/smoke.ts, GLOBE_PROBE): in the
// packaged app the renderer, CesiumJS's workers and its WebAssembly decoders load from inside
// app.asar over file://. Opening the Globe must draw its first tiles with at least one Cesium
// worker started from the package's cesium/Workers/, no worker error, page error or CSP
// violation, and Cesium's Draco decoder must read from the package and compile.

/** Why the smoke report's Globe answer is not good enough, or null when it is. */
export function globeProbeProblem(report) {
  const g = report?.globe;
  if (!g || typeof g !== 'object') return 'the smoke report has no Globe answer.';
  if (typeof g.error === 'string') return `the Globe probe failed: ${g.error}`;
  const workers = Array.isArray(g.workers) ? g.workers.map(String) : [];
  if (workers.length === 0) return 'opening the Globe started no CesiumJS worker.';
  const stray = workers.filter((u) => !/^file:.*\/cesium\/Workers\/[^/]+\.js$/.test(u));
  if (stray.length) return `a Globe worker is not one of the package's: ${stray.join(', ')}`;
  const workerErrors = Array.isArray(g.workerErrors) ? g.workerErrors : [];
  if (workerErrors.length) return `a CesiumJS worker failed: ${workerErrors.join('; ')}`;
  const errors = Array.isArray(g.errors) ? g.errors : [];
  if (errors.length) return `the Globe raised errors: ${errors.join('; ')}`;
  if (g.ready !== true) return 'the Globe did not draw its first tiles in time.';
  const wasm = g.wasm;
  if (!wasm || typeof wasm !== 'object') return 'the Globe probe did not try the WebAssembly.';
  if (typeof wasm.error === 'string')
    return `CesiumJS's WebAssembly did not load (${String(wasm.url)}): ${wasm.error}`;
  if (!(wasm.bytes > 0) || !(wasm.exports > 0))
    return `CesiumJS's WebAssembly is empty (${String(wasm.url)}).`;
  return null;
}

/** One line for the log. */
export function describeGlobe(report) {
  const g = report.globe;
  const names = g.workers.map((u) => String(u).replace(/^.*\//, ''));
  return `the Globe drew its first tiles with ${String(names.length)} Cesium workers (${names.join(', ')}) and compiled ${String(g.wasm.url).replace(/^.*\//, '')} (${String(g.wasm.bytes)} bytes)`;
}
