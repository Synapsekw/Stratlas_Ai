import { Vector3, type PerspectiveCamera } from 'three';
import { FONT_MONO, FONT_UI, PALETTE } from '../palette';
import type { ClientRectLike } from '../types';
import {
  estimateLabelWidth,
  LEADER_TAIL,
  LEADER_Y,
  placeCallouts,
  type CalloutItem,
  type CalloutSide,
  type ScreenRect,
} from './declutter';

export interface CalloutSpec {
  id: string;
  anchor: Vector3;
  /** First line is the tag (mono, bold); the rest are details. */
  lines: string[];
  selected: boolean;
  /** Expanded whatever it overlaps (the hovered component). */
  forced?: boolean;
  /** Higher wins a collision among unforced callouts (nearer the camera breaks ties). */
  rank?: number;
}

interface CalloutEl {
  spec: CalloutSpec;
  el: HTMLDivElement;
  dot: HTMLSpanElement;
  leader: SVGSVGElement;
  plate: HTMLDivElement;
  w: number;
  h: number;
  up: number;
  dx: number;
  side: CalloutSide | null | undefined;
  shown: boolean | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const LINE_H = 13;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/**
 * HTML layer over the canvas: asset callouts with leader lines (Mission style) that declutter to
 * dots, the compass, the measure readout and the dev frame-time overlay. Positions are written
 * with transforms only, after each rendered frame.
 */
export class Overlay {
  readonly root: HTMLDivElement;
  private readonly callouts = new Map<string, CalloutEl>();
  private hoverId: string | null = null;
  private keepOut: (() => Iterable<ClientRectLike>) | null = null;
  private readonly obstacles = new Set<() => Iterable<Vector3>>();
  private readonly compass: SVGSVGElement;
  private readonly compassRose: SVGGElement;
  private readonly compassText: SVGTextElement;
  private readonly measure: HTMLDivElement;
  private readonly measureDots: [HTMLSpanElement, HTMLSpanElement];
  private measureState: { a: Vector3 | null; b: Vector3 | null; text: string } = {
    a: null,
    b: null,
    text: '',
  };
  private readonly perf: HTMLDivElement;
  private readonly v = new Vector3();
  private lastHeading = Number.NaN;

  constructor(
    host: HTMLElement,
    private readonly hooks: {
      onCalloutClick(id: string): void;
      onCompassClick(): void;
      requestRender(): void;
    },
  ) {
    const root = document.createElement('div');
    root.className = 'aio-stage-overlay';
    Object.assign(root.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
      font: `400 11px ${FONT_UI}`,
      color: PALETTE.ovCss,
      userSelect: 'none',
    });
    host.appendChild(root);
    this.root = root;

    // compass, bottom right; click for the north-up top view
    this.compass = svg('svg', { width: 56, height: 56, viewBox: '0 0 64 64' });
    Object.assign(this.compass.style, {
      position: 'absolute',
      right: '12px',
      bottom: '12px',
      pointerEvents: 'auto',
      cursor: 'pointer',
    });
    this.compass.setAttribute('role', 'button');
    this.compass.setAttribute('aria-label', 'Compass. Click for a north-up top view');
    this.compass.addEventListener('click', () => {
      hooks.onCompassClick();
    });
    this.compass.append(
      svg('circle', {
        cx: 32,
        cy: 32,
        r: 27,
        fill: 'oklch(0.13 0.01 250 / .78)',
        stroke: PALETTE.ovFaintCss,
      }),
    );
    this.compassRose = svg('g', {});
    for (let a = 0; a < 360; a += 15) {
      const maj = a % 90 === 0;
      this.compassRose.append(
        svg('line', {
          x1: 32,
          y1: 5,
          x2: 32,
          y2: maj ? 12 : 9,
          stroke: maj ? PALETTE.ovCss : PALETTE.ovFaintCss,
          'stroke-width': 1,
          transform: `rotate(${a} 32 32)`,
        }),
      );
    }
    this.compassRose.append(
      svg('path', { d: 'M32 9 L36 19 L32 17 L28 19 Z', fill: PALETTE.accCss }),
    );
    const n = svg('text', { x: 32, y: 30, 'text-anchor': 'middle', fill: PALETTE.ovCss });
    n.style.font = `600 9px ${FONT_MONO}`;
    n.textContent = 'N';
    this.compassRose.append(n);
    this.compassText = svg('text', {
      x: 32,
      y: 46,
      'text-anchor': 'middle',
      fill: PALETTE.ovDimCss,
    });
    this.compassText.style.font = `500 9px ${FONT_MONO}`;
    this.compass.append(this.compassRose, this.compassText);
    root.append(this.compass);

    // measure readout
    this.measure = document.createElement('div');
    Object.assign(this.measure.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      padding: '3px 7px',
      background: PALETTE.plateCss,
      border: `1px solid ${PALETTE.accCss}`,
      font: `600 11px ${FONT_MONO}`,
      color: PALETTE.ovCss,
      whiteSpace: 'nowrap',
      display: 'none',
    });
    const dot = () => {
      const d = document.createElement('span');
      Object.assign(d.style, {
        position: 'absolute',
        left: '-4px',
        top: '-4px',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: '#ffd166',
        boxShadow: '0 0 0 1px oklch(0.13 0.01 250)',
        display: 'none',
      });
      root.append(d);
      return d;
    };
    this.measureDots = [dot(), dot()];
    root.append(this.measure);

