/**
 * The inference utility process (BLD-10): onnxruntime sessions, one per model and kept warm, plus
 * pre- and post-processing. Main talks to it with the messages below (`utility.ts` is the host;
 * `workerMain.ts` is the process entry). This module has no Electron import, so tests run the
 * same core in-process with a fake runtime (the `OrtLike` seam of mask assist).
 *
 * Execution providers, in order: DirectML (Windows), CoreML (macOS), CPU. When the preferred one
 * cannot load the model the session falls back to CPU, and the provider in use is reported.
 */
import type { DetectorModelCard, InferenceRuntime } from '@aio/schema';
import type { OrtSession, OrtTensor } from '../maskAssist';
import { detectImage } from './detect';
import type { NamedTensor } from './layouts';
import type { ScoredBox } from './nms';
import type { RgbaImage } from './tile';

export type Provider = NonNullable<InferenceRuntime['provider']>;
export type ProviderSetting = 'auto' | 'cpu';

/** The part of onnxruntime-node the worker uses (a superset of mask assist's `OrtLike`). */
export interface OrtNodeLike {
  InferenceSession: {
    create(
      model: string | Uint8Array,
      options?: { executionProviders?: string[] },
    ): Promise<OrtSession>;
  };
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor;
  listSupportedBackends?: () => readonly { name: string }[];
  env?: { versions?: Record<string, string | undefined> };
}

/** A tensor as it crosses the process boundary. */
export interface WireTensor {
  data: Float32Array;
  dims: number[];
}

export type ToWorker =
  | { type: 'probe'; id: number; provider: ProviderSetting }
  | { type: 'open'; id: number; path: string; provider: ProviderSetting }
  | { type: 'run'; id: number; session: string; feeds: Record<string, WireTensor> }
  | {
      type: 'detect';
      id: number;
      session: string;
      image: RgbaImage;
      card: DetectorModelCard;
      minConfidence: number;
      tile?: { size: number; overlap: number };
      scale?: number;
    }
  | { type: 'close'; id: number; path: string };

export interface ProbeResult {
  available: boolean;
  provider?: Provider;
  version?: string;
  /** Execution providers this onnxruntime build lists (`cpu`, `dml`, `coreml`, ...). */
  backends?: string[];
  problem?: string;
}

export interface OpenResult {
  session: string;
  inputNames: string[];
  outputNames: string[];
  provider: Provider;
}

export type FromWorker =
  { type: 'result'; id: number; value: unknown } | { type: 'error'; id: number; message: string };

