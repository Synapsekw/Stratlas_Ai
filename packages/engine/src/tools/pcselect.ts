/**
 * Box and lasso selection of cloud points (cleanup, ANN-4): a screen rectangle or a freehand path
 * drawn over the view in an SVG overlay, reported in NDC with the camera's view-projection (local
 * frame to clip) at the time of drawing. A lasso keeps at most 256 vertices. Escape cancels. The
 * app counts and stores the selection (renderer/pointcloud/cleanupScene.ts).
 */
import { MAX_LASSO_VERTICES } from '@aio/schema';
import { Matrix4 } from 'three';
import type { EngineStage } from '../types';

export { MAX_LASSO_VERTICES };

export type SelectShape = 'box' | 'lasso';
export interface PointSelection {
  shape: SelectShape;
  polygon: [number, number][];
  viewProj: number[];
}

/** A drag shorter than this (CSS pixels) is a click, not a selection. */
const MIN_DRAG_PX = 4;
const SVG = 'http://www.w3.org/2000/svg';

export function rectPolygon(a: [number, number], b: [number, number]): [number, number][] {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer-Douglas-Peucker: every dropped point lies within `eps` of the kept polyline. */
function rdp(pts: readonly [number, number][], eps: number): [number, number][] {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop() ?? [0, 0];
    let far = -1;
    let farD = eps;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(pts[k] ?? [0, 0], pts[i] ?? [0, 0], pts[j] ?? [0, 0]);
      if (d > farD) {
        farD = d;
        far = k;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  return pts.filter((_, k) => keep[k] === 1);
}

/**
 * At most `max` vertices, consecutive duplicates removed. The tolerance grows until the path fits,
 * then a bisection finds the smallest tolerance that still fits, so the outline stays as close to
 * the drawn path as the vertex budget allows.
 */
export function simplifyPath(
  pts: readonly [number, number][],
  max = MAX_LASSO_VERTICES,
): [number, number][] {
  const clean: [number, number][] = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) clean.push(p);
  }
  if (clean.length <= max) return clean;
  let lo = 0;
  let hi = 1e-4;
  let out = rdp(clean, hi);
  while (out.length > max) {
    lo = hi;
    hi *= 1.5;
    out = rdp(clean, hi);
  }
  for (let n = 0; n < 12 && hi - lo > 1e-6; n++) {
    const mid = (lo + hi) / 2;
    const tryOut = rdp(clean, mid);
    if (tryOut.length <= max) {
      hi = mid;
      out = tryOut;
    } else lo = mid;
  }
  return out;
}

export class PointSelectTool {
  private shape: SelectShape;
  private path: [number, number][] = [];
  private start: { x: number; y: number } | null = null;
  private overlay: SVGSVGElement | null = null;
  private outline: SVGPolylineElement | null = null;

  constructor(
    private readonly stage: EngineStage,
    private readonly opts: {
      shape: SelectShape;
      onSelect(sel: PointSelection): void;
      onCancel(): void;
    },
  ) {
    this.shape = opts.shape;
  }

  setShape(shape: SelectShape): void {
    if (shape === this.shape) return;
    this.abort();
    this.shape = shape;
  }

  attach(): () => void {
    const canvas = this.stage.renderer.domElement;
    const parent = canvas.parentElement ?? document.body;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('data-testid', 'pcselect-overlay');
    svg.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5';
    const line = document.createElementNS(SVG, 'polyline');
    line.setAttribute('fill', 'rgba(255,176,32,0.12)');
    line.setAttribute('stroke', '#ffb020');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-dasharray', '4 3');
    svg.append(line);
    parent.append(svg);
    this.overlay = svg;
    this.outline = line;

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // The selection takes the press: neither the orbit controls nor the stage's click see it,
      // so a release never selects assets.
      e.stopImmediatePropagation();
      if (this.start) return;
      this.stage.controls.enabled = false;
      this.start = { x: e.clientX, y: e.clientY };
      this.path = [this.ndc(e)];
      this.draw();
    };
    const move = (e: PointerEvent) => {
      if (!this.start) return;
      if (this.shape === 'box') this.path = [this.path[0] ?? this.ndc(e), this.ndc(e)];
      else this.path.push(this.ndc(e));
      this.draw();
    };
    const up = (e: PointerEvent) => {
      const s = this.start;
      if (!s) return;
      this.start = null;
      this.stage.controls.enabled = true;
      const moved = Math.hypot(e.clientX - s.x, e.clientY - s.y) >= MIN_DRAG_PX;
      const first = this.path[0];
      const polygon =
        this.shape === 'box'
          ? first && moved
            ? rectPolygon(first, this.ndc(e))
            : []
          : simplifyPath([...this.path, this.ndc(e)]);
      this.path = [];
      this.draw();
      if (!moved || polygon.length < 3) return;
      const cam = this.stage.camera;
      cam.updateMatrixWorld();
      const viewProj = new Matrix4()
        .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
        .toArray();
      this.opts.onSelect({ shape: this.shape, polygon, viewProj });
    };
    // The system took the pointer (touch scroll, focus loss): drop the drawing, keep the tool.
    const cancelPointer = () => {
      this.abort();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      this.abort();
      e.stopImmediatePropagation();
      this.opts.onCancel();
    };
    canvas.addEventListener('pointerdown', down, { capture: true });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancelPointer);
    window.addEventListener('keydown', key, { capture: true });
    return () => {
      canvas.removeEventListener('pointerdown', down, { capture: true });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancelPointer);
      window.removeEventListener('keydown', key, { capture: true });
      this.abort();
      svg.remove();
      this.overlay = null;
      this.outline = null;
    };
  }

  /** Drop a drawing in progress and give the orbit controls back. */
  private abort(): void {
    if (!this.start) return;
    this.start = null;
    this.path = [];
    this.stage.controls.enabled = true;
    this.draw();
  }

  private ndc(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1];
  }

  /** The outline in overlay pixels (the overlay covers the canvas's parent). */
  private draw(): void {
    const line = this.outline;
    const svg = this.overlay;
    if (!line || !svg) return;
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    const o = svg.getBoundingClientRect();
    const px = ([x, y]: [number, number]) =>
      `${String(r.left - o.left + ((x + 1) / 2) * r.width)},${String(r.top - o.top + ((1 - y) / 2) * r.height)}`;
    const pts =
      this.shape === 'box' && this.path.length === 2
        ? rectPolygon(this.path[0] ?? [0, 0], this.path[1] ?? [0, 0])
        : this.path;
    line.setAttribute('points', pts.length ? [...pts, pts[0] ?? [0, 0]].map(px).join(' ') : '');
  }
}
