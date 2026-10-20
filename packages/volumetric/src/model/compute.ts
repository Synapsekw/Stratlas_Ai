/**
 * Everything the volumetric workspace computes, behind one class so it runs the same in the
 * Web Worker (worker.ts) and in tests. Grids load lazily, once, from the project's kit scripts.
 * All positions are easting and northing in the project CRS.
 */
import type { VolumeBaseId } from '@aio/schema';
import { changeBodyCoarse, changeBodyFine, coarseBody, fineBody, type BodyCells } from './bodies';
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
import { densify, type EN } from './edit';
import { pileSurface } from './frame';
import {
  decodeCoarse,
  decodeDsm,
  decodePile,
  type CoarseGrids,
  type DsmGrid,
  type PileGrid,
} from './kitdata';

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
  /** A hand-edited line (kit edits saved before the kit editor retired): no fine body under it. */
  edited: boolean;
}

export interface SceneRequest {
  epoch: string;
  /** The base the inventory bodies stand on in 3D: display only, never a figure. */
  base: VolumeBaseId;
  mode: 'inv' | 'chg';
  /** The two surveys a change body spans (change mode), earlier first as picked. */
  from?: string;
  to?: string;
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

  constructor(private readonly o: ComputeOptions) {}

  private get first(): string {
    return this.o.epochs[0] ?? '';
  }
  private get last(): string {
    return this.o.epochs.at(-1) ?? '';
  }
  /** The surveys a change compares: the ones asked for, else the first and the last. */
  private pair(from?: string, to?: string): [string, string] {
    return [from ?? this.first, to ?? this.last];
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

  private async surface(epoch: string, pile: string | null) {
    const dsm = await this.dsm(epoch);
    const g = pile ? await this.pile(pile) : null;
    return { dsm, surf: pileSurface(g, epoch, dsm) };
  }

  async scene(req: SceneRequest): Promise<{ piles: ScenePile[] }> {
    const chg = req.mode === 'chg';
    const [from, to] = this.pair(req.from, req.to);
    const dsm = await this.dsm(chg ? to : req.epoch);
    const first = chg ? await this.dsm(from) : null;
    // the toe lies on the ground of the survey the view shows (a change body is the same on
    // every date; a view of another date would bury or float a toe draped on the "to" one)
    const ground = chg && req.epoch !== to ? await this.dsm(req.epoch) : dsm;
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
            ? changeBodyFine(fine, from, to, this.o.deadband, 3)
            : first
              ? changeBodyCoarse(coarse, first, dsm, p.id, this.o.deadband)
              : null;
      } else if (p.edited) {
        // the kit's grids hold the automatic outline only: a saved edit draws its toe line
        body = null;
      } else {
        body =
          fine !== null
            ? fineBody(fine, req.epoch, req.base, 3)
            : coarseBody(coarse, dsm, p.id, req.epoch, req.base);
        if (body) baseAt = bodyBase(body);
      }
      out.push({ id: p.id, body, ...drape(p.ring, (E, N) => sampleDsm(ground, E, N), baseAt) });
    }
    return { piles: out };
  }

  /** The heights of two surveys (the first and the last unless asked) along a line. */
  async section(a: EN, b: EN, from?: string, to?: string): Promise<SectionProfile> {
    const [f, t] = this.pair(from, to);
    return sectionProfile(await this.dsm(f), await this.dsm(t), a, b, this.o.deadband);
  }

  /**
   * The height change between two surveys' site heights (the first and the last unless asked),
   * coloured: the Cut / fill drape where the survey engine has no prepared surface for a date.
   */
  async changeRaster(from?: string, to?: string): Promise<Raster> {
    const [f, t] = this.pair(from, to);
    return changeRaster(await this.dsm(f), await this.dsm(t), this.o.deadband);
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
