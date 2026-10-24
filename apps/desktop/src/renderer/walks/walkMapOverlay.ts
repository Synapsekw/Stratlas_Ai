import { walkPathPoints, type XZ } from '@aio/geo';
import { MAP_INK, oklchHex, type MapOverlay, type OverlayLayer } from '@aio/maps';
import { shiftLocal, type DateShift, type Vec3, type WalkLayer } from '@aio/schema';
import type { Feature, FeatureCollection } from 'geojson';
import { walkPinPoints, walkShown, type SheetWalk, type WalkDrawOptions } from './walkOverlay';
import {
  along,
  arrowPoints,
  fanPoints,
  headingFromBearingDeg,
  MARKER_M,
  ringPoints,
  type WalkMarkerStyle,
  type WalkViewNow,
} from './walkView';

/*
 * The walk on the map (design "What the surface shows"): one GeoJSON overlay per shown walk,
 * through the map's `setOverlays`, in the walk's survey date colour. MapLibre cannot read CSS
 * variables, so `colourOf` gives a resolved colour here (`resolveCssColour`).
 */

/** Opacity of a walk's line outside Place walk (and of the walks not being placed). */
export const WALK_LINE_DIM = 0.6;
/** Length of the heading tick at the current position, metres. */
const TICK_M = 3;

/** Colours MapLibre parses as they are: hex, rgb() and hsl(). */
const PLAIN = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(rgb|hsl)a?\([^()]*\))$/i;
const OKLCH = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.%]+\s*)?\)$/i;

/**
 * A colour as MapLibre reads it: hex, rgb() and hsl() as given, `oklch(l c h)` as hex; anything
 * else (none, color-mix, an unknown word) falls back to the map's secondary ink.
 */
export function mapColour(colour: string): string {
  const c = colour.trim();
  if (PLAIN.test(c)) return c;
  const m = OKLCH.exec(c);
  if (!m) return MAP_INK.fg1;
  const l = Number(m[1]) / (m[2] === '%' ? 100 : 1);
  const hex = oklchHex(l, Number(m[3]), Number(m[4]));
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex : MAP_INK.fg1;
}

/**
 * A `var(--name)` colour (the date colours) as a colour MapLibre reads: its computed value through
 * `mapColour`; an unset variable falls back to the map's secondary ink.
 */
export function resolveCssColour(colour: string, el: Element = document.documentElement): string {
  const m = /^var\((--[\w-]+)\)$/.exec(colour.trim());
  if (!m?.[1]) return mapColour(colour);
  const v = getComputedStyle(el).getPropertyValue(m[1]).trim();
  return v ? mapColour(v) : MAP_INK.fg1;
}

/**
 * A point of a walk (model x/z as measured) on the map: moved with its survey date when the date
 * is lined up.
 */
const onMap =
  (proj: { toLonLat(v: Vec3): [number, number] }, shift: DateShift | null) =>
  (xz: XZ): [number, number] =>
    proj.toLonLat(shiftLocal([xz[0], 0, xz[1]], shift));

/** The map overlay id of a walk layer. */
export const walkOverlayId = (layerId: string): string => `walk-${layerId}`;
/** The map overlay id of a walk's current position (its own overlay: it moves every tick). */
export const walkNowOverlayId = (layerId: string): string => `walk-${layerId}-now`;

/** The map overlay id of the shape being placed (its own overlay: it follows the pointer). */
export const walkPreviewOverlayId = (layerId: string): string => `walk-${layerId}-preview`;

const styles = new Map<string, OverlayLayer[]>();

/**
 * The style layers of a walk's path overlay, one array per colour and placing state, so the map
 * does not restyle when only the data changes.
 */
export function pathStyle(colour: string, placing: boolean): OverlayLayer[] {
  const key = `${colour}|${placing ? 'placing' : 'shown'}`;
  let out = styles.get(key);
  if (!out) {
    out = buildPathStyle(colour, placing);
    styles.set(key, out);
  }
  return out;
}

const nowStyles = new Map<string, OverlayLayer[]>();

