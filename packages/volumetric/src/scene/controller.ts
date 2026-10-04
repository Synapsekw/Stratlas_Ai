/**
 * The volumetric overlay in the 3D stage: volume bodies (lifted or in place) with their toe
 * lines and base plates, cut and fill bodies, the change or elevation colours draped on the
 * survey terrain, the survey swipe, the section line and the boundary being edited. It reads the
 * volumetric store, asks the worker for geometry and touches only its own group, the terrain
 * layers' materials (texture and clipping, restored afterwards) and the pile callout text.
 */
import type { EngineStage } from '@aio/engine';
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Plane,
  RGBAFormat,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
import type { StoreApi } from 'zustand/vanilla';
import type { ScenePile } from '../model/compute';
import type { EN } from '../model/edit';
import type { SurfaceMode, Volumetric } from '../store';
import { bodyGeometry, swipePlane, toLocalFn, type ToLocal } from './geometry';

const SELECT = 0x5ad2b4;
const EDIT = 0xffd23f;

type WithMap = Material & { map?: Texture | null };

/** Visible itself and through all its parents. */
function visibleChain(o: Object3D | null): boolean {
  for (let x = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

function disposeGroup(g: Object3D) {
  while (g.children.length) {
    const o = g.children.pop();
    o?.traverse((c) => {
      const m = c as Partial<Mesh>;
      m.geometry?.dispose();
      const mats = m.material;
      if (mats) for (const x of Array.isArray(mats) ? mats : [mats]) x.dispose();
    });
  }
}

function lineGeometry(pts: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(Float32Array.from(pts), 3));
  return g;
}

export class VolumetricScene {
  readonly group = new Group();
  private readonly bodies = new Group();
  private readonly sectionG = new Group();
  private readonly editG = new Group();
  private readonly unsub: (() => void)[] = [];
  private sceneKey = '';
  private sceneSeq = 0;
  private liveDrawn: unknown = null;
  private sectionDrawn: unknown = null;
  private readonly drapes = new Map<
    string,
    { mode: SurfaceMode; root: Object3D; group: Group; material: MeshStandardMaterial }
  >();
  private readonly pendingDrapes = new Set<string>();
  private readonly textures = new Map<string, Promise<Texture>>();
  private readonly savedClip = new Map<Material, Plane[] | null>();
  private readonly swipeRight = new Plane();
  private readonly swipeLeft = new Plane();
  private readonly clipRight: Plane[] = [];
  private readonly clipLeft: Plane[] = [];
  private calloutKey = '';
  private readonly frameListeners = new Set<() => void>();
  /** Edited ring vertex positions (local frame) while a handle is dragged. */
  private dragRing: { ring: EN[]; z: number[] } | null = null;

  constructor(
    readonly stage: EngineStage,
    private readonly store: StoreApi<Volumetric>,
  ) {
    this.group.name = 'volumetric';
    this.group.add(this.bodies, this.sectionG, this.editG);
  }

  /** Start drawing into the stage and following the store. */
  attach(): void {
    if (this.unsub.length) return;
    this.sceneKey = '';
    this.liveDrawn = null;
    this.sectionDrawn = null;
    this.calloutKey = '';
    this.stage.scene.add(this.group);
    this.unsub.push(
      this.store.subscribe(() => {
        this.update();
      }),
    );
    this.unsub.push(
      this.stage.onFrame(() => {
        this.reconcile();
        for (const l of this.frameListeners) l();
      }),
    );
    this.update();
  }

  /** Stop, remove everything drawn and give the terrain back its own look. */
  detach(): void {
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    this.sceneSeq++;
    this.restoreSurface();
    this.restoreClip();
    this.restoreCallouts();
    disposeGroup(this.bodies);
    disposeGroup(this.sectionG);
    disposeGroup(this.editG);
    this.stage.scene.remove(this.group);
    this.stage.requestRender();
  }

  /** Run after every rendered frame's update (handles follow the camera). */
  onFrame(cb: () => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  get local(): ToLocal {
    return toLocalFn(this.store.getState().origin);
  }

  /** Local-frame position of (E, N, H). */
  world(E: number, N: number, H: number): Vector3 {
    return new Vector3(...this.local(E, N, H));
  }

  private terrainRoot(epoch: string): Object3D | null {
    const id = this.store.getState().layers[epoch]?.terrain;
    return id ? (this.stage.scene.getObjectByName(`layer:${id}`) ?? null) : null;
  }

  /* ------------------------------------------------------------------ store changes */

  private update(): void {
    const s = this.store.getState();
    if (s.status !== 'ready' || !s.service) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.bodies.visible = !s.swipe;
    void this.updateBodies();
    this.updateEdit();
    void this.updateSection();
    this.stage.requestRender();
  }

  private async updateBodies(): Promise<void> {
    const s = this.store.getState();
    const svc = s.service;
    if (!svc) return;
    const chg = s.surface === 'change';
    const epoch = s.shownEpoch();
    const origin = s.origin;
    const piles = s.piles
      .filter((p) => p.id !== s.edit?.pile && (chg || p.epochs[epoch]))
      .map((p) => {
        const src = chg ? p.zoneRing : (p.epochs[epoch]?.ring ?? p.zoneRing);
        return {
          id: p.id,
          ring: src.map((q): EN => [q[0] + origin[0], origin[1] - q[1]]),
          edited: !chg && p.edited.includes(epoch),
        };
      });
    const req = {
      epoch,
      base: s.base,
      mode: chg ? ('chg' as const) : ('inv' as const),
      selected: s.selected,
      piles,
    };
    const key = JSON.stringify([req, s.body, !!s.edit]);
    if (key === this.sceneKey) return;
    this.sceneKey = key;
    const seq = ++this.sceneSeq;
    try {
      const r = await svc.scene(req);
      if (seq !== this.sceneSeq) return;
      this.drawBodies(r.piles, chg);
    } catch (e) {
      if (seq === this.sceneSeq)
        this.store.getState().setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  private drawBodies(piles: ScenePile[], chg: boolean): void {
    const s = this.store.getState();
    disposeGroup(this.bodies);
    const local = this.local;
    const clip = this.stage.clippingPlanes;
    const editing = !!s.edit;
    const lifted = s.body === 'lift' && !editing;
    for (const p of piles) {
      const sel = p.id === s.selected;
      const dim = (!!s.selected && !sel) || editing;
      const g = new Group();
      g.name = `vol:${p.id}`;
      g.userData.pile = p.id;
      let lift = 0;
      if (p.body && s.body !== 'off') {
        const geo = bodyGeometry(p.body, local, { lifted, change: chg });
        lift = geo.lift;
        const top = new BufferGeometry();
        top.setAttribute('position', new BufferAttribute(geo.top, 3));
        if (geo.colors) top.setAttribute('color', new BufferAttribute(geo.colors, 3));
        top.setIndex(new BufferAttribute(geo.index, 1));
        top.computeVertexNormals();
        const topMesh = new Mesh(
          top,
          new MeshLambertMaterial({
            color: chg ? 0xffffff : 0xff4d4d,
            vertexColors: chg,
            transparent: true,
            opacity: dim ? 0.28 : lifted ? 0.62 : 0.5,
            depthWrite: false,
            side: DoubleSide,
            clippingPlanes: clip,
          }),
        );
        topMesh.renderOrder = 3;
        topMesh.name = 'body-top';
        g.add(topMesh);
        // the base plate: under a lifted body, or seen through the pile when selected in place
        if (lifted || (sel && !chg)) {
          const bot = new BufferGeometry();
          bot.setAttribute('position', new BufferAttribute(geo.bottom, 3));
          bot.setIndex(new BufferAttribute(geo.index, 1));
          const plate = new Mesh(
            bot,
            new MeshBasicMaterial({
              color: 0xe6ebf2,
              transparent: true,
              opacity: dim ? 0.14 : lifted ? 0.3 : 0.22,
              depthWrite: false,
              depthTest: lifted,
              side: DoubleSide,
              clippingPlanes: clip,
            }),
          );
          plate.renderOrder = 2;
          plate.name = 'base-plate';
          g.add(plate);
        }
        if (geo.hatch.length) {
          const hg = lineGeometry([...geo.hatch]);
          if (geo.hatchColors) hg.setAttribute('color', new BufferAttribute(geo.hatchColors, 3));
          const hl = new LineSegments(
            hg,
            new LineBasicMaterial({
              color: geo.hatchColors ? 0xffffff : 0xff2a2a,
              vertexColors: !!geo.hatchColors,
              transparent: true,
              opacity: dim ? 0.18 : 0.5,
              depthWrite: false,
              clippingPlanes: clip,
            }),
          );
          hl.renderOrder = 4;
          g.add(hl);
        }
      }
      // toe line on the ground, the base outline under a lifted body and posts between them
      const toe: number[] = [];
      for (let i = 0; i + 2 < p.toe.length; i += 3)
        toe.push(
          ...local(p.toe[i] ?? 0, p.toe[i + 1] ?? 0, (p.toe[i + 2] ?? 0) + (sel ? 0.35 : 0.25)),
        );
      if (toe.length > 6) {
        const tl = new LineLoop(
          lineGeometry(toe),
          new LineBasicMaterial({
            color: sel ? SELECT : 0xffffff,
            transparent: true,
            opacity: dim ? 0.45 : 0.95,
            depthWrite: false,
            depthTest: !sel,
            clippingPlanes: clip,
          }),
        );
        tl.renderOrder = sel ? 7 : 5;
        tl.name = sel ? 'toe-selected' : 'toe';
        g.add(tl);
      }
      if (lifted && p.toeBase && lift > 0 && toe.length > 6) {
        const bl: number[] = [];
        const posts: number[] = [];
        const n = p.toeBase.length;
        const every = Math.max(1, Math.round(n / 28));
        for (let k = 0; k < n; k++) {
          const E = p.toe[k * 3] ?? 0;
          const N = p.toe[k * 3 + 1] ?? 0;
          const b = local(E, N, (p.toeBase[k] ?? 0) + lift);
          bl.push(...b);
          if (k % every === 0) posts.push(...local(E, N, (p.toe[k * 3 + 2] ?? 0) + 0.25), ...b);
        }
        const outline = new LineLoop(
          lineGeometry(bl),
          new LineBasicMaterial({
            color: 0x7d86ff,
            transparent: true,
            opacity: dim ? 0.35 : 0.95,
            depthWrite: false,
            clippingPlanes: clip,
          }),
        );
        outline.renderOrder = 5;
        g.add(outline);
        const pl = new LineSegments(
          lineGeometry(posts),
          new LineBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: dim ? 0.35 : 0.9,
            depthWrite: false,
            clippingPlanes: clip,
          }),
        );
        pl.renderOrder = 5;
        g.add(pl);
      }
      this.bodies.add(g);
    }
    this.stage.requestRender();
  }

  private updateEdit(): void {
    const ed = this.store.getState().edit;
    const live = ed?.live ?? null;
    if (live === this.liveDrawn && !this.dragRing) return;
    this.liveDrawn = live;
    disposeGroup(this.editG);
    if (!ed) return;
    const local = this.local;
    const clip = this.stage.clippingPlanes;
    if (live) {
      const b = live.body;
      if (b.tmax > -Infinity && b.ins.some((v) => v === 1)) {
        const geo = bodyGeometry(b, local, { lifted: false, change: false });
        const top = new BufferGeometry();
        top.setAttribute('position', new BufferAttribute(geo.top, 3));
        top.setIndex(new BufferAttribute(geo.index, 1));
        top.computeVertexNormals();
        const m = new Mesh(
          top,
          new MeshLambertMaterial({
            color: 0xff4d4d,
            transparent: true,
            opacity: 0.45,
            depthWrite: false,
            side: DoubleSide,
            clippingPlanes: clip,
          }),
        );
        m.renderOrder = 3;
        this.editG.add(m);
        const bot = new BufferGeometry();
        bot.setAttribute('position', new BufferAttribute(geo.bottom, 3));
        bot.setIndex(new BufferAttribute(geo.index, 1));
        const plate = new Mesh(
          bot,
          new MeshBasicMaterial({
            color: 0xe6ebf2,
            transparent: true,
            opacity: 0.2,
            depthWrite: false,
            depthTest: false,
            side: DoubleSide,
            clippingPlanes: clip,
          }),
        );
        plate.renderOrder = 2;
        plate.name = 'base-plate';
        this.editG.add(plate);
      }
    }
    this.drawEditLine();
  }

  /** The yellow line of the edited toe, from the live result or the ring being dragged. */
  private drawEditLine(): void {
    for (const c of [...this.editG.children]) {
      if (c.name !== 'edit-line') continue;
      this.editG.remove(c);
      (c as Line).geometry.dispose();
      ((c as Line).material as Material).dispose();
    }
    const ed = this.store.getState().edit;
    if (!ed) return;
    const local = this.local;
    const pts: number[] = [];
    if (this.dragRing) {
      const { ring, z } = this.dragRing;
      ring.forEach(([E, N], k) => {
        const a = z[k] ?? 0;
        const next = ring[(k + 1) % ring.length];
        const bz = z[(k + 1) % ring.length] ?? a;
        if (!next) return;
        for (const t of [0, 0.5])
          pts.push(...local(E + (next[0] - E) * t, N + (next[1] - N) * t, a + (bz - a) * t + 0.4));
      });
    } else if (ed.live) {
      const t = ed.live.toe;
      for (let i = 0; i + 2 < t.length; i += 3)
        pts.push(...local(t[i] ?? 0, t[i + 1] ?? 0, (t[i + 2] ?? 0) + 0.4));
    }
    if (pts.length < 6) return;
    const l = new LineLoop(
      lineGeometry(pts),
      new LineBasicMaterial({ color: EDIT, depthTest: false, transparent: true }),
    );
    l.renderOrder = 9;
    l.name = 'edit-line';
    this.editG.add(l);
    this.stage.requestRender();
  }

  /** While a handle is dragged: the ring and vertex heights to draw (null when it is let go). */
  setDragRing(d: { ring: EN[]; z: number[] } | null): void {
    this.dragRing = d;
    this.drawEditLine();
  }

  private async updateSection(): Promise<void> {
    const s = this.store.getState();
    const sec = s.section;
    if (sec === this.sectionDrawn) return;
    this.sectionDrawn = sec;
    disposeGroup(this.sectionG);
    this.stage.requestRender();
    if (sec.mode === 'idle' || !s.service) return;
    const epoch = s.shownEpoch();
    const line =
      sec.points.length === 2 ? [...densifyOpen(sec.points[0], sec.points[1], 0.5)] : sec.points;
    const hs = await s.service.heights(epoch, null, [...sec.points, ...line]).catch(() => null);
    if (!hs || this.store.getState().section !== sec) return;
    const local = this.local;
    sec.points.forEach(([E, N], k) => {
      const z = hs[k] ?? 0;
      const m = new Mesh(
        new SphereGeometry(0.9, 16, 12),
        new MeshBasicMaterial({ color: 0xbc0000, depthTest: false }),
      );
      m.position.set(...local(E, N, z + 0.9));
      m.renderOrder = 8;
      this.sectionG.add(m);
    });
    const lp: number[] = [];
    line.forEach(([E, N], k) => {
      const z = hs[sec.points.length + k];
      if (z != null) lp.push(...local(E, N, z + 0.35));
    });
    if (lp.length >= 6) {
      const l = new Line(
        lineGeometry(lp),
        new LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }),
      );
      l.renderOrder = 8;
      this.sectionG.add(l);
    }
    this.stage.requestRender();
  }

  /* ------------------------------------------------------------------ per frame */

  /** Apply what depends on loaded layers: surface colours, swipe clipping, callout text. */
  private reconcile(): void {
    this.reconcileSurface();
    this.reconcileSwipe();
    this.reconcileCallouts();
  }

  /** Which survey drapes are wanted: both photos while swiping, else the shown survey. */
  private wantedDrapes(): Map<string, SurfaceMode> {
    const s = this.store.getState();
    const epochs = s.file?.captures.map((c) => c.epoch) ?? [];
    const first = epochs[0];
    const last = epochs.at(-1);
    if (s.swipe && first && last && first !== last)
      return new Map<string, SurfaceMode>([
        [first, 'photo'],
        [last, 'photo'],
      ]);
    return new Map<string, SurfaceMode>([[s.shownEpoch(), s.surface]]);
  }

  /**
   * The survey texture (photo, change or relief) draped over the terrain: a copy of the terrain
   * meshes that keep their texture coordinates, drawn just in front of the terrain.
   */
  private reconcileSurface(): void {
    const want = this.wantedDrapes();
    for (const [epoch, d] of this.drapes) {
      const root = this.terrainRoot(epoch);
      if (want.get(epoch) !== d.mode || root !== d.root) this.removeDrape(epoch);
      else d.group.visible = visibleChain(root);
    }
    for (const [epoch, mode] of want) {
      if (this.drapes.has(epoch) || this.pendingDrapes.has(epoch)) continue;
      const root = this.terrainRoot(epoch);
      if (root) this.buildDrape(epoch, mode, root);
    }
  }

  private surfaceTexture(
    epoch: string,
    mode: SurfaceMode,
    root: Object3D,
  ): Promise<Texture | null> {
    if (mode === 'photo') {
      let map: Texture | null = null;
      root.traverse((o) => {
        const m = (o as Partial<Mesh>).material as WithMap | undefined;
        if (!map && m && !Array.isArray(m) && m.map) map = m.map;
      });
      return Promise.resolve(map);
    }
    const key = mode === 'change' ? 'change' : `elev/${epoch}`;
    let p = this.textures.get(key);
    if (!p) {
      const svc = this.store.getState().service;
      if (!svc) return Promise.resolve(null);
      const r = mode === 'change' ? svc.changeRaster() : svc.reliefRaster(epoch);
      p = r.then((raster) => {
        const tex = new DataTexture(
          new Uint8Array(raster.data.buffer.slice(0)),
          raster.width,
          raster.height,
          RGBAFormat,
        );
        tex.flipY = false;
        tex.colorSpace = SRGBColorSpace;
        tex.magFilter = LinearFilter;
        tex.minFilter = LinearFilter;
        tex.generateMipmaps = false;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        return tex;
      });
      p.catch(() => this.textures.delete(key));
      this.textures.set(key, p);
    }
    return p;
  }

  private buildDrape(epoch: string, mode: SurfaceMode, root: Object3D): void {
    this.pendingDrapes.add(epoch);
    void this.surfaceTexture(epoch, mode, root).then(
      (tex) => {
        this.pendingDrapes.delete(epoch);
        if (!tex || !this.unsub.length) return;
        if (this.wantedDrapes().get(epoch) !== mode || this.terrainRoot(epoch) !== root) return;
        const material = new MeshStandardMaterial({
          map: tex,
          roughness: 1,
          metalness: 0,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
          clippingPlanes: this.stage.clippingPlanes,
        });
        const group = new Group();
        group.name = `drape:${epoch}`;
        root.updateMatrixWorld(true);
        root.traverse((o) => {
          const m = o as Partial<Mesh>;
          if (!m.isMesh || !m.geometry || o.userData.aioMerged === true) return;
          if (!m.geometry.hasAttribute('uv')) return;

          const d = new Mesh(m.geometry, material);
          d.matrixAutoUpdate = false;
          d.matrix.copy(o.matrixWorld);
          d.receiveShadow = true;
          group.add(d);
        });
        group.visible = visibleChain(root);
        this.group.add(group);
        this.drapes.set(epoch, { mode, root, group, material });
        this.stage.requestRender();
      },
      (e: unknown) => {
        this.pendingDrapes.delete(epoch);
        this.store.getState().setMessage(e instanceof Error ? e.message : String(e));
      },
    );
  }

  private removeDrape(epoch: string): void {
    const d = this.drapes.get(epoch);
    if (!d) return;
    this.group.remove(d.group);
    d.material.dispose();
    this.drapes.delete(epoch);
    this.stage.requestRender();
  }

  private restoreSurface(): void {
    for (const epoch of [...this.drapes.keys()]) this.removeDrape(epoch);
    this.pendingDrapes.clear();
    for (const p of this.textures.values())
      void p.then(
        (t) => {
          t.dispose();
        },
        () => undefined,
      );
    this.textures.clear();
  }

  private reconcileSwipe(): void {
    const s = this.store.getState();
    const epochs = s.file?.captures.map((c) => c.epoch) ?? [];
    const first = epochs[0];
    const last = epochs.at(-1);
    if (!s.swipe || !first || !last || first === last) {
      if (this.savedClip.size) this.restoreClip();
      for (const d of this.drapes.values())
        if (d.material.clippingPlanes !== this.stage.clippingPlanes) {
          d.material.clippingPlanes = this.stage.clippingPlanes;
          d.material.needsUpdate = true;
        }
      return;
    }
    swipePlane(this.stage.camera, s.swipeX, this.swipeRight);
    this.swipeLeft.copy(this.swipeRight).negate();
    const sec = this.stage.clippingPlanes;
    for (const [arr, plane] of [
      [this.clipLeft, this.swipeLeft],
      [this.clipRight, this.swipeRight],
    ] as const) {
      arr.length = 0;
      arr.push(...sec, plane);
    }
    for (const [epoch, arr] of [
      [first, this.clipLeft],
      [last, this.clipRight],
    ] as const) {
      const drape = this.drapes.get(epoch);
      if (drape && drape.material.clippingPlanes !== arr) {
        drape.material.clippingPlanes = arr;
        drape.material.needsUpdate = true;
      }
      this.terrainRoot(epoch)?.traverse((o) => {
        const m = o as Partial<Mesh>;
        if (!m.material) return;
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          if (!this.savedClip.has(mat)) this.savedClip.set(mat, mat.clippingPlanes);
          if (mat.clippingPlanes !== arr) {
            mat.clippingPlanes = arr;
            mat.needsUpdate = true;
          }
        }
      });
    }
  }

  private restoreClip(): void {
    for (const [mat, planes] of this.savedClip) {
      mat.clippingPlanes = planes;
      mat.needsUpdate = true;
    }
    this.savedClip.clear();
    this.stage.requestRender();
  }

  /** Pile callouts show the net volume on the chosen base, edits included. */
  private reconcileCallouts(): void {
    const s = this.store.getState();
    const roots = Object.entries(s.layers)
      .map(
        ([e, l]) =>
          [
            e,
            l.terrain ? this.stage.scene.getObjectByName(`layer:${l.terrain}`) : undefined,
          ] as const,
      )
      .filter((x): x is readonly [string, Object3D] => x[1] !== undefined);
    const key = JSON.stringify([
      s.base,
      s.edits.length,
      s.edits.map((e) => e.updatedAt),
      roots.map((r) => r[1].uuid),
    ]);
    if (key === this.calloutKey) return;
    this.calloutKey = key;
    const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
    for (const [epoch, group] of roots) {
      group.traverse((o) => {
        const tags = o.userData.aioTags as
          { node: string; tag: string; area?: string }[] | undefined;
        if (!Array.isArray(tags)) return;
        o.userData.aioTagsOriginal ??= tags as unknown;
        o.userData.aioTags = tags.map((t) => {
          const p = s.piles.find((q) => q.id === t.tag);
          const v = p?.epochs[epoch]?.volumes[s.base].net;
          return v === undefined ? t : { ...t, area: `${nf.format(Math.round(v))} m³` };
        });
      });
    }
    const mode = this.stage.labelMode;
    this.stage.setLabelMode(mode === 'off' ? 'key' : 'off');
    this.stage.setLabelMode(mode);
  }

  private restoreCallouts(): void {
    this.stage.scene.traverse((o) => {
      const original: unknown = o.userData.aioTagsOriginal;
      if (original) {
        o.userData.aioTags = original;
        delete o.userData.aioTagsOriginal;
      }
    });
  }
}

/** Points every `step` metres from a to b, both ends included. */
function* densifyOpen(a: EN | undefined, b: EN | undefined, step: number): Generator<EN> {
  if (!a || !b) return;
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
  for (let k = 0; k <= n; k++)
    yield [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
}
