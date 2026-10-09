/**
 * Messages between the renderer and the survey engine worker (M11 G4): the G2 TypeScript executor
 * (`@aio/survey` `compareItems` over `projectResolver`) runs off the UI thread; a run is cancelled
 * when its polygon is edited. Shared by `engineServe.ts` (the worker side) and `engineClient.ts`.
 */
import type {
  ComparisonItem,
  ComparisonResult,
  DesignEntry,
  HeightTiles,
  SurfaceRef,
} from '@aio/schema';
import type { SiteContext, ToleranceShare } from '@aio/survey';

/** What the worker resolves surfaces against: one open project. */
export interface EngineContext {
  /** `aio://project/<id>/`, the base the project's files are fetched from. */
  base: string;
  surfaces: HeightTiles[];
  /** Capture ids in date order. */
  captures: string[];
  designs: DesignEntry[];
  site: SiteContext;
}

/** The difference of one item on a coarse grid for heat maps (row 0 south). */
export interface HeatGrid {
  item: string;
  /** West and south edges of cell (0, 0), project CRS metres. */
  x0: number;
  y0: number;
  cellM: number;
  nx: number;
  ny: number;
  /** dz per cell, NaN outside the polygon or without data. */
  dz: Float32Array;
  /** The surface side's height per cell (for the 3D heat map), NaN without data. */
  z: Float32Array;
}

export interface RunRequest {
  ring: [number, number][];
  items: ComparisonItem[];
  /** The survey the measurement is viewed on (resolves `current` and `previous`). */
  capture?: string;
  /** Also return heat grids of at most this many cells a side (0: none). */
  heat?: number;
  /** The tolerance of a design item without its own `deadbandM` (the site's default), metres. */
  toleranceM?: number;
}

/** The in-tolerance share of a design item's area (compliance to design, DSN-3). */
export interface ItemShare {
  item: string;
  toleranceM: number;
  share: ToleranceShare;
}

export interface RunReply {
  results: ComparisonResult[];
  heat: HeatGrid[];
  /** One per item with a design side that was computed on a grid. */
  shares: ItemShare[];
  ms: number;
}

export interface SiteRequest {
  from: SurfaceRef;
  to: SurfaceRef;
  cellM: number;
  ring?: [number, number][];
}

export type EngineRequest =
  | { kind: 'context'; context: EngineContext }
  | { kind: 'run'; id: number; req: RunRequest }
  | { kind: 'fingerprints'; id: number; req: RunRequest }
  | { kind: 'site'; id: number; req: SiteRequest }
  | { kind: 'cancel'; id: number };

export type EngineReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string; cancelled?: boolean };

/** The part of a Worker or MessagePort both ends use. */
export interface EnginePort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}
