/**
 * Host of the inference utility process: starts it on first use, matches answers to requests,
 * and starts it again after a crash (a crash fails the requests in flight with an exact message
 * and never takes main down). Generic over the child so tests drive the worker core in-process;
 * `electron.ts` gives it `utilityProcess.fork`.
 */
import type { DetectorModelCard } from '@aio/schema';
import type { OrtLike, OrtSession, OrtTensor } from '../maskAssist';
import type { ScoredBox } from './nms';
import type { RgbaImage } from './tile';
import type {
  FromWorker,
  OpenResult,
  ProbeResult,
  ProviderSetting,
  ToWorker,
  WireTensor,
} from './worker';

/** What the host needs of a child process. */
export interface ChildLike {
  postMessage(msg: ToWorker): void;
  onMessage(fn: (msg: FromWorker) => void): void;
  onExit(fn: (code: number | null) => void): void;
  kill(): void;
}

type Body<T extends ToWorker['type']> = Omit<Extract<ToWorker, { type: T }>, 'id' | 'type'>;

export interface InferenceHost {
  probe(provider: ProviderSetting): Promise<ProbeResult>;
  open(path: string, provider: ProviderSetting): Promise<OpenResult>;
  run(session: string, feeds: Record<string, WireTensor>): Promise<Record<string, WireTensor>>;
  detect(req: {
    session: string;
    image: RgbaImage;
    card: DetectorModelCard;
    minConfidence: number;
    tile?: { size: number; overlap: number };
    scale?: number;
  }): Promise<ScoredBox[]>;
  close(path: string): Promise<void>;
  dispose(): void;
  /**
   * What is known without asking: whether the process runs now, and the last probe answer of
   * this run (null before the first). Never starts the process (diagnostics read this).
   */
  known(): { running: boolean; probe: ProbeResult | null };
}

export function createInferenceHost(spawn: () => ChildLike): InferenceHost {
  let child: ChildLike | null = null;
  let next = 1;
  let lastProbe: ProbeResult | null = null;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

  function ensure(): ChildLike {
    if (child) return child;
    const c = spawn();
    c.onMessage((m) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'result') p.resolve(m.value);
      else p.reject(new Error(m.message));
    });
    c.onExit((code) => {
      if (child !== c) return;
      child = null;
      const err = new Error(
        `The detection process stopped unexpectedly (code ${String(code)}). It starts again on the next run.`,
      );
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    });
    child = c;
    return c;
  }

  function request<T extends ToWorker['type'], R>(type: T, body: Body<T>): Promise<R> {
    const id = next++;
    return new Promise<R>((resolve, reject) => {
      pending.set(id, {
        resolve: (v) => {
          resolve(v as R);
        },
        reject,
      });
      try {
        ensure().postMessage({ ...body, type, id } as unknown as ToWorker);
      } catch (e) {
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  return {
    probe: async (provider) => {
      const r = await request<'probe', ProbeResult>('probe', { provider });
      lastProbe = r;
      return r;
    },
    open: (path, provider) => request('open', { path, provider }),
    run: (session, feeds) => request('run', { session, feeds }),
    detect: (req) => request('detect', req),
    close: async (path) => {
      if (child) await request('close', { path });
    },
    dispose() {
      const c = child;
      child = null;
      c?.kill();
      for (const p of pending.values()) p.reject(new Error('The detection process was closed.'));
      pending.clear();
    },
    known: () => ({ running: child !== null, probe: lastProbe }),
  };
}

/**
 * An `OrtLike` whose sessions live in the inference utility process: mask assist keeps its code
 * and runs its SAM sessions there, off the main thread.
 */
export function remoteOrt(host: InferenceHost, provider: () => ProviderSetting): OrtLike {
  class Tensor implements OrtTensor {
    readonly data: Float32Array;
    readonly dims: readonly number[];
    constructor(_type: 'float32', data: Float32Array, dims: readonly number[]) {
      this.data = data;
      this.dims = dims;
    }
  }
  const wire = (t: OrtTensor): WireTensor => ({
    data: t.data instanceof Float32Array ? t.data : Float32Array.from(t.data),
    dims: [...t.dims],
  });
  return {
    Tensor,
    InferenceSession: {
      async create(path: string): Promise<OrtSession> {
        const opened = await host.open(path, provider());
        return {
          inputNames: opened.inputNames,
          outputNames: opened.outputNames,
          async run(feeds) {
            const out = await host.run(
              opened.session,
              Object.fromEntries(Object.entries(feeds).map(([k, v]) => [k, wire(v)])),
            );
            return out;
          },
        };
      },
    },
  };
}
