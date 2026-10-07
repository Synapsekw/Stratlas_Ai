/**
 * The packaged-app smoke report (tools/release/smoke-packaged.mjs). With `STRATLAS_SMOKE=1` the
 * app exits once its UI loaded; when `STRATLAS_SMOKE_REPORT` names a file it first asks for the
 * local detection runtime the way Settings does (`inference:models` from the window, through the
 * preload bridge, main and the inference utility process) and writes the answer there. The
 * release script checks the answer: onnxruntime must load from the unpacked app and report a
 * version and its execution providers. It also asks the window to `eval`, which the app policy
 * (csp.ts, a `<meta>` in the built page) must refuse.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Load the runtime and answer, at most this long (a cold start loads the native libraries). */
export const SMOKE_PROBE_MS = 30_000;

export interface SmokeReport {
  /** The `inference:models` answer, or why it did not come. */
  inference: unknown;
  /** `renderer`: through the window like Settings; `main`: the window call failed, main asked. */
  via: 'renderer' | 'main';
  rendererError?: string;
  /** The window's policy and what `eval('1')` did there (`CSP_PROBE`), or why it did not answer. */
  csp?: unknown;
}

export interface SmokeProbeDeps {
  /** `inference:models` from the window (preload `window.aio.invoke`). */
  fromRenderer: () => Promise<unknown>;
  /** The same answer from main, when the window call itself fails. */
  fromMain: () => Promise<unknown>;
  /** `CSP_PROBE` run in the window. */
  csp?: () => Promise<unknown>;
  timeoutMs?: number;
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

/** Ask for the runtime; never throws (a failure is part of the report). */
export async function smokeProbe(deps: SmokeProbeDeps): Promise<SmokeReport> {
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