/** The style layers of a walk's current position overlay, one array per colour. */
export function nowStyle(colour: string): OverlayLayer[] {
  let out = nowStyles.get(colour);
  if (!out) {
    out = [
      {
        id: 'tick',
        type: 'line',
        filter: ['==', ['get', 'kind'], 'tick'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
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
    ];
    nowStyles.set(colour, out);
  }
  return out;
}

function buildPathStyle(colour: string, placing: boolean): OverlayLayer[] {
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
      id: 'pins',
      type: 'circle',
      filter: ['==', ['get', 'kind'], 'pin'],
      paint: {
        'circle-radius': 9,
        'circle-color': [
          'case',
          ['==', ['get', 'role'], 'start'],
          MAP_INK.bg0,
          ['get', 'active'],
          colour,
          MAP_INK.bg0,
        ],
        'circle-stroke-color': [
          'case',
          ['==', ['get', 'role'], 'start'],
          colour,
          ['get', 'active'],
          MAP_INK.bg0,
          colour,
        ],
        'circle-stroke-width': 2,
      },
      above: true,
    },
    {
      id: 'pin-n',
      type: 'symbol',
      filter: ['all', ['==', ['get', 'kind'], 'pin'], ['==', ['get', 'role'], 'pin']],
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
 * stretch without a pin), kept stills, and for the walk being placed its numbered pins. Build it
 * again (new data) only when a fit changes; the current position is `walkNowMapOverlay`.
 */
export function walkMapOverlays(
  walks: readonly SheetWalk[],
  proj: { toLonLat(v: Vec3): [number, number] },
  colourOf: (l: WalkLayer) => string,
  opts: WalkDrawOptions,
): MapOverlay[] {
  const out: MapOverlay[] = [];
  for (const { layer, fit, raw, shift } of walks) {
    if (!walkShown(layer, opts)) continue;
    const ll = onMap(proj, shift ?? null);
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
          properties: { kind: 'pin', n: p.n, index: p.index, active: p.active, role: p.role },
          geometry: { type: 'Point', coordinates: ll(p.xz) },
        });
    }
    const data: FeatureCollection = { type: 'FeatureCollection', features };
    out.push({ id: walkOverlayId(layer.id), data, layers: pathStyle(colourOf(layer), placing) });
  }
  return out;
}

/**
 * The current position of a walk at time `nowT` (seconds) with a short heading tick, as its own
 * small overlay so a time tick does not rebuild the path. Null before the walk is placed.
 */
export function walkNowMapOverlay(
  walk: SheetWalk,
  proj: { toLonLat(v: Vec3): [number, number] },
  colourOf: (l: WalkLayer) => string,
  nowT: number | null,
): MapOverlay | null {
  if (nowT === null || !Number.isFinite(nowT)) return null;
  const a = walk.fit.at(nowT);
  if (!a) return null;
  const ll = onMap(proj, walk.shift ?? null);
  const tip: XZ = [
    a.xz[0] - TICK_M * Math.sin(a.headingRad),
    a.xz[1] - TICK_M * Math.cos(a.headingRad),
  ];
  const data: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
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
    ],
  };
  return { id: walkNowOverlayId(walk.layer.id), data, layers: nowStyle(colourOf(walk.layer)) };
}

const previewStyles = new Map<string, OverlayLayer[]>();

/** The style of the shape being placed, one array per colour and look (data changes only). */
function previewStyle(colour: string, ghost: boolean, tooClose: boolean): OverlayLayer[] {
  const key = `${colour}|${String(ghost)}|${String(tooClose)}`;
  let out = previewStyles.get(key);
  if (!out) {
    out = [
      {
        id: 'preview',
        type: 'line',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': colour,
          'line-width': 2,
          'line-opacity': ghost ? 0.45 : 1,
          ...(ghost || tooClose ? { 'line-dasharray': [2, 2] } : {}),
        },
        above: true,
      },
    ];
    previewStyles.set(key, out);
  }
  return out;
}

/** The shape being placed on the map (ghost or live), or null with fewer than two points. */
export function walkPreviewMapOverlay(
  layerId: string,
  xz: readonly XZ[],
  proj: { toLonLat(v: Vec3): [number, number] },
  colour: string,
  ghost: boolean,
  tooClose: boolean,
  shift: DateShift | null = null,
): MapOverlay | null {
  if (xz.length < 2) return null;
  const ll = onMap(proj, shift);
  const data: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { kind: 'preview' },
        geometry: {
          type: 'LineString',
          coordinates: xz.map(ll),
        },
      },
    ],
  };
  return { id: walkPreviewOverlayId(layerId), data, layers: previewStyle(colour, ghost, tooClose) };
}

// ---------------------------------------------------------------- SPIKE: the view cone marker

/** The map overlay id of a walk's position marker with its view cone. */
export const walkMarkerOverlayId = (layerId: string): string => `walk-${layerId}-marker`;

const markerStyles = new Map<string, OverlayLayer[]>();

/** The style layers of a marker, one array per colour and design (data-driven opacities). */
function markerStyle(colour: string, style: WalkMarkerStyle, dim: boolean): OverlayLayer[] {
  const key = `${colour}|${style}|${String(dim)}`;
  let out = markerStyles.get(key);
  if (out) return out;
  const k = dim ? 0.45 : 1;
  const is = (part: string): unknown[] => ['==', ['get', 'part'], part];
  out = [
    {
      id: 'fill',
      type: 'fill',
      filter: is('fill'),
      paint: {
        'fill-color': ['coalesce', ['get', 'colour'], colour],
        'fill-opacity': ['*', ['get', 'op'], k],
      },
      above: true,
    },
    {
      id: 'edge',
      type: 'line',
      filter: is('edge'),
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'colour'], colour],
        'line-width': ['get', 'w'],
        'line-opacity': k,
      },
      above: true,
    },
    {
      id: 'dot',
      type: 'circle',
      filter: is('dot'),
      paint: {
        'circle-radius': style === 'compass' ? 6 : 7,
        'circle-color': colour,
        'circle-stroke-color': MAP_INK.fg0,
        'circle-stroke-width': 2.5,
        'circle-opacity': k,
        'circle-stroke-opacity': k,
      },
      above: true,
    },
    {
      id: 'tick',
      type: 'circle',
      filter: is('tick'),
      paint: { 'circle-radius': 2.4, 'circle-color': MAP_INK.fg0, 'circle-opacity': k },
      above: true,
    },
  ];
  markerStyles.set(key, out);
  return out;
}

