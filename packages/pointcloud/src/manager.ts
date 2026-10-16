import type { SceneHandle } from '@aio/engine';
import type { PointcloudCleanup, PointcloudScalar } from '@aio/schema';
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
import { budgetShareOf } from './budgetShare';
import { WORKER_MIN_POINTS, chunkMask, type ChunkMask } from './cleanup/chunk';
import { cleanupUniformsOf, compileCleanup, type CompiledCleanup } from './cleanup/evaluate';
import { pointcloudCleanup, type CleanupRecipes } from './cleanup/store';
import { EdlPass } from './edl';
import { lowHeight, robustHeightRange, type HeightSample, type HeightStats } from './heights';
import {
  DEFAULT_CHANGE_RANGE,
  FLIGHT_PALETTE,
  MODE_INDEX,
  applyChangeUniforms,
  applyCleanupUniforms,
  applyHiddenClasses,
  createPointMaterial,
  type PointMaterial,
} from './material';
import {
  boxInFrustum,
  indexNodes,
  parentKey,
  selectNodes,
  type LodIndex,
  type LodNode,
  type Plane4,
} from './octree';
import type { Decoder } from './pool';
import type { DecodedChunk } from './protocol';
import { effectiveBudget, type PointcloudSettings } from './settings';
import { pointcloudStats, type ScalarSummary } from './stats';
import { IntervalGate, LOD_INTERVAL_MS, STATS_INTERVAL_MS, UploadQueue } from './stream';

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
  /** COPC: the decoder's quantisation, kept to mask the chunk again. */
  quant?: { offset: [number, number, number]; scale: [number, number, number] };
  /**
   * COPC: the decoded classes, before any cleanup class selection. The `aClass` attribute shares
   * this array until a class selection first overrides it; then this keeps a copy.
   */
  baseClass?: Uint8Array;
  baseClasses?: Record<number, number>;
}

export type ChunkSeed = Omit<ChunkState, 'object' | 'busy' | 'failed'>;

/** A view the octree refines for instead of the camera's (placing a finding from a photo). */
export interface LodFocus {
  eye: V3;
  planes: readonly Plane4[];
  /** Pixels per metre at distance 1 of that view (the photo's focal length in pixels). */
  pxPerM: number;
}

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
  /** Its decoded chunks carry a scalar per point (change clouds). */
  hasScalar: boolean;
  /** What the layer says about that scalar (label, unit, range, diverging); null without one. */
  scalar: PointcloudScalar | null;
  /** RGB expected from the format before any chunk is decoded (png-packed carries colour). */
  rgbHint: boolean;
  visible: boolean;
  copc: CopcLayerInfo | null;
  pagesLoading: Set<string>;
  /** Chunks with an object in the scene. */
  loaded: Set<ChunkState>;
  /**
   * COPC: one material per octree depth, sharing every uniform of `material` but the point size,
   * so nodes draw at their own size without re-uploading the uniforms object by object.
   */
  depthMaterials: Map<number, PointMaterial>;
  /** Shallowest octree depth whose chunks carry a height sample (the elevation range level). */
  heightLod: number;
  /** The layer's cleanup recipe compiled in the local frame (COPC only), or null. */
  cleanup: { recipe: PointcloudCleanup; compiled: CompiledCleanup; regionsKey: string } | null;
  /** Bumped when the selections change; a worker mask from before is dropped. */
  maskVersion: number;
}

/** A decoded chunk waiting for its frame. */
interface Ready {
  layer: CloudLayerState;
  chunk: ChunkState;
  data: DecodedChunk;
}

