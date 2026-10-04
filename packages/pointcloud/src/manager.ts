import type { SceneHandle } from '@aio/engine';
import {
  BufferAttribute,
  BufferGeometry,
  Frustum,
  Group,
  Matrix4,
  Points,
  Sphere,
  Vector2,
  Vector3,
} from 'three';
import type { StoreApi } from 'zustand/vanilla';
import type { CopcNodeInfo, CopcPage, CopcSource } from './copc';
import type { LasLayout } from './copcDecode';
import { copcChunkSeeds } from './copcLayer';
import type { Bounds3, Quantisation } from './decode';
import { EdlPass } from './edl';
import { robustHeightRange, type HeightSample, type HeightStats } from './heights';
import {
  FLIGHT_PALETTE,
  MODE_INDEX,
  applyHiddenClasses,
  createPointMaterial,
  type PointMaterial,
} from './material';
import { parentKey, selectNodes, type LodNode, type Plane4 } from './octree';
import type { Decoder } from './pool';
import type { DecodedChunk } from './protocol';
import type { PointcloudSettings } from './settings';
import { pointcloudStats } from './stats';

type V3 = readonly [number, number, number];

export type ChunkSource =
  | { kind: 'kit'; url: string; scale: number }
  | { kind: 'png'; url: string; quant: Quantisation }
  | {
      kind: 'copc';
      url: string;
      node: CopcNodeInfo;
      layout: LasLayout;
      /** Project origin [E, N, H] in the file CRS. */
      origin: V3;
      /** Node box in the local frame (the quantisation range). */
      box: { min: V3; max: V3 };
    };

export interface ChunkState {
  key: string;
  source: ChunkSource;
  points: number;
  bounds: Bounds3;
  lod: number;
  object: Points | null;
  busy: boolean;
  failed: boolean;
  /** Octree: keys of the child chunks. */
  children?: string[];
  /** Octree: point spacing of the node, metres. */
  spacing?: number;
  /** Octree placeholder: the hierarchy page that holds this node. */
  page?: CopcPage;
  /** Points per class (COPC), once decoded. */
  classes?: Record<number, number>;
  /** A sample of the chunk's point heights (local Y), once decoded; kept after unloading. */
  heights?: Float32Array;
}

export type ChunkSeed = Omit<ChunkState, 'object' | 'busy' | 'failed'>;

/** A COPC layer's file, header and frame, for loading further hierarchy pages. */
export interface CopcLayerInfo {
  url: string;
  source: CopcSource;
  origin: V3;
}

export interface CloudLayerState {
  id: string;
  group: Group;
  chunks: ChunkState[];
  byKey: Map<string, ChunkState>;
  material: PointMaterial | null;
  tint: string;
  baseSize: number;
  hasRgb: boolean;
  hasIntensity: boolean;
  hasClass: boolean;
  /** RGB expected from the format before any chunk is decoded (png-packed carries colour). */
  rgbHint: boolean;
  visible: boolean;
  copc: CopcLayerInfo | null;
  pagesLoading: Set<string>;
}

const MAX_INFLIGHT = 8;
/** Refine an octree node while its spacing projects to more than this many pixels. */
const REFINE_PX = 1.5;

const nodeKeyOf = (chunkKey: string) => chunkKey.slice(chunkKey.lastIndexOf('#') + 1);

/** All clouds of one SceneHandle: shared budget, LOD, EDL and per-frame uniforms. */
export class CloudManager {
  readonly layers = new Map<string, CloudLayerState>();
  /** Parent of every cloud group; lives in the main scene or in the EDL scene. */
  readonly root = new Group();
  private edl: EdlPass | null = null;
  private inflight = 0;
  private dirty = true;
  private created = 0;
  private readonly lastView = new Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  private readonly viewProj = new Matrix4();
  private readonly frustum = new Frustum();
  private readonly bufferSize = new Vector2();
  private readonly unsubscribers: (() => void)[] = [];
  private decoder: Decoder | null = null;
  private pxPerM = 800;
  private sizeScale = 1;
  /** Automatic elevation range; recomputed when `heightsDirty`. */
  private heights: HeightStats | null = null;
  private heightsDirty = true;

