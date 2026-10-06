/**
 * The Electron side of local detection: the utility process (`utilityProcess.fork` of
 * `inferenceWorker.js`, with the memory cap from Settings), photo decoding with Electron's own
 * codec, the model folders, and the project and pass access `registerInferenceIpc` needs. One
 * inference process serves detection and mask assist; it starts on first use.
 */
import { brand } from '@aio/brand';
import type { DetectionsFile, IpcEvent, Settings } from '@aio/schema';
import { DetectionsFile as DetectionsFileSchema } from '@aio/schema';
import { app, nativeImage, utilityProcess } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { utilityLog } from '../diagnostics/electron';
import { DETECTIONS_DIR, writeDetectionPass } from '../detections';
import type { DecodedImage } from '../maskAssist';
import type { ProjectRegistry } from '../project';
import { readManifest } from '../project';
import { resolveInside } from '../protocol/paths';
import type { InferenceEnv } from './index';
import { createInferenceHost, remoteOrt, type ChildLike, type InferenceHost } from './utility';
import type { FromWorker, ToWorker } from './worker';

/** Default memory cap of the inference process (V8 heap; onnxruntime's own memory is native). */
export const DEFAULT_MEMORY_CAP_MB = 4096;

let currentSettings: () => Settings | undefined = () => undefined;
let host: InferenceHost | null = null;

function spawnWorker(): ChildLike {
  const cap = currentSettings()?.inference?.memoryCapMb ?? DEFAULT_MEMORY_CAP_MB;
  const child = utilityProcess.fork(join(import.meta.dirname, 'inferenceWorker.js'), [], {
    serviceName: `${brand.productName} detection`,
    stdio: 'pipe',
    execArgv: [`--max-old-space-size=${String(cap)}`],
  });
  const log = utilityLog();
  child.stdout?.on('data', (b: Buffer) => log?.write('info', [b.toString('utf8').trimEnd()]));
  child.stderr?.on('data', (b: Buffer) => log?.write('error', [b.toString('utf8').trimEnd()]));
  // messages wait until the process is up
  let ready = false;
  const queue: ToWorker[] = [];
  child.once('spawn', () => {
    ready = true;
    for (const m of queue.splice(0)) child.postMessage(m);
  });
  return {
    postMessage(m) {
      if (ready) child.postMessage(m);
      else queue.push(m);
    },
    onMessage(fn) {
      child.on('message', (m: FromWorker) => {
        fn(m);
      });
    },
    onExit(fn) {
      child.on('exit', (code) => {
        fn(code);
      });
    },
    kill() {
      child.kill();
    },
  };
}

/** The one inference process host of this app. */
export function inferenceHost(): InferenceHost {
  host ??= createInferenceHost(spawnWorker);
  return host;
}

/** onnxruntime for mask assist, running in the inference process (null when unavailable). */
export async function inferenceOrt() {
  const provider = () => currentSettings()?.inference?.provider ?? 'auto';
  const probe = await inferenceHost()
    .probe(provider())
    .catch(() => null);
  return probe?.available ? remoteOrt(inferenceHost(), provider) : null;
}

/** A photo decoded with Electron's codec, scaled to at most `maxSide`, as RGBA. */
export function decodeImage(path: string, maxSide: number): Promise<DecodedImage> {
  const img = nativeImage.createFromPath(path);
  if (img.isEmpty()) return Promise.reject(new Error(`Could not decode ${path}`));
  const { width, height } = img.getSize();
  const s = Math.min(1, maxSide / Math.max(width, height));
  const scaled =
    s < 1
      ? img.resize({
          width: Math.round(width * s),
          height: Math.round(height * s),
          quality: 'good',
        })
      : img;
  const size = scaled.getSize();
  // toBitmap is BGRA on every platform Electron supports here: swap to RGBA
  const bgra = scaled.toBitmap();
  const rgba = new Uint8Array(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2] ?? 0;
    rgba[i + 1] = bgra[i + 1] ?? 0;
    rgba[i + 2] = bgra[i] ?? 0;
    rgba[i + 3] = bgra[i + 3] ?? 255;
  }
  return Promise.resolve({
    width,
    height,
    scaledWidth: size.width,
    scaledHeight: size.height,
    rgba,
  });
}

export interface ElectronInferenceDeps {
  registry: ProjectRegistry;
  settings: () => Settings;
  /** The pipeline pack folder, or null. */
  packDir: () => Promise<string | null>;
  send: (event: IpcEvent<'inference:progress'>) => void;
}

/** The environment `registerInferenceIpc` runs in, inside the app. */
export function electronInference(deps: ElectronInferenceDeps): { env: InferenceEnv } {
  currentSettings = deps.settings;
  const env: InferenceEnv = {
    settings: () => deps.settings().inference,
    host: inferenceHost,
    dirs: async () => {
      // an empty folder setting means the default
      const custom = deps.settings().inference?.modelsDir?.trim();
      const pack = await deps.packDir();
      return {
        user:
          custom !== undefined && custom !== ''
            ? custom
            : join(app.getPath('userData'), 'models', 'detect'),
        pack: pack ? join(pack, 'models', 'detect') : null,
      };
    },
    project: async (projectId) => {
      if (deps.registry.package(projectId))
        return {
          error: 'This project is a read-only package. Detections are not saved into it.',
        };
      const root = deps.registry.root(projectId);
      if (root === undefined)
        return { error: `Project "${projectId}" is not open. Open it, then try again.` };
      const m = await readManifest(root);
      return m.ok ? { root, manifest: m.value } : { error: m.error };
    },
    decode: async (root, rel, maxSide) => {
      const r = await resolveInside(root, rel);
      if (!r.ok) throw new Error(`The photo ${rel} is not in this project.`);
      return decodeImage(r.path, maxSide);
    },
    readPass: async (root, name): Promise<DetectionsFile | null> => {
      try {
        const raw: unknown = JSON.parse(await readFile(join(root, DETECTIONS_DIR, name), 'utf8'));
        const parsed = DetectionsFileSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    writePass: writeDetectionPass,
    progress: deps.send,
    now: () => new Date().toISOString(),
    log: (message) => {
      utilityLog()?.write('info', [message]);
    },
  };
  return { env };
}
