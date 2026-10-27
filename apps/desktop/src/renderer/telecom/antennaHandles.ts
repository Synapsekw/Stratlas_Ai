/**
 * The drag handles on the selected antenna's box in the 3D view: a small cone arrow at the centre
 * of each face, pointing out, the same size on screen at any zoom. Hover grows an arrow; the
 * dragged one grows and takes the accent, and a chip by the cursor names the size and its value
 * ("H Height 1.66 m"), so the state never rests on colour alone. Arrows on the far side are dimmed
 * but can be grabbed.
 *
 * Dragging moves only that face (`antennaStore.dragBox`); Escape puts the box back. On release the
 * unit is measured again from the points in the new box (`commitBoxDrag`). The handles are an SVG
 * layer over the canvas, so a press on one never reaches the orbit controls; they show only while
 * `boxEditBlocked` allows them (no dish, no read-only package, no job going).
 */
import type { EngineStage } from '@aio/engine';
import type { AntennaUnit, DateShift, Vec3 } from '@aio/schema';
import { t } from '@aio/ui';
import { Raycaster, Vector2, Vector3 } from 'three';
import type { Frame } from '../survey/measureScene';
import {
  BOX_FACES,
  boxCropSelection,
  DIM_KEYS,
  extentFromRay,
  faceKey,
  type BoxFace,
} from './antennaBoxEdit';
import { antennaCentre, axisToLocal } from './antennaMeasure';
import {
  antennaStore,
  beginBoxDrag,
  boxEditBlocked,
  cancelBoxDrag,
  commitBoxDrag,
  dragBox,
  drawnFile,
} from './antennaStore';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const v3 = (p: Vec3) => new Vector3(p[0], p[1], p[2]);
const n = (v: number) => v.toFixed(1);

/** The pointer's hold on a face: the fixed face's centre and the outward normal, stage local. */
interface Hold {
  face: BoxFace;
  fixed: Vector3;
  normal: Vector3;
  pointer: { x: number; y: number };
}

