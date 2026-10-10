/**
 * The renderer's handle on the survey engine worker (M11 G4): G3's `ComparisonRunner` seam wired
 * to G2's TypeScript executor off the UI thread. A run with a key cancels the previous run with the
 * same key (a polygon edited while it computes), so only the latest numbers come back.
 */
import type { ComparisonItem, ComparisonResult, SitePoint } from '@aio/schema';
import type { ComparisonRunner } from '@aio/survey';
import type {
  EngineContext,
  EnginePort,
  EngineReply,
  EngineRequest,
  RunReply,
  RunRequest,
  SiteRequest,
} from './engineProtocol';

/** A run that was cancelled because a newer one replaced it (or the engine stopped). */
export class RunCancelled extends Error {
  constructor() {
    super('The comparison was cancelled.');
    this.name = 'RunCancelled';
  }
}

/**
 * The engine died under its requests (an uncaught error in the worker, a script that did not
 * load, a message that could not be read): what was out fails with this, and the client is done.
 * `compareStore` starts another engine for the next request.
 */
export class EngineStopped extends Error {
  constructor(detail?: string) {
    super(
      `The comparison engine stopped${detail ? ` (${detail})` : ''}. Recompute to start it again.`,
    );
    this.name = 'EngineStopped';
  }
}

export interface SiteReply {
  result: ComparisonResult;
  grid: {
    dz: Float32Array;
    nx: number;
    ny: number;
    x0: number;
    y0: number;
    cellM: number;
  } | null;
}

export interface EngineClient {
  setContext(context: EngineContext): void;
  /** Compare items over a ring; a `key` cancels the previous run with that key. */
  run(req: RunRequest, key?: string): Promise<RunReply>;
  fingerprints(req: RunRequest): Promise<string[]>;
  site(req: SiteRequest, key?: string): Promise<SiteReply>;
  /** G3's seam: one item over one ring, for a capture. */
  runner(capture?: string): ComparisonRunner;
  /** Why the engine died, or null while it runs (and after it was put away on purpose). */
  stopped(): EngineStopped | null;
  /** The context it was last given (for the engine started in its place). */
  context(): EngineContext | null;
  dispose(): void;
}

export function connectEngine(port: EnginePort & { terminate?(): void }): EngineClient {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const keyed = new Map<string, number>();
  let next = 1;
  let closed = false;
  let died: EngineStopped | null = null;
  let known: EngineContext | null = null;
  /** The engine will not answer any more: fail what is out and put the worker away. */
  const die = (detail?: string) => {
    if (closed) return;
    closed = true;
    died = new EngineStopped(detail?.slice(0, 300));
    const out = [...pending.values()];
    pending.clear();
    keyed.clear();
    for (const p of out) p.reject(died);
    port.onmessage = null;
    port.onerror = null;
    port.onmessageerror = null;
    port.terminate?.();
  };
  port.onerror = (ev) => {
    // a script that did not load arrives as a plain event, without a message
    const message = (ev as { message?: unknown }).message;
    die(typeof message === 'string' && message ? message : undefined);
  };
  port.onmessageerror = () => {
    die('a message from it could not be read');
  };
  port.onmessage = (ev: MessageEvent) => {
    const r = ev.data as EngineReply;
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    if (r.ok) p.resolve(r.value);
    else p.reject(r.cancelled ? new RunCancelled() : new Error(r.error));
  };
  const call = <T>(make: (id: number) => EngineRequest, key?: string): Promise<T> => {
    if (closed) return Promise.reject(died ?? new RunCancelled());
    const id = next++;
    if (key !== undefined) {
      const old = keyed.get(key);
      if (old !== undefined) {
        port.postMessage({ kind: 'cancel', id: old } satisfies EngineRequest);
        const p = pending.get(old);
        pending.delete(old);
        p?.reject(new RunCancelled());
      }
      keyed.set(key, id);
    }
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (v) => {
          if (key !== undefined && keyed.get(key) === id) keyed.delete(key);
          resolve(v as T);
        },
        reject: (e) => {
          if (key !== undefined && keyed.get(key) === id) keyed.delete(key);
          reject(e);
        },
      });
      port.postMessage(make(id));
    });
  };
  const client: EngineClient = {
    setContext(context) {
      known = context;
      if (closed) return;
      port.postMessage({ kind: 'context', context } satisfies EngineRequest);
    },
    run: (req, key) => call<RunReply>((id) => ({ kind: 'run', id, req }), key),
    fingerprints: (req) => call<string[]>((id) => ({ kind: 'fingerprints', id, req })),
    site: (req, key) => call<SiteReply>((id) => ({ kind: 'site', id, req }), key),
    runner: (capture) => ({
      async run(ring: readonly SitePoint[], item: ComparisonItem) {
        const r = await client.run({
          ring: ring.map((p) => [p[0], p[1]]),
          items: [item],
          ...(capture !== undefined ? { capture } : {}),
        });
        const res = r.results[0];
        if (!res) throw new Error('The engine returned no result.');
        return res;
      },
    }),
    stopped: () => died,
    context: () => known,
    dispose() {
      if (closed) return;
      closed = true;
      for (const p of pending.values()) p.reject(new RunCancelled());
      pending.clear();
      port.onmessage = null;
      port.onerror = null;
      port.onmessageerror = null;
      port.terminate?.();
    },
  };
  return client;
}

/** Start the module worker. */
export function startEngineWorker(): EngineClient {
  const w = new Worker(new URL('./engine.worker.ts', import.meta.url), {
    type: 'module',
    name: 'survey-engine',
  });
  return connectEngine(w);
}
