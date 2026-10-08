/**
 * The packaged-app smoke report (tools/release/smoke-packaged.mjs). With `QUADRION_SMOKE=1` the
 * app exits once its UI loaded; when `QUADRION_SMOKE_REPORT` names a file it first asks for the
 * local detection runtime the way Settings does (`inference:models` from the window, through the
 * preload bridge, main and the inference utility process) and writes the answer there. The
 * release script checks the answer: onnxruntime must load from the unpacked app and report a
 * version and its execution providers. It also asks the window to `eval`, which the app policy
 * (csp.ts, a `<meta>` in the built page) must refuse, and opens the Globe (`GLOBE_PROBE`): CesiumJS
 * must start its workers and compile its WebAssembly decoders from inside the package.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Load the runtime and answer, at most this long (a cold start loads the native libraries). */
export const SMOKE_PROBE_MS = 30_000;

/** Open the Globe and wait for its first tiles, at most this long. */
export const GLOBE_PROBE_MS = 60_000;

export interface SmokeReport {
  /** The `inference:models` answer, or why it did not come. */
  inference: unknown;
  /** `renderer`: through the window like Settings; `main`: the window call failed, main asked. */
  via: 'renderer' | 'main';
  rendererError?: string;
  /** The window's policy and what `eval('1')` did there (`CSP_PROBE`), or why it did not answer. */
  csp?: unknown;
  /** What opening the Globe did (`GLOBE_PROBE`), or why it did not answer. */
  globe?: unknown;
}

export interface SmokeProbeDeps {
  /** `inference:models` from the window (preload `window.aio.invoke`). */
  fromRenderer: () => Promise<unknown>;
  /** The same answer from main, when the window call itself fails. */
  fromMain: () => Promise<unknown>;
  /** `CSP_PROBE` run in the window. */
  csp?: () => Promise<unknown>;
  /** `GLOBE_PROBE` run in the window, after the runtime answered. */
  globe?: () => Promise<unknown>;
  timeoutMs?: number;
  globeTimeoutMs?: number;
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1000);

function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not answer within ${String(Math.round(ms / 1000))} s.`));
    }, ms);
  });
  return Promise.race([p, late]).finally(() => {
    clearTimeout(timer);
  });
}

/** Ask for the runtime, then open the Globe; never throws (a failure is part of the report). */
export async function smokeProbe(deps: SmokeProbeDeps): Promise<SmokeReport> {
  const report = await runtimeProbe(deps);
  if (!deps.globe) return report;
  try {
    return {
      ...report,
      globe: await within(deps.globeTimeoutMs ?? GLOBE_PROBE_MS, deps.globe(), 'The Globe probe'),
    };
  } catch (e) {
    return { ...report, globe: { error: text(e) } };
  }
}

async function runtimeProbe(deps: SmokeProbeDeps): Promise<SmokeReport> {
  const ms = deps.timeoutMs ?? SMOKE_PROBE_MS;
  let csp: { csp?: unknown } = {};
  if (deps.csp) {
    try {
      csp = { csp: await within(ms, deps.csp(), 'The CSP probe') };
    } catch (e) {
      csp = { csp: { error: text(e) } };
    }
  }
  try {
    return {
      inference: await within(ms, deps.fromRenderer(), 'inference:models from the window'),
      via: 'renderer',
      ...csp,
    };
  } catch (e) {
    const rendererError = text(e);
    try {
      return {
        inference: await within(ms, deps.fromMain(), 'The inference process'),
        via: 'main',
        rendererError,
        ...csp,
      };
    } catch (e2) {
      return { inference: { error: text(e2) }, via: 'main', rendererError, ...csp };
    }
  }
}

/** Write the report where the release script reads it. */
export async function writeSmokeReport(path: string, report: SmokeReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/** The script that asks for the runtime from the window (the preload bridge is `window.aio`). */
export const RENDERER_PROBE = "window.aio.invoke('inference:models', {})";

/**
 * Run in the window like page code (`executeJavaScript`, not DevTools evaluation, which is exempt
 * from the eval policy): the policy the page carries and what `eval('1')` does under it.
 */
export const CSP_PROBE = `(() => {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  let result = 'allowed';
  try { eval('1'); } catch (e) { result = e.name + ': ' + e.message; }
  return { url: location.href, meta: meta ? meta.getAttribute('content') : null, eval: result };
})()`;

/**
 * Run in the window like page code: open the Globe from the sidebar and wait until its first tiles
 * are drawn (`GlobeController.inspect()`, the `__aioGlobe` hook), noting every worker CesiumJS
 * starts and any worker error, page error or CSP violation on the way; then fetch Cesium's Draco
 * decoder the way Cesium does (XMLHttpRequest beside the page, from inside app.asar when packaged)
 * and compile it under the policy's `'wasm-unsafe-eval'`.
 */
export const GLOBE_PROBE = `(async () => {
  const out = { url: location.href, ready: false, workers: [], workerErrors: [], errors: [], wasm: null };
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(u, o) {
      super(u, o);
      out.workers.push(String(u));
      this.addEventListener('error', (e) => out.workerErrors.push(String(u) + ': ' + (e.message || 'failed to load')));
    }
  };
  const onError = (e) => out.errors.push(String(e.message || e.type));
  const onCsp = (e) => out.errors.push('CSP ' + e.effectiveDirective + ' ' + e.blockedURI);
  window.addEventListener('error', onError);
  document.addEventListener('securitypolicyviolation', onCsp);
  try {
    const nav = [...document.querySelectorAll('.sb-nav .nav-item')].find((b) => /Globe/.test(b.textContent || ''));
    if (!nav) return { ...out, error: 'no Globe in the sidebar' };
    nav.click();
    const until = Date.now() + 50000;
    while (Date.now() < until) {
      const el = document.querySelector('[data-testid="globe-canvas"]');
      const state = el && el.__aioGlobe ? el.__aioGlobe.inspect() : null;
      if (state && state.tilesLoaded && out.workers.length > 0) { out.ready = true; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    const url = new URL('cesium/ThirdParty/draco_decoder.wasm', location.href).href;
    try {
      const buf = await new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('GET', url);
        x.responseType = 'arraybuffer';
        x.onload = () => (x.response && x.response.byteLength ? resolve(x.response) : reject(new Error('empty answer')));
        x.onerror = () => reject(new Error('could not be read'));
        x.send();
      });
      const m = await WebAssembly.compile(buf);
      out.wasm = { url, bytes: buf.byteLength, exports: WebAssembly.Module.exports(m).length };
    } catch (e) {
      out.wasm = { url, error: String(e && e.message ? e.message : e) };
    }
    return out;
  } finally {
    window.Worker = W;
    window.removeEventListener('error', onError);
    document.removeEventListener('securitypolicyviolation', onCsp);
  }
})()`;
