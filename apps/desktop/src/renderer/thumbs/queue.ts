/**
 * Thumbnails the renderer makes for project images that have none yet (no `thumbs/` copy in the
 * project, nothing in main's cache). Requests are deduplicated, the newest goes first (what is on
 * screen now), at most `concurrency` run at a time, and a request nobody waits for any more is
 * dropped before it starts.
 */

/** Message to the thumbnail worker. */
export interface ThumbJob {
  id: number;
  /** aio:// URL of the full image. */
  url: string;
  /** Longest side of the thumbnail in pixels. */
  maxPx: number;
}

/** Answer of the thumbnail worker: JPEG bytes or an error. */
export type ThumbReply = { id: number; data: ArrayBuffer } | { id: number; error: string };

export interface ThumbRequest {
  projectId: string;
  /** Project-relative path of the image. */
  path: string;
  /** aio:// URL of the full image. */
  source: string;
}

export interface ThumbQueueDeps {
  /** Make the thumbnail of the full image at `url` (in a worker). */
  make(url: string): Promise<ArrayBuffer>;
  /** Keep the thumbnail for next time (main's cache); failures are ignored. */
  store(req: ThumbRequest, bytes: Uint8Array<ArrayBuffer>): Promise<unknown>;
  /** A URL the page can show for the bytes (an object URL). */
  toUrl(bytes: ArrayBuffer): string;
  concurrency: number;
}

type Listener = (url: string | null) => void;

interface Entry {
  req: ThumbRequest;
  listeners: Set<Listener>;
  started: boolean;
}

export interface ThumbQueue {
  /** Ask for a thumbnail; `done` gets its URL, or null when it cannot be made. Returns a cancel. */
  request(req: ThumbRequest, done: Listener): () => void;
  /** The URL of a thumbnail made earlier in this session, if any. */
  made(req: Pick<ThumbRequest, 'projectId' | 'path'>): string | undefined;
  /** Requests waiting or running. */
  pending(): number;
}

const keyOf = (r: Pick<ThumbRequest, 'projectId' | 'path'>) => `${r.projectId}\n${r.path}`;

export function createThumbQueue(deps: ThumbQueueDeps): ThumbQueue {
  const entries = new Map<string, Entry>();
  /** Keys waiting to start, newest last. */
  const waiting: string[] = [];
  const done = new Map<string, string | null>();
  let running = 0;

  const pump = () => {
    while (running < deps.concurrency && waiting.length > 0) {
      const key = waiting.pop();
      if (key === undefined) break;
      const e = entries.get(key);
      if (!e || e.started) continue;
      e.started = true;
      running++;
      deps.make(e.req.source).then(
        (bytes) => {
          const url = deps.toUrl(bytes);
          void deps.store(e.req, new Uint8Array(bytes)).catch(() => undefined);
          finish(key, url);
        },
        () => {
          finish(key, null);
        },
      );
    }
  };

  const finish = (key: string, url: string | null) => {
    running--;
    done.set(key, url);
    const e = entries.get(key);
    entries.delete(key);
    for (const l of e?.listeners ?? []) l(url);
    pump();
  };

  return {
    request(req, listener) {
      const key = keyOf(req);
      if (done.has(key)) {
        listener(done.get(key) ?? null);
        return () => undefined;
      }
      let e = entries.get(key);
      if (!e) {
        e = { req, listeners: new Set(), started: false };
        entries.set(key, e);
      }
      e.listeners.add(listener);
      if (!e.started) {
        const at = waiting.indexOf(key);
        if (at >= 0) waiting.splice(at, 1);
        waiting.push(key);
      }
      pump();
      const entry = e;
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0 && !entry.started) {
          entries.delete(key);
          const at = waiting.indexOf(key);
          if (at >= 0) waiting.splice(at, 1);
        }
      };
    },
    made(req) {
      return done.get(keyOf(req)) ?? undefined;
    },
    pending: () => entries.size,
  };
}
