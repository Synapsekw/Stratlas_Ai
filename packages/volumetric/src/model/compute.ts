/**
 * Everything the volumetric workspace computes, behind one class so it runs the same in the
 * Web Worker (worker.ts) and in tests. Grids load lazily, once, from the project's kit scripts.
 * All positions are easting and northing in the project CRS.
 */
import type { BaseVolumes, VolumeBaseId } from '@aio/schema';
import {
  changeBodyCoarse,
  changeBodyFine,
  coarseBody,
  editBody,
  fineBody,
  type BodyCells,
} from './bodies';
import {
  changeRaster,
  heightStats,
  reliefRaster,
  sampleDsm,
  sectionProfile,
  type Raster,
  type ReliefStyle,
  type SectionProfile,
} from './dsm';
import {
  densify,
  editGeometry,
  editVolumes,
  type EditGeometry,
  type EditResult,
  type EN,
} from './edit';
import { pileSurface } from './frame';
import {
  decodeCoarse,
  decodeDsm,
  decodePile,
  type CoarseGrids,
  type DsmGrid,
  type PileGrid,
} from './kitdata';
import { pileLongSection, type PileSection } from './section';
import { pileVolumes } from './volume';

/** URLs of the kit scripts. */
export interface GridSources {
  pile(id: string): string;
  dsm(epoch: string): string;
  coarse: string;
}

export interface ComputeOptions {
  fetchText(url: string): Promise<string>;
  sources: GridSources;
  /** Survey epochs, first to last. */
  epochs: readonly string[];
  deadband: number;
}

export interface ScenePileRequest {
  id: string;
  /** The toe line to draw (zone ring in change mode). */
  ring: EN[];
  /** A hand-edited line: its body comes from the refitted bases. */
  edited: boolean;
}

export interface SceneRequest {
  epoch: string;
  base: VolumeBaseId;
  mode: 'inv' | 'chg';
  selected: string | null;
  piles: ScenePileRequest[];
}

export interface ScenePile {
  id: string;
  body: BodyCells | null;
  /** Toe line draped on the surface, flat (E, N, z) triples. */
  toe: Float64Array;
  /** Base height under each toe point (inventory bodies), for the lifted base outline. */
  toeBase: Float64Array | null;
}

export interface EditRequest {
  pile: string;
  epoch: string;
  ring: EN[];
  base: VolumeBaseId;
}

export interface EditResponse {
  result: EditResult;
  body: BodyCells;
  toe: Float64Array;
  /** Each ring vertex with the surface height under it. */
  vertices: [number, number, number][];
}

export interface GridInfo {
  w: number;
  h: number;
  res: number;
  x0: number;
  y1: number;
  /** Elevation range for the colour relief (1st and 99th percentile of both surveys), m. */
  relief: [number, number];
  /** Lowest and highest valid height of both surveys, m. */
  extent: [number, number];
}

export class VolumeCompute {
  private readonly piles = new Map<string, Promise<PileGrid>>();
  private readonly dsms = new Map<string, Promise<DsmGrid>>();
  private coarseP: Promise<CoarseGrids> | null = null;
  private gridP: Promise<GridInfo> | null = null;
  private readonly editCache = new Map<string, EditGeometry | null>();

  constructor(private readonly o: ComputeOptions) {}

  private get first(): string {
    return this.o.epochs[0] ?? '';
  }
  private get last(): string {
    return this.o.epochs.at(-1) ?? '';
  }

