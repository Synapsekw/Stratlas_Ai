import type { EngineStage } from '@aio/engine';
import type { WalkFit } from '@aio/geo';
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Points,
  PointsMaterial,
  Vector2,
  Vector3,
} from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  along,
  arrowPoints,
  fanPoints,
  MARKER_M,
  ringPoints,
  type WalkMarkerStyle,
} from './walkView';

/*
 * The walk in the 3D view (design "Walk placing by start and end", unit 6): the path as a line
 * on the ground at the clicked heights, the shape that follows the pointer, and the Start and
 * End handles, drawn over the model (no depth test, raised render order). Hover through
 * `stage.raycast`, clicks through `stage.claimClicks`, a handle drag with the orbit controls off.
 * Placed walks lie on the ground the view draws (draped by `walkGround.ts`), 3 px over a dark
 * halo and depth tested, so the ground and models in front hide them. The session behind it is
 * wired in `WalkSceneMount.tsx`.
 */

export const WALK_SCENE_GROUP = 'aio-walks';
export const WALK_PREVIEW_NAME = 'aio-walk-preview';

/** A walk's path in the model, runs split where the dashed state changes. */
export interface WalkSceneWalk {
  id: string;
  colour: string;
  runs: { pts: [number, number, number][]; dashed: boolean }[];
}
/** What the walk being placed in the 3D view shows and takes. */
export interface WalkScenePlacing {
  walk: WalkSceneWalk | null;
  preview: { pts: [number, number, number][]; ghost: boolean; tooClose: boolean } | null;
  handles: { id: 'start' | 'end'; at: [number, number, number] }[];
  /** A click on the view is wanted (start, end, or a fine-tune pin, move or align). */
  clicks: boolean;
}
export interface WalkSceneInput {
  hover(at: [number, number] | null, y?: number): void;
  click(at: [number, number], y: number): void;
  drag(handle: 'start' | 'end', at: [number, number], y: number): void;
  endDrag(): void;
}
/** SPIKE: where a walk a 360 pane shows is, and where it looks, on the ground of the 3D view. */
export interface WalkSceneMarker {
  id: string;
  colour: string;
  /** The ground under the spot, scene coordinates. */
  at: [number, number, number];
  /** Model heading of the look (null: no look, the walk not placed), and half the cone's width. */
  lookHeadingRad: number | null;
  halfRad: number;
  /** Model heading of the walk itself (the small direction tick). */
  walkHeadingRad: number;
  style: WalkMarkerStyle;
  dim?: boolean;
}
export interface WalkSceneView {
  /** Placed walks, draped on the ground (not the one being placed). */
  setPlaced(walks: readonly WalkSceneWalk[]): void;
  setPlacing(p: WalkScenePlacing | null, input: WalkSceneInput | null): void;
  /** SPIKE: the markers of the walks the 360 panes show. */
  setMarkers(markers: readonly WalkSceneMarker[]): void;
  dispose(): void;
}
/** Lines sit this far above the ground, metres, so the ground does not hide them. */
const LIFT_M = 0.1;
/** Placed walks are draped on the ground and depth tested, lifted this much, metres. */
export const DRAPE_LIFT_M = 0.15;
/** SPIKE: the marker's stem, metres, with its dot on top. */
const STEM_M = 1.8;
/** A placed walk's line, screen px, over a dark halo 3 px wider. */
export const PLACED_PX = 3;
const HALO = '#0b0f14';
/** A press this close to a handle (screen px) grabs it. */
const HANDLE_PX = 10;
const GHOST = 0.45;