  constructor(
    readonly handle: SceneHandle,
    private readonly makeDecoder: () => Decoder,
    readonly settings: StoreApi<PointcloudSettings>,
  ) {
    this.root.name = 'PointClouds';
    this.unsubscribers.push(
      handle.onFrame(() => {
        this.frame();
      }),
    );
    this.unsubscribers.push(
      settings.subscribe((s, prev) => {
        if (s.edl !== prev.edl) this.placeRoot();
        if (s.budget !== prev.budget) this.dirty = true;
        if (s.hiddenClasses !== prev.hiddenClasses) {
          for (const l of this.layers.values())
            if (l.material) applyHiddenClasses(l.material, s.hiddenClasses);
        }
        handle.requestRender();
      }),
    );
    this.placeRoot();
  }

  /** The scene's decoder (a worker pool), created on first use. */
  getDecoder(): Decoder {
    this.decoder ??= this.makeDecoder();
    return this.decoder;
  }

  private placeRoot(): void {
    const s = this.settings.getState();
    if (s.edl) {
      if (!this.edl) {
        const caps = (
          this.handle.renderer as { capabilities?: { logarithmicDepthBuffer?: boolean } }
        ).capabilities;
        this.edl = new EdlPass(caps?.logarithmicDepthBuffer === true);
      }
      this.edl.cloudScene.add(this.root);
      this.handle.scene.add(this.edl.quad);
    } else {
      this.edl?.quad.removeFromParent();
      this.handle.scene.add(this.root);
    }
  }

  addLayer(
    id: string,
    chunks: ChunkSeed[],
    baseSize: number,
    rgbHint = false,
    copc: CopcLayerInfo | null = null,
  ) {
    const group = new Group();
    group.name = `pointcloud:${id}`;
    group.userData.layerId = id;
    this.root.add(group);
    const states = chunks.map((c) => ({ ...c, object: null, busy: false, failed: false }));
    const layer: CloudLayerState = {
      id,
      group,
      chunks: states,
      byKey: new Map(states.map((c) => [c.key, c])),
      material: null,
      tint: FLIGHT_PALETTE[this.created++ % FLIGHT_PALETTE.length] ?? '#5ab0ff',
      baseSize,
      hasRgb: false,
      hasIntensity: false,
      hasClass: false,
      rgbHint,
      visible: true,
      copc,
      pagesLoading: new Set(),
    };
    this.layers.set(id, layer);
    this.dirty = true;
    this.heightsDirty = true;
    this.updateStats();
    this.handle.requestRender();
    return layer;
  }

  setVisible(id: string, visible: boolean): void {
    const l = this.layers.get(id);
    if (!l) return;
    l.visible = visible;
    l.group.visible = visible;
    this.dirty = true;
    this.heightsDirty = true;
    this.handle.requestRender();
  }

  removeLayer(id: string): void {
    const l = this.layers.get(id);
    if (!l) return;
    for (const c of l.chunks) this.unloadChunk(c);
    l.material?.dispose();
    l.group.removeFromParent();
    this.layers.delete(id);
    this.heightsDirty = true;
    this.updateStats();
    this.handle.requestRender();
  }

  get empty(): boolean {
    return this.layers.size === 0;
  }