  private load<T>(url: string, what: string, decode: (t: string) => Promise<T>): Promise<T> {
    return this.o.fetchText(url).then(decode, (e: unknown) => {
      throw new Error(
        `Could not load the ${what} (${url}): ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  pile(id: string): Promise<PileGrid> {
    let p = this.piles.get(id);
    if (!p) {
      p = this.load(this.o.sources.pile(id), `10 cm grid of ${id}`, decodePile);
      p.catch(() => this.piles.delete(id));
      this.piles.set(id, p);
    }
    return p;
  }

  dsm(epoch: string): Promise<DsmGrid> {
    let p = this.dsms.get(epoch);
    if (!p) {
      p = this.load(this.o.sources.dsm(epoch), `site elevation of ${epoch}`, decodeDsm);
      p.catch(() => this.dsms.delete(epoch));
      this.dsms.set(epoch, p);
    }
    return p;
  }

  coarse(): Promise<CoarseGrids> {
    if (!this.coarseP) {
      const p = this.load(this.o.sources.coarse, 'pile masks', (t) =>
        decodeCoarse(t, this.o.epochs),
      );
      p.catch(() => {
        this.coarseP = null;
      });
      this.coarseP = p;
    }
    return this.coarseP;
  }

  grid(): Promise<GridInfo> {
    if (!this.gridP) {
      const p = Promise.all(this.o.epochs.map((e) => this.dsm(e))).then((ds): GridInfo => {
        const d = ds[0];
        if (!d) throw new Error('No survey');
        const { auto, extent } = heightStats(ds);
        return { w: d.w, h: d.h, res: d.res, x0: d.x0, y1: d.y1, relief: auto, extent };
      });
      p.catch(() => {
        this.gridP = null;
      });
      this.gridP = p;
    }
    return this.gridP;
  }

  /** The automatic volumes of a pile recomputed from its 10 cm grid, per epoch. */
  async recompute(id: string): Promise<Record<string, BaseVolumes | null>> {
    const g = await this.pile(id);
    return Object.fromEntries(this.o.epochs.map((e) => [e, pileVolumes(g, e)]));
  }

  private async surface(epoch: string, pile: string | null) {
    const dsm = await this.dsm(epoch);
    const g = pile ? await this.pile(pile) : null;
    return { dsm, surf: pileSurface(g, epoch, dsm) };
  }

  private async editGeom(pile: string, epoch: string, ring: EN[]): Promise<EditGeometry | null> {
    const key = `${pile}/${epoch}/${JSON.stringify(ring)}`;
    if (this.editCache.has(key)) return this.editCache.get(key) ?? null;
    const { surf } = await this.surface(epoch, pile);
    const g = editGeometry(ring, surf);
    if (this.editCache.size > 64) this.editCache.clear();
    this.editCache.set(key, g);
    return g;
  }

  async scene(req: SceneRequest): Promise<{ piles: ScenePile[] }> {
    const chg = req.mode === 'chg';
    const dsm = await this.dsm(chg ? this.last : req.epoch);
    const first = chg ? await this.dsm(this.first) : null;
    const coarse = await this.coarse();
    const out: ScenePile[] = [];
    for (const p of req.piles) {
      const sel = p.id === req.selected;
      const fine = sel ? await this.pile(p.id) : null;
      let body: BodyCells | null;
      let baseAt: ((E: number, N: number) => number) | null = null;
      if (chg) {
        body =
          fine !== null
            ? changeBodyFine(fine, this.first, this.last, this.o.deadband, 3)
            : first
              ? changeBodyCoarse(coarse, first, dsm, p.id, this.o.deadband)
              : null;
      } else if (p.edited) {
        const g = await this.editGeom(p.id, req.epoch, p.ring);
        body = g ? editBody(g, req.base, sel ? 0.25 : 0.4) : null;
        if (g) baseAt = (E, N) => g.baseAt(req.base, E, N);
      } else {
        body =
          fine !== null
            ? fineBody(fine, req.epoch, req.base, 3)
            : coarseBody(coarse, dsm, p.id, req.epoch, req.base);
        if (body) baseAt = bodyBase(body);
      }
      out.push({ id: p.id, body, ...drape(p.ring, (E, N) => sampleDsm(dsm, E, N), baseAt) });
    }
    return { piles: out };
  }

  async edit(req: EditRequest): Promise<EditResponse | null> {
    const g = await this.editGeom(req.pile, req.epoch, req.ring);
    if (!g) return null;
    const dsm = await this.dsm(req.epoch);
    const result = editVolumes(g, dsm.x0, dsm.y1);
    const body = editBody(g, req.base, 0.25);
    const { toe } = drape(req.ring, g.surf, null, 0.8);
    const vertices = req.ring.map(([E, N]): [number, number, number] => [
      E,
      N,
      g.surf(E, N) ?? body.bmin,
    ]);
    return { result, body, toe, vertices };
  }

  async section(a: EN, b: EN): Promise<SectionProfile> {
    return sectionProfile(
      await this.dsm(this.first),
      await this.dsm(this.last),
      a,
      b,
      this.o.deadband,
    );
  }

  async pileSection(id: string, epoch: string, base: VolumeBaseId): Promise<PileSection> {
    return pileLongSection(await this.pile(id), epoch, base, this.first, this.last);
  }

  async changeRaster(): Promise<Raster> {
    return changeRaster(await this.dsm(this.first), await this.dsm(this.last), this.o.deadband);
  }

  /**
   * Colour relief of a survey: the style's ramp, range and hillshade; without a range, the 1st to
   * 99th percentile of both surveys.
   */
  async reliefRaster(epoch: string, style: Partial<ReliefStyle> = {}): Promise<Raster> {
    let { lo, hi } = style;
    if (lo === undefined || hi === undefined) {
      const g = await this.grid();
      lo ??= g.relief[0];
      hi ??= g.relief[1];
    }
    return reliefRaster(await this.dsm(epoch), lo, hi, style);
  }

  /** Surface heights under points (E, N) of one survey, null where there is no data. */
  async heights(epoch: string, pile: string | null, pts: EN[]): Promise<(number | null)[]> {
    const { surf } = await this.surface(epoch, pile);
    return pts.map(([E, N]) => surf(E, N));
  }
}

/** Nearest-cell base height of a body (for the lifted base outline). */
function bodyBase(b: BodyCells): (E: number, N: number) => number {
  return (E, N) => {
    const i = Math.max(0, Math.min(b.nx - 1, Math.round((E - b.e0) / b.cell)));
    const j = Math.max(0, Math.min(b.ny - 1, Math.round((b.n0 - N) / b.cell)));
    let best = b.bmin;
    let bd = Infinity;
    // the toe sits on the edge of the body: look for the nearest cell inside within 3 cells
    for (let dj = -3; dj <= 3; dj++)
      for (let di = -3; di <= 3; di++) {
        const x = i + di;
        const y = j + dj;
        if (x < 0 || y < 0 || x >= b.nx || y >= b.ny) continue;
        const k = y * b.nx + x;
        if (!b.ins[k]) continue;
        const d = di * di + dj * dj;
        if (d < bd) {
          bd = d;
          best = b.bot[k] ?? best;
        }
      }
    return best;
  };
}

/** A ring sampled every `step` metres on a surface (holes take the last height). */
function drape(
  ring: EN[],
  surf: (E: number, N: number) => number | null,
  baseAt: ((E: number, N: number) => number) | null,
  step = 1,
): { toe: Float64Array; toeBase: Float64Array | null } {
  const pts = densify(ring, step);
  const toe: number[] = [];
  const base: number[] = [];
  let last: number | null = null;
  for (const [E, N] of pts) {
    const z: number | null = surf(E, N) ?? last;
    if (z == null) continue;
    last = z;
    toe.push(E, N, z);
    if (baseAt) base.push(baseAt(E, N));
  }
  return { toe: Float64Array.from(toe), toeBase: baseAt ? Float64Array.from(base) : null };
}
