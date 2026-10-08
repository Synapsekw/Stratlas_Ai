/**
 * Cross-sections off the main thread (M11 G5): the section worker resolves the surfaces of a
 * section (prepared tiles and design TINs, read through `aio://project/<id>/...`, once each) and
 * samples them with `@aio/survey`'s section arithmetic; pins are sampled at the pin itself. The
 * client starts the worker lazily and falls back to the same engine on the main thread where
 * workers do not exist (unit tests).
 */
import type { DesignEntry, HeightTiles, SectionProfile } from '@aio/schema';
import {
  pinAt,
  projectResolver,
  resolveSection,
  sampleSection,
  sectionLabel,
  surfaceKey,
  TileCache,
  type Pin,
  type SectionRef,
  type SectionSurface,
} from '@aio/survey';

/** What the worker needs to resolve surfaces. */
export interface SectionSources {
  /** `aio://project/<id>/` (with the trailing slash). */
  base: string;
  surfaces: HeightTiles[];
  designs: DesignEntry[];
  /** Capture ids in date order. */
  captures: string[];
  /** The capture `current` means; absent: the latest with a surface. */
  capture?: string;
}

export interface SectionRequest {
  line: [number, number][];
  refs: SectionRef[];
}

export interface SectionResult {
  stepM: number;
  length: number;
  chainage: number[];
  e: number[];
  n: number[];
  profiles: SectionProfile[];
  /** Surfaces that could not be resolved, with the reason. */
  missing: { key: string; label: string; reason: string }[];
}

export interface SectionEngine {
  setSources(s: SectionSources): Promise<void>;
  section(r: SectionRequest): Promise<SectionResult>;
  pin(r: SectionRequest & { chainage: number; reference: number }): Promise<Pin>;
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** The engine: the same code in the worker and on the main thread. */
export function createSectionEngine(
  fetchBytes: (url: string) => Promise<Uint8Array | null>,
): SectionEngine {
  let sources: SectionSources | null = null;
  let resolve: ReturnType<typeof projectResolver> | null = null;
  const cache = new TileCache(512);
  const resolved = new Map<
    string,
    Promise<{ surfaces: SectionSurface[]; missing: SectionResult['missing'] }>
  >();

  const surfacesOf = (refs: SectionRef[]) => {
    if (!resolve) throw new Error('The section has no surfaces to read yet.');
    const r = resolve;
    const key = JSON.stringify(refs);
    let p = resolved.get(key);
    if (!p) {
      p = resolveSection(refs, r).then(({ surfaces, missing }) => ({
        surfaces,
        missing: missing.map((m) => ({
          key: surfaceKey(m.ref),
          label: sectionLabel(m.ref, null),
          reason: m.reason,
        })),
      }));
      p.catch(() => resolved.delete(key));
      resolved.set(key, p);
    }
    return p;
  };

  return {
    setSources(s) {
      sources = s;
      resolved.clear();
      cache.clear();
      resolve = projectResolver({
        surfaces: s.surfaces,
        captures: s.captures,
        ...(s.capture !== undefined ? { capture: s.capture } : {}),
        designs: s.designs,
        cache,
        fetchBytes: (path) => fetchBytes(`${s.base}${encodePath(path)}`),
      });
      return Promise.resolve();
    },
    async section(req) {
      if (!sources) throw new Error('The section has no surfaces to read yet.');
      const { surfaces, missing } = await surfacesOf(req.refs);
      const sec = await sampleSection({ line: req.line }, surfaces);
      return {
        stepM: sec.step,
        length: sec.length,
        chainage: Array.from(sec.chainage),
        e: Array.from(sec.e),
        n: Array.from(sec.n),
        profiles: sec.profiles,
        missing,
      };
    },
    async pin(req) {
      const { surfaces } = await surfacesOf(req.refs);
      return pinAt(req.line, req.chainage, surfaces, { reference: req.reference });
    },
  };
}

export async function fetchBytes(url: string): Promise<Uint8Array | null> {
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url} answered ${String(r.status)}`);
  return new Uint8Array(await r.arrayBuffer());
}

// ---------------------------------------------------------------------------------- the client

type Op = 'setSources' | 'section' | 'pin';
export interface WorkerCall {
  id: number;
  op: Op;
  arg: unknown;
}
export type WorkerReply =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

let client: SectionEngine | null = null;

/** The section engine: in the section worker, or on this thread without workers. */
export function sectionEngine(): SectionEngine {
  if (client) return client;
  if (typeof Worker === 'undefined') {
    client = createSectionEngine(fetchBytes);
    return client;
  }
  const w = new Worker(new URL('./section.worker.ts', import.meta.url), {
    type: 'module',
    name: 'sections',
  });
  let next = 1;
  const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  w.onmessage = (e: MessageEvent<WorkerReply>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.ok(e.data.value);
    else p.fail(new Error(e.data.error));
  };
  w.onerror = (e) => {
    for (const p of pending.values()) p.fail(new Error(e.message || 'The section worker stopped.'));
    pending.clear();
  };
  const call = <T>(op: Op, arg: unknown): Promise<T> =>
    new Promise<T>((ok, fail) => {
      const id = next++;
      pending.set(id, {
        ok: (v) => {
          ok(v as T);
        },
        fail,
      });
      w.postMessage({ id, op, arg } satisfies WorkerCall);
    });
  client = {
    setSources: (s) => call('setSources', s),
    section: (r) => call('section', r),
    pin: (r) => call('pin', r),
  };
  return client;
}