  /** Runs before every rendered frame. */
  private frame(): void {
    const s = this.settings.getState();
    const cam = this.handle.camera;
    const r = this.handle.renderer;
    const buf = r.getDrawingBufferSize(this.bufferSize);
    const pxPerM = buf.y / (2 * Math.tan((cam.fov * Math.PI) / 360));
    this.pxPerM = pxPerM;
    this.sizeScale = s.sizeScale;
    const maxPx = s.maxPixels * r.getPixelRatio();
    // one range for every node of every cloud: the user's, else the clouds' robust range
    const [hMin, hMax] = s.heightRange ?? this.heightRange() ?? [0, 10];
    for (const l of this.layers.values()) {
      const m = l.material;
      if (!m) continue;
      m.uniforms.uSize.value = l.baseSize * s.sizeScale;
      m.uniforms.uPxPerM.value = pxPerM;
      m.uniforms.uMaxPx.value = maxPx;
      m.uniforms.uMode.value = MODE_INDEX[s.colourMode];
      m.uniforms.uHeight.value.set(hMin, hMax);
    }
    if (this.edl) this.edl.strength = s.edlStrength;

    cam.updateMatrixWorld();
    this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    if (!matricesClose(this.viewProj, this.lastView)) this.dirty = true;
    if (this.dirty) {
      this.dirty = false;
      this.lastView.copy(this.viewProj);
      const eye = cam.getWorldPosition(new Vector3());
      this.frustum.setFromProjectionMatrix(this.viewProj);
      const planes: Plane4[] = this.frustum.planes.map((p) => [
        p.normal.x,
        p.normal.y,
        p.normal.z,
        p.constant,
      ]);
      this.update([eye.x, eye.y, eye.z], s.budget, planes);
    }
  }

  /**
   * Automatic elevation range of the visible clouds, local Y (the frame the shader colours):
   * the 1st to 99th percentile of the point heights sampled from each cloud's coarsest decoded
   * level (the octree root, the overview chunk, a whole kit cloud). That level spans the whole
   * cloud, stays loaded, and keeps the colours from shifting as finer nodes stream in. COPC node
   * boxes are octree cubes, far taller than the points, so they never set the range.
   */
  heightStats(): HeightStats | null {
    if (!this.heightsDirty) return this.heights;
    this.heightsDirty = false;
    const samples: HeightSample[] = [];
    for (const l of this.layers.values()) {
      if (!l.visible) continue;
      let top = Infinity;
      for (const c of l.chunks) if (c.heights?.length && c.lod < top) top = c.lod;
      for (const c of l.chunks) {
        if (c.lod !== top || !c.heights?.length) continue;
        samples.push({ heights: c.heights, weight: Math.max(c.points, 1) / c.heights.length });
      }
    }
    this.heights = robustHeightRange(samples);
    return this.heights;
  }

  /** The automatic elevation range (see heightStats); null before any cloud is decoded. */
  heightRange(): [number, number] | null {
    return this.heightStats()?.range ?? null;
  }

  private update(eye: [number, number, number], budget: number, frustum: Plane4[]): void {
    const owner = new Map<string, CloudLayerState>();
    const nodes: LodNode[] = [];
    for (const l of this.layers.values()) {
      for (const c of l.chunks) {
        if (!l.visible) {
          if (c.lod > 0 && c.object) this.unloadChunk(c);
          continue;
        }
        if (c.failed) continue;
        owner.set(c.key, l);
        const n: LodNode = {
          key: c.key,
          points: c.points,
          bounds: c.bounds,
          root: c.lod === 0,
          loaded: c.object !== null || c.busy,
        };
        if (c.children) n.children = c.children;
        if (c.spacing !== undefined) n.spacing = c.spacing;
        if (c.page) n.page = true;
        nodes.push(n);
      }
    }
    const sel = selectNodes(nodes, eye, {
      budget,
      pxPerM: this.pxPerM,
      minPx: REFINE_PX,
      frustum,
    });
    for (const key of sel.unload) {
      const c = owner.get(key)?.byKey.get(key);
      if (c && !c.busy) this.unloadChunk(c);
    }
    for (const key of sel.pages) {
      const l = owner.get(key);
      const c = l?.byKey.get(key);
      if (l && c) this.loadPage(l, c);
    }
    for (const key of sel.load) {
      if (this.inflight >= MAX_INFLIGHT) {
        this.dirty = true; // come back next frame
        break;
      }
      const c = owner.get(key)?.byKey.get(key);
      if (c) this.loadChunk(c);
    }
    this.updateSizes();
    this.updateStats();
  }