/** The provider to try first on this platform. */
export function preferredProvider(
  setting: ProviderSetting,
  platform: NodeJS.Platform,
  backends: readonly string[],
): Provider {
  if (setting === 'cpu') return 'cpu';
  if (platform === 'win32' && backends.includes('dml')) return 'dml';
  if (platform === 'darwin' && backends.includes('coreml')) return 'coreml';
  return 'cpu';
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

function toWire(t: OrtTensor): WireTensor {
  const d = t.data;
  return { data: d instanceof Float32Array ? d : Float32Array.from(d), dims: [...t.dims] };
}

export interface WorkerCore {
  handle(msg: ToWorker): Promise<FromWorker>;
}

export function createWorkerCore(
  loadOrt: () => Promise<OrtNodeLike | null>,
  platform: NodeJS.Platform = process.platform,
): WorkerCore {
  let ort: OrtNodeLike | null | undefined;
  let loadProblem = '';
  /** Session key (`<provider>|<path>`) to its session. */
  const sessions = new Map<string, { s: OrtSession; provider: Provider }>();

  async function runtime(): Promise<OrtNodeLike | null> {
    if (ort === undefined) {
      try {
        ort = await loadOrt();
        if (!ort) loadProblem = 'The ONNX runtime is not installed in this build.';
      } catch (e) {
        ort = null;
        loadProblem = `The ONNX runtime could not be loaded: ${message(e)}`;
      }
    }
    return ort;
  }

  const backends = (o: OrtNodeLike) => (o.listSupportedBackends?.() ?? []).map((b) => b.name);

  async function open(path: string, setting: ProviderSetting): Promise<OpenResult> {
    const o = await runtime();
    if (!o) throw new Error(loadProblem);
    const want = preferredProvider(setting, platform, backends(o));
    const key = `${setting}|${path}`;
    let entry = sessions.get(key);
    if (!entry) {
      try {
        entry = {
          s: await o.InferenceSession.create(path, {
            executionProviders: want === 'cpu' ? ['cpu'] : [want, 'cpu'],
          }),
          provider: want,
        };
      } catch (e) {
        if (want === 'cpu')
          throw new Error(`The model could not be loaded: ${message(e)}`, { cause: e });
        // the GPU provider refused the model: CPU always works for a valid model
        try {
          entry = {
            s: await o.InferenceSession.create(path, { executionProviders: ['cpu'] }),
            provider: 'cpu',
          };
        } catch (e2) {
          throw new Error(`The model could not be loaded: ${message(e2)}`, { cause: e2 });
        }
      }
      sessions.set(key, entry);
    }
    return {
      session: key,
      inputNames: [...entry.s.inputNames],
      outputNames: [...entry.s.outputNames],
      provider: entry.provider,
    };
  }

  async function runSession(
    key: string,
    feeds: Record<string, WireTensor>,
  ): Promise<Record<string, WireTensor>> {
    const o = await runtime();
    const entry = sessions.get(key);
    if (!o || !entry) throw new Error('The model is not open any more. Run again.');
    const tensors = Object.fromEntries(
      Object.entries(feeds).map(([k, v]) => [k, new o.Tensor('float32', v.data, v.dims)]),
    );
    const out = await entry.s.run(tensors);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, toWire(v)]));
  }

  async function detect(msg: Extract<ToWorker, { type: 'detect' }>): Promise<ScoredBox[]> {
    const entry = sessions.get(msg.session);
    if (!entry) throw new Error('The model is not open any more. Run again.');
    const inputName = entry.s.inputNames[0] ?? 'images';
    return detectImage(
      msg.image,
      {
        card: msg.card,
        minConfidence: msg.minConfidence,
        ...(msg.tile ? { tile: msg.tile } : {}),
        ...(msg.scale ? { scale: msg.scale } : {}),
      },
      async (input) => {
        const out = await runSession(msg.session, {
          [inputName]: { data: input.data, dims: [...input.dims] },
        });
        return entry.s.outputNames.map((name): NamedTensor => ({
          name,
          dims: out[name]?.dims ?? [],
          data: out[name]?.data ?? new Float32Array(),
        }));
      },
    );
  }

  async function probe(setting: ProviderSetting): Promise<ProbeResult> {
    const o = await runtime();
    if (!o) return { available: false, problem: loadProblem };
    const version = o.env?.versions?.node ?? o.env?.versions?.common;
    const listed = backends(o);
    return {
      available: true,
      provider: preferredProvider(setting, platform, listed),
      ...(version ? { version } : {}),
      ...(listed.length > 0 ? { backends: listed } : {}),
    };
  }

  return {
    async handle(msg) {
      try {
        let value: unknown;
        switch (msg.type) {
          case 'probe':
            value = await probe(msg.provider);
            break;
          case 'open':
            value = await open(msg.path, msg.provider);
            break;
          case 'run':
            value = await runSession(msg.session, msg.feeds);
            break;
          case 'detect':
            value = await detect(msg);
            break;
          case 'close':
            for (const k of [...sessions.keys()])
              if (k.endsWith(`|${msg.path}`)) sessions.delete(k);
            value = true;
            break;
        }
        return { type: 'result', id: msg.id, value };
      } catch (e) {
        return { type: 'error', id: msg.id, message: message(e) };
      }
    },
  };
}
