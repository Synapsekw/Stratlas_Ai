/**
 * The packaged-app smoke report (tools/release/smoke-packaged.mjs). With `STRATLAS_SMOKE=1` the
 * app exits once its UI loaded; when `STRATLAS_SMOKE_REPORT` names a file it first asks for the
 * local detection runtime the way Settings does (`inference:models` from the window, through the
 * preload bridge, main and the inference utility process) and writes the answer there. The
 * release script checks the answer: onnxruntime must load from the unpacked app and report a
 * version and its execution providers.
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
}

export interface SmokeProbeDeps {
  /** `inference:models` from the window (preload `window.aio.invoke`). */
  fromRenderer: () => Promise<unknown>;
  /** The same answer from main, when the window call itself fails. */
  fromMain: () => Promise<unknown>;
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
  try {
    return {
      inference: await within(ms, deps.fromRenderer(), 'inference:models from the window'),
      via: 'renderer',
    };
  } catch (e) {
    const rendererError = text(e);
    try {
      return {
        inference: await within(ms, deps.fromMain(), 'The inference process'),
        via: 'main',
        rendererError,
      };
    } catch (e2) {
      return { inference: { error: text(e2) }, via: 'main', rendererError };
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
