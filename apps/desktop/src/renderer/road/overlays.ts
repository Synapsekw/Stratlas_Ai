import type { MapOverlay, OverlayLayer } from '@aio/maps';
import type { PciSeverity, RoadModel, Vec3 } from '@aio/schema';
import type { Feature, FeatureCollection } from 'geojson';
import {
  DENSITY_ZERO,
  densityBreaks,
  densityColor,
  gridCellRing,
  pciRating,
  type DensityMeasure,
} from './model';

type ToLonLat = (p: Vec3 | readonly [number, number, number]) => [number, number];

export type AreaOverlay = 'none' | 'pci' | 'density';

export interface RoadLayerOptions {
  centreline: boolean;
  overlay: AreaOverlay;
  pciSeverity: PciSeverity;
  densitySize: string;
  densityMeasure: DensityMeasure;
  /** Area overlay opacity, 0 to 1. */
  opacity: number;
}

const PCI_FIELD: Record<PciSeverity, string> = {
  low: 'pciLow',
  medium: 'pciMedium',
  high: 'pciHigh',
};

/** Density cells as polygons with their class colour (`empty` cells draw faint). */
export function densityCollection(
  road: RoadModel,
  size: string,
  measure: DensityMeasure,
  toLonLat: ToLonLat,
): FeatureCollection {
  const cells = road.density.sizes[size] ?? [];
  const metres = Number(size);
  const value = (c: (typeof cells)[number]) => (measure === 'pct' ? c.coverPct : c.defects);
  const breaks = densityBreaks(cells.map(value), measure);
  const features: Feature[] = cells.map((c) => {
    const ring = gridCellRing(road.density.gridOrigin, metres, c.i, c.j).map((p) => toLonLat(p));
    const first = ring[0] ?? [0, 0];
    const color = densityColor(value(c), breaks);
    return {
      type: 'Feature',
      properties: {
        kind: 'density',
        size: metres,
        defects: c.defects,
        defectM2: c.defectM2,
        coverPct: c.coverPct,
        pavementM2: c.pavementM2,
        color: color ?? DENSITY_ZERO,
        empty: color === null,
      },
      geometry: { type: 'Polygon', coordinates: [[...ring, first]] },
    };
  });
  return { type: 'FeatureCollection', features };
}

/** Density legend: the class breaks and their colours. */
export function densityLegend(
  road: RoadModel,
  size: string,
  measure: DensityMeasure,
): { from: number; to: number | null; color: string }[] {
  const cells = road.density.sizes[size] ?? [];
  const breaks = densityBreaks(
    cells.map((c) => (measure === 'pct' ? c.coverPct : c.defects)),
    measure,
  );
  return breaks.map((b, i) => ({
    from: b,
    to: breaks[i + 1] ?? null,
    color: densityColor(b, breaks) ?? DENSITY_ZERO,
  }));
}

/** PCI unit fill and outline, coloured by the rating of the chosen severity assumption. */
export function pciLayers(road: RoadModel, sev: PciSeverity, opacity: number): OverlayLayer[] {
  const ratings = [...road.pci.ratings].sort((a, b) => a.min - b.min);
  const steps = ratings.slice(1).flatMap((r) => [r.min - 0.5, r.color]);
  return [
    {
      id: 'fill',
      type: 'fill',
      paint: {
        'fill-color': [
          'step',
          ['to-number', ['get', PCI_FIELD[sev]], -1],
          ratings[0]?.color ?? '#6d6d6d',
          ...steps,
        ],
        'fill-opacity': opacity,
      },
    },
    {
      id: 'line',
      type: 'line',
      paint: { 'line-color': '#0c121d', 'line-width': 0.6, 'line-opacity': 0.6 },
    },
  ];
}

function densityLayers(opacity: number): OverlayLayer[] {
  return [
    {
      id: 'fill',
      type: 'fill',
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': ['case', ['get', 'empty'], opacity * 0.12, opacity],
      },
    },
    {
      id: 'line',
      type: 'line',
      paint: { 'line-color': '#0c121d', 'line-width': 0.6, 'line-opacity': 0.5 },
    },
  ];
}

const CENTRELINE_LAYERS: OverlayLayer[] = [
  {
    id: 'casing',
    type: 'line',
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#0c121d', 'line-width': 4.5, 'line-opacity': 0.55 },
  },
  {
    id: 'line',
    type: 'line',
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': 2,
      'line-opacity': 0.9,
      'line-dasharray': [3, 3],
    },
  },
  {
    id: 'tick',
    type: 'circle',
    above: true,
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 3.5,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#0c121d',
      'circle-stroke-width': 1.5,
    },
  },
  {
    id: 'label',
    type: 'symbol',
    above: true,
    filter: ['==', ['geometry-type'], 'Point'],
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Medium'],
      'text-size': 11,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#0c121d', 'text-halo-width': 2 },
  },
];

function fmt(v: unknown, digits = 1): string {
  return typeof v === 'number' ? v.toFixed(digits) : 'n/a';
}

/**
 * The road overlays for the map, bottom to top: the PCI sample units, the density cells (when a
 * collection is given) and the centreline with its chainage ticks.
 */
export function roadOverlays(
  road: RoadModel,
  o: RoadLayerOptions,
  ctx: {
    url: (path: string) => string;
    toLonLat: ToLonLat;
    density: FeatureCollection | null;
    onPciUnit?: (props: Record<string, unknown>) => void;
  },
): MapOverlay[] {
  const out: MapOverlay[] = [];
  const pciPath = road.overlays?.pciUnits;
  if (pciPath) {
    const field = PCI_FIELD[o.pciSeverity];
    out.push({
      id: 'road-pci',
      data: ctx.url(pciPath),
      layers: pciLayers(road, o.pciSeverity, o.opacity),
      visible: o.overlay === 'pci',
      tooltip: (p) => {
        const raw = p[field];
        const v = typeof raw === 'number' ? raw : null;
        const rating = pciRating(road.pci.ratings, v);
        return `PCI ${v === null ? 'n/a' : Math.round(v)}${rating ? ` · ${rating.label}` : ''}\nSample unit ${typeof p.id === 'string' ? p.id : ''} · km ${fmt(p.km, 3)} · ${fmt(p.pavementM2)} m² pavement`;
      },
      ...(ctx.onPciUnit ? { onClick: ctx.onPciUnit } : {}),
    });
  }
  if (ctx.density) {
    out.push({
      id: 'road-density',
      data: ctx.density,
      layers: densityLayers(o.opacity),
      visible: o.overlay === 'density',
      tooltip: (p) =>
        `${fmt(p.size, 0)} m cell\n${fmt(p.defects, 0)} defects · ${fmt(p.defectM2)} m² · ${fmt(p.coverPct)}% of ${fmt(p.pavementM2, 0)} m² pavement`,
    });
  }
  const linePath = road.overlays?.centreline;
  if (linePath) {
    out.push({
      id: 'road-centreline',
      data: ctx.url(linePath),
      layers: CENTRELINE_LAYERS,
      visible: o.centreline,
    });
  }
  return out;
}