export function sceneRuns(
  fit: WalkFit,
  durationS: number,
  stepS = 0.25,
  lift = LIFT_M,
): WalkSceneWalk['runs'] {
  const runs: WalkSceneWalk['runs'] = [];
  let cur: WalkSceneWalk['runs'][number] | null = null;
  const end = Number.isFinite(durationS) && durationS > 0 ? durationS : 0;
  const step = Number.isFinite(stepS) && stepS > 0 ? stepS : 0.25;
  // whole steps, then the end itself, so the line always reaches the last second
  const n = Math.ceil(end / step - 1e-9);
  for (let i = 0; i <= n; i++) {
    const a = fit.at(Math.min(i * step, end));
    if (!a) {
      cur = null;
      continue;
    }
    const p: [number, number, number] = [a.xz[0], a.groundY + lift, a.xz[1]];
    if (cur?.dashed !== a.dashed) {
      // runs share their joint, so a dashed stretch meets the solid one
      const prev: WalkSceneWalk['runs'][number] | null = cur;
      const joint: [number, number, number] | undefined = prev?.pts.at(-1);
      const next: WalkSceneWalk['runs'][number] = { pts: joint ? [joint] : [], dashed: a.dashed };
      runs.push(next);
      cur = next;
    }
    cur.pts.push(p);
  }
  return runs.filter((r) => r.pts.length > 1);
}

export function previewPoints(
  xz: readonly [number, number][],
  y: [number, number] | null,
  lift = LIFT_M,
): [number, number, number][] {
  const n = xz.length;
  return xz.map((p, i) => {
    const f = n > 1 ? i / (n - 1) : 0;
    const h = y ? y[0] + (y[1] - y[0]) * f : 0;
    return [p[0], h + lift, p[1]];
  });
}

let dotTexture: CanvasTexture | null | undefined;
/** A round dot for points (they draw squares otherwise); null where there is no canvas. */
function roundDot(): CanvasTexture | null {
  if (dotTexture !== undefined) return dotTexture;
  const c = typeof document === 'undefined' ? null : document.createElement('canvas');
  const g = c?.getContext('2d') ?? null;
  if (!c || !g) return (dotTexture = null);
  c.width = c.height = 64;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  dotTexture = new CanvasTexture(c);
  return dotTexture;
}