/** The level-of-detail inputs, rebuilt only when the chunk set or the layer visibility changes. */
interface LodCache {
  version: number;
  chunks: ChunkState[];
  nodes: LodNode[];
  owner: Map<string, CloudLayerState>;
  index: LodIndex;
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
  /** Reselect on the next frame (chunk set, budget or visibility changed). */
  private dirty = true;
  /** Bumped when the chunk set or the layer visibility changes; invalidates `lod`. */
  private version = 0;
  private lod: LodCache | null = null;
  /** Wanted chunks not loaded yet, highest priority first (the last selection). */
  private wanted: string[] = [];
  private wantedAt = 0;
  private readonly ready = new UploadQueue<Ready>();
  private readonly lodGate = new IntervalGate(LOD_INTERVAL_MS);
  private readonly statsGate = new IntervalGate(STATS_INTERVAL_MS);
  private sizesDirty = false;
  private statsDirty = true;
  /** Parent chunk of each octree chunk (null at the root), resolved once. */
  private readonly parents = new WeakMap<ChunkState, ChunkState | null>();
  private created = 0;
  private readonly lastView = new Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  private readonly viewProj = new Matrix4();
  private readonly frustum = new Frustum();
  private readonly bufferSize = new Vector2();
  private readonly unsubscribers: (() => void)[] = [];
  private decoder: Decoder | null = null;
  private pxPerM = 800;
  private focus: LodFocus | null = null;
  private focusSeq = 0;
  /** The `focusSeq` the last level-of-detail selection was made for. */
  private selectedSeq = 0;
  /** Automatic elevation range; recomputed when `heightsDirty`. */
  private heights: HeightStats | null = null;
  private heightsDirty = true;
  /** This scene's share of the point budget (1 unless a second 3D view shares it). */
  private share = 1;

