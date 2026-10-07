import { Matrix4, Vector3 } from 'three';
import { engineConfig } from '../config';
import { isEngineStage } from '../registry';
import type { SceneHandle } from '../types';
import {
  clusterSites,
  hitCluster,
  timeSpan,
  type ScreenSite,
  type SiteCluster,
} from './markerMath';

/** Places that carry markers: one or more photos or panoramas taken from (about) one point. */
export interface MarkerSite {
  pos: readonly [number, number, number];
  /** Caller member indices (photo or panorama items). */
  members: number[];
}

export interface MarkerMember {
  id: string;
  takenAt?: string | undefined;
  /** Image for the cluster list (a thumbnail first, the full image if that fails). */
  thumb?: string | undefined;
  full?: string | undefined;
}

export interface MarkerLayerOptions {
  scene: SceneHandle;
  kind: 'photo' | 'pano';
  sites: MarkerSite[];
  member(i: number): MarkerMember;
  /** Open one member (select the photo, enter the panorama). */
  open(i: number): void;
  /** Member indices currently selected. */
  selected(): ReadonlySet<number>;
}

/** Icons closer than this many pixels merge into one with a count. */
const CLUSTER_PX = 24;
/** Most icons of one layer on the stage at once. */
const MAX_ICONS = 36;
/** Pointer distance from an icon centre that hits it: a 28 px target around an 18 px plate. */
export const HIT_PX = 14;
const CLICK_SLOP_PX = 5;
/** Most rows in the list a cluster opens on click. */
const LIST_MAX = 60;

const GLYPH = {
  // a camera: body and lens
  photo: '<path d="M3 7h3.2L7.8 5h4.4l1.6 2H17v8.5H3z"/><circle cx="10" cy="11.2" r="2.6"/>',
  // a panorama: the curved strip of a wide view
  pano: '<path d="M2.5 6.2c5 1.7 10 1.7 15 0v7.6c-5-1.7-10-1.7-15 0z"/><path d="M10 7.6v4.8"/>',
} as const;

const CSS = `
.aio-mk-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1;contain:strict}
.aio-mk{position:absolute;left:0;top:0;width:28px;height:28px;margin:-14px 0 0 -14px;display:grid;place-items:center;will-change:transform;color:var(--ov,oklch(0.96 0.008 250))}
.aio-mk-p{box-sizing:border-box;width:18px;height:18px;display:grid;place-items:center;background:oklch(0.15 0.01 250 / .8);border:1.25px solid oklch(0.96 0.008 250 / .72);box-shadow:0 0 0 1px oklch(0.08 0.01 250 / .35),0 2px 6px oklch(0.06 0.01 250 / .45);transition:transform .14s cubic-bezier(.25,1,.5,1),border-color .14s,background-color .14s}
.aio-mk[data-kind=photo] .aio-mk-p{border-radius:4px}
.aio-mk[data-kind=pano] .aio-mk-p{border-radius:50%}
.aio-mk svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.aio-mk.is-hover .aio-mk-p{transform:scale(1.18);border-color:var(--acc,oklch(0.79 0.115 172))}
.aio-mk.is-sel .aio-mk-p{border-width:2px;border-color:var(--acc,oklch(0.79 0.115 172));background:oklch(0.22 0.04 172 / .92);color:var(--acc-strong,oklch(0.86 0.12 172))}
.aio-mk-n{position:absolute;left:18px;top:1px;box-sizing:border-box;min-width:15px;height:13px;padding:0 3px;border-radius:7px;background:var(--acc,oklch(0.79 0.115 172));color:var(--acc-ink,oklch(0.2 0.03 172));font:600 9.5px/13px var(--f-mono,'IBM Plex Mono',ui-monospace,monospace);text-align:center;font-variant-numeric:tabular-nums;box-shadow:0 0 0 1.5px oklch(0.15 0.01 250 / .85)}
.aio-mk-tip{position:absolute;left:0;top:0;pointer-events:none;white-space:nowrap;padding:4px 8px 5px;border-radius:4px;background:var(--scrim,oklch(0.13 0.01 250 / .84));border:1px solid var(--line-strong,oklch(0.36 0.012 250));color:var(--ov,oklch(0.96 0.008 250));font:500 11px/15px var(--f-mono,'IBM Plex Mono',ui-monospace,monospace);z-index:2}
.aio-mk-tip i{display:block;font-style:normal;color:var(--ov-dim,oklch(0.96 0.008 250 / .55))}
.aio-mk-list{position:absolute;z-index:6;max-height:260px;overflow-y:auto;min-width:200px;max-width:300px;padding:4px;background:var(--bg-1,#12161c);border:1px solid var(--line-strong,#39424e);border-radius:6px;box-shadow:0 12px 32px rgba(0,0,0,.45);color:var(--fg-0,#eef1f5);font:500 12px/1.2 var(--f-mono,'IBM Plex Mono',ui-monospace,monospace);pointer-events:auto}
.aio-mk-list button{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:3px 6px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
.aio-mk-list button:hover,.aio-mk-list button:focus-visible{background:var(--bg-3,#222a34);outline:none}
.aio-mk-list img{width:40px;height:28px;object-fit:cover;border-radius:2px;background:var(--bg-3,#222a34);flex:none}
.aio-mk-list span{display:flex;flex-direction:column;gap:2px;min-width:0}
.aio-mk-list small{color:var(--fg-2,#8b95a3);font-size:11px}
.aio-mk-list .more{padding:6px;color:var(--fg-3,#7d8794)}
`;