  /** Octree point size: the spacing of the deepest loaded node under each node (Potree's adaptive size). */
  private updateSizes(): void {
    for (const l of this.layers.values()) {
      if (!l.copc) continue;
      const deepest = new Map<string, number>();
      for (const c of l.chunks) {
        if (!c.object) continue;
        for (let k: string | null = nodeKeyOf(c.key); k; k = parentKey(k)) {
          const d = deepest.get(k);
          if (d !== undefined && d >= c.lod) break;
          deepest.set(k, c.lod);
        }
      }
      const s0 = l.copc.source.spacing;
      for (const c of l.chunks) {
        if (!c.object) continue;
        const d = deepest.get(nodeKeyOf(c.key)) ?? c.lod;
        c.object.userData.size = s0 / 2 ** d;
      }
    }
  }

  private loadPage(l: CloudLayerState, c: ChunkState): void {
    const info = l.copc;
    const page = c.page;
    const dec = this.getDecoder();
    if (!info || !page || l.pagesLoading.has(c.key) || !dec.copcPage) return;
    l.pagesLoading.add(c.key);
    dec
      .copcPage(info.url, page)
      .then((h) => {
        if (this.layers.get(l.id) !== l) return;
        for (const seed of copcChunkSeeds(l.id, info.url, info.source, h, info.origin)) {
          const existing = l.byKey.get(seed.key);
          if (existing) {
            if (!existing.page) continue;
            delete existing.page;
            Object.assign(existing, seed);
          } else {
            const s: ChunkState = { ...seed, object: null, busy: false, failed: false };
            l.chunks.push(s);
            l.byKey.set(s.key, s);
          }
        }
      })
      .catch((e: unknown) => {
        c.failed = true;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Point cloud hierarchy page ${c.key} could not be loaded: ${msg}`);
        pointcloudStats.getState().addError(`${c.key}: ${msg}`);
      })
      .finally(() => {
        l.pagesLoading.delete(c.key);
        this.dirty = true;
        this.updateStats();
        this.handle.requestRender();
      });
  }

  private layerOf(c: ChunkState): CloudLayerState | undefined {
    for (const l of this.layers.values()) if (l.byKey.get(c.key) === c) return l;
    return undefined;
  }

  private loadChunk(c: ChunkState): void {
    const dec = this.getDecoder();
    c.busy = true;
    this.inflight++;
    const src = c.source;
    const job =
      src.kind === 'kit'
        ? { kind: 'kit' as const, url: src.url, scale: src.scale }
        : src.kind === 'png'
          ? { kind: 'png' as const, url: src.url, points: c.points, quant: src.quant }
          : {
              kind: 'copc' as const,
              url: src.url,
              node: src.node,
              layout: src.layout,
              origin: src.origin,
              box: src.box,
            };
    dec
      .decode(job)
      .then((d) => {
        c.busy = false;
        this.inflight--;
        const l = this.layerOf(c);
        if (!l) return;
        this.attach(l, c, d);
      })
      .catch((e: unknown) => {
        c.busy = false;
        c.failed = true;
        this.inflight--;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Point cloud chunk ${c.key} could not be loaded: ${msg}`);
        pointcloudStats.getState().addError(`${c.key}: ${msg}`);
      })
      .finally(() => {
        this.dirty = true;
        this.updateSizes();
        this.updateStats();
        this.handle.requestRender();
      });
  }

  private attach(l: CloudLayerState, c: ChunkState, d: DecodedChunk): void {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(d.position, 3));
    if (d.rgb) geo.setAttribute('aRgb', new BufferAttribute(d.rgb, 3, true));
    if (d.intensity) geo.setAttribute('aIntensity', new BufferAttribute(d.intensity, 1, true));
    if (d.classification) geo.setAttribute('aClass', new BufferAttribute(d.classification, 1));
    if (
      !l.material ||
      l.hasRgb !== !!d.rgb ||
      l.hasIntensity !== !!d.intensity ||
      l.hasClass !== !!d.classification
    ) {
      l.hasRgb = !!d.rgb;
      l.hasIntensity = !!d.intensity;
      l.hasClass = !!d.classification;
      l.material?.dispose();
      l.material = createPointMaterial({
        hasRgb: l.hasRgb,
        hasIntensity: l.hasIntensity,
        hasClass: l.hasClass,
        baseSize: l.baseSize,
        tint: l.tint,
      });
      applyHiddenClasses(l.material, this.settings.getState().hiddenClasses);
      // the section tool cuts meshes and clouds together through this shared array
      l.material.clippingPlanes = this.handle.clippingPlanes;
      for (const o of l.chunks) if (o.object) o.object.material = l.material;
    }
    const pts = new Points(geo, l.material);
    pts.name = `pointcloud:${l.id}:${c.key}`;
    pts.userData.layerId = l.id;
    pts.userData.chunk = c.key;
    pts.matrixAutoUpdate = false;
    const src = c.source;
    if (src.kind === 'kit') {
      pts.scale.setScalar(src.scale);
    } else {
      const q = src.kind === 'png' ? src.quant : d.quant;
      if (q) {
        pts.position.set(q.offset[0], q.offset[1], q.offset[2]);
        pts.scale.set(q.scale[0], q.scale[1], q.scale[2]);
      }
    }
    if (src.kind === 'copc') {
      // octree nodes draw at the spacing of their deepest loaded descendant (updateSizes)
      pts.userData.size = c.spacing ?? l.baseSize;
      pts.onBeforeRender = () => {
        const m = pts.material;
        m.uniforms.uSize.value = (pts.userData.size as number) * this.sizeScale;
        m.uniformsNeedUpdate = true;
      };
    }
    pts.updateMatrix();
    // The bounding sphere in local (quantised) units, from the decoded bounds.
    const inv = pts.matrix.clone().invert();
    const lo = new Vector3(...d.bounds.min).applyMatrix4(inv);
    const hi = new Vector3(...d.bounds.max).applyMatrix4(inv);
    geo.boundingSphere = new Sphere(lo.clone().add(hi).multiplyScalar(0.5), lo.distanceTo(hi) / 2);
    // octree LOD keeps the node box; flat chunks switch to their tight bounds
    if (src.kind !== 'copc') c.bounds = d.bounds;
    c.points = d.count;
    if (d.classes) c.classes = d.classes;
    if (d.heights?.length) {
      c.heights = d.heights;
      this.heightsDirty = true;
    }
    c.object = pts;
    l.group.add(pts);
  }

  private unloadChunk(c: ChunkState): void {
    if (!c.object) return;
    c.object.removeFromParent();
    c.object.geometry.dispose();
    c.object = null;
  }

  private updateStats(): void {
    let loaded = 0;
    let total = 0;
    let loading = 0;
    let rgb = false;
    let classes: Record<number, number> | null = null;
    for (const l of this.layers.values()) {
      if (l.material ? l.hasRgb : l.rgbHint) rgb = true;
      if (l.copc) total += l.copc.source.pointCount;
      for (const c of l.chunks) {
        if (!l.copc) total += c.points;
        if (c.object && l.visible) {
          loaded += c.points;
          if (c.classes) {
            classes ??= {};
            for (const [k, n] of Object.entries(c.classes)) classes[+k] = (classes[+k] ?? 0) + n;
          }
        }
        if (c.busy) loading++;
      }
    }
    pointcloudStats.getState().setCounts(this.handle, {
      loaded,
      total,
      loading,
      layers: this.layers.size,
      rgb,
      heightRange: this.heightRange(),
      heightExtent: this.heightStats()?.extent ?? null,
      classes,
    });
  }

  dispose(): void {
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    for (const u of this.unsubscribers) u();
    // a hand-set elevation range belongs to this site
    if (this.settings.getState().heightRange) this.settings.getState().setHeightRange(null);
    this.edl?.dispose();
    this.root.removeFromParent();
    this.decoder?.dispose();
    pointcloudStats.getState().forget(this.handle);
  }
}

function matricesClose(a: Matrix4, b: Matrix4): boolean {
  const x = a.elements;
  const y = b.elements;
  for (let i = 0; i < 16; i++) if (Math.abs((x[i] ?? 0) - (y[i] ?? 0)) > 1e-6) return false;
  return true;
}
