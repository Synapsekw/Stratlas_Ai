/**
 * THROWAWAY DESIGN SPIKE (feat/pile-3d-look): three candidate looks for an opened pile in 3D, to
 * compare with today's. Not production code, no tests.
 *
 *   current  today's look, unchanged
 *   A        "Propeller prism": the pile surface lifted above the ground, solid red with baked
 *            hillshade; the footprint tinted blue on the ground (the base); a white glass box
 *            (outline at the top and at the base, a white post at each vertex)
 *   B        "Draped": the pile painted red on the ground, a crisp white outline, nothing lifted
 *   C        "Prism + heat": A, its surface coloured by height above the base, with a legend
 *
 * Switch: Ctrl+Alt+P cycles, or `window.__pileLook = 'A'` (the screenshot spec). Opening a pile
 * (its focus) with a look other than `current` flies the camera to frame it obliquely.
 */
import type { EngineStage } from '@aio/engine';
import type { SitePoint, Vec3 } from '@aio/schema';
import { workspace } from '@aio/workspace';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  ShapeUtils,
  Vector2,
} from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { timeline } from '../workspace/timeline';
import { drawnPoints } from './measureDates';
import { editedOutline } from './measureMove';
import { drawnSampler } from './dateSurfaces';
import { stageClamp, type Frame } from './measureScene';
import { measureStore } from './measureStore';

export type PileLook = 'current' | 'A' | 'B' | 'C';
const LOOKS: PileLook[] = ['current', 'A', 'B', 'C'];

interface SpikeWindow {
  __pileLook?: PileLook;
  __pileLookListeners?: Set<() => void>;
  __pileFly?: (factor?: number, elevationDeg?: number, azimuthDeg?: number) => void;
}
const w = window as unknown as SpikeWindow;

/** The look in force (the window hook, `current` by default). */
export function pileLook(): PileLook {
  return w.__pileLook ?? 'current';
}

/** Whether measureScene should leave this measurement to the spike. */
export function spikeOwnsPile(id: string): boolean {
  if (pileLook() === 'current') return false;
  const s = measureStore.getState();
  return s.focus === id && !s.editing && isPileId(id);
}

function isPileId(id: string): boolean {
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  return !!m && m.tool === 'volume' && m.family === 'polygon';
}

const listeners = (w.__pileLookListeners ??= new Set());

/** Install the `__pileLook` property so a plain assignment notifies the scene. */
(() => {
  const desc = Object.getOwnPropertyDescriptor(window, '__pileLook');
  if (desc?.set) return;
  let value: PileLook = 'current';
  Object.defineProperty(window, '__pileLook', {
    configurable: true,
    get: () => value,
    set: (v: PileLook) => {
      value = LOOKS.includes(v) ? v : 'current';
      for (const l of listeners) l();
    },
  });
})();

