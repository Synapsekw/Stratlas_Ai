/**
 * Which imagery the Globe draws, bottom layer first. `planGlobeLayers` is the one place that
 * decides it, from the look the person chose and what is installed; the view only builds what
 * the plan lists. A further source (a streamed one, if the founder ever allows it) is one more
 * kind of entry here and one more case in the view, and nothing else changes.
 *
 * Everything in a plan is offline: bundled shapes, bundled Natural Earth II, street packs and
 * imagery packs read from the data folder.
 */
import type { GlobeStyle } from './style';
import { imageryLayerOrder, type PackExtent } from './tiles';

/**
 * Street map tiles for the Globe, drawn by the host (the app renders its street style from the
 * installed street packs; `@aio/globe` knows nothing about how). Tiles are Web Mercator XYZ.
 */
export interface GlobeTileSource {
  /** Edge of a tile in CSS pixels (the size the style was designed for; images may be denser). */
  readonly tileSize: number;
  /** The deepest level worth asking for anywhere. */
  readonly maxZoom: number;
  /** Shown in the Globe's credits while the tiles are. */
  readonly credit: string;
  /**
   * How many levels deeper than a tile's own the source can draw its style (0 when left out).
   * The Globe then has every tile in view drawn in the style of the deepest one, so labels and
   * line widths agree where a coarser tile meets a finer one (`styleZoomFor`).
   */
  readonly styleSteps?: number;
  /**
   * One tile, drawn as the style has it at `styleZoom` (the tile's own level when left out).
   * `undefined`: busy, ask again on a later frame. A promise of `null`: nothing here at this
   * level (the Globe keeps the coarser tile above it).
   */
  request(
    z: number,
    x: number,
    y: number,
    styleZoom?: number,
  ): Promise<TexImageSource | null> | undefined;
  stats?(): GlobeTileStats;
  dispose?(): void;
}

/** What drawing the street tiles cost (the inspection hook, diagnostics, the report). */
export interface GlobeTileStats {
  /** Tiles drawn. */
  tiles: number;
  /** Requests answered "nothing here". */
  skipped: number;
  /** Requests turned away because the renderer was busy. */
  deferred: number;
  /** Milliseconds from request to image: the mean, the slowest, the latest. */
  meanMs: number;
  maxMs: number;
  lastMs: number;
  /** Of `meanMs`: waiting for the tile to be read and drawn, and copying its picture. */
  drawMs?: number;
  copyMs?: number;
  /** Pixels along the edge of the images. */
  imagePx: number;
  /** Tiles handed over before the renderer said it was done. */
  timeouts?: number;
  /** The last fault the renderer reported, if any. */
  lastError?: string | null;
}

/**
 * The style zoom a street tile of `level` is drawn at when the deepest tile in view is at
 * `viewZoom`: the view's zoom, but never shallower than the tile's own level and at most `steps`
 * levels deeper (beyond that the picture would be too small to read anyway).
 */
export function styleZoomFor(level: number, viewZoom: number | null, steps: number): number {
  if (viewZoom === null) return level;
  return Math.max(level, Math.min(viewZoom, level + Math.max(0, steps)));
}

export type GlobeLayerPlan<P> =
  /** The bundled land and border shapes in the street colours: the Earth of the street looks. */
  | { kind: 'earth-shapes'; role: 'whole' | 'underlay' }
  /** The street map from the installed street packs. */
  | { kind: 'street' }
  /** Natural Earth II, the painted raster of CesiumJS's assets: the Earth of the old look. */
  | { kind: 'natural-earth' }
  /** An installed imagery pack. */
  | { kind: 'imagery-pack'; pack: P };

export interface GlobeLayerInput<P> {
  style: GlobeStyle;
  /** Street tiles are available (at least one street pack is installed). */
  street: boolean;
  /** The imagery packs the Imagery setting selects. */
  imagery: readonly P[];
}

/** The Globe's imagery layers for a look, bottom first. */
export function planGlobeLayers<P extends Pick<PackExtent, 'bbox' | 'maxZoom'>>(
  input: GlobeLayerInput<P>,
): GlobeLayerPlan<P>[] {
  const packs = imageryLayerOrder(input.imagery).map((pack): GlobeLayerPlan<P> => ({
    kind: 'imagery-pack',
    pack,
  }));
  if (input.style === 'natural-earth') return [{ kind: 'natural-earth' }, ...packs];
  const base: GlobeLayerPlan<P>[] = input.street
    ? [{ kind: 'earth-shapes', role: 'underlay' }, { kind: 'street' }]
    : [{ kind: 'earth-shapes', role: 'whole' }];
  // satellite is a choice: the street globe stays the default, packs or not
  return input.style === 'satellite' ? [...base, ...packs] : base;
}

/** Whether a plan draws imagery packs (their credits show only then). */
export const planShowsPacks = (plan: readonly GlobeLayerPlan<unknown>[]): boolean =>
  plan.some((l) => l.kind === 'imagery-pack');
