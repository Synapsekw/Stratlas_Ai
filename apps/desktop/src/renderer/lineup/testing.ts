import type {
  CaptureLineUp,
  CaptureLineUpTurn,
  LineUpFit,
  LineUpMeasure,
  ProjectManifest,
} from '@aio/schema';

/** Test data for the line-up step: two survey dates with an ortho each, and a cloud on the later. */

const raster = (id: string, role: 'ortho' | 'dsm', capture?: string) => ({
  kind: 'raster',
  id,
  name: id,
  visible: true,
  role,
  format: 'cog',
  src: { path: `${id}.tif` },
  ...(capture ? { capture } : {}),
});

export const ortho = (id: string, capture?: string) => raster(id, 'ortho', capture);
export const dsm = (id: string, capture?: string) => raster(id, 'dsm', capture);
export const cloud = (id: string, capture?: string) => ({
  kind: 'pointcloud',
  id,
  name: id,
  visible: true,
  format: 'copc',
  src: { path: `${id}.copc.laz` },
  ...(capture ? { capture } : {}),
});

export function lineUpManifest(
  opts: {
    lineUps?: Record<string, CaptureLineUp>;
    /** `lineUpTurn` by capture id, beside its `lineUp`. */
    turns?: Record<string, CaptureLineUpTurn>;
    layers?: object[];
    captures?: { id: string; label: string; date: string }[];
  } = {},
): ProjectManifest {
  const captures = opts.captures ?? [
    { id: 'd1', label: 'Survey 2 March 2026', date: '2026-03-02' },
    { id: 'd2', label: 'Survey 13 April 2026', date: '2026-04-13' },
  ];
  return {
    schema: 'aio.project/1',
    id: 'p',
    name: 'P',
    crs: { epsg: 32639 },
    origin: [500000, 4000000, 10],
    captures: captures.map((c) => {
      const lineUp = opts.lineUps?.[c.id];
      const lineUpTurn = opts.turns?.[c.id];
      return { ...c, ...(lineUp ? { lineUp } : {}), ...(lineUpTurn ? { lineUpTurn } : {}) };
    }),
    layers: opts.layers ?? [ortho('o1', 'd1'), ortho('o2', 'd2'), cloud('c2', 'd2')],
    severityModels: [],
    classCatalogues: [],
  } as unknown as ProjectManifest;
}

export function measureOf(over: Partial<LineUpMeasure> = {}): LineUpMeasure {
  return {
    keep: 'd1',
    move: 'd2',
    layerKeep: 'o1',
    layerMove: 'o2',
    source: 'ortho',
    eastM: -2,
    northM: 0,
    totalM: 2,
    cellM: 0.05,
    tolerancePx: 2,
    spreadPx: 0.4,
    tiles: 12,
    verdict: 'ok',
    ...over,
  };
}

/** A `lineup-fit.json`: by default a 0.25 degree turn and +0.35% scale about a pivot on site. */
export function fitOf(over: Partial<LineUpFit> = {}): LineUpFit {
  return {
    rotationDeg: 0.25,
    scale: 1.0035,
    pivotE: 500050,
    pivotN: 3999975,
    eastM: -2,
    northM: 0.5,
    maxMoveM: 2.4,
    residualPx: 0.3,
    inliers: 12,
    verdict: 'ok',
    ...over,
  };
}