    this.perf = document.createElement('div');
    Object.assign(this.perf.style, {
      position: 'absolute',
      left: '8px',
      top: '8px',
      padding: '6px 8px',
      background: 'oklch(0.13 0.01 250 / .86)',
      border: `1px solid ${PALETTE.ovFaintCss}`,
      font: `500 11px/1.45 ${FONT_MONO}`,
      whiteSpace: 'pre',
      display: 'none',
    });
    root.append(this.perf);
  }

  setCallouts(specs: readonly CalloutSpec[]) {
    const keep = new Set(specs.map((s) => s.id));
    for (const [id, c] of this.callouts) {
      if (!keep.has(id)) {
        c.el.remove();
        this.callouts.delete(id);
      }
    }
    for (const spec of specs) {
      const existing = this.callouts.get(spec.id);
      if (
        existing?.spec.selected === spec.selected &&
        existing.spec.lines.join('\n') === spec.lines.join('\n')
      ) {
        existing.spec = spec;
        continue;
      }
      existing?.el.remove();
      this.callouts.set(spec.id, this.build(spec));
    }
  }

  private build(spec: CalloutSpec): CalloutEl {
    const col = spec.selected ? PALETTE.accCss : PALETTE.ovCss;
    const up = spec.selected ? 56 : 30;
    const dx = spec.selected ? 20 : 14;
    const w = estimateLabelWidth(spec.lines);
    const h = spec.lines.length * LINE_H + 10;
    const el = document.createElement('div');
    el.dataset.callout = spec.id;
    Object.assign(el.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      willChange: 'transform',
      zIndex: spec.selected ? '3' : '1',
    });
    const dot = document.createElement('span');
    Object.assign(dot.style, {
      position: 'absolute',
      left: '-4px',
      top: '-4px',
      width: '8px',
      height: '8px',
      boxSizing: 'border-box',
      background: spec.selected ? PALETTE.accCss : 'oklch(0.13 0.01 250)',
      border: `1.25px solid ${col}`,
      pointerEvents: 'auto',
      cursor: 'pointer',
    });
    dot.title = spec.lines.join(' · ');
    dot.addEventListener('pointerenter', () => {
      this.hoverId = spec.id;
      this.hooks.requestRender();
    });
    dot.addEventListener('pointerleave', () => {
      if (this.hoverId === spec.id) this.hoverId = null;
      this.hooks.requestRender();
    });
    dot.addEventListener('click', () => {
      this.hooks.onCalloutClick(spec.id);
    });
    const leader = svg('svg', { width: dx + 12, height: up + 2, overflow: 'visible' });
    Object.assign(leader.style, {
      position: 'absolute',
      left: '0',
      top: `${-up}px`,
      overflow: 'visible',
      transformOrigin: '0 0',
    });
    leader.append(
      svg('path', {
        d: `M2,${up - 2} L${dx},0 L${dx + LEADER_TAIL},0`,
        stroke: col,
        'stroke-width': 1,
        fill: 'none',
        opacity: spec.selected ? 1 : 0.65,
      }),
    );
    const plate = document.createElement('div');
    Object.assign(plate.style, {
      position: 'absolute',
      left: `${dx + LEADER_TAIL}px`,
      top: `${-up - LEADER_Y}px`,
      width: `${w}px`,
      boxSizing: 'border-box',
      padding: '4px 8px',
      background: PALETTE.plateCss,
      border: `1px solid ${spec.selected ? PALETTE.accCss : PALETTE.ovFaintCss}`,
      borderRadius: '2px',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      lineHeight: `${LINE_H}px`,
    });
    spec.lines.forEach((line, i) => {
      const d = document.createElement('div');
      d.textContent = line;
      d.style.font = i === 0 ? `600 10.5px ${FONT_MONO}` : `400 10px ${FONT_UI}`;
      d.style.color = i === 0 ? col : PALETTE.ovDimCss;
      d.style.overflow = 'hidden';
      d.style.textOverflow = 'ellipsis';
      plate.append(d);
    });
    el.append(leader, plate, dot);
    this.root.insertBefore(el, this.compass);
    return { spec, el, dot, leader, plate, w, h, up, dx, side: undefined, shown: null };
  }

  /** UI drawn over the stage (video window, toolbars) that callouts must keep clear of. */
  setKeepOut(provider: (() => Iterable<ClientRectLike>) | null) {
    this.keepOut = provider;
  }

  /** World points (issue pins) whose screen spot callout plates must not cover. */
  addObstacles(provider: () => Iterable<Vector3>): () => void {
    this.obstacles.add(provider);
    return () => {
      this.obstacles.delete(provider);
    };
  }

  private screenKeepOut(width: number, height: number): ScreenRect[] {
    // the compass, bottom right
    const out: ScreenRect[] = [{ x: width - 72, y: height - 72, w: 72, h: 72 }];
    if (!this.keepOut) return out;
    const host = this.root.getBoundingClientRect();
    for (const r of this.keepOut()) {
      const x = r.left - host.left;
      const y = r.top - host.top;
      const w = r.right - r.left;
      const h = r.bottom - r.top;
      if (w <= 0 || h <= 0 || x > width || y > height || x + w < 0 || y + h < 0) continue;
      out.push({ x, y, w, h });
    }
    return out;
  }

  /** Project, declutter and place everything. Call after each rendered frame. */
  update(camera: PerspectiveCamera, width: number, height: number, headingDeg: number) {
    const items: CalloutItem[] = [];
    const screen = new Map<string, [number, number]>();
    const camPos = camera.position;
    for (const c of this.callouts.values()) {
      const p = this.project(c.spec.anchor, camera, width, height);
      if (!p || p[0] < -40 || p[0] > width + 40 || p[1] < -20 || p[1] > height + 60) {
        if (c.shown !== false) {
          c.el.style.display = 'none';
          c.shown = false;
        }
        continue;
      }
      screen.set(c.spec.id, p);
      items.push({
        id: c.spec.id,
        ax: p[0],
        ay: p[1],
        w: c.w,
        h: c.h,
        up: c.up,
        run: c.dx,
        priority: (c.spec.rank ?? 0) * 1e6 - c.spec.anchor.distanceTo(camPos),
      });
    }
    const forced = new Set<string>();
    for (const c of this.callouts.values())
      if (c.spec.selected || c.spec.forced) forced.add(c.spec.id);
    if (this.hoverId) forced.add(this.hoverId);
    const obstacles: ScreenRect[] = [];
    if (items.length > 0)
      for (const provider of this.obstacles)
        for (const w of provider()) {
          const p = this.project(w, camera, width, height);
          // a pin ball and its code label to the right
          if (p) obstacles.push({ x: p[0] - 9, y: p[1] - 12, w: 72, h: 24 });
        }
    const { sides, hidden } = placeCallouts(items, {
      forced,
      keepOut: items.length > 0 ? this.screenKeepOut(width, height) : [],
      obstacles,
      width,
      height,
    });
    for (const [id, p] of screen) {
      const c = this.callouts.get(id);
      if (!c) continue;
      const show = !hidden.has(id);
      if (c.shown !== show) {
        c.el.style.display = show ? '' : 'none';
        c.shown = show;
      }
      if (!show) continue;
      c.el.style.transform = `translate3d(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px, 0)`;
      const side = sides.get(id) ?? null;
      if (c.side !== side) {
        const ex = side !== null;
        c.leader.style.display = ex ? '' : 'none';
        c.plate.style.display = ex ? '' : 'none';
        c.leader.style.transform = side === 'left' ? 'scaleX(-1)' : '';
        c.plate.style.left =
          side === 'left' ? `${-(c.dx + LEADER_TAIL) - c.w}px` : `${c.dx + LEADER_TAIL}px`;
        c.el.style.zIndex = ex ? (c.spec.selected ? '3' : '2') : '1';
        c.side = side;
      }
    }

    // measure
    const { a, b, text } = this.measureState;
    const pa = a ? this.project(a, camera, width, height) : null;
    const pb = b ? this.project(b, camera, width, height) : null;
    this.place(this.measureDots[0], pa);
    this.place(this.measureDots[1], pb);
    if (pa && pb && text) {
      this.measure.style.display = '';
      this.measure.textContent = text;
      this.measure.style.transform = `translate3d(${((pa[0] + pb[0]) / 2 + 8).toFixed(1)}px, ${((pa[1] + pb[1]) / 2 - 26).toFixed(1)}px, 0)`;
    } else this.measure.style.display = 'none';

    // compass: the rose turns so N points at north on screen
    if (Math.abs(headingDeg - this.lastHeading) > 0.2 || Number.isNaN(this.lastHeading)) {
      this.lastHeading = headingDeg;
      this.compassRose.setAttribute('transform', `rotate(${(-headingDeg).toFixed(1)} 32 32)`);
      this.compassText.textContent = `${String(Math.round(((headingDeg % 360) + 360) % 360) % 360).padStart(3, '0')}°`;
    }
  }

  private place(el: HTMLElement, p: [number, number] | null) {
    if (!p) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.transform = `translate3d(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px, 0)`;
  }

  private project(
    anchor: Vector3,
    camera: PerspectiveCamera,
    width: number,
    height: number,
  ): [number, number] | null {
    this.v.copy(anchor).project(camera);
    if (this.v.z > 1 || this.v.z < -1) return null;
    return [((this.v.x + 1) / 2) * width, ((1 - this.v.y) / 2) * height];
  }

  setMeasure(a: Vector3 | null, b: Vector3 | null, text: string) {
    this.measureState = { a, b, text };
  }

  setPerf(text: string | null) {
    this.perf.style.display = text === null ? 'none' : '';
    if (text !== null) this.perf.textContent = text;
  }

  dispose() {
    this.root.remove();
    this.callouts.clear();
  }
}