/** Point in polygon (E, N). */
function inside(e: number, n: number, ring: readonly SitePoint[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a[1] > n !== b[1] > n && e < ((b[0] - a[0]) * (n - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/** The base under (e, n): the boundary's heights, triangulated (a TIN base). */
function tinBase(ring: readonly SitePoint[]): (e: number, n: number) => number | null {
  const tris = ShapeUtils.triangulateShape(
    ring.map((p) => new Vector2(p[0], p[1])),
    [],
  );
  return (e, n) => {
    for (const [i, j, k] of tris) {
      const a = ring[i ?? -1];
      const b = ring[j ?? -1];
      const c = ring[k ?? -1];
      if (!a || !b || !c) continue;
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (d === 0) continue;
      const l1 = ((b[1] - c[1]) * (e - c[0]) + (c[0] - b[0]) * (n - c[1])) / d;
      const l2 = ((c[1] - a[1]) * (e - c[0]) + (a[0] - c[0]) * (n - c[1])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) return l1 * a[2] + l2 * b[2] + l3 * c[2];
    }
    return null;
  };
}

/** blue, cyan, green, yellow, red */
const RAMP: [number, number, number][] = [
  [0.16, 0.32, 0.95],
  [0.1, 0.75, 0.9],
  [0.2, 0.8, 0.3],
  [0.98, 0.88, 0.15],
  [0.93, 0.15, 0.13],
];
function ramp(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP[i] ?? [0, 0, 0];
  const b = RAMP[i + 1] ?? [0, 0, 0];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Attach the spike to the main 3D view. Returns the detach. */
export function attachPileLookSpike(stage: EngineStage, frame: Frame): () => void {
  const group = new Group();
  group.name = 'spike-pile-look';
  stage.scene.add(group);
  const canvas = stage.renderer.domElement;
  const host = canvas.parentElement ?? canvas;
  const clamp = stageClamp(stage, frame);
  const fatMats: LineMaterial[] = [];
  let legend: HTMLDivElement | null = null;

  const clear = () => {
    for (const c of [...group.children]) {
      group.remove(c);
      const o = c as Mesh;
      o.geometry.dispose();
      (o.material as { dispose(): void }).dispose();
    }
    fatMats.length = 0;
    legend?.remove();
    legend = null;
  };

  const fat = (segs: number[], color: number, width: number, depthTest: boolean, order: number) => {
    if (segs.length < 6) return;
    const g = new LineSegmentsGeometry();
    g.setPositions(segs);
    const mat = new LineMaterial({
      color,
      linewidth: width,
      transparent: true,
      opacity: 0.95,
      depthTest,
      depthWrite: false,
    });
    mat.resolution.set(canvas.clientWidth, canvas.clientHeight);
    fatMats.push(mat);
    const l = new LineSegments2(g, mat);
    l.renderOrder = order;
    l.frustumCulled = false;
    l.raycast = () => undefined;
    group.add(l);
  };

  /** Segments of a closed loop, as flat local coordinates. */
  const loopSegs = (pts: Vec3[]): number[] => {
    const out: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (a && b) out.push(...a, ...b);
    }
    return out;
  };

  let builtKey = '';
  let flownFor: string | null = null;

  const ringOf = (id: string): SitePoint[] | null => {
    const m = measureStore.getState().file.measurements.find((x) => x.id === id);
    if (!m) return null;
    const manifest = workspace.getState().project?.manifest ?? null;
    const stored = editedOutline(m, timeline.getState().focus);
    return drawnPoints({ points: [...stored], scope: m.scope }, manifest);
  };

  const fly = (factor = 1.0, elevationDeg = 38, azimuthDeg = 200) => {
    const s = measureStore.getState();
    const id = s.focus;
    if (!id) return;
    const ring = ringOf(id);
    if (!ring || ring.length < 3) return;
    const es = ring.map((p) => p[0]);
    const ns = ring.map((p) => p[1]);
    const span = Math.max(Math.max(...es) - Math.min(...es), Math.max(...ns) - Math.min(...ns), 5);
    const ce = (Math.max(...es) + Math.min(...es)) / 2;
    const cn = (Math.max(...ns) + Math.min(...ns)) / 2;
    const ground = centreZ ?? ring.reduce((a, p) => a + p[2], 0) / ring.length;
    const look = pileLook();
    const lifted = look === 'A' || look === 'C';
    const cz = ground + (lifted ? lastLift * 0.45 : 0);
    const el = (elevationDeg * Math.PI) / 180;
    const az = (azimuthDeg * Math.PI) / 180;
    // site direction from the pile to the camera: azimuth from north, clockwise
    const d: SitePoint = [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
    const c = frame.toLocal([ce, cn, cz]);
    const t = frame.toLocal([ce + d[0], cn + d[1], cz + d[2]]);
    workspace.getState().flyTo({
      kind: 'point',
      p: c,
      distance: span * 2.0 * factor + (lifted ? lastLift : 0),
      dir: [t[0] - c[0], t[1] - c[1], t[2] - c[2]],
    });
    stage.requestRender();
  };
  w.__pileFly = fly;
  (window as unknown as { __spikeStage?: unknown }).__spikeStage = stage;
  (window as unknown as { __pileLookParts?: () => number }).__pileLookParts = () =>
    group.children.length;

  let lastLift = 0;
  let centreZ: number | null = null;
  let heights: { key: string; zs: Float64Array } | null = null;
  let pending = '';
  const dbg = (t: string) => {
    (window as unknown as { __pileLookDebug?: string }).__pileLookDebug = t;
  };

  const build = () => {
    const s = measureStore.getState();
    const look = pileLook();
    const id = s.focus;
    const key = JSON.stringify([look, id, !!s.editing, timeline.getState().focus]);
    if (key === builtKey) return;
    if (look === 'current' || !id || s.editing || !isPileId(id)) {
      clear();
      builtKey = key;
      stage.requestRender();
      return;
    }
    const ring = ringOf(id);
    if (!ring || ring.length < 3) return;
    const es = ring.map((p) => p[0]);
    const ns = ring.map((p) => p[1]);
    const minE = Math.min(...es);
    const maxE = Math.max(...es);
    const minN = Math.min(...ns);
    const maxN = Math.max(...ns);
    const span = Math.max(maxE - minE, maxN - minN, 5);
    const step = span / 110;
    const nx = Math.ceil((maxE - minE) / step) + 1;
    const ny = Math.ceil((maxN - minN) / step) + 1;
    const base = tinBase(ring);
    // terrain heights on the grid: the date's prepared surface (the 3D terrain is not raycastable)
    const hkey = JSON.stringify([id, timeline.getState().focus, ring]);
    if (heights?.key !== hkey) {
      if (pending !== hkey) {
        pending = hkey;
        const es0 = new Float64Array(nx * ny);
        const ns0 = new Float64Array(nx * ny);
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            es0[j * nx + i] = minE + i * step;
            ns0[j * nx + i] = minN + j * step;
          }
        const m = measureStore.getState().file.measurements.find((x) => x.id === id);
        const capture =
          timeline.getState().focus ?? (m?.scope.kind === 'survey' ? m.scope.capture : null);
        const manifest = workspace.getState().project?.manifest ?? null;
        void (async () => {
          const sampler = capture ? await drawnSampler(capture, manifest) : null;
          let zs: Float64Array;
          if (sampler) zs = await sampler(es0, ns0);
          else {
            zs = new Float64Array(nx * ny);
            for (let k = 0; k < zs.length; k++)
              zs[k] = clamp(es0[k] ?? 0, ns0[k] ?? 0) ?? Number.NaN;
          }
          let ok = 0;
          for (const z of zs) if (Number.isFinite(z)) ok++;
          dbg(
            `heights ${String(ok)}/${String(zs.length)} sampler ${String(!!sampler)} capture ${String(capture)}`,
          );
          if (pending !== hkey) return;
          heights = { key: hkey, zs };
          pending = '';
          safeBuild();
        })().catch((e: unknown) => {
          dbg(`heights error ${String(e)}`);
          pending = '';
        });
      }
      return;
    }
    const zs = heights.zs;
    clear();
    builtKey = key;
    const zAt = (i: number, j: number): number => {
      const ci = Math.max(0, Math.min(nx - 1, i));
      const cj = Math.max(0, Math.min(ny - 1, j));
      const z = zs[cj * nx + ci] ?? Number.NaN;
      return !Number.isFinite(z) ? (base(minE + ci * step, minN + cj * step) ?? 0) : z;
    };
    // heights above the base, the highest
    let hmax = 0.5;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const e = minE + i * step;
        const n = minN + j * step;
        if (!inside(e, n, ring)) continue;
        const b = base(e, n);
        if (b !== null) hmax = Math.max(hmax, zAt(i, j) - b);
      }
    const lifted = look === 'A' || look === 'C';
    const lift = lifted ? Math.max(hmax * 1.6, span * 0.22) : 0;
    lastLift = lift;

    // the grid's triangles inside the boundary
    const index: number[] = [];
    for (let j = 0; j + 1 < ny; j++)
      for (let i = 0; i + 1 < nx; i++) {
        const e = minE + (i + 0.5) * step;
        const n = minN + (j + 0.5) * step;
        if (!inside(e, n, ring)) continue;
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    const L = [-0.45, -0.25, 0.86]; // light from the west-south-west, high (the camera's side)
    const ll = Math.hypot(L[0] ?? 0, L[1] ?? 0, L[2] ?? 0);
    const surface = (
      offset: number,
      colour: (i: number, j: number, shade: number) => [number, number, number],
      opacity: number,
      depthTest: boolean,
      order: number,
    ) => {
      const pos = new Float32Array(nx * ny * 3);
      const col = new Float32Array(nx * ny * 3);
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const e = minE + i * step;
          const n = minN + j * step;
          const z = zAt(i, j);
          const l = frame.toLocal([e, n, z + offset]);
          const k = (j * nx + i) * 3;
          pos[k] = l[0];
          pos[k + 1] = l[1];
          pos[k + 2] = l[2];
          // normal from the grid (E, N, Z), 1.6x vertical exaggeration for the shading only
          const dzde = ((zAt(i + 1, j) - zAt(i - 1, j)) / (2 * step)) * 3;
          const dzdn = ((zAt(i, j + 1) - zAt(i, j - 1)) / (2 * step)) * 3;
          const nl = Math.hypot(dzde, dzdn, 1);
          const dot =
            ((-dzde / nl) * (L[0] ?? 0) + (-dzdn / nl) * (L[1] ?? 0) + (1 / nl) * (L[2] ?? 0)) / ll;
          const shade = 0.42 + 0.62 * Math.max(0, dot);
          const rgb = colour(i, j, shade);
          // vertex colours are linear: the sRGB picks go through 2.2
          col[k] = Math.pow(rgb[0], 2.2);
          col[k + 1] = Math.pow(rgb[1], 2.2);
          col[k + 2] = Math.pow(rgb[2], 2.2);
        }
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new Float32BufferAttribute(col, 3));
      g.setIndex(index);
      const mat = new MeshBasicMaterial({
        vertexColors: true,
        transparent: opacity < 1,
        opacity,
        side: DoubleSide,
        depthTest,
        depthWrite: opacity >= 0.85,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      });
      const mesh = new Mesh(g, mat);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      mesh.raycast = () => undefined;
      group.add(mesh);
    };
    const red = (_i: number, _j: number, sh: number): [number, number, number] => [
      Math.min(1, 0.96 * sh),
      0.13 * sh,
      0.11 * sh,
    ];
    const heat = (i: number, j: number, sh: number): [number, number, number] => {
      const b = base(minE + i * step, minN + j * step) ?? zAt(i, j);
      const c = ramp((zAt(i, j) - b) / hmax);
      const k = 0.55 + 0.45 * sh;
      return [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];
    };

    // the boundary, densified and laid on the ground
    const dense: [number, number][] = [];
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      if (!a || !b) continue;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const parts = Math.max(1, Math.ceil(len / (step * 0.75)));
      for (let q = 0; q < parts; q++)
        dense.push([a[0] + ((b[0] - a[0]) * q) / parts, a[1] + ((b[1] - a[1]) * q) / parts]);
    }
    const groundZ = (e: number, n: number) => {
      const fi = (e - minE) / step;
      const fj = (n - minN) / step;
      const i = Math.floor(fi);
      const j = Math.floor(fj);
      const a = fi - i;
      const b = fj - j;
      return (
        zAt(i, j) * (1 - a) * (1 - b) +
        zAt(i + 1, j) * a * (1 - b) +
        zAt(i, j + 1) * (1 - a) * b +
        zAt(i + 1, j + 1) * a * b
      );
    };
    centreZ = groundZ((minE + maxE) / 2, (minN + maxN) / 2);
    const onGround = (dz: number): Vec3[] =>
      dense.map(([e, n]) => frame.toLocal([e, n, groundZ(e, n) + dz]));

    if (look === 'B') {
      surface(0.06, red, 0.72, false, 30);
      fat(loopSegs(onGround(0.08)), 0xffffff, 2.5, false, 45);
    } else {
      // the base: the footprint tinted blue on the ground
      surface(0.03, () => [0.2, 0.45, 1.0], 0.5, false, 29);
      // the pile, lifted
      surface(lift, look === 'C' ? heat : red, 0.93, true, 31);
      const top = onGround(lift);
      const bottom = onGround(0.06);
      fat(loopSegs(top), 0xffffff, 1.8, true, 44);
      fat(loopSegs(bottom), 0xffffff, 2.2, false, 44);
      const posts: number[] = [];
      for (const p of ring) {
        const z = groundZ(p[0], p[1]);
        posts.push(...frame.toLocal([p[0], p[1], z]), ...frame.toLocal([p[0], p[1], z + lift]));
      }
      fat(posts, 0xffffff, 1.4, true, 44);
      if (look === 'C') {
        legend = document.createElement('div');
        legend.dataset.testid = 'spike-heat-legend';
        legend.style.cssText =
          'position:absolute;left:14px;bottom:100px;z-index:5;padding:8px 10px;border-radius:8px;' +
          'background:rgba(14,17,22,.82);color:#e8ecf2;font:12px/1.3 system-ui,sans-serif;' +
          'pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.35)';
        const grad = RAMP.map((c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`).join(
          ',',
        );
        legend.innerHTML =
          '<div style="margin-bottom:5px;opacity:.85">Height above base</div>' +
          `<div style="width:160px;height:9px;border-radius:3px;background:linear-gradient(90deg,${grad})"></div>` +
          `<div style="display:flex;justify-content:space-between;margin-top:3px;font-variant-numeric:tabular-nums"><span>0 m</span><span>${(hmax / 2).toFixed(1)} m</span><span>${hmax.toFixed(1)} m</span></div>`;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(legend);
      }
    }
    stage.requestRender();
  };

  const safeBuild = () => {
    try {
      build();
    } catch (e) {
      (window as unknown as { __pileLookDebug?: string }).__pileLookDebug = `error ${String(e)}`;
    }
  };
  const onChange = () => {
    safeBuild();
    const s = measureStore.getState();
    const id = s.focus;
    if (pileLook() !== 'current' && id && isPileId(id) && !s.editing && flownFor !== id) {
      flownFor = id;
      // let the build settle the lift before framing
      setTimeout(() => {
        safeBuild();
        fly();
      }, 50);
    }
    if (!id) flownFor = null;
  };
  const onLook = () => {
    flownFor = null;
    // measureScene redraws on a new selection array: it hands the pile over or takes it back
    measureStore.setState((s) => ({ selected: [...s.selected] }));
    onChange();
  };
  listeners.add(onLook);
  const offStore = measureStore.subscribe(onChange);
  const offTimeline = timeline.subscribe(onChange);
  const timer = window.setInterval(safeBuild, 700); // terrain arriving late
  const offFrame = stage.onFrame(() => {
    for (const m of fatMats) m.resolution.set(canvas.clientWidth, canvas.clientHeight);
  });
  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey && e.altKey && e.key.toLowerCase() === 'p')) return;
    e.preventDefault();
    const next = LOOKS[(LOOKS.indexOf(pileLook()) + 1) % LOOKS.length] ?? 'current';
    w.__pileLook = next;
  };
  window.addEventListener('keydown', onKey);
  return () => {
    listeners.delete(onLook);
    offStore();
    offTimeline();
    offFrame();
    window.clearInterval(timer);
    window.removeEventListener('keydown', onKey);
    clear();
    stage.scene.remove(group);
  };
}
