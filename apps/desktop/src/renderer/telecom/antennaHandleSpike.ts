/**
 * THROWAWAY DESIGN SPIKE (feat/antenna-box-handles): three candidate looks for the drag handles
 * on the selected antenna's 3D box, so the founder can pick one from real screenshots.
 *
 * A face arrows, B grip dots, C lever tabs. Dragging a handle moves only that face (the opposite
 * face stays put) and resizes the drawn box live; there is no re-measure and nothing is saved
 * (the store's file is replaced in memory only).
 *
 * Switch: Ctrl+Alt+H cycles A, B, C, off, or `window.__antennaHandles = 'B'` (the screenshot
 * spec). The handles are an SVG overlay over the canvas, so they are screen-size constant and a
 * press on one never reaches the orbit controls.
 */
import type { EngineStage } from '@aio/engine';
import type { AntennaUnit, DateShift, Vec3 } from '@aio/schema';
import { Raycaster, Vector2, Vector3 } from 'three';
import type { Frame } from '../survey/measureScene';
import { antennaCentre, axisToLocal } from './antennaMeasure';
import { antennaStore } from './antennaStore';

export type HandleLook = 'A' | 'B' | 'C' | 'off';
const ORDER: HandleLook[] = ['A', 'B', 'C', 'off'];
const LOOK_NAMES: Record<HandleLook, string> = {
  A: 'A face arrows',
  B: 'B grip dots',
  C: 'C lever tabs',
  off: 'off',
};
const AXIS_NAMES = ['Width', 'Height', 'Depth'] as const;
const AXIS_LETTERS = ['W', 'H', 'D'] as const;
const MIN_EXTENT_M = 0.05;
const SVG_NS = 'http://www.w3.org/2000/svg';

interface SpikeWindow {
  __antennaHandles?: HandleLook;
}
const w = window as unknown as SpikeWindow;
let look: HandleLook = 'A';
const listeners = new Set<() => void>();

function installProperty(): void {
  const desc = Object.getOwnPropertyDescriptor(window, '__antennaHandles');
  if (desc?.set) return;
  Object.defineProperty(window, '__antennaHandles', {
    configurable: true,
    get: () => look,
    set: (v: HandleLook) => {
      look = ORDER.includes(v) ? v : 'A';
      listeners.forEach((l) => {
        l();
      });
    },
  });
}

const STYLE = `
.ahs-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 4; }
.ahs-layer svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.ahs-h { pointer-events: auto; cursor: grab; }
.ahs-h .ahs-g { transform-box: fill-box; transform-origin: center; transition: transform 90ms ease-out; }
.ahs-h:hover .ahs-g { transform: scale(1.35); }
.ahs-h[data-active='1'] .ahs-g { transform: scale(1.35); }
.ahs-h[data-back='1'] { opacity: 0.45; }
.ahs-h[data-active='1'] { opacity: 1; cursor: grabbing; }
.ahs-fill { fill: var(--fg-0); stroke: var(--bg-0); stroke-width: 1.5; }
.ahs-h[data-active='1'] .ahs-fill, .ahs-h:hover .ahs-fill { fill: var(--acc-strong); }
.ahs-stem { stroke: var(--fg-0); stroke-width: 2; stroke-linecap: round; }
.ahs-h[data-active='1'] .ahs-stem { stroke: var(--acc-strong); }
.ahs-letter { font: 700 10px/1 var(--f-mono); fill: var(--bg-0); text-anchor: middle; dominant-baseline: central; pointer-events: none; }
.ahs-face { fill: var(--acc-a40); stroke: var(--acc-strong); stroke-width: 2; }
.ahs-edge { stroke: var(--acc-strong); stroke-width: 3; stroke-linecap: round; }
.ahs-chip { position: absolute; left: 0; top: 0; padding: 3px 8px; border-radius: var(--r-4);
  background: var(--scrim); box-shadow: var(--el-1); color: var(--fg-0);
  font: 500 12px/1.3 var(--f-mono); white-space: nowrap; display: none; }
.ahs-chip b { color: var(--acc-strong); font-weight: 700; margin-right: 6px; }
body[data-ahs-on='1'] .antenna-labels .sv-label[data-key*=':dim:'] { display: none !important; }
.ahs-tag { position: absolute; left: 8px; top: 8px; padding: 2px 6px; border-radius: var(--r-4);
  background: var(--scrim); color: var(--fg-1); font: 500 11px/1.3 var(--f-mono); }
`;

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

interface Face {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
}
const FACES: Face[] = [
  { axis: 0, sign: 1 },
  { axis: 0, sign: -1 },
  { axis: 1, sign: 1 },
  { axis: 1, sign: -1 },
  { axis: 2, sign: 1 },
  { axis: 2, sign: -1 },
];
const faceKey = (f: Face) => `${String(f.axis)}:${f.sign > 0 ? '+' : '-'}`;

