/**
 * Everything the volumetric workspace computes, behind one class so it runs the same in the
 * Web Worker (worker.ts) and in tests. Grids load lazily, once, from the project's kit scripts.
 * All positions are easting and northing in the project CRS.
 */
import {
  changeRaster,
  heightStats,
  reliefRaster,
  sampleDsm,
  type Raster,
  type ReliefStyle,
} from './dsm';
import { densify, type EN } from './edit';
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
}

export interface SceneRequest {
  /** The survey the view shows: the toe lines lie on its ground. */
  epoch: string;
  piles: ScenePileRequest[];
}

export interface ScenePile {
  id: string;
  /** Toe line draped on the surface, flat (E, N, z) triples. */
  toe: Float64Array;
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

  /**
   * The toe lines of the piles asked for, on the ground of the survey the view shows. The kit's
   * volume bodies and base plates are no longer drawn (volumetrics finalization, 18 Nov 2026): an
   * opened pile is shown by its volume measurement.
   */
  async scene(req: SceneRequest): Promise<{ piles: ScenePile[] }> {
    const ground = await this.dsm(req.epoch);
    return {
      piles: req.piles.map((p) => ({
        id: p.id,
        toe: drape(p.ring, (E, N) => sampleDsm(ground, E, N)),
      })),
    };
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
}

/** A ring sampled every `step` metres on a surface (holes take the last height). */
function drape(ring: EN[], surf: (E: number, N: number) => number | null, step = 1): Float64Array {
  const toe: number[] = [];
  let last: number | null = null;
  for (const [E, N] of densify(ring, step)) {
    const z: number | null = surf(E, N) ?? last;
    if (z == null) continue;
    last = z;
    toe.push(E, N, z);
  }
  return Float64Array.from(toe);
}