export function attachAntennaHandles(
  stage: EngineStage,
  frame: Frame,
  opts: { getShift: () => DateShift | null; getLayer: () => string | null },
): () => void {
  // unit tests mount the runner on a bare stage stub: the handles stay out of those
  const stub = stage as Partial<EngineStage>;
  if (
    !stub.renderer ||
    typeof stub.requestRender !== 'function' ||
    typeof stub.onFrame !== 'function'
  )
    return () => undefined;
  const canvas = stage.renderer.domElement;
  const host = canvas.parentElement;
  if (!host) return () => undefined;

  const layer = document.createElement('div');
  layer.className = 'antenna-handles';
  layer.dataset.testid = 'antenna-handles';
  // a pointer shortcut: the typed values in the unit's details do the same from the keyboard
  layer.setAttribute('aria-hidden', 'true');
  const svg = el('svg');
  const chip = document.createElement('div');
  chip.className = 'antenna-handle-chip';
  chip.dataset.testid = 'antenna-handle-readout';
  layer.append(svg, chip);
  host.appendChild(layer);

  let hold: Hold | null = null;
  const nodes = new Map<string, SVGGElement>();
  for (const f of BOX_FACES) {
    const g = el('g', { class: 'antenna-handle', 'data-face': faceKey(f) });
    const title = el('title');
    title.textContent = t('telecom.antennas.resize.handle');
    const inner = el('g', { class: 'antenna-handle-arrow' });
    inner.append(
      el('line', { class: 'antenna-handle-stem' }),
      el('path', { class: 'antenna-handle-cone' }),
    );
    g.append(title, inner);
    g.addEventListener('pointerdown', (e) => {
      onDown(e, f);
    });
    svg.append(g);
    nodes.set(faceKey(f), g);
  }

  /** The selected unit as drawn (in its dragged box while dragged), when it takes handles. */
  const shownUnit = (): AntennaUnit | null => {
    const a = antennaStore.getState();
    const id = a.selected;
    if (!id || a.hidden[id]) return null;
    const dragging = a.boxEdit?.unitId === id && a.boxEdit.phase === 'drag';
    if (!dragging && boxEditBlocked(id, a) !== false) return null;
    return drawnFile(a.file, a.boxEdit)?.units.find((u) => u.id === id) ?? null;
  };

  const rect = () => canvas.getBoundingClientRect();
  const project = (p: Vector3): { x: number; y: number; behind: boolean } => {
    const q = p.clone().project(stage.camera);
    const r = rect();
    return { x: ((q.x + 1) / 2) * r.width, y: ((1 - q.y) / 2) * r.height, behind: q.z > 1 };
  };

  const update = () => {
    const unit = shownUnit();
    if (!unit) {
      layer.style.display = 'none';
      return;
    }
    layer.style.display = '';
    const c = v3(antennaCentre(unit, frame, opts.getShift()));
    const axes = unit.box.axes.map((a) => v3(axisToLocal(a)));
    const ext = unit.box.extents;
    const cam = stage.camera.position;
    const right = new Vector3().setFromMatrixColumn(stage.camera.matrixWorld, 0);
    // back faces first, so the front arrows lie on top
    const order = BOX_FACES.map((f) => {
      const normal = (axes[f.axis] ?? new Vector3()).clone().multiplyScalar(f.sign);
      const centre = c.clone().addScaledVector(normal, ext[f.axis] / 2);
      return { f, normal, centre, front: normal.dot(cam.clone().sub(centre)) > 0 };
    }).sort((a, b) => Number(a.front) - Number(b.front));
    for (const { f, normal, centre, front } of order) {
      const g = nodes.get(faceKey(f));
      if (!g) continue;
      svg.append(g);
      const p = project(centre);
      const tip = project(centre.clone().addScaledVector(normal, 0.1));
      const side = project(centre.clone().addScaledVector(right, 0.1));
      // how much of the arrow faces the camera: one pointing at the eye is drawn short
      const ppm = Math.hypot(side.x - p.x, side.y - p.y) / 0.1;
      let dx = tip.x - p.x;
      let dy = tip.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const fore = Math.max(Math.min(1, len / (ppm * 0.1 || 1)), 0.35);
      dx /= len;
      dy /= len;
      const active = hold?.face.axis === f.axis && hold.face.sign === f.sign;
      g.dataset.active = active ? '1' : '0';
      g.dataset.back = front || active ? '0' : '1';
      g.style.display = p.behind ? 'none' : '';
      const t0 = 3;
      const shaft = 10 * fore;
      const head = 14 * Math.max(fore, 0.6);
      const bx = p.x + dx * (t0 + shaft);
      const by = p.y + dy * (t0 + shaft);
      const stem = g.querySelector('.antenna-handle-stem');
      stem?.setAttribute('x1', n(p.x + dx * t0));
      stem?.setAttribute('y1', n(p.y + dy * t0));
      stem?.setAttribute('x2', n(bx));
      stem?.setAttribute('y2', n(by));
      const px = -dy * 7;
      const py = dx * 7;
      g.querySelector('.antenna-handle-cone')?.setAttribute(
        'd',
        `M ${n(bx + px)} ${n(by + py)} L ${n(bx + dx * head)} ${n(by + dy * head)} L ${n(bx - px)} ${n(by - py)} Z`,
      );
    }
    if (!hold) {
      chip.style.display = 'none';
      return;
    }
    const key = DIM_KEYS[hold.face.axis];
    chip.replaceChildren();
    const letter = document.createElement('b');
    letter.textContent = t(`telecom.antennas.resize.letter.${key}`);
    chip.append(
      letter,
      `${t(`telecom.antennas.resize.chip.${key}`)} ${t('telecom.antennas.label.metres', {
        value: ext[hold.face.axis].toFixed(2),
      })}`,
    );
    chip.style.display = 'block';
    chip.style.transform = `translate(${n(hold.pointer.x + 16)}px, ${n(hold.pointer.y + 14)}px)`;
  };

  const raycaster = new Raycaster();
  const onMove = (e: PointerEvent) => {
    if (!hold) return;
    const r = rect();
    hold.pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    raycaster.setFromCamera(
      new Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      ),
      stage.camera,
    );
    const { origin, direction } = raycaster.ray;
    const extent = extentFromRay(
      [hold.fixed.x, hold.fixed.y, hold.fixed.z],
      [hold.normal.x, hold.normal.y, hold.normal.z],
      [origin.x, origin.y, origin.z],
      [direction.x, direction.y, direction.z],
    );
    if (extent !== null) dragBox(extent);
    stage.requestRender();
  };
  const release = () => {
    hold = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    stage.controls.enabled = true;
    stage.requestRender();
  };
  const onUp = () => {
    if (!hold) return;
    release();
    const a = antennaStore.getState();
    const unit = drawnFile(a.file, a.boxEdit)?.units.find((u) => u.id === a.boxEdit?.unitId);
    if (!unit) {
      cancelBoxDrag();
      return;
    }
    const axes = unit.box.axes.map(axisToLocal) as [Vec3, Vec3, Vec3];
    const selection = boxCropSelection(
      antennaCentre(unit, frame, opts.getShift()),
      axes,
      unit.box.extents,
    );
    void commitBoxDrag({ layer: opts.getLayer(), selection });
  };
  const onCancel = () => {
    if (!hold) return;
    release();
    cancelBoxDrag();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !hold) return;
    // Escape puts the box back; it does not also leave the selection
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };
  const onDown = (e: PointerEvent, f: BoxFace) => {
    if (e.button !== 0 || hold) return;
    const unit = shownUnit();
    if (!unit || !beginBoxDrag(unit.id, f)) return;
    e.preventDefault();
    e.stopPropagation();
    const c = v3(antennaCentre(unit, frame, opts.getShift()));
    const normal = v3(axisToLocal(unit.box.axes[f.axis])).multiplyScalar(f.sign);
    const r = rect();
    hold = {
      face: f,
      fixed: c.clone().addScaledVector(normal, -unit.box.extents[f.axis] / 2),
      normal,
      pointer: { x: e.clientX - r.left, y: e.clientY - r.top },
    };
    stage.controls.enabled = false;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    stage.requestRender();
  };

  const offFrame = stage.onFrame(update);
  const offStore = antennaStore.subscribe(() => {
    stage.requestRender();
  });
  update();

  return () => {
    if (hold) onCancel();
    offFrame();
    offStore();
    layer.remove();
  };
}