let styled = false;
function injectStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.dataset.aio = 'markers';
  s.textContent = CSS;
  document.head.append(s);
}

/** The marker layers of each scene, so photos and panoramas share hover, clicks and space. */
const layersOf = new WeakMap<SceneHandle, Set<MarkerLayer>>();
/** A panorama icon on (almost) the same spot as a photo icon steps aside by this much. */
const NUDGE_PX = 16;

interface MarkerEl {
  root: HTMLDivElement;
  count: HTMLSpanElement;
}

/**
 * Photo and panorama markers as HTML over the canvas: a crisp plate with a glyph (rounded square
 * for photos, circle for panoramas), sites closer than a few pixels on screen merged into one icon
 * with a count badge, hover (count and time span) and selected states. Clicks are hit-tested here
 * (28 px targets) and claimed from the stage; a merged icon opens a list of its members.
 */
export class MarkerLayer {
  private readonly root: HTMLDivElement | null;
  private readonly tip: HTMLDivElement | null;
  private readonly pool: MarkerEl[] = [];
  private clusters: SiteCluster[] = [];
  private hovered = -1;
  private visible = true;
  private dirty = true;
  private readonly lastView = new Matrix4();
  private lastSize = '';
  private readonly v = new Vector3();
  private readonly offs: (() => void)[] = [];
  private down: { x: number; y: number } | null = null;
  private closeList: (() => void) | null = null;
  private hoverRaf = 0;
  private hoverAt: { x: number; y: number } | null = null;

