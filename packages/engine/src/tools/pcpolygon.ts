/**
 * Click-by-click outline tool (antenna flagging): each click on the view adds a vertex, a
 * double-click, Enter or `close()` with at least 3 vertices reports the outline as a lasso
 * selection (NDC polygon plus the camera's view-projection at that moment). Backspace and `undo()`
 * drop the last vertex, Escape cancels; Enter and Backspace in a text field, select or editable
 * element stay the field's. Clicks come through `stage.claimClicks`, which only passes
 * a press and release under 4 px apart, so orbiting never adds vertices.
 */
import { Matrix4 } from 'three';
import type { EngineStage } from '../types';
import { MAX_LASSO_VERTICES, type PointSelection } from './pcselect';

const SVG = 'http://www.w3.org/2000/svg';
/** A click this close (CSS pixels) to the last vertex is the second click of a double-click. */
const SAME_SPOT_PX = 4;

/** Whether a key goes to a field that edits text or picks a value (its Enter and Backspace). */
const editing = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.isContentEditable ||
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT');

export class PolygonClickTool {
  private vertices: [number, number][] = [];
  private pointer: [number, number] | null = null;
  private overlay: SVGSVGElement | null = null;
  private fill: SVGPolylineElement | null = null;
  private band: SVGLineElement | null = null;
  private dots: SVGCircleElement[] = [];

  constructor(
    private readonly stage: EngineStage,
    private readonly opts: {
      onClose(sel: PointSelection): void;
      onCancel(): void;
      onChange?(vertices: number): void;
    },
  ) {}

  attach(): () => void {
    const canvas = this.stage.renderer.domElement;
    const parent = canvas.parentElement ?? document.body;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('data-testid', 'pcpolygon-overlay');
    svg.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5';
    const line = document.createElementNS(SVG, 'polyline');
    line.setAttribute('fill', 'rgba(255,176,32,0.12)');
    line.setAttribute('stroke', '#ffb020');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-dasharray', '4 3');
    const band = document.createElementNS(SVG, 'line');
    band.setAttribute('stroke', '#ffb020');
    band.setAttribute('stroke-width', '1');
    band.setAttribute('stroke-dasharray', '2 3');
    svg.append(line, band);
    parent.append(svg);
    this.overlay = svg;
    this.fill = line;
    this.band = band;

    const unclaim = this.stage.claimClicks((e) => {
      if (e.button !== 0) return false;
      this.add(e);
      return true;
    });
    const move = (e: PointerEvent) => {
      if (!this.vertices.length) return;
      this.pointer = this.ndc(e);
      this.draw();
    };
    const dbl = () => {
      this.close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        this.reset();
        this.opts.onCancel();
      } else if (e.key === 'Enter') {
        if (!this.vertices.length || editing(e.target)) return;
        e.stopImmediatePropagation();
        this.close();
      } else if (e.key === 'Backspace') {
        if (!this.vertices.length || editing(e.target)) return;
        e.stopImmediatePropagation();
        this.undo();
      }
    };
    window.addEventListener('pointermove', move);
    canvas.addEventListener('dblclick', dbl);
    window.addEventListener('keydown', key, { capture: true });
    // a crosshair while armed, as every pick shows (passive pointer features keep off it)
    const cursor = canvas.style.cursor;
    canvas.style.cursor = 'crosshair';
    return () => {
      unclaim();
      if (canvas.style.cursor === 'crosshair') canvas.style.cursor = cursor;
      window.removeEventListener('pointermove', move);
      canvas.removeEventListener('dblclick', dbl);
      window.removeEventListener('keydown', key, { capture: true });
      svg.remove();
      this.overlay = null;
      this.fill = null;
      this.band = null;
      this.dots = [];
      this.vertices = [];
    };
  }

  undo(): void {
    if (!this.vertices.length) return;
    this.vertices.pop();
    this.changed();
  }

  close(): void {
    if (this.vertices.length < 3) return;
    const polygon = this.vertices.map((v): [number, number] => [v[0], v[1]]);
    const cam = this.stage.camera;
    cam.updateMatrixWorld();
    const viewProj = new Matrix4()
      .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
      .toArray();
    this.reset();
    this.opts.onClose({ shape: 'lasso', polygon, viewProj });
  }

  private reset(): void {
    this.vertices = [];
    this.pointer = null;
    this.changed();
  }

  private add(e: PointerEvent): void {
    if (this.vertices.length >= MAX_LASSO_VERTICES) return;
    const v = this.ndc(e);
    const last = this.vertices[this.vertices.length - 1];
    if (last) {
      const r = this.stage.renderer.domElement.getBoundingClientRect();
      const px = Math.hypot(((v[0] - last[0]) / 2) * r.width, ((v[1] - last[1]) / 2) * r.height);
      if (px < SAME_SPOT_PX) return;
    }
    this.vertices.push(v);
    this.pointer = v;
    this.changed();
  }

  private changed(): void {
    this.draw();
    this.opts.onChange?.(this.vertices.length);
  }

  private ndc(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1];
  }

  private draw(): void {
    const svg = this.overlay;
    const line = this.fill;
    const band = this.band;
    if (!svg || !line || !band) return;
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    const o = svg.getBoundingClientRect();
    const x = (v: number) => r.left - o.left + ((v + 1) / 2) * r.width;
    const y = (v: number) => r.top - o.top + ((1 - v) / 2) * r.height;
    const vs = this.vertices;
    line.setAttribute('points', vs.map((v) => `${String(x(v[0]))},${String(y(v[1]))}`).join(' '));
    const last = vs[vs.length - 1];
    const p = this.pointer;
    if (last && p) {
      band.setAttribute('x1', String(x(last[0])));
      band.setAttribute('y1', String(y(last[1])));
      band.setAttribute('x2', String(x(p[0])));
      band.setAttribute('y2', String(y(p[1])));
    } else {
      for (const a of ['x1', 'y1', 'x2', 'y2']) band.setAttribute(a, '0');
    }
    while (this.dots.length > vs.length) this.dots.pop()?.remove();
    while (this.dots.length < vs.length) {
      const c = document.createElementNS(SVG, 'circle');
      c.setAttribute('r', '3.5');
      c.setAttribute('fill', '#ffb020');
      svg.append(c);
      this.dots.push(c);
    }
    vs.forEach((v, i) => {
      this.dots[i]?.setAttribute('cx', String(x(v[0])));
      this.dots[i]?.setAttribute('cy', String(y(v[1])));
    });
  }
}