const v3 = (p: Vec3) => new Vector3(p[0], p[1], p[2]);

interface Drag {
  face: Face;
  unitId: string;
  /** The fixed opposite face's centre, local. */
  fixed: Vector3;
  /** Outward normal of the dragged face, local. */
  normal: Vector3;
  start: AntennaUnit;
  extent: number;
  pointer: { x: number; y: number };
}

/** The unit with one face moved: the opposite face stays where it was. */
function resized(unit: AntennaUnit, face: Face, extent: number): AntennaUnit {
  const old = unit.box.extents[face.axis];
  const n = axisToLocal(unit.box.axes[face.axis]);
  const half = ((extent - old) / 2) * face.sign;
  // local x = E, y = Z, z = -N
  const dE = n[0] * half;
  const dZ = n[1] * half;
  const dN = -n[2] * half;
  const extents: Vec3 = [...unit.box.extents];
  extents[face.axis] = extent;
  const [cE, cN, cZ] = unit.box.centre;
  const next: AntennaUnit = {
    ...unit,
    box: { ...unit.box, centre: [cE + dE, cN + dN, cZ + dZ], extents },
  };
  const key = (['widthM', 'heightM', 'depthM'] as const)[face.axis];
  const m = unit[key];
  if (m) next[key] = { ...m, value: extent };
  return next;
}

