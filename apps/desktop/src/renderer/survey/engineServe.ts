/**
 * The survey engine worker's side (M11 G4): G2's TypeScript executor over the open project's
 * prepared surfaces, fetched through `aio://` with one tile cache. Runs are cancellable (a new run
 * for the same polygon cancels the old one in the client); results carry `engine: 'ts'` and the
 * fingerprint of every input, so the panel can tell a stale result from a current one.
 */
import type { ComparisonItem, SurfaceRef } from '@aio/schema';
import {
  bilinear,
  compareItem,
  fingerprint,
  isSurface,
  newShared,
  normalRing,
  projectResolver,
  resolveCurrentPrevious,
  TileCache,
  type GridOut,
  type Resolve,
  type ResolvedSurface,
} from '@aio/survey';
import type {
  EngineContext,
  EnginePort,
  EngineReply,
  EngineRequest,
  HeatGrid,
  RunReply,
  RunRequest,
  SiteRequest,
} from './engineProtocol';

/** Fetch a project file's bytes, or null when it is missing. */
export type FetchBytes = (url: string) => Promise<Uint8Array | null>;

export const fetchBytes: FetchBytes = async (url) => {
  const r = await fetch(url);
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
};

const joinUrl = (base: string, path: string) =>
  `${base.endsWith('/') ? base : `${base}/`}${path.split('/').map(encodeURIComponent).join('/')}`;

/** One project's engine: resolvers per viewed capture over one tile cache. */
export class EngineSession {
  private cache = new TileCache();
  private resolvers = new Map<string, Resolve>();
  constructor(
    readonly ctx: EngineContext,
    private fetch: FetchBytes,
  ) {}

  resolver(capture?: string): Resolve {
    const key = capture ?? '';
    let r = this.resolvers.get(key);
    if (!r) {
      r = projectResolver({
        surfaces: this.ctx.surfaces,
        captures: this.ctx.captures,
        ...(capture !== undefined ? { capture } : {}),
        designs: this.ctx.designs,
        fetchBytes: (path) => this.fetch(joinUrl(this.ctx.base, path)),
        cache: this.cache,
      });
      this.resolvers.set(key, r);
    }
    return r;
  }

  async run(req: RunRequest, signal?: AbortSignal): Promise<RunReply> {
    const t0 = performance.now();
    const resolve = this.resolver(req.capture);
    const shared = newShared();
    const results = [];
    const heat: HeatGrid[] = [];
    for (const item of req.items) {
      const out: GridOut[] | undefined = req.heat ? [] : undefined;
      const r = await compareItem(
        req.ring,
        item,
        resolve,
        { site: this.ctx.site, ...(signal ? { signal } : {}), shared },
        out,
      );
      results.push(r);
      const g = out?.[0];
      if (g && req.heat && r.status !== 'refused')
        heat.push(await heatGrid(item, g, req.heat, resolve, signal));
    }
    return { results, heat, ms: performance.now() - t0 };
  }

  /** The fingerprint each item would have now (the inputs only, nothing is computed). */
  async fingerprints(req: RunRequest): Promise<string[]> {
    const resolve = this.resolver(req.capture);
    const ring = normalRing(req.ring);
    const side = async (ref: SurfaceRef): Promise<ResolvedSurface | null> => {
      if (!isSurface(ref)) return null;
      try {
        return await resolve(ref);
      } catch {
        return null;
      }
    };
    const out: string[] = [];
    for (const item of req.items)
      out.push(
        await fingerprint(ring, item, await side(item.from), await side(item.to), this.ctx.site),
      );
    return out;
  }

  /** The whole-site difference on a coarse grid (draft regions), over a ring or the overlap. */
  async site(req: SiteRequest, signal?: AbortSignal) {
    const resolve = this.resolver();
    let ring = req.ring;
    if (!ring) {
      const boxes: [number, number, number, number][] = [];
      const cp = resolveCurrentPrevious(this.ctx.surfaces, this.ctx.captures);
      for (const ref of [req.from, req.to]) {
        // the data extent of the prepared surface (its bounds), not its whole tile grid
        const t =
          ref.kind === 'survey'
            ? this.ctx.surfaces.find((x) => x.id === ref.surface)
            : ref.kind === 'current'
              ? cp.current?.surface
              : ref.kind === 'previous'
                ? cp.previous?.surface
                : undefined;
        if (!t) throw new Error('A whole-site comparison needs two prepared survey surfaces.');
        boxes.push([t.bounds[0], t.bounds[1], t.bounds[3], t.bounds[4]]);
      }
      const x0 = Math.max(...boxes.map((b) => b[0]));
      const y0 = Math.max(...boxes.map((b) => b[1]));
      const x1 = Math.min(...boxes.map((b) => b[2]));
      const y1 = Math.min(...boxes.map((b) => b[3]));
      if (!(x0 < x1 && y0 < y1)) throw new Error('The two surfaces do not overlap.');
      ring = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ];
    }
    const item: ComparisonItem = {
      id: 'site',
      from: req.from,
      to: req.to,
      useDeadband: false,
      cellM: req.cellM,
    };
    const out: GridOut[] = [];
    const result = await compareItem(
      ring,
      item,
      resolve,
      { site: this.ctx.site, ...(signal ? { signal } : {}) },
      out,
    );
    const g = out[0];
    if (!g) return { result, grid: null };
    const { dz, nx, ny } = fullWindow(g);
    return {
      result,
      grid: {
        dz: Float32Array.from(dz),
        nx,
        ny,
        x0: g.le + g.win.i0 * g.win.cell,
        y0: g.ln + g.win.j0 * g.win.cell,
        cellM: g.win.cell,
      },
    };
  }
}

