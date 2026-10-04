/**
 * Platform shims for the legacy offline viewers, injected by the aio:// protocol as the first
 * script of every `legacy/*.html` document (see `legacy.ts`).
 *
 * The viewers were built for two hosts: a plain folder (`target: 'offline'`) and the claude.ai
 * artifact runtime (`window.claude.use(...)`). Inside Stratlas they run offline, and the
 * capabilities they ask for are provided locally:
 *
 * - `downloads`: `save({ filename, data })` posts the bytes to the Stratlas window, which asks
 *   for a place with the native save dialog (IPC `dialog:saveFile`).
 * - `db`: a small document store (`collection().doc().set/update/delete/get`, `onSnapshot`)
 *   kept in localStorage per project. The Masafi boundary editor stores its edits here.
 * - Offline flags: `KIT.target` and `VS_CONFIG.target` are forced to `'offline'` whenever the
 *   viewer sets them, and `TANK_OFFLINE` is true.
 *
 * `legacyShim` is serialized with `Function.prototype.toString`, so it must not reference
 * anything outside its own body (no imports, no module-level helpers). The tests run it from
 * the serialized source to prove that.
 */

/** Sent from the viewer to the Stratlas window, with a MessagePort for the reply. */
export interface ShimSaveMessage {
  source: 'stratlas-legacy';
  type: 'save';
  filename: string;
  data: string | Uint8Array;
  mimeType?: string;
}

/** The Stratlas window's answer to a save. */
export type ShimReply =
  { ok: true } | { ok: false; code: 'declined' } | { ok: false; error: string };

export interface ShimConfig {
  projectId: string;
}

export function legacyShim(cfg: ShimConfig): void {
  type Json = Record<string, unknown>;
  interface Listener {
    next: (s: unknown) => void;
    error?: ((e: unknown) => void) | undefined;
  }
  const win = window as unknown as Record<string, unknown>;

  const fail = (message: string, code: string): Error =>
    Object.assign(new Error(message), { code });

  // Offline flags: whatever the viewer assigns later, its target stays 'offline'.
  const forceOffline = (name: string) => {
    let value: unknown = win[name];
    const patch = (v: unknown) => {
      if (v && typeof v === 'object') (v as Json).target = 'offline';
      return v;
    };
    patch(value);
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (v: unknown) => {
        value = patch(v);
      },
    });
  };
  forceOffline('KIT');
  forceOffline('VS_CONFIG');
  win.TANK_OFFLINE = true;

  // downloads
  const toBytes = async (data: unknown): Promise<string | Uint8Array> => {
    if (typeof data === 'string') return data;
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    if (data && typeof data === 'object') return JSON.stringify(data);
    return String(data);
  };

  const downloads = {
    async save(req: { filename?: unknown; data?: unknown; mimeType?: unknown }): Promise<void> {
      const filename = typeof req.filename === 'string' ? req.filename : 'download';
      const data = await toBytes(req.data);
      const msg: Json = { source: 'stratlas-legacy', type: 'save', filename, data };
      if (typeof req.mimeType === 'string') msg.mimeType = req.mimeType;
      const channel = new MessageChannel();
      const reply = new Promise<Json>((resolve) => {
        channel.port1.onmessage = (e: MessageEvent) => {
          channel.port1.close();
          resolve((e.data ?? {}) as Json);
        };
      });
      window.parent.postMessage(msg, '*', [channel.port2]);
      const r = await reply;
      if (r.ok === true) return;
      if (r.code === 'declined') throw fail('Download cancelled.', 'declined');
      throw fail(typeof r.error === 'string' ? r.error : 'The file could not be saved.', 'failed');
    },
  };

  // db: one localStorage entry per collection, namespaced by project.
  const prefix = `stratlas.legacy/${cfg.projectId}/db/`;
  const listeners = new Map<string, Set<Listener>>();
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  const read = (name: string): Record<string, Json> => {
    try {
      const raw = localStorage.getItem(prefix + name);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, Json>) : {};
    } catch {
      return {};
    }
  };

  const snapshot = (name: string) => {
    const all = read(name);
    const docs = Object.keys(all)
      .sort()
      .map((id) => ({ id, exists: true, data: () => copy(all[id]) }));
    return {
      docs,
      size: docs.length,
      empty: docs.length === 0,
      forEach: (fn: (d: (typeof docs)[number]) => void) => {
        docs.forEach(fn);
      },
    };
  };

  const notify = (name: string) => {
    const set = listeners.get(name);
    if (!set || set.size === 0) return;
    const snap = snapshot(name);
    for (const l of [...set]) {
      try {
        l.next(snap);
      } catch (e) {
        console.error(e);
      }
    }
  };

  const write = (name: string, change: (all: Record<string, Json>) => void) => {
    const all = read(name);
    change(all);
    let text: string;
    try {
      text = JSON.stringify(all);
    } catch {
      throw fail('This value cannot be stored.', 'invalid_argument');
    }
    try {
      localStorage.setItem(prefix + name, text);
    } catch {
      throw fail('There is no room left to store edits.', 'resource_exhausted');
    }
    queueMicrotask(() => {
      notify(name);
    });
  };

  const storable = (data: unknown): Json => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw fail('A document must be an object.', 'invalid_argument');
    }
    try {
      return copy(data as Json);
    } catch {
      throw fail('This value cannot be stored.', 'invalid_argument');
    }
  };

  const collection = (name: string) => ({
    doc: (id: string) => ({
      id,
      set: (data: unknown) =>
        Promise.resolve().then(() => {
          const value = storable(data);
          write(name, (all) => {
            all[id] = value;
          });
        }),
      update: (patch: unknown) =>
        Promise.resolve().then(() => {
          const value = storable(patch);
          write(name, (all) => {
            all[id] = { ...(all[id] ?? {}), ...value };
          });
        }),
      delete: () =>
        Promise.resolve().then(() => {
          write(name, (all) => {
            Reflect.deleteProperty(all, id);
          });
        }),
      get: () =>
        Promise.resolve().then(() => {
          const value = read(name)[id];
          return { id, exists: value !== undefined, data: () => (value ? copy(value) : undefined) };
        }),
    }),
    add: (data: unknown) =>
      Promise.resolve().then(() => {
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const value = storable(data);
        write(name, (all) => {
          all[id] = value;
        });
        return { id };
      }),
    get: () => Promise.resolve().then(() => snapshot(name)),
    onSnapshot: (next: (s: unknown) => void, error?: (e: unknown) => void) => {
      const l: Listener = { next, error };
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(l);
      setTimeout(() => {
        if (set.has(l)) l.next(snapshot(name));
      }, 0);
      return () => {
        set.delete(l);
      };
    },
  });

  // Another window of the same project changed the store.
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key?.startsWith(prefix)) notify(e.key.slice(prefix.length));
  });

  const db = { collection };

  win.claude = {
    use: (name: unknown): Promise<unknown> =>
      Promise.resolve(name === 'downloads' ? downloads : name === 'db' ? db : null),
  };
}

/** The shim as JavaScript source, for injection into legacy HTML. */
export const SHIM_SOURCE: string = legacyShim.toString();