export function attachWalkScene(stage: EngineStage): WalkSceneView {
  const group = new Group();
  group.name = WALK_SCENE_GROUP;
  group.renderOrder = 45;
  stage.scene.add(group);
  const placedGroup = new Group();
  const placingGroup = new Group();
  const markerGroup = new Group();
  group.add(placedGroup, placingGroup, markerGroup);
  const canvas = stage.renderer.domElement;

  let placing: WalkScenePlacing | null = null;
  let input: WalkSceneInput | null = null;
  let dragging: 'start' | 'end' | null = null;

  const line = (
    pts: readonly [number, number, number][],
    colour: string,
    opacity: number,
    dashed: boolean,
  ): Line => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pts.flat(), 3));
    // no fog: an overlay reads clearly however far the camera backs off (as the measure tool)
    const common = {
      color: new Color(colour),
      depthTest: false,
      fog: false,
      transparent: true,
      opacity,
    };
    const l = new Line(
      g,
      dashed
        ? new LineDashedMaterial({ ...common, dashSize: 0.6, gapSize: 0.4 })
        : new LineBasicMaterial(common),
    );
    if (dashed) l.computeLineDistances();
    l.renderOrder = 45;
    return l;
  };
  const size = new Vector2();
  /**
   * A line `width` pixels wide that the ground and models in front hide (depth tested unless
   * `depth` is false, pulled a little towards the camera so the surface it lies on does not
   * cover it).
   */
  const fatLine = (
    pts: readonly (readonly [number, number, number])[],
    colour: string,
    opacity: number,
    width: number,
    opts: { dashed?: boolean; depth?: boolean; order?: number } = {},
  ): Line2 => {
    const g = new LineGeometry();
    g.setPositions(pts.flatMap((p) => [p[0], p[1], p[2]]));
    const mat = new LineMaterial({
      color: new Color(colour).getHex(),
      linewidth: width,
      transparent: true,
      opacity,
      depthTest: opts.depth !== false,
      depthWrite: false,
      dashed: opts.dashed === true,
      dashSize: 0.6,
      gapSize: 0.4,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    mat.fog = false;
    const l = new Line2(g, mat);
    if (opts.dashed) l.computeLineDistances();
    l.renderOrder = opts.order ?? 45;
    l.frustumCulled = false;
    l.raycast = () => undefined;
    // fat lines take their width in pixels of the canvas they are drawn on
    l.onBeforeRender = (renderer) => {
      renderer.getSize(size);
      mat.resolution.set(size.x, size.y);
    };
    return l;
  };
  const disposeTree = (o: Object3D) => {
    o.traverse((c) => {
      const m = c as Partial<Mesh>;
      m.geometry?.dispose();
      const mat = m.material;
      if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) x.dispose();
    });
  };
  const clear = (g: Group) => {
    for (const c of [...g.children]) {
      g.remove(c);
      disposeTree(c);
    }
  };
  const drawWalk = (g: Group, w: WalkSceneWalk, opacity: number) => {
    for (const r of w.runs) g.add(line(r.pts, w.colour, opacity, r.dashed));
  };
  /** A placed walk on the ground: its date colour over a dark halo, depth tested. */
  const drawDraped = (g: Group, w: WalkSceneWalk) => {
    for (const r of w.runs) {
      g.add(fatLine(r.pts, HALO, 0.45, PLACED_PX + 3, { dashed: r.dashed }));
      g.add(fatLine(r.pts, w.colour, 0.95, PLACED_PX, { dashed: r.dashed, order: 46 }));
    }
  };

  /** A flat fan or polygon on the ground: `pts` in x/z about the marker, `alpha` per point. */
  const flat = (
    pts: readonly (readonly [number, number])[],
    y: number,
    colour: string,
    alpha: readonly number[] | number,
    fan = true,
  ): Mesh => {
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new Float32BufferAttribute(
        pts.flatMap((p) => [p[0], y, p[1]]),
        3,
      ),
    );
    const c = new Color(colour);
    g.setAttribute(
      'color',
      new Float32BufferAttribute(
        pts.flatMap((_, i) => [c.r, c.g, c.b, typeof alpha === 'number' ? alpha : (alpha[i] ?? 0)]),
        4,
      ),
    );
    const idx: number[] = [];
    // a fan about point 0 (the apex or, for a ring's fill, a first point on it)
    for (let i = 1; i < pts.length - 1; i++) idx.push(0, i, i + 1);
    if (!fan && pts.length > 2) idx.push(0, pts.length - 1, 1);
    g.setIndex(idx);
    const m = new Mesh(
      g,
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        fog: false,
      }),
    );
    m.renderOrder = 47;
    m.raycast = () => undefined;
    return m;
  };

  /** SPIKE: one marker: the design's cone on the ground, a stem and a dot on top. */
  const drawMarker = (mk: WalkSceneMarker): Group => {
    const g = new Group();
    g.name = `aio-walk-marker-${mk.id}`;
    g.position.set(mk.at[0], mk.at[1], mk.at[2]);
    const k = mk.dim ? 0.45 : 1;
    const y = 0.08;
    const o: [number, number] = [0, 0];
    const xyz = (p: readonly [number, number], h = y): [number, number, number] => [p[0], h, p[1]];
    const look = mk.lookHeadingRad;
    const half = mk.halfRad;
    const tickDot = () => {
      const p = along(o, mk.walkHeadingRad, MARKER_M.tick);
      g.add(flat(ringPoints(p, 0.22, 12), y + 0.01, '#f0f2f4', 0.95 * k, false));
    };
    if (mk.style === 'beam') {
      if (look !== null) {
        // the apex strong, the rim gone: a beam of light along the look (two fans: a quick
        // fall-off near the spot, a long faint reach)
        const fan = fanPoints(o, look, half, MARKER_M.beam, 24);
        const near = fanPoints(o, look, half, MARKER_M.beam * 0.5, 24);
        g.add(flat(fan, y, mk.colour, [0.7 * k, ...fan.slice(1).map(() => 0.05 * k)]));
        g.add(flat(near, y + 0.005, mk.colour, [0.6 * k, ...near.slice(1).map(() => 0)]));
      }
      g.add(flat(ringPoints(o, 0.45, 16), y + 0.012, mk.colour, k, false));
      tickDot();
    } else if (mk.style === 'compass') {
      const ring = ringPoints(o, MARKER_M.compassRing, 40);
      g.add(flat(ring, y - 0.01, '#0b0f14', 0.45 * k, false));
      g.add(
        fatLine(
          ring.map((p) => xyz(p)),
          mk.colour,
          k,
          2,
          { order: 48 },
        ),
      );
      if (look !== null) {
        const fan = fanPoints(o, look, half, MARKER_M.compassFan, 24);
        g.add(flat(fan, y + 0.01, mk.colour, 0.35 * k));
        g.add(
          fatLine(
            [...fan, o].map((p) => xyz(p)),
            mk.colour,
            k,
            1.5,
            { order: 48 },
          ),
        );
      }
      const tip = along(o, mk.walkHeadingRad, MARKER_M.compassRing + 0.6);
      const back = along(o, mk.walkHeadingRad, MARKER_M.compassRing - 0.9);
      const side = (s: number) => along(back, mk.walkHeadingRad + (s * Math.PI) / 2, 1.1);
      g.add(
        fatLine(
          [side(1), tip, side(-1)].map((p) => xyz(p, y + 0.02)),
          '#f0f2f4',
          k,
          2.5,
          {
            order: 49,
          },
        ),
      );
    } else {
      if (look !== null) {
        const fan = fanPoints(o, look, half, MARKER_M.rays, 24);
        g.add(flat(fan, y, mk.colour, 0.1 * k));
        g.add(
          fatLine(
            [fan[1] ?? o, o, fan.at(-1) ?? o].map((p) => xyz(p)),
            mk.colour,
            k,
            1.5,
            {
              order: 48,
            },
          ),
        );
        const [nose, l, notch, r] = arrowPoints(o, look);
        g.add(flat([notch, r, nose, l], y + 0.02, mk.colour, k));
        g.add(
          fatLine(
            [nose, l, notch, r, nose].map((p) => xyz(p, y + 0.03)),
            '#f0f2f4',
            k,
            2,
            {
              order: 49,
            },
          ),
        );
      }
      tickDot();
    }
    // a stem up from the spot and a dot on top: it reads in 3D from any side, over the model
    g.add(
      fatLine(
        [
          [0, 0, 0],
          [0, STEM_M, 0],
        ],
        '#f0f2f4',
        0.9 * k,
        2,
        { order: 49 },
      ),
    );
    const dot = (px: number, colour: string, order: number) => {
      const pg = new BufferGeometry();
      pg.setAttribute('position', new Float32BufferAttribute([0, STEM_M, 0], 3));
      const map = roundDot();
      const p = new Points(
        pg,
        new PointsMaterial({
          color: new Color(colour),
          size: px,
          sizeAttenuation: false,
          depthTest: false,
          fog: false,
          transparent: true,
          opacity: k,
          ...(map ? { map, alphaTest: 0.5 } : {}),
        }),
      );
      p.renderOrder = order;
      p.raycast = () => undefined;
      g.add(p);
    };
    dot(17, '#f0f2f4', 50);
    dot(12, mk.colour, 51);
    return g;
  };

  const redraw = () => {
    clear(placingGroup);
    const p = placing;
    if (p?.walk) drawWalk(placingGroup, p.walk, 1);
    if (p?.preview && p.preview.pts.length > 1) {
      const l = line(
        p.preview.pts,
        p.walk?.colour ?? '#ffffff',
        p.preview.ghost ? GHOST : 1,
        p.preview.ghost || p.preview.tooClose,
      );
      l.name = WALK_PREVIEW_NAME;
      placingGroup.add(l);
    }
    if (p && p.handles.length > 0) {
      const g = new BufferGeometry();
      g.setAttribute(
        'position',
        new Float32BufferAttribute(
          p.handles.flatMap((h) => [h.at[0], h.at[1] + LIFT_M, h.at[2]]),
          3,
        ),
      );
      const pts = new Points(
        g,
        new PointsMaterial({
          color: new Color(p.walk?.colour ?? '#ffffff'),
          size: 14,
          sizeAttenuation: false,
          depthTest: false,
          fog: false,
          transparent: true,
        }),
      );
      pts.renderOrder = 46;
      placingGroup.add(pts);
    }
    stage.requestRender();
  };

  const ground = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return null;
    const hit = stage.raycast(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    return hit ? hit.point : null;
  };
  const tmp = new Vector3();
  const screenOf = (p: readonly [number, number, number]): Vector2 | null => {
    tmp.set(p[0], p[1], p[2]).project(stage.camera);
    if (tmp.z > 1) return null;
    const r = canvas.getBoundingClientRect();
    return new Vector2(r.left + ((tmp.x + 1) / 2) * r.width, r.top + ((1 - tmp.y) / 2) * r.height);
  };
  const handleAt = (e: PointerEvent): 'start' | 'end' | null => {
    let best: 'start' | 'end' | null = null;
    let bestD = HANDLE_PX;
    for (const h of placing?.handles ?? []) {
      const s = screenOf(h.at);
      const d = s ? Math.hypot(s.x - e.clientX, s.y - e.clientY) : Infinity;
      if (d <= bestD) {
        best = h.id;
        bestD = d;
      }
    }
    return best;
  };

  const onMove = (e: PointerEvent) => {
    if (!input) return;
    const p = ground(e);
    if (dragging) {
      if (p) input.drag(dragging, [p.x, p.z], p.y);
      return;
    }
    if (p) input.hover([p.x, p.z], p.y);
    else input.hover(null);
  };
  const onLeave = () => {
    if (!dragging) input?.hover(null);
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !input) return;
    const h = handleAt(e);
    if (!h) return;
    dragging = h;
    stage.controls.enabled = false;
    e.stopImmediatePropagation();
    // a release can be lost (alt-tab, a cancelled touch): these end the drag too, and only
    // listen while it lasts
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onUp);
    window.addEventListener('keydown', onKey, { capture: true });
  };
  /** End a handle drag where it is (release, cancel, lost focus, Escape, end of the session). */
  function onUp() {
    if (!dragging) return;
    dragging = null;
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', onUp);
    window.removeEventListener('keydown', onKey, { capture: true });
    stage.controls.enabled = true;
    input?.endDrag();
  }
  /** Escape during a drag ends the drag only, not the placing session behind it. */
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !dragging) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    onUp();
  }
  const offClaim = stage.claimClicks((e) => {
    // the stage reports a handle grab that barely moved as a click before the window sees the
    // release: it belongs to the drag, so swallow it rather than place a pin there too
    if (dragging) return true;
    if (!placing?.clicks || !input) return false;
    const p = ground(e);
    if (p) input.click([p.x, p.z], p.y);
    return true;
  });
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown, { capture: true });
  window.addEventListener('pointerup', onUp);

  return {
    setPlaced: (walks) => {
      clear(placedGroup);
      for (const w of walks) drawDraped(placedGroup, w);
      stage.requestRender();
    },
    setMarkers: (markers) => {
      clear(markerGroup);
      for (const m of markers) markerGroup.add(drawMarker(m));
      stage.requestRender();
    },
    setPlacing: (p, i) => {
      // a session that ends mid drag still ends the drag (orbit controls back on)
      if (!p || !i) onUp();
      placing = p;
      input = i;
      canvas.style.cursor = p?.clicks ? 'crosshair' : '';
      redraw();
    },
    dispose: () => {
      onUp();
      offClaim();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointerup', onUp);
      clear(placedGroup);
      clear(placingGroup);
      clear(markerGroup);
      stage.scene.remove(group);
      stage.requestRender();
    },
  };
}