export function attachAntennaHandleSpike(
  stage: EngineStage,
  frame: Frame,
  getShift: () => DateShift | null,
): () => void {
  installProperty();
  w.__antennaHandles ??= 'A';
  // unit tests mount the runner on a bare stage stub: the spike stays out of those
  const stub = stage as Partial<EngineStage>;
  if (!stub.renderer || typeof stub.requestRender !== 'function') return () => undefined;
  const canvas = stage.renderer.domElement;
  const host = canvas.parentElement;
  // unit tests mount the runner on a bare stage stub: the spike stays out of those
  if (!host || typeof stage.requestRender !== 'function' || typeof stage.onFrame !== 'function')
    return () => undefined;

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  const layer = document.createElement('div');
  layer.className = 'ahs-layer';
  layer.dataset.surface = 'dark';
  layer.dataset.testid = 'antenna-handle-spike';
  const svg = el('svg');
  const under = el('g');
  const handles = el('g');
  const over = el('g');
  svg.append(under, handles, over);
  const chip = document.createElement('div');
  chip.className = 'ahs-chip';
  chip.dataset.testid = 'antenna-handle-readout';
  const tag = document.createElement('div');
  tag.className = 'ahs-tag';
  layer.append(svg, chip, tag);
  host.appendChild(layer);

  let drag: Drag | null = null;
  let built: HandleLook | null = null;
  const nodes = new Map<string, SVGGElement>();

  const selectedUnit = (): AntennaUnit | null => {
    const a = antennaStore.getState();
    return a.file?.units.find((u) => u.id === a.selected) ?? null;
  };

  const r = () => canvas.getBoundingClientRect();
  const project = (p: Vector3): { x: number; y: number; behind: boolean } => {
    const q = p.clone().project(stage.camera);
    const rect = r();
    return {
      x: ((q.x + 1) / 2) * rect.width,
      y: ((1 - q.y) / 2) * rect.height,
      behind: q.z > 1,
    };
  };

  /** Build the six handle nodes of the current look. */
  const build = () => {
    handles.replaceChildren();
    nodes.clear();
    built = look;
    if (look === 'off') return;
    for (const f of FACES) {
      const g = el('g', { class: 'ahs-h', 'data-ahs-handle': faceKey(f) });
      const inner = el('g', { class: 'ahs-g' });
      if (look === 'A') {
        inner.append(el('line', { class: 'ahs-stem', 'data-part': 'stem' }));
        inner.append(el('path', { class: 'ahs-fill', 'data-part': 'cone' }));
      } else if (look === 'B') {
        inner.append(el('circle', { class: 'ahs-fill', r: 6, 'data-part': 'dot' }));
      } else {
        g.append(el('line', { class: 'ahs-stem', 'data-part': 'stem' }));
        inner.append(
          el('rect', { class: 'ahs-fill', width: 16, height: 16, rx: 4, 'data-part': 'paddle' }),
        );
        const text = el('text', { class: 'ahs-letter', 'data-part': 'letter' });
        text.textContent = AXIS_LETTERS[f.axis];
        inner.append(text);
      }
      g.append(inner);
      g.addEventListener('pointerdown', (e) => {
        onDown(e, f);
      });
      handles.append(g);
      nodes.set(faceKey(f), g);
    }
  };

  const update = () => {
    tag.textContent = `Handles (Ctrl+Alt+H): ${LOOK_NAMES[look]}`;
    // the handles sit where the dimension values do: the spike hides those values while on
    document.body.dataset.ahsOn = look === 'off' ? '0' : '1';
    if (built !== look) build();
    const unit = selectedUnit();
    under.replaceChildren();
    over.replaceChildren();
    if (!unit || look === 'off') {
      handles.style.display = 'none';
      chip.style.display = 'none';
      return;
    }
    handles.style.display = '';
    const shift = getShift();
    const c = v3(antennaCentre(unit, frame, shift));
    const axes = unit.box.axes.map((a) => v3(axisToLocal(a)));
    const ext = unit.box.extents;
    const cam = stage.camera.position;
    const right = new Vector3().setFromMatrixColumn(stage.camera.matrixWorld, 0);
    const corner = (s: [number, number, number]) => {
      const p = c.clone();
      for (let k = 0; k < 3; k++)
        p.addScaledVector(axes[k] ?? new Vector3(), ((s[k] ?? 0) * (ext[k] ?? 0)) / 2);
      return p;
    };

    // back faces first, so the front handles lie on top
    const order = FACES.map((f) => {
      const n = (axes[f.axis] ?? new Vector3()).clone().multiplyScalar(f.sign);
      const centre = c.clone().addScaledVector(n, ext[f.axis] / 2);
      return { f, n, centre, front: n.dot(cam.clone().sub(centre)) > 0 };
    }).sort((a, b) => Number(a.front) - Number(b.front));

    for (const { f, n, centre, front } of order) {
      const g = nodes.get(faceKey(f));
      if (!g) continue;
      handles.append(g); // reorder
      const p = project(centre);
      const tip = project(centre.clone().addScaledVector(n, 0.1));
      const side = project(centre.clone().addScaledVector(right, 0.1));
      const ppm = Math.hypot(side.x - p.x, side.y - p.y) / 0.1;
      let dx = tip.x - p.x;
      let dy = tip.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const fore = Math.min(1, len / (ppm * 0.1 || 1));
      dx /= len;
      dy /= len;
      const active = drag?.face.axis === f.axis && drag.face.sign === f.sign;
      g.dataset.active = active ? '1' : '0';
      g.dataset.back = front || active ? '0' : '1';
      g.style.display = p.behind ? 'none' : '';
      const k = Math.max(fore, 0.35);
      if (look === 'A') {
        const t0 = 3;
        const shaft = 10 * k;
        const head = 14 * Math.max(k, 0.6);
        const bx = p.x + dx * (t0 + shaft);
        const by = p.y + dy * (t0 + shaft);
        const stem = g.querySelector('[data-part="stem"]');
        stem?.setAttribute('x1', String(p.x + dx * t0));
        stem?.setAttribute('y1', String(p.y + dy * t0));
        stem?.setAttribute('x2', String(bx));
        stem?.setAttribute('y2', String(by));
        const px = -dy * 7;
        const py = dx * 7;
        g.querySelector('[data-part="cone"]')?.setAttribute(
          'd',
          `M ${String(bx + px)} ${String(by + py)} L ${String(bx + dx * head)} ${String(by + dy * head)} L ${String(bx - px)} ${String(by - py)} Z`,
        );
      } else if (look === 'B') {
        const dot = g.querySelector('[data-part="dot"]');
        dot?.setAttribute('cx', String(p.x));
        dot?.setAttribute('cy', String(p.y));
      } else {
        const reach = 12 + 18 * k;
        const ex = p.x + dx * reach;
        const ey = p.y + dy * reach;
        const stem = g.querySelector('[data-part="stem"]');
        stem?.setAttribute('x1', String(p.x));
        stem?.setAttribute('y1', String(p.y));
        stem?.setAttribute('x2', String(ex));
        stem?.setAttribute('y2', String(ey));
        const paddle = g.querySelector('[data-part="paddle"]');
        paddle?.setAttribute('x', String(ex - 8));
        paddle?.setAttribute('y', String(ey - 8));
        const letter = g.querySelector('[data-part="letter"]');
        letter?.setAttribute('x', String(ex));
        letter?.setAttribute('y', String(ey + 0.5));
      }
    }

    if (!drag) {
      chip.style.display = 'none';
      return;
    }
    const { axis, sign } = drag.face;
    const value = `${unit.box.extents[axis].toFixed(2)} m`;
    if (look === 'B') {
      // the dragged face highlighted, and the length along the nearest edge that changes
      const [u, v] = [0, 1, 2].filter((k) => k !== axis) as [number, number];
      const quad: Vector3[] = [];
      for (const [su, sv] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const s: [number, number, number] = [0, 0, 0];
        s[axis] = sign;
        s[u] = su;
        s[v] = sv;
        quad.push(corner(s));
      }
      under.append(
        el('polygon', {
          class: 'ahs-face',
          points: quad
            .map(project)
            .map((q) => `${String(q.x)},${String(q.y)}`)
            .join(' '),
        }),
      );
      let best: { a: Vector3; b: Vector3; d: number } | null = null;
      for (const [su, sv] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const s: [number, number, number] = [0, 0, 0];
        s[u] = su;
        s[v] = sv;
        s[axis] = -1;
        const a = corner(s);
        s[axis] = 1;
        const b = corner(s);
        const d = a.clone().lerp(b, 0.5).distanceTo(cam);
        if (!best || d < best.d) best = { a, b, d };
      }
      if (best) {
        const pa = project(best.a);
        const pb = project(best.b);
        over.append(
          el('line', {
            class: 'ahs-edge',
            x1: pa.x,
            y1: pa.y,
            x2: pb.x,
            y2: pb.y,
          }),
        );
        const mx = (pa.x + pb.x) / 2;
        const my = (pa.y + pb.y) / 2;
        const ex = pb.x - pa.x;
        const ey = pb.y - pa.y;
        const el2 = Math.hypot(ex, ey) || 1;
        // off the edge, away from the box centre on screen
        const pc = project(c);
        let nx = -ey / el2;
        let ny = ex / el2;
        if (nx * (mx - pc.x) + ny * (my - pc.y) < 0) {
          nx = -nx;
          ny = -ny;
        }
        chip.innerHTML = `<b>${AXIS_LETTERS[axis]}</b>${value}`;
        chip.style.display = 'block';
        const rect = chip.getBoundingClientRect();
        chip.style.transform = `translate(${String(mx + nx * 18 - (nx < 0 ? rect.width : 0))}px, ${String(my + ny * 18 - rect.height / 2)}px)`;
      }
    } else {
      chip.innerHTML = `<b>${AXIS_LETTERS[axis]}</b>${AXIS_NAMES[axis]} ${value}`;
      chip.style.display = 'block';
      chip.style.transform = `translate(${String(drag.pointer.x + 16)}px, ${String(drag.pointer.y + 14)}px)`;
    }
  };

  const raycaster = new Raycaster();
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const rect = r();
    drag.pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    raycaster.setFromCamera(
      new Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      stage.camera,
    );
    // the point on the face's normal line through the fixed face nearest the pointer's ray
    const { origin, direction } = raycaster.ray;
    const u = drag.normal;
    const w0 = drag.fixed.clone().sub(origin);
    const b = u.dot(direction);
    const denom = 1 - b * b;
    if (denom < 1e-4) return;
    const t = (b * direction.dot(w0) - u.dot(w0)) / denom;
    const extent = Math.max(MIN_EXTENT_M, t);
    const a = antennaStore.getState();
    if (!a.file) return;
    const id = drag.unitId;
    const start = drag.start;
    const next = resized(start, drag.face, extent);
    antennaStore.setState({
      file: { ...a.file, units: a.file.units.map((x) => (x.id === id ? next : x)) },
    });
    stage.requestRender();
  };
  const onUp = () => {
    if (!drag) return;
    drag = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    stage.controls.enabled = true;
    stage.requestRender();
  };
  const onDown = (e: PointerEvent, f: Face) => {
    if (e.button !== 0) return;
    const unit = selectedUnit();
    if (!unit) return;
    e.preventDefault();
    e.stopPropagation();
    const c = v3(antennaCentre(unit, frame, getShift()));
    const normal = v3(axisToLocal(unit.box.axes[f.axis])).multiplyScalar(f.sign);
    const extent = unit.box.extents[f.axis];
    const rect = r();
    drag = {
      face: f,
      unitId: unit.id,
      fixed: c.clone().addScaledVector(normal, -extent / 2),
      normal,
      start: unit,
      extent,
      pointer: { x: e.clientX - rect.left, y: e.clientY - rect.top },
    };
    stage.controls.enabled = false;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    stage.requestRender();
  };

  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey && e.altKey && e.code === 'KeyH')) return;
    e.preventDefault();
    w.__antennaHandles = ORDER[(ORDER.indexOf(look) + 1) % ORDER.length] ?? 'A';
  };
  const onLook = () => {
    stage.requestRender();
    update();
  };
  listeners.add(onLook);
  window.addEventListener('keydown', onKey);
  const offFrame = stage.onFrame(update);
  const offStore = antennaStore.subscribe(() => {
    stage.requestRender();
  });
  update();

  return () => {
    onUp();
    listeners.delete(onLook);
    window.removeEventListener('keydown', onKey);
    offFrame();
    offStore();
    layer.remove();
    style.remove();
  };
}