  constructor(private readonly o: MarkerLayerOptions) {
    injectStyle();
    const canvas = o.scene.renderer.domElement;
    const host = canvas.parentElement;
    if (host && typeof document !== 'undefined') {
      this.root = document.createElement('div');
      this.root.className = 'aio-mk-layer';
      this.root.dataset.markers = o.kind;
      this.tip = document.createElement('div');
      this.tip.className = 'aio-mk-tip';
      this.tip.style.display = 'none';
      this.root.append(this.tip);
      host.append(this.root);
    } else {
      this.root = null;
      this.tip = null;
    }
    let peers = layersOf.get(o.scene);
    if (!peers) layersOf.set(o.scene, (peers = new Set()));
    peers.add(this);
    this.offs.push(() => peers.delete(this));
    this.offs.push(o.scene.onFrame(this.layout));
    const onDown = (e: PointerEvent) => {
      this.down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
      this.hoverAt = { x: e.clientX, y: e.clientY };
      if (this.hoverRaf) return;
      // after the stage's own hover frame, so the marker cursor wins
      this.hoverRaf = requestAnimationFrame(() => {
        this.hoverRaf = 0;
        if (this.hoverAt) this.hover(this.hoverAt.x, this.hoverAt.y);
      });
    };
    const onLeave = () => {
      this.hoverAt = null;
      this.setHover(-1);
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    this.offs.push(() => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      cancelAnimationFrame(this.hoverRaf);
    });
    const scene = o.scene;
    if (isEngineStage(scene)) this.offs.push(scene.claimClicks((e) => this.click(e)));
    else {
      const onUp = (e: PointerEvent) => {
        const d = this.down;
        this.down = null;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= CLICK_SLOP_PX) this.click(e);
      };
      canvas.addEventListener('pointerup', onUp);
      this.offs.push(() => {
        canvas.removeEventListener('pointerup', onUp);
      });
    }
  }

  /** Icons drawn now (merged places count once). */
  get drawn(): readonly SiteCluster[] {
    return this.clusters;
  }

  setVisible(v: boolean) {
    this.visible = v;
    if (this.root) this.root.style.display = v ? '' : 'none';
    if (!v) {
      this.setHover(-1);
      this.closeList?.();
    }
    // the other layers' icons may step aside for these, or stop doing so
    for (const p of this.peers()) p.dirty = true;
    this.o.scene.requestRender();
  }

  /** Selection changed: repaint on the next frame. */
  refresh() {
    this.dirty = true;
    this.o.scene.requestRender();
  }

  private canvasXY(clientX: number, clientY: number) {
    const r = this.o.scene.renderer.domElement.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  private peers(): MarkerLayer[] {
    return [...(layersOf.get(this.o.scene) ?? [])];
  }

  /** Distance (px) from a stage point to this layer's nearest icon within reach, else Infinity. */
  private reach(x: number, y: number): number {
    if (!this.visible) return Infinity;
    const c = this.clusters[hitCluster(this.clusters, x, y, HIT_PX)];
    return c ? Math.hypot(c.x - x, c.y - y) : Infinity;
  }

  /** This layer's icon under a stage point, when no other marker layer's icon is nearer. */
  private hitAt(x: number, y: number): number {
    if (!this.visible) return -1;
    const mine = this.reach(x, y);
    if (!Number.isFinite(mine)) return -1;
    // the nearest icon wins; on a tie the layer drawn on top (added later)
    for (const p of this.peers().reverse()) {
      if (p === this) break;
      if (p.reach(x, y) <= mine) return -1;
    }
    for (const p of this.peers()) {
      if (p === this) break;
      if (p.reach(x, y) < mine) return -1;
    }
    return hitCluster(this.clusters, x, y, HIT_PX);
  }

  /** True when a pointer at these client coordinates is on an icon of any marker layer. */
  hits(clientX: number, clientY: number): boolean {
    const { x, y } = this.canvasXY(clientX, clientY);
    return this.peers().some((p) => {
      p.layout();
      return Number.isFinite(p.reach(x, y));
    });
  }

  /** The members of this layer's icon under a pointer (a merged icon: all of them), or null. */
  membersAt(clientX: number, clientY: number): number[] | null {
    if (!this.visible) return null;
    this.layout();
    const { x, y } = this.canvasXY(clientX, clientY);
    const c = this.clusters[this.hitAt(x, y)];
    return c ? this.membersOf(c) : null;
  }

  private click(e: PointerEvent): boolean {
    if (!this.visible) return false;
    for (const p of this.peers()) p.layout();
    const { x, y } = this.canvasXY(e.clientX, e.clientY);
    const k = this.hitAt(x, y);
    const c = this.clusters[k];
    if (!c) return false;
    const members = this.membersOf(c);
    const only = members.length === 1 ? members[0] : undefined;
    if (only !== undefined) this.o.open(only);
    else this.openList(c, members);
    return true;
  }

  private membersOf(c: SiteCluster): number[] {
    return c.sites.flatMap((s) => this.o.sites[s]?.members ?? []);
  }

  private hover(clientX: number, clientY: number) {
    if (!this.visible) return;
    // no tooltips over an open list
    if (this.peers().some((p) => p.closeList)) {
      this.setHover(-1);
      return;
    }
    const { x, y } = this.canvasXY(clientX, clientY);
    const k = this.hitAt(x, y);
    this.setHover(k);
    if (k >= 0) this.o.scene.renderer.domElement.style.cursor = 'pointer';
  }

  private setHover(k: number) {
    if (k === this.hovered) return;
    this.hovered = k;
    this.dirty = true;
    this.o.scene.requestRender();
  }

  private tipText(c: SiteCluster): [string, string] {
    const t = engineConfig().text;
    const members = this.membersOf(c);
    const first = members[0];
    const head =
      members.length === 1 && first !== undefined
        ? t(this.o.kind === 'photo' ? 'stage.markers.photo' : 'stage.markers.pano', {
            id: this.o.member(first).id,
          })
        : t(this.o.kind === 'photo' ? 'stage.markers.photos' : 'stage.markers.panos', {
            count: members.length,
          });
    const span = timeSpan(members.map((i) => this.o.member(i).takenAt));
    const when =
      span === null
        ? ''
        : typeof span === 'string'
          ? span
          : t('stage.markers.timeRange', { from: span[0], to: span[1] });
    const action = t(members.length === 1 ? 'stage.markers.open' : 'stage.markers.list');
    return [head, [when, action].filter(Boolean).join(' · ')];
  }

  private openList(c: SiteCluster, members: number[]) {
    this.closeList?.();
    for (const p of this.peers()) p.setHover(-1);
    const root = this.root;
    if (!root) return;
    const t = engineConfig().text;
    const box = document.createElement('div');
    box.className = 'aio-mk-list';
    box.dataset.testid = 'marker-list';
    box.setAttribute('role', 'listbox');
    box.setAttribute('aria-label', this.tipText(c)[0]);
    const rows = [...members].sort((a, b) =>
      (this.o.member(a).takenAt ?? '').localeCompare(this.o.member(b).takenAt ?? ''),
    );
    for (const i of rows.slice(0, LIST_MAX)) {
      const m = this.o.member(i);
      const row = document.createElement('button');
      row.type = 'button';
      row.setAttribute('role', 'option');
      if (m.thumb ?? m.full) {
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = m.thumb ?? m.full ?? '';
        img.onerror = () => {
          if (m.full && img.src !== m.full) img.src = m.full;
          else img.style.visibility = 'hidden';
        };
        row.append(img);
      }
      const text = document.createElement('span');
      const id = document.createElement('b');
      id.textContent = m.id;
      text.append(id);
      if (m.takenAt) {
        const when = document.createElement('small');
        when.textContent = m.takenAt.slice(11, 19);
        text.append(when);
      }
      row.append(text);
      row.addEventListener('click', () => {
        close();
        this.o.open(i);
      });
      box.append(row);
    }
    if (rows.length > LIST_MAX) {
      const more = document.createElement('div');
      more.className = 'more';
      more.textContent = t('stage.markers.more', { count: rows.length - LIST_MAX });
      box.append(more);
    }
    // beside the icon, kept inside the stage, over the other marker layers
    root.append(box);
    root.style.zIndex = '3';
    const W = root.clientWidth;
    const H = root.clientHeight;
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    const left = c.x + 16 + bw > W - 8 ? c.x - 16 - bw : c.x + 16;
    const top = Math.max(8, Math.min(H - bh - 8, c.y - 14));
    box.style.left = `${Math.round(Math.max(8, left))}px`;
    box.style.top = `${Math.round(top)}px`;
    box.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const away = (e: PointerEvent) => {
      if (!box.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const close = () => {
      box.remove();
      root.style.zIndex = '';
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc, true);
      if (this.closeList === close) this.closeList = null;
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc, true);
    this.closeList = close;
  }

  private el(k: number): MarkerEl {
    let m = this.pool[k];
    if (m) return m;
    const root = document.createElement('div');
    root.className = 'aio-mk';
    root.dataset.kind = this.o.kind;
    root.innerHTML = `<div class="aio-mk-p"><svg viewBox="0 0 20 20" aria-hidden="true">${GLYPH[this.o.kind]}</svg></div>`;
    const count = document.createElement('span');
    count.className = 'aio-mk-n';
    root.append(count);
    this.root?.insertBefore(root, this.tip);
    m = { root, count };
    this.pool.push(m);
    return m;
  }

  /** Project the sites, merge close ones and write the icons (only when the view changed). */
  private readonly layout = () => {
    const cam = this.o.scene.camera;
    const canvas = this.o.scene.renderer.domElement;
    let W = canvas.clientWidth;
    let H = canvas.clientHeight;
    if (!W || !H) {
      const r = canvas.getBoundingClientRect();
      W = r.width;
      H = r.height;
    }
    cam.updateMatrixWorld();
    const size = `${String(W)}x${String(H)}`;
    if (!this.dirty && size === this.lastSize && this.lastView.equals(cam.matrixWorld)) return;
    this.lastView.copy(cam.matrixWorld);
    this.lastSize = size;
    this.dirty = false;
    if (!this.visible) return;
    const pts: ScreenSite[] = [];
    this.o.sites.forEach((s, i) => {
      const v = this.v.set(s.pos[0], s.pos[1], s.pos[2]).project(cam);
      if (v.z > 1 || v.z < -1) return;
      const x = ((v.x + 1) / 2) * W;
      const y = ((1 - v.y) / 2) * H;
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) return;
      pts.push({ i, x, y, n: s.members.length });
    });
    const hoveredKey = this.clusters[this.hovered]?.sites[0];
    // merge icons that would overlap; a dense set (hundreds of places) merges wider still, so the
    // stage never carries more than MAX_ICONS of them and zooming in splits them up again
    let radius = CLUSTER_PX;
    this.clusters = clusterSites(pts, radius);
    while (this.clusters.length > MAX_ICONS && radius < 400) {
      radius *= 1.5;
      this.clusters = clusterSites(pts, radius);
    }
    // a panorama shot from where photos were taken: its icon steps aside, both stay readable
    if (this.o.kind === 'pano') {
      const photos = this.peers().filter((p) => p.o.kind === 'photo' && p.visible);
      for (const p of photos) p.layout();
      const taken = photos.flatMap((p) => p.clusters);
      for (const c of this.clusters)
        if (taken.some((t) => Math.hypot(t.x - c.x, t.y - c.y) < NUDGE_PX)) {
          // to the left: the photo icon's count badge sits on its right
          c.x -= NUDGE_PX + 6;
        }
    }
    this.hovered =
      hoveredKey === undefined ? -1 : this.clusters.findIndex((c) => c.sites[0] === hoveredKey);
    const root = this.root;
    if (!root) return;
    const sel = this.o.selected();
    this.clusters.forEach((c, k) => {
      const m = this.el(k);
      m.root.style.display = '';
      m.root.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
      const count = this.membersOf(c).length;
      const text = count > 1 ? String(count) : '';
      if (m.count.textContent !== text) m.count.textContent = text;
      m.count.style.display = count > 1 ? '' : 'none';
      m.root.dataset.count = String(count);
      m.root.classList.toggle('is-hover', k === this.hovered);
      m.root.classList.toggle('is-sel', sel.size > 0 && this.membersOf(c).some((i) => sel.has(i)));
    });
    for (let k = this.clusters.length; k < this.pool.length; k++) {
      const m = this.pool[k];
      if (m && m.root.style.display !== 'none') m.root.style.display = 'none';
    }
    const tip = this.tip;
    const hc = this.clusters[this.hovered];
    if (tip) {
      if (hc) {
        const [head, sub] = this.tipText(hc);
        tip.textContent = head;
        if (sub) {
          const i = document.createElement('i');
          i.textContent = sub;
          tip.append(i);
        }
        tip.style.display = '';
        // over the other marker layers' icons
        root.style.zIndex = '2';
        const right = hc.x + 18 + tip.offsetWidth < W - 8;
        const x = right ? hc.x + 18 : hc.x - 18 - tip.offsetWidth;
        tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(hc.y - tip.offsetHeight / 2)}px)`;
      } else {
        tip.style.display = 'none';
        root.style.zIndex = this.closeList ? '3' : '';
      }
    }
  };

  dispose() {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.closeList?.();
    this.root?.remove();
  }
}