type LonLatOf = (xz: XZ) => [number, number];
const poly = (pts: readonly XZ[], ll: LonLatOf): Feature['geometry'] => ({
  type: 'Polygon',
  coordinates: [[...pts.map(ll), ll(pts[0] ?? [0, 0])]],
});
const lineOf = (pts: readonly XZ[], ll: LonLatOf): Feature['geometry'] => ({
  type: 'LineString',
  coordinates: pts.map(ll),
});

/**
 * Where walk `walk` is at `view.t` with a view cone along its look (`view.lookDeg`, `view.hfovDeg`
 * wide) in design `style`, as its own small overlay; the walk direction is a small tick. Without
 * a look (the walk not placed yet) the cone is left out. Null when the walk has no spot then.
 */
export function walkMarkerMapOverlay(
  walk: SheetWalk,
  proj: { toLonLat(v: Vec3): [number, number] },
  colour: string,
  view: WalkViewNow,
  style: WalkMarkerStyle,
  opts: { dim?: boolean } = {},
): MapOverlay | null {
  if (!Number.isFinite(view.t)) return null;
  const a = walk.fit.at(view.t);
  if (!a) return null;
  const ll = onMap(proj, walk.shift ?? null);
  const half = (Math.min(170, Math.max(5, view.hfovDeg)) * Math.PI) / 360;
  const look = view.lookDeg === null ? null : headingFromBearingDeg(view.lookDeg);
  const features: Feature[] = [];
  const f = (part: string, geometry: Feature['geometry'], props: Record<string, unknown> = {}) => {
    features.push({ type: 'Feature', properties: { part, ...props }, geometry });
  };
  const tick = (dist: number) => {
    f('tick', { type: 'Point', coordinates: ll(along(a.xz, a.headingRad, dist)) });
  };
  if (style === 'beam') {
    // a radial fade: four nested fans, the overlap darkest at the apex
    if (look !== null)
      for (const r of [1, 0.83, 0.67, 0.5, 0.33, 0.17])
        f('fill', poly(fanPoints(a.xz, look, half, MARKER_M.beam * r), ll), { op: 0.15 });
    tick(MARKER_M.tick);
  } else if (style === 'compass') {
    f('fill', poly(ringPoints(a.xz, MARKER_M.compassRing), ll), { op: 0.45, colour: '#0b0f14' });
    f('edge', lineOf(ringPoints(a.xz, MARKER_M.compassRing), ll), { w: 2 });
    if (look !== null) {
      const fan = fanPoints(a.xz, look, half, MARKER_M.compassFan);
      f('fill', poly(fan, ll), { op: 0.35 });
      f('edge', lineOf([...fan, a.xz], ll), { w: 1.5 });
    }
    // the walk direction: a chevron on the ring
    const tip = along(a.xz, a.headingRad, MARKER_M.compassRing + 0.6);
    const back = along(a.xz, a.headingRad, MARKER_M.compassRing - 0.9);
    const side = (s: number): XZ => along(back, a.headingRad + (s * Math.PI) / 2, 1.1);
    f('edge', lineOf([side(1), tip, side(-1)], ll), { w: 2.5, colour: MAP_INK.fg0 });
  } else {
    if (look !== null) {
      const fan = fanPoints(a.xz, look, half, MARKER_M.rays);
      f('fill', poly(fan, ll), { op: 0.1 });
      f('edge', lineOf([fan[1] ?? a.xz, a.xz, fan.at(-1) ?? a.xz], ll), { w: 1.5 });
      // the arrowhead turned to the look
      const [nose, l, notch, r] = arrowPoints(a.xz, look);
      f('fill', poly([nose, l, notch, r], ll), { op: 1 });
      f('edge', lineOf([nose, l, notch, r, nose], ll), { w: 2, colour: MAP_INK.fg0 });
    }
    tick(MARKER_M.tick);
  }
  // the rays design's arrowhead is the position; the others draw a dot
  if (style !== 'rays' || look === null) f('dot', { type: 'Point', coordinates: ll(a.xz) });
  return {
    id: walkMarkerOverlayId(walk.layer.id),
    data: { type: 'FeatureCollection', features },
    layers: markerStyle(colour, style, opts.dim === true),
  };
}
