import { walkPathPoints, type XZ } from '@aio/geo';
import { MAP_INK, oklchHex, type MapOverlay, type OverlayLayer } from '@aio/maps';
import type { Vec3, WalkLayer } from '@aio/schema';
import type { Feature, FeatureCollection } from 'geojson';
import { walkPinPoints, walkShown, type SheetWalk, type WalkDrawOptions } from './walkOverlay';

/*
 * The walk on the map (design "What the surface shows"): one GeoJSON overlay per shown walk,
 * through the map's `setOverlays`, in the walk's survey date colour. MapLibre cannot read CSS
 * variables, so `colourOf` gives a resolved colour here (`resolveCssColour`).
 */

/** Opacity of a walk's line outside Place walk (and of the walks not being placed). */
export const WALK_LINE_DIM = 0.6;
/** Length of the heading tick at the current position, metres. */
const TICK_M = 3;

/** An `oklch(l c h)` colour as hex (MapLibre does not parse oklch), else as given. */
export function mapColour(colour: string): string {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.%]+\s*)?\)$/i.exec(
    colour.trim(),
  );
  if (!m) return colour;
  const l = Number(m[1]) / (m[2] === '%' ? 100 : 1);
  return oklchHex(l, Number(m[3]), Number(m[4]));
}

/**
 * A `var(--name)` colour (the date colours) as a colour MapLibre reads: its computed value,
 * oklch turned into hex; anything else as given.
 */
export function resolveCssColour(colour: string, el: Element = document.documentElement): string {
  const m = /^var\((--[\w-]+)\)$/.exec(colour.trim());
  if (!m?.[1]) return mapColour(colour);
  const v = getComputedStyle(el).getPropertyValue(m[1]).trim();
  return v ? mapColour(v) : colour;
}

/** The map overlay id of a walk layer. */
export const walkOverlayId = (layerId: string): string => `walk-${layerId}`;

function styleFor(colour: string, placing: boolean): OverlayLayer[] {
  const opacity = placing ? 1 : WALK_LINE_DIM;
  const lineLayout = { 'line-join': 'round', 'line-cap': 'round' };
  const isLine = (dashed: boolean): unknown[] => [
    'all',
    ['==', ['get', 'kind'], 'line'],
    ['==', ['get', 'dashed'], dashed],
  ];
  return [
    {
      id: 'stills',
      type: 'circle',
      filter: ['==', ['get', 'kind'], 'still'],
      paint: { 'circle-radius': 1.5, 'circle-color': colour, 'circle-opacity': opacity },
    },
    {
      id: 'line',
      type: 'line',
      filter: isLine(false),
      layout: lineLayout,
      paint: { 'line-color': colour, 'line-width': 2, 'line-opacity': opacity },
    },
    {
      id: 'line-dashed',
      type: 'line',
      filter: isLine(true),
      layout: lineLayout,
      paint: {
        'line-color': colour,
        'line-width': 2,
        'line-opacity': opacity,
        'line-dasharray': [2, 2],
      },
    },
    {
      id: 'now-tick',
      type: 'line',
      filter: ['==', ['get', 'kind'], 'tick'],
      layout: lineLayout,
      paint: { 'line-color': colour, 'line-width': 2 },
      above: true,
    },
    {
      id: 'now',
      type: 'circle',
      filter: ['==', ['get', 'kind'], 'now'],
      paint: {
        'circle-radius': 5,
        'circle-color': colour,
        'circle-stroke-color': MAP_INK.bg0,
        'circle-stroke-width': 2,
      },
      above: true,
    },
    {
      id: 'pins',
      type: 'circle',
      filter: ['==', ['get', 'kind'], 'pin'],
      paint: {
        'circle-radius': 9,
        'circle-color': ['case', ['get', 'active'], colour, MAP_INK.bg0],
        'circle-stroke-color': ['case', ['get', 'active'], MAP_INK.bg0, colour],
        'circle-stroke-width': 2,
      },
      above: true,
    },
    {
      id: 'pin-n',
      type: 'symbol',
      filter: ['==', ['get', 'kind'], 'pin'],
      layout: {
        'text-field': ['to-string', ['get', 'n']],
        'text-font': ['Noto Sans Medium'],
        'text-size': 11,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': ['case', ['get', 'active'], MAP_INK.bg0, colour] },
      above: true,
    },
  ];
}

/**
 * One overlay per shown walk (visible and placed, or being placed): its line (dashed across a
 * stretch without a pin), kept stills, and for the walk being placed its numbered pins and the
 * current position with a heading tick. Build it again (new data) when a fit changes.
 */
export function walkMapOverlays(
  walks: readonly SheetWalk[],
  proj: { toLonLat(v: Vec3): [number, number] },
  colourOf: (l: WalkLayer) => string,
  opts: WalkDrawOptions,
): MapOverlay[] {
  const ll = (xz: XZ): [number, number] => proj.toLonLat([xz[0], 0, xz[1]]);
  const out: MapOverlay[] = [];
  for (const { layer, fit, raw } of walks) {
    if (!walkShown(layer, opts)) continue;
    const placing = layer.id === opts.placingId;
    const path = walkPathPoints(fit, raw, layer.durationS);
    const features: Feature[] = [];
    for (const run of path.line) {
      if (run.length < 2) continue;
      features.push({
        type: 'Feature',
        properties: { kind: 'line', dashed: run.at(-1)?.dashed ?? false },
        geometry: { type: 'LineString', coordinates: run.map((p) => ll(p.xz)) },
      });
    }
    for (const s of path.stills)
      features.push({
        type: 'Feature',
        properties: { kind: 'still', n: s.n },
        geometry: { type: 'Point', coordinates: ll(s.xz) },
      });
    if (placing) {
      for (const p of walkPinPoints(fit))
        features.push({
          type: 'Feature',
          properties: { kind: 'pin', n: p.n, index: p.index, active: p.active },
          geometry: { type: 'Point', coordinates: ll(p.xz) },
        });
      const a = opts.nowT !== null ? fit.at(opts.nowT) : null;
      if (a) {
        const tip: XZ = [
          a.xz[0] - TICK_M * Math.sin(a.headingRad),
          a.xz[1] - TICK_M * Math.cos(a.headingRad),
        ];
        features.push(
          {
            type: 'Feature',
            properties: { kind: 'tick' },
            geometry: { type: 'LineString', coordinates: [ll(a.xz), ll(tip)] },
          },
          {
            type: 'Feature',
            properties: { kind: 'now' },
            geometry: { type: 'Point', coordinates: ll(a.xz) },
          },
        );
      }
    }
    const data: FeatureCollection = { type: 'FeatureCollection', features };
    out.push({ id: walkOverlayId(layer.id), data, layers: styleFor(colourOf(layer), placing) });
  }
  return out;
}