  constructor(
    readonly handle: SceneHandle,
    private readonly makeDecoder: () => Decoder,
    readonly settings: StoreApi<PointcloudSettings>,
    readonly cleanup: StoreApi<CleanupRecipes> = pointcloudCleanup,
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
        if (s.budget !== prev.budget || s.budgetCap !== prev.budgetCap) this.dirty = true;
        if (s.hiddenClasses !== prev.hiddenClasses) {
          for (const l of this.layers.values())
            if (l.material) applyHiddenClasses(l.material, this.hiddenFor(l));
        }
        handle.requestRender();
      }),
    );
    this.unsubscribers.push(
      cleanup.subscribe((s, prev) => {
        if (s.recipes === prev.recipes) return;
        for (const l of this.layers.values()) {
          const r = s.recipes[l.id] ?? null;
          if (r !== (prev.recipes[l.id] ?? null)) this.applyRecipe(l, r);
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
    scalar: PointcloudScalar | null = null,
    /** Keep a colour the layer already had (the noise copy swap); default the next palette entry. */
    tint?: string,
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
      tint: tint ?? FLIGHT_PALETTE[this.created++ % FLIGHT_PALETTE.length] ?? '#5ab0ff',
      baseSize,
      hasRgb: false,
      hasIntensity: false,
      hasClass: false,
      hasScalar: false,
      scalar,
      rgbHint,
      visible: true,
      copc,
      pagesLoading: new Set(),
      loaded: new Set(),
      depthMaterials: new Map(),
      heightLod: Infinity,
      cleanup: null,
      maskVersion: 0,
    };
    this.layers.set(id, layer);
    this.applyRecipe(layer, this.cleanup.getState().recipes[id] ?? null);
    this.structureChanged();
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
    this.structureChanged();
    this.heightsDirty = true;
    this.handle.requestRender();
  }

  removeLayer(id: string): void {
    const l = this.layers.get(id);
    if (!l) return;
    for (const c of l.chunks) this.unloadChunk(c);
    for (const r of this.ready.remove((x) => x.layer === l)) r.chunk.busy = false;
    this.disposeMaterials(l);
    l.group.removeFromParent();
    this.layers.delete(id);
    this.structureChanged();
    this.heightsDirty = true;
    this.updateStats();
    this.handle.requestRender();
  }

  get empty(): boolean {
    return this.layers.size === 0;
  }

  /** The chunk set or the layer visibility changed: rebuild the LOD inputs and reselect. */
  private structureChanged(): void {
    this.version++;
    this.dirty = true;
    this.statsDirty = true;
  }

  /** Runs before every rendered frame. */
  private frame(): void {
    const now = performance.now();
    const s = this.settings.getState();
    // a second 3D view takes part of the budget (budgetShare.ts)
    const share = budgetShareOf(this.handle);
    if (share !== this.share) {
      this.share = share;
      this.dirty = true;
    }
    const cam = this.handle.camera;
    const r = this.handle.renderer;
    const buf = r.getDrawingBufferSize(this.bufferSize);
    const pxPerM = buf.y / (2 * Math.tan((cam.fov * Math.PI) / 360));
    this.pxPerM = pxPerM;
    const maxPx = s.maxPixels * r.getPixelRatio();

    // decoded nodes reach the GPU a frame's budget at a time (stream.ts)
    if (this.ready.size) {
      this.ready.drain((x) => {
        this.attachReady(x);
      });
    }

    cam.updateMatrixWorld();
    this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    // while the camera moves the selection is redone every LOD_INTERVAL_MS, not every frame
    const moved = !matricesClose(this.viewProj, this.lastView);
    if (this.dirty || (moved && this.lodGate.due(now))) {
      this.dirty = false;
      this.lodGate.mark(now);
      this.lastView.copy(this.viewProj);
      const eye = cam.getWorldPosition(new Vector3());
      this.frustum.setFromProjectionMatrix(this.viewProj);
      const planes: Plane4[] = this.frustum.planes.map((p) => [
        p.normal.x,
        p.normal.y,
        p.normal.z,
        p.constant,
      ]);
      const budget = effectiveBudget(s) * this.share;
      const f = this.focus;
      if (f) this.update([f.eye[0], f.eye[1], f.eye[2]], budget, [...f.planes], f.pxPerM);
      else this.update([eye.x, eye.y, eye.z], budget, planes);
      this.selectedSeq = this.focusSeq;
    } else if (moved) {
      // come back when the interval is up, even if the camera stops now
      this.handle.requestRender();
    }
    this.loadWanted();
    if (this.sizesDirty) this.updateSizes();

    // one range for every node of every cloud: the user's, else the clouds' robust range
    const [hMin, hMax] = s.heightRange ?? this.heightRange() ?? [0, 10];
    // colouring by change: clouds without the change field step aside while a change cloud shows
    let changeShown = false;
    if (s.colourMode === 'change')
      for (const l of this.layers.values()) if (l.visible && l.hasScalar) changeShown = true;
    for (const l of this.layers.values()) {
      const m = l.material;
      if (!m) continue;
      applyChangeUniforms(m, {
        range: s.changeRange ?? scalarHalfRange(l.scalar),
        threshold: s.changeThreshold,
        diverging: l.scalar?.diverging ?? false,
        hideNoScalar: changeShown,
      });
      // octree depth materials share every uniform but uSize (their spacing, set once)
      m.uniforms.uSize.value = l.baseSize;
      m.uniforms.uScale.value = s.sizeScale;
      m.uniforms.uPxPerM.value = pxPerM;
      m.uniforms.uMaxPx.value = maxPx;
      m.uniforms.uMode.value = MODE_INDEX[s.colourMode];
      m.uniforms.uHeight.value.set(hMin, hMax);
    }
    if (this.edl) this.edl.strength = s.edlStrength;

    const busy = this.ready.size > 0 || this.inflight > 0;
    if (this.statsDirty && (!busy || this.statsGate.due(now))) {
      this.statsGate.mark(now);
      this.updateStats();
    }
    // keep frames coming while decoded nodes wait for their turn
    if (this.ready.size) this.handle.requestRender();
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
    for (const l of this.layers.values()) if (l.visible) samples.push(...coarsestSamples(l));
    this.heights = robustHeightRange(samples);
    return this.heights;
  }

  /**
   * The low point of one shown cloud, local Y: the `p` weighted percentile of the heights sampled
   * from its coarsest decoded level (as heightStats). Null when the layer is unknown, hidden or
   * has not streamed yet.
   */
  lowHeight(layerId: string, p: number): number | null {
    const l = this.layers.get(layerId);
    if (!l?.visible) return null;
    return lowHeight(coarsestSamples(l), p);
  }

  /** The automatic elevation range (see heightStats); null before any cloud is decoded. */
  heightRange(): [number, number] | null {
    return this.heightStats()?.range ?? null;
  }

  /** Refine for `focus` instead of the camera until `clearFocus`. Returns its number. */
  setFocus(focus: LodFocus): number {
    this.focus = focus;
    this.focusSeq++;
    this.dirty = true;
    this.handle.requestRender();
    return this.focusSeq;
  }

  /** Back to the camera's view, if focus `seq` is still the one in force. */
  clearFocus(seq: number): void {
    if (seq !== this.focusSeq || !this.focus) return;
    this.focus = null;
    this.focusSeq++;
    this.dirty = true;
    this.handle.requestRender();
  }

  /** A selection was made for focus `seq` and everything it wanted is loaded (or failed). */
  settled(seq: number): boolean {
    if (this.selectedSeq < seq || this.inflight > 0 || this.ready.size > 0) return false;
    for (const l of this.layers.values()) if (l.pagesLoading.size > 0) return false;
    const owner = this.lod?.owner;
    return this.wanted.every((k) => {
      const c = owner?.get(k)?.byKey.get(k);
      if (!c) return true;
      return c.object !== null || c.failed;
    });
  }

  /** Deepest octree depth loaded among the shown chunks that meet `planes`. */
  deepestLoaded(planes: readonly Plane4[]): number {
    let depth = 0;
    for (const l of this.layers.values()) {
      if (!l.visible) continue;
      for (const c of l.loaded) if (c.lod > depth && boxInFrustum(c.bounds, planes)) depth = c.lod;
    }
    return depth;
  }

  /** The LOD inputs for the current chunk set, rebuilt only when it changed. */
  private lodInputs(): LodCache {
    if (this.lod?.version === this.version) return this.lod;
    const chunks: ChunkState[] = [];
    const nodes: LodNode[] = [];
    const owner = new Map<string, CloudLayerState>();
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
          loaded: false,
        };
        if (c.children) n.children = c.children;
        if (c.spacing !== undefined) n.spacing = c.spacing;
        if (c.page) n.page = true;
        chunks.push(c);
        nodes.push(n);
      }
    }
    this.lod = { version: this.version, chunks, nodes, owner, index: indexNodes(nodes) };
    return this.lod;
  }

  private update(
    eye: [number, number, number],
    budget: number,
    frustum: Plane4[],
    pxPerM = this.pxPerM,
  ): void {
    const { chunks, nodes, owner, index } = this.lodInputs();
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const n = nodes[i];
      if (!c || !n) continue;
      // flat chunks learn their count and tight bounds when decoded
      n.points = c.points;
      n.bounds = c.bounds;
      n.loaded = c.object !== null || c.busy;
    }
    const sel = selectNodes(nodes, eye, { budget, pxPerM, minPx: REFINE_PX, frustum }, index);
    for (const key of sel.unload) {
      const c = owner.get(key)?.byKey.get(key);
      if (c && !c.busy) this.unloadChunk(c);
    }
    for (const key of sel.pages) {
      const l = owner.get(key);
      const c = l?.byKey.get(key);
      if (l && c) this.loadPage(l, c);
    }
    this.wanted = sel.load;
    this.wantedAt = 0;
  }

  /** Starts decodes from the last selection while workers are free (no reselection needed). */
  private loadWanted(): void {
    const owner = this.lod?.owner;
    if (!owner) return;
    while (this.inflight < MAX_INFLIGHT && this.wantedAt < this.wanted.length) {
      const key = this.wanted[this.wantedAt++];
      if (key === undefined) break;
      const c = owner.get(key)?.byKey.get(key);
      if (c && !c.object && !c.busy && !c.failed && !c.page) this.loadChunk(c);
    }
  }

  /** The parent chunk of an octree chunk, looked up once. */
  private parentOf(l: CloudLayerState, c: ChunkState): ChunkState | null {
    let p = this.parents.get(c);
    if (p === undefined) {
      const k = parentKey(nodeKeyOf(c.key));
      p = k === null ? null : (l.byKey.get(`${l.id}#${k}`) ?? null);
      this.parents.set(c, p);
    }
    return p;
  }

  /**
   * Octree point size: the spacing of the deepest loaded node under each node (Potree's adaptive
   * size), applied as the material of that depth. Runs when the loaded set changed.
   */
  private updateSizes(): void {
    this.sizesDirty = false;
    for (const l of this.layers.values()) {
      if (!l.copc || !l.material) continue;
      const deepest = new Map<ChunkState, number>();
      for (const c of l.loaded) {
        for (let k: ChunkState | null = c; k; k = this.parentOf(l, k)) {
          const d = deepest.get(k);
          if (d !== undefined && d >= c.lod) break;
          deepest.set(k, c.lod);
        }
      }
      for (const c of l.loaded) {
        if (!c.object) continue;
        c.object.material = this.depthMaterial(l, l.material, deepest.get(c) ?? c.lod);
      }
    }
  }

  /**
   * The layer's material at octree depth `d` (world point size = root spacing / 2^d; the user's
   * size scale is the shared uScale).
   */
  private depthMaterial(l: CloudLayerState, base: PointMaterial, d: number): PointMaterial {
    let m = l.depthMaterials.get(d);
    if (!m) {
      m = base.clone();
      const s0 = l.copc?.source.spacing ?? l.baseSize;
      // every uniform shared with the base material but the size
      m.uniforms = { ...base.uniforms, uSize: { value: s0 / 2 ** d } };
      m.clippingPlanes = this.handle.clippingPlanes;
      l.depthMaterials.set(d, m);
    }
    return m;
  }

  private disposeMaterials(l: CloudLayerState): void {
    for (const m of l.depthMaterials.values()) m.dispose();
    l.depthMaterials.clear();
    l.material?.dispose();
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
        this.structureChanged();
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
        this.inflight--;
        const l = this.layerOf(c);
        if (!l) {
          c.busy = false;
          return;
        }
        // stays busy until its frame comes (frame -> attachReady)
        const bytes =
          d.position.byteLength +
          (d.rgb?.byteLength ?? 0) +
          (d.intensity?.byteLength ?? 0) +
          (d.classification?.byteLength ?? 0) +
          (d.scalar?.byteLength ?? 0);
        this.ready.push({ layer: l, chunk: c, data: d }, bytes, c.lod);
      })
      .catch((e: unknown) => {
        c.busy = false;
        c.failed = true;
        this.inflight--;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Point cloud chunk ${c.key} could not be loaded: ${msg}`);
        pointcloudStats.getState().addError(`${c.key}: ${msg}`);
        this.structureChanged();
      })
      .finally(() => {
        this.statsDirty = true;
        this.handle.requestRender();
      });
  }

  private attachReady({ layer: l, chunk: c, data: d }: Ready): void {
    c.busy = false;
    // the layer went away or hid while the node waited
    if (this.layers.get(l.id) !== l || l.byKey.get(c.key) !== c) return;
    if (!l.visible && c.lod > 0) return;
    if (c.object) return;
    this.attach(l, c, d);
    this.sizesDirty = true;
    this.statsDirty = true;
  }

  private attach(l: CloudLayerState, c: ChunkState, d: DecodedChunk): void {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(d.position, 3));
    if (d.rgb) geo.setAttribute('aRgb', new BufferAttribute(d.rgb, 3, true));
    if (d.intensity) geo.setAttribute('aIntensity', new BufferAttribute(d.intensity, 1, true));
    if (d.classification) geo.setAttribute('aClass', new BufferAttribute(d.classification, 1));
    if (d.scalar) geo.setAttribute('aScalar', new BufferAttribute(d.scalar, 1));
    const src = c.source;
    if (
      !l.material ||
      l.hasRgb !== !!d.rgb ||
      l.hasIntensity !== !!d.intensity ||
      l.hasClass !== !!d.classification ||
      l.hasScalar !== !!d.scalar
    ) {
      l.hasRgb = !!d.rgb;
      l.hasIntensity = !!d.intensity;
      l.hasClass = !!d.classification;
      l.hasScalar = !!d.scalar;
      this.disposeMaterials(l);
      l.material = createPointMaterial({
        hasRgb: l.hasRgb,
        hasIntensity: l.hasIntensity,
        hasClass: l.hasClass,
        hasScalar: l.hasScalar,
        // every chunk of a layer has the same source kind, so this never rebuilds per chunk;
        // the depth materials are cloned from this one (defines included) after it
        hasMask: src.kind === 'copc',
        baseSize: l.baseSize,
        tint: l.tint,
      });
      applyHiddenClasses(l.material, this.hiddenFor(l));
      applyCleanupUniforms(l.material, cleanupUniformsOf(l.cleanup?.compiled ?? null));
      // the section tool cuts meshes and clouds together through this shared array
      l.material.clippingPlanes = this.handle.clippingPlanes;
      for (const o of l.loaded) if (o.object) o.object.material = l.material;
      this.sizesDirty = true;
    }
    if (src.kind === 'copc') {
      geo.setAttribute('aMask', new BufferAttribute(new Uint8Array(d.count), 1));
      if (d.quant) c.quant = d.quant;
      if (d.classification) {
        c.baseClass = d.classification;
        if (d.classes) c.baseClasses = d.classes;
      }
    }
    const pts = new Points(geo, l.material);
    pts.name = `pointcloud:${l.id}:${c.key}`;
    pts.userData.layerId = l.id;
    pts.userData.chunk = c.key;
    pts.matrixAutoUpdate = false;
    if (src.kind === 'kit') {
      pts.scale.setScalar(src.scale);
    } else {
      const q = src.kind === 'png' ? src.quant : d.quant;
      if (q) {
        pts.position.set(q.offset[0], q.offset[1], q.offset[2]);
        pts.scale.set(q.scale[0], q.scale[1], q.scale[2]);
      }
    }
    // octree nodes draw at the spacing of their deepest loaded descendant (updateSizes)
    if (src.kind === 'copc') pts.material = this.depthMaterial(l, l.material, c.lod);
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
      // only the shallowest sampled level sets the range (heightStats)
      if (c.lod <= l.heightLod) {
        l.heightLod = c.lod;
        this.heightsDirty = true;
      }
    }
    c.object = pts;
    l.loaded.add(c);
    l.group.add(pts);
    if (src.kind === 'copc' && l.cleanup?.compiled.regions.length) this.maskChunk(l, c);
  }

  /** The layer's hidden classes: its recipe's set (COPC layers), else the global one. */
  private hiddenFor(l: CloudLayerState): readonly number[] {
    const own = l.copc ? this.cleanup.getState().recipes[l.id]?.hiddenClasses : undefined;
    return own ?? this.settings.getState().hiddenClasses;
  }

  private applyRecipe(l: CloudLayerState, r: PointcloudCleanup | null): void {
    // png-packed and kit-packed clouds have no COPC source to save from: no cleanup (the panel says so)
    if (!l.copc) return;
    const prev = l.cleanup;
    // a clip box drag or a height change keeps the regions array: no recompile, no re-mask
    let regionsKey = '';
    let sameRegions: boolean;
    if (!r) {
      sameRegions = (prev?.regionsKey ?? '') === '';
    } else if (prev?.recipe.regions === r.regions) {
      regionsKey = prev.regionsKey;
      sameRegions = true;
    } else {
      regionsKey = r.regions.length ? JSON.stringify(r.regions) : '';
      sameRegions = regionsKey === (prev?.regionsKey ?? '');
    }
    if (r) {
      const reuse = sameRegions && prev ? prev.compiled.regions : null;
      const compiled = compileCleanup(reuse ? { ...r, regions: [] } : r, {
        origin: l.copc.origin,
      });
      if (reuse) compiled.regions = reuse;
      l.cleanup = { recipe: r, compiled, regionsKey };
    } else {
      l.cleanup = null;
    }
    if (l.material) {
      // the depth materials share these uniform objects
      applyCleanupUniforms(l.material, cleanupUniformsOf(l.cleanup?.compiled ?? null));
      applyHiddenClasses(l.material, this.hiddenFor(l));
    }
    if (!sameRegions) {
      l.maskVersion++;
      for (const c of l.loaded) this.maskChunk(l, c);
    }
  }

  /** Masks one loaded COPC chunk by the layer's selections: in a worker above WORKER_MIN_POINTS. */
  private maskChunk(l: CloudLayerState, c: ChunkState): void {
    const obj = c.object;
    const quant = c.quant;
    const copc = l.copc;
    if (!obj || !quant || !copc) return;
    const position = obj.geometry.getAttribute('position');
    const count = position.count;
    const cu = l.cleanup;
    if (!cu || cu.compiled.regions.length === 0) {
      this.setMask(c, { mask: new Uint8Array(count), cls: null, classes: null });
      return;
    }
    const positions = position.array as Uint16Array;
    const input = { count, positions, quant, classes: c.baseClass ?? null };
    const dec = this.getDecoder();
    const version = l.maskVersion;
    if (count > WORKER_MIN_POINTS && dec.mask) {
      dec
        .mask({
          kind: 'mask',
          recipe: cu.recipe,
          origin: copc.origin,
          count,
          positions: positions.slice(),
          quant,
          classes: c.baseClass?.slice() ?? null,
        })
        .then((r) => {
          if (l.maskVersion === version && c.object === obj) this.setMask(c, r);
        })
        .catch((e: unknown) => {
          console.warn(`Cleanup mask of ${c.key} on the main thread: ${String(e)}`);
          if (l.maskVersion === version && c.object === obj)
            this.setMask(c, chunkMask(cu.compiled, input));
        });
      return;
    }
    this.setMask(c, chunkMask(cu.compiled, input));
  }

  /**
   * Writes a chunk's mask and class override into its attributes in place (a replaced attribute
   * would leave its GPU buffer behind until the geometry is disposed).
   */
  private setMask(c: ChunkState, r: ChunkMask): void {
    const geo = c.object?.geometry;
    if (!geo) return;
    const mask = geo.getAttribute('aMask') as BufferAttribute | undefined;
    if (mask?.array.length === r.mask.length) {
      (mask.array as Uint8Array).set(r.mask);
      mask.needsUpdate = true;
    } else {
      geo.setAttribute('aMask', new BufferAttribute(r.mask, 1));
    }
    const base = c.baseClass;
    const cls = geo.getAttribute('aClass') as BufferAttribute | undefined;
    if (base && cls?.array.length === base.length) {
      const arr = cls.array as Uint8Array;
      if (r.cls) {
        // the first override: keep the decoded classes apart from the drawn ones
        if (arr === base) c.baseClass = base.slice();
        arr.set(r.cls);
        cls.needsUpdate = true;
      } else if (arr !== base) {
        arr.set(base);
        cls.needsUpdate = true;
      }
    }
    const classes = r.classes ?? c.baseClasses;
    if (classes) c.classes = classes;
    this.statsDirty = true;
    this.handle.requestRender();
  }

  private unloadChunk(c: ChunkState): void {
    if (!c.object) return;
    c.object.removeFromParent();
    c.object.geometry.dispose();
    c.object = null;
    this.layerOf(c)?.loaded.delete(c);
    this.sizesDirty = true;
    this.statsDirty = true;
  }

  private updateStats(): void {
    this.statsDirty = false;
    let loaded = 0;
    let total = 0;
    const loading = this.inflight + this.ready.size;
    let rgb = false;
    let classes: Record<number, number> | null = null;
    let scalar: ScalarSummary | null = null;
    for (const l of this.layers.values()) {
      if (l.material ? l.hasRgb : l.rgbHint) rgb = true;
      if (l.visible && l.hasScalar && l.loaded.size > 0) scalar = addScalar(scalar, l.scalar);
      if (l.copc) total += l.copc.source.pointCount;
      else for (const c of l.chunks) total += c.points;
      if (!l.visible) continue;
      for (const c of l.loaded) {
        loaded += c.points;
        if (c.classes) {
          classes ??= {};
          for (const [k, n] of Object.entries(c.classes)) classes[+k] = (classes[+k] ?? 0) + n;
        }
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
      scalar,
    });
  }

  dispose(): void {
    for (const r of this.ready.clear()) r.chunk.busy = false;
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

/**
 * The height samples of a cloud's coarsest decoded level (the octree root, the overview chunk, a
 * whole kit cloud), each weighted by the points it stands for.
 */
function coarsestSamples(l: CloudLayerState): HeightSample[] {
  let top = Infinity;
  for (const c of l.chunks) if (c.heights?.length && c.lod < top) top = c.lod;
  const out: HeightSample[] = [];
  for (const c of l.chunks) {
    if (c.lod !== top || !c.heights?.length) continue;
    out.push({ heights: c.heights, weight: Math.max(c.points, 1) / c.heights.length });
  }
  return out;
}

/** The change field summary with one more shown change cloud. */
function addScalar(prev: ScalarSummary | null, meta: PointcloudScalar | null): ScalarSummary {
  return {
    label: prev?.label ?? meta?.label ?? 'Distance',
    unit: prev?.unit ?? meta?.unit ?? 'm',
    range: Math.max(prev?.range ?? 0, scalarHalfRange(meta)),
    diverging: (prev?.diverging ?? false) || (meta?.diverging ?? false),
  };
}

/** The distance a layer's scalar gets the full colour at: the larger end of its range. */
export function scalarHalfRange(meta: PointcloudScalar | null): number {
  if (!meta) return DEFAULT_CHANGE_RANGE;
  const r = Math.max(Math.abs(meta.range[0]), Math.abs(meta.range[1]));
  return r > 0 ? r : DEFAULT_CHANGE_RANGE;
}

function matricesClose(a: Matrix4, b: Matrix4): boolean {
  const x = a.elements;
  const y = b.elements;
  for (let i = 0; i < 16; i++) if (Math.abs((x[i] ?? 0) - (y[i] ?? 0)) > 1e-6) return false;
  return true;
}
