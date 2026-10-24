import { walkPathPoints, type XZ } from '@aio/geo';
import { MAP_INK, oklchHex, type MapOverlay, type OverlayLayer } from '@aio/maps';
import { shiftLocal, type DateShift, type Vec3, type WalkLayer } from '@aio/schema';
import type { Feature, FeatureCollection } from 'geojson';
import { walkPinPoints, walkShown, type SheetWalk, type WalkDrawOptions } from './walkOverlay';
import { BEAM_FADE, BEAM_PX, beamFanPath, beamHalfRad, type WalkViewNow } from './walkView';

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

// ---------------------------------------------------------------- the Beam marker

/**
 * Where a walk a 360 pane shows is and where it looks, for its Beam on the map: the spot as
 * lon/lat, the look's compass bearing (null while the walk is not placed: no cone), the view's
 * horizontal field of view and the compass bearing the walk moves along.
 */
export interface BeamMarker {
  layerId: string;
  lonLat: [number, number];
  lookDeg: number | null;
  hfovDeg: number;
  walkDeg: number;
  colour: string;
}

/** The compass bearing (degrees, clockwise from north, 0 to 360) of a model heading (radians). */
const bearingOf = (headingRad: number): number => {
  const d = (-headingRad * 180) / Math.PI;
  return (((d % 360) + 360) % 360) + 0;
};

/** The Beam of walk `walk` at the view's time, or null when the walk has no spot then. */
export function walkBeamMarker(
  walk: SheetWalk,
  proj: { toLonLat(v: Vec3): [number, number] },
  colour: string,
  view: WalkViewNow,
): BeamMarker | null {
  if (!Number.isFinite(view.t)) return null;
  const a = walk.fit.at(view.t);
  if (!a) return null;
  return {
    layerId: walk.layer.id,
    lonLat: onMap(proj, walk.shift ?? null)(a.xz),
    lookDeg: view.lookDeg,
    hfovDeg: view.hfovDeg,
    walkDeg: bearingOf(a.headingRad),
    colour,
  };
}

const n3 = (v: number): string => String(Math.round(v * 1000) / 1000 || 0);

/**
 * The SVG transform that turns the Beam's fan (drawn along +x, east on a north-up screen) to the
 * compass bearing `worldDeg` on a map turned to `mapBearingDeg`, and lays it on the ground of a
 * map pitched `pitchDeg` (the screen shortens the ground's depth by its cosine).
 */
export function beamConeTransform(
  worldDeg: number,
  mapBearingDeg: number,
  pitchDeg: number,
): string {
  const k = Math.cos((Math.min(85, Math.max(0, pitchDeg)) * Math.PI) / 180);
  return `scale(1 ${n3(k)}) rotate(${n3(worldDeg - mapBearingDeg - 90)})`;
}

/** The slice of a MapLibre map the Beam markers use. */
export interface BeamMap {
  getContainer(): HTMLElement;
  project(lonLat: [number, number]): { x: number; y: number };
  getBearing(): number;
  getPitch(): number;
  on(type: 'move' | 'resize', fn: () => void): unknown;
  off(type: 'move' | 'resize', fn: () => void): unknown;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
let beamSeq = 0;

interface BeamEl {
  root: HTMLDivElement;
  svg: SVGSVGElement;
  cone: SVGGElement;
  fan: SVGPathElement;
  stops: SVGStopElement[];
  tick: SVGGElement;
  dot: SVGCircleElement;
  marker: BeamMarker;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * The Beam markers of the walks the 360 panes show, as HTML over a MapLibre map: one per walk,
 * the same size on screen at every zoom (it still reads zoomed right out), its fan one smooth
 * radial fade (an SVG gradient, no stacked shapes), turned by the look bearing less the map
 * bearing and laid on the ground when the map pitches. Each names its walk (`data-layer-id`) and
 * its look (`data-look-deg`, the compass bearing rounded) for the end to end tests. It takes no
 * pointer.
 */
export class MapBeamMarkers {
  private readonly els = new Map<string, BeamEl>();
  private readonly layout = (): void => {
    for (const e of this.els.values()) this.place(e);
  };

  constructor(private readonly map: BeamMap) {
    map.on('move', this.layout);
    map.on('resize', this.layout);
  }