/** The bands of a grid output as one window (row 0 south). */
function fullWindow(g: GridOut): { dz: Float64Array; nx: number; ny: number } {
  const { nx, ny } = g.win;
  const dz = new Float64Array(nx * ny).fill(NaN);
  for (const b of g.bands) {
    const r0 = b.win.j0 - g.win.j0;
    dz.set(b.dz.subarray(0, b.win.nx * b.win.ny), r0 * nx);
  }
  return { dz, nx, ny };
}

/** Average a window down to at most `max` cells a side and sample the surface under it. */
async function heatGrid(
  item: ComparisonItem,
  g: GridOut,
  max: number,
  resolve: Resolve,
  signal?: AbortSignal,
): Promise<HeatGrid> {
  const full = fullWindow(g);
  const k = Math.max(1, Math.ceil(Math.max(full.nx, full.ny) / max));
  const nx = Math.ceil(full.nx / k);
  const ny = Math.ceil(full.ny / k);
  const dz = new Float32Array(nx * ny).fill(NaN);
  for (let r = 0; r < ny; r++)
    for (let c = 0; c < nx; c++) {
      let s = 0;
      let n = 0;
      for (let dr = 0; dr < k; dr++) {
        const rr = r * k + dr;
        if (rr >= full.ny) break;
        for (let dc = 0; dc < k; dc++) {
          const cc = c * k + dc;
          if (cc >= full.nx) break;
          const v = full.dz[rr * full.nx + cc] ?? NaN;
          if (Number.isFinite(v)) {
            s += v;
            n++;
          }
        }
      }
      if (n > 0) dz[r * nx + c] = s / n;
    }
  const cell = g.win.cell * k;
  const x0 = g.le + g.win.i0 * g.win.cell;
  const y0 = g.ln + g.win.j0 * g.win.cell;
  const z = new Float32Array(nx * ny).fill(NaN);
  // the terrain under the heat map: the survey side (To when it is a surface, else From)
  const ref = isSurface(item.to) ? item.to : item.from;
  try {
    const s = await resolve(ref);
    if (s.kind === 'grid') {
      const xs = new Float64Array(nx * ny);
      const ys = new Float64Array(nx * ny);
      for (let r = 0; r < ny; r++)
        for (let c = 0; c < nx; c++) {
          xs[r * nx + c] = x0 + (c + 0.5) * cell;
          ys[r * nx + c] = y0 + (r + 0.5) * cell;
        }
      const h = await bilinear(s.grid, xs, ys, -s.grid.originE, -s.grid.originN, signal);
      for (let q = 0; q < h.length; q++) z[q] = h[q] ?? NaN;
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'EngineCancelled') throw e;
    // no terrain: the 3D heat map is left out, the 2D one still draws
  }
  return { item: item.id, x0, y0, cellM: cell, nx, ny, dz, z };
}

/** Answer engine requests arriving on `port` (the worker's global scope, or a test channel). */
export function serveEngine(port: EnginePort, fetch: FetchBytes = fetchBytes): void {
  let session: EngineSession | null = null;
  const running = new Map<number, AbortController>();
  port.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as EngineRequest;
    if (msg.kind === 'context') {
      session = new EngineSession(msg.context, fetch);
      return;
    }
    if (msg.kind === 'cancel') {
      running.get(msg.id)?.abort();
      return;
    }
    const reply = (r: EngineReply, transfer: Transferable[] = []) => {
      port.postMessage(r, transfer);
    };
    const s = session;
    if (!s) {
      reply({ id: msg.id, ok: false, error: 'The survey engine has no project.' });
      return;
    }
    const ac = new AbortController();
    running.set(msg.id, ac);
    const work: Promise<unknown> =
      msg.kind === 'run'
        ? s.run(msg.req, ac.signal)
        : msg.kind === 'fingerprints'
          ? s.fingerprints(msg.req)
          : s.site(msg.req, ac.signal);
    work.then(
      (value) => {
        running.delete(msg.id);
        const transfer: Transferable[] = [];
        if (msg.kind === 'run')
          for (const h of (value as RunReply).heat)
            transfer.push(h.dz.buffer as ArrayBuffer, h.z.buffer as ArrayBuffer);
        reply({ id: msg.id, ok: true, value }, transfer);
      },
      (e: unknown) => {
        running.delete(msg.id);
        const cancelled = e instanceof Error && e.name === 'EngineCancelled';
        reply({
          id: msg.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          ...(cancelled ? { cancelled } : {}),
        });
      },
    );
  };
}