  /** Show these markers (later ones on top); the others go. */
  set(markers: readonly BeamMarker[]): void {
    const keep = new Set(markers.map((m) => m.layerId));
    for (const [id, e] of this.els)
      if (!keep.has(id)) {
        e.root.remove();
        this.els.delete(id);
      }
    for (const m of markers) {
      const e = this.els.get(m.layerId) ?? this.create(m);
      this.update(e, m);
      this.place(e);
    }
  }

  dispose(): void {
    this.map.off('move', this.layout);
    this.map.off('resize', this.layout);
    for (const e of this.els.values()) e.root.remove();
    this.els.clear();
  }

  private create(m: BeamMarker): BeamEl {
    const host = this.map.getContainer();
    const doc = host.ownerDocument;
    const r = BEAM_PX.reach;
    const root = doc.createElement('div');
    root.className = 'walk-beam';
    root.dataset.testid = 'walk-beam';
    root.setAttribute('aria-hidden', 'true');
    Object.assign(root.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      pointerEvents: 'none',
      willChange: 'transform',
    });
    const svg = svgEl(doc, 'svg', {
      width: String(2 * r),
      height: String(2 * r),
      viewBox: `${String(-r)} ${String(-r)} ${String(2 * r)} ${String(2 * r)}`,
    });
    Object.assign(svg.style, {
      position: 'absolute',
      left: `${String(-r)}px`,
      top: `${String(-r)}px`,
      overflow: 'visible',
    });
    const id = `walk-beam-${String(++beamSeq)}`;
    const grad = svgEl(doc, 'radialGradient', {
      id,
      gradientUnits: 'userSpaceOnUse',
      cx: '0',
      cy: '0',
      r: String(r),
    });
    const stops = BEAM_FADE.map(([at, op]) =>
      svgEl(doc, 'stop', { offset: String(at), 'stop-opacity': String(op) }),
    );
    grad.append(...stops);
    const defs = svgEl(doc, 'defs', {});
    defs.append(grad);
    const cone = svgEl(doc, 'g', { 'data-part': 'cone' });
    const fan = svgEl(doc, 'path', { fill: `url(#${id})` });
    cone.append(fan);
    // the way the walk moves: a small light dot just ahead of the spot
    const tick = svgEl(doc, 'g', { 'data-part': 'tick' });
    tick.append(
      svgEl(doc, 'circle', {
        cx: String(BEAM_PX.tick),
        cy: '0',
        r: String(BEAM_PX.tickR),
        fill: MAP_INK.fg0,
        stroke: MAP_INK.bg0,
        'stroke-width': '1',
      }),
    );
    const dot = svgEl(doc, 'circle', {
      'data-part': 'dot',
      r: String(BEAM_PX.dot),
      stroke: MAP_INK.fg0,
      'stroke-width': String(BEAM_PX.ring),
    });
    svg.append(defs, cone, tick, dot);
    root.append(svg);
    host.append(root);
    const e: BeamEl = { root, svg, cone, fan, stops, tick, dot, marker: m };
    this.els.set(m.layerId, e);
    return e;
  }

  private update(e: BeamEl, m: BeamMarker): void {
    e.marker = m;
    e.root.dataset.layerId = m.layerId;
    if (m.lookDeg === null) {
      delete e.root.dataset.lookDeg;
      e.cone.remove();
    } else {
      e.root.dataset.lookDeg = String(Math.round(((m.lookDeg % 360) + 360) % 360) % 360);
      if (!e.cone.isConnected) e.svg.insertBefore(e.cone, e.tick);
      e.fan.setAttribute('d', beamFanPath(BEAM_PX.reach, beamHalfRad(m.hfovDeg)));
    }
    for (const s of e.stops) s.setAttribute('stop-color', m.colour);
    e.dot.setAttribute('fill', m.colour);
  }

  private place(e: BeamEl): void {
    const p = this.map.project(e.marker.lonLat);
    e.root.style.transform = `translate(${n3(p.x)}px, ${n3(p.y)}px)`;
    const bearing = this.map.getBearing();
    const pitch = this.map.getPitch();
    if (e.marker.lookDeg !== null)
      e.cone.setAttribute('transform', beamConeTransform(e.marker.lookDeg, bearing, pitch));
    e.tick.setAttribute('transform', beamConeTransform(e.marker.walkDeg, bearing, pitch));
  }
}
