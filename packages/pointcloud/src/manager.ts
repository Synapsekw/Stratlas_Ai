import type { SceneHandle } from '@aio/engine';
import { BufferAttribute, BufferGeometry, Group, Points, Sphere, Vector2, Vector3 } from 'three';
import type { StoreApi } from 'zustand/vanilla';
import type { Bounds3, Quantisation } from './decode';
import { EdlPass } from './edl';
import { selectChunks, type LodCandidate } from './lod';
import { FLIGHT_PALETTE, MODE_INDEX, createPointMaterial, type PointMaterial } from './material';
import type { Decoder } from './pool';
import type { DecodedChunk } from './protocol';
import type { PointcloudSettings } from './settings';
import { pointcloudStats } from './stats';

export type ChunkSource =
  { kind: 'kit'; url: string; scale: number } | { kind: 'png'; url: string; quant: Quantisation };

export interface ChunkState {
  key: string;
  source: ChunkSource;
  points: number;
  bounds: Bounds3;
  lod: number;
  object: Points | null;
  busy: boolean;
  failed: boolean;
}

export interface CloudLayerState {
  id: string;
  group: Group;
  chunks: ChunkState[];
  material: PointMaterial | null;
  tint: string;
  baseSize: number;
  hasRgb: boolean;
  hasIntensity: boolean;
  /** RGB expected from the format before any chunk is decoded (png-packed carries colour). */
  rgbHint: boolean;
  visible: boolean;
}

const MAX_INFLIGHT = 4;

/** All clouds of one SceneHandle: shared budget, LOD, EDL and per-frame uniforms. */
export class CloudManager {
  readonly layers = new Map<string, CloudLayerState>();
  /** Parent of every cloud group; lives in the main scene or in the EDL scene. */
  readonly root = new Group();
  private edl: EdlPass | null = null;
  private inflight = 0;
  private dirty = true;
  private created = 0;
  private readonly lastEye = new Vector3(Infinity, 0, 0);
  private readonly bufferSize = new Vector2();
  private readonly unsubscribers: (() => void)[] = [];
  private decoder: Decoder | null = null;

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
        handle.requestRender();
      }),
    );
    this.placeRoot();
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
    chunks: Omit<ChunkState, 'object' | 'busy' | 'failed'>[],
    baseSize: number,
    rgbHint = false,
  ) {
    const group = new Group();
    group.name = `pointcloud:${id}`;
    group.userData.layerId = id;
    this.root.add(group);
    const layer: CloudLayerState = {
      id,
      group,
      chunks: chunks.map((c) => ({ ...c, object: null, busy: false, failed: false })),
      material: null,
      tint: FLIGHT_PALETTE[this.created++ % FLIGHT_PALETTE.length] ?? '#5ab0ff',
      baseSize,
      hasRgb: false,
      hasIntensity: false,
      rgbHint,
      visible: true,
    };
    this.layers.set(id, layer);
    this.dirty = true;
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
    this.handle.requestRender();
  }

  removeLayer(id: string): void {
    const l = this.layers.get(id);
    if (!l) return;
    for (const c of l.chunks) this.unloadChunk(c);
    l.material?.dispose();
    l.group.removeFromParent();
    this.layers.delete(id);
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
    const maxPx = s.maxPixels * r.getPixelRatio();
    const [hMin, hMax] = this.heightRange() ?? [0, 10];
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
    const eye = cam.getWorldPosition(new Vector3());
    if (eye.distanceToSquared(this.lastEye) > 1e-4) this.dirty = true;
    if (this.dirty) {
      this.dirty = false;
      this.lastEye.copy(eye);
      this.update([eye.x, eye.y, eye.z], s.budget);
    }
  }

  /** Height range of the loaded chunks of visible clouds, local Y; null with none loaded. */
  heightRange(): [number, number] | null {
    let lo = Infinity;
    let hi = -Infinity;
    for (const l of this.layers.values()) {
      if (!l.visible) continue;
      for (const c of l.chunks) {
        if (!c.object) continue;
        lo = Math.min(lo, c.bounds.min[1]);
        hi = Math.max(hi, c.bounds.max[1]);
      }
    }
    return Number.isFinite(lo) && hi > lo ? [lo, hi] : null;
  }

  private update(eye: [number, number, number], budget: number): void {
    const byKey = new Map<string, ChunkState>();
    const candidates: LodCandidate[] = [];
    for (const l of this.layers.values()) {
      for (const c of l.chunks) {
        if (!l.visible) {
          if (c.lod > 0 && c.object) this.unloadChunk(c);
          continue;
        }
        if (c.failed) continue;
        byKey.set(c.key, c);
        candidates.push({
          key: c.key,
          points: c.points,
          bounds: c.bounds,
          lod: c.lod,
          loaded: c.object !== null || c.busy,
        });
      }
    }
    const sel = selectChunks(candidates, eye, { budget });
    for (const key of sel.unload) {
      const c = byKey.get(key);
      if (c && !c.busy) this.unloadChunk(c);
    }
    for (const key of sel.load) {
      if (this.inflight >= MAX_INFLIGHT) {
        this.dirty = true; // come back next frame
        break;
      }
      const c = byKey.get(key);
      if (c) this.loadChunk(c);
    }
    this.updateStats();
  }

  private layerOf(c: ChunkState): CloudLayerState | undefined {
    for (const l of this.layers.values()) if (l.chunks.includes(c)) return l;
    return undefined;
  }

  private loadChunk(c: ChunkState): void {
    this.decoder ??= this.makeDecoder();
    c.busy = true;
    this.inflight++;
    const { kind, url } = c.source;
    const job =
      c.source.kind === 'kit'
        ? { kind: 'kit' as const, url, scale: c.source.scale }
        : { kind: 'png' as const, url, points: c.points, quant: c.source.quant };
    this.decoder
      .decode(job)
      .then((d) => {
        c.busy = false;
        this.inflight--;
        const l = this.layerOf(c);
        if (!l) return;
        this.attach(l, c, d, kind);
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
        this.updateStats();
        this.handle.requestRender();
      });
  }

  private attach(l: CloudLayerState, c: ChunkState, d: DecodedChunk, kind: 'kit' | 'png'): void {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(d.position, 3));
    if (d.rgb) geo.setAttribute('aRgb', new BufferAttribute(d.rgb, 3, true));
    if (d.intensity) geo.setAttribute('aIntensity', new BufferAttribute(d.intensity, 1, true));
    if (!l.material || l.hasRgb !== !!d.rgb || l.hasIntensity !== !!d.intensity) {
      l.hasRgb = !!d.rgb;
      l.hasIntensity = !!d.intensity;
      l.material?.dispose();
      l.material = createPointMaterial({
        hasRgb: l.hasRgb,
        hasIntensity: l.hasIntensity,
        baseSize: l.baseSize,
        tint: l.tint,
      });
      // the section tool cuts meshes and clouds together through this shared array
      l.material.clippingPlanes = this.handle.clippingPlanes;
      for (const o of l.chunks) if (o.object) o.object.material = l.material;
    }
    const pts = new Points(geo, l.material);
    pts.name = `pointcloud:${l.id}:${c.key}`;
    pts.userData.layerId = l.id;
    pts.userData.chunk = c.key;
    pts.matrixAutoUpdate = false;
    if (kind === 'kit' && c.source.kind === 'kit') {
      pts.scale.setScalar(c.source.scale);
    } else if (c.source.kind === 'png') {
      const q = c.source.quant;
      pts.position.set(q.offset[0], q.offset[1], q.offset[2]);
      pts.scale.set(q.scale[0], q.scale[1], q.scale[2]);
    }
    pts.updateMatrix();
    // The bounding sphere in local (quantised) units, from the decoded bounds.
    const inv = pts.matrix.clone().invert();
    const lo = new Vector3(...d.bounds.min).applyMatrix4(inv);
    const hi = new Vector3(...d.bounds.max).applyMatrix4(inv);
    geo.boundingSphere = new Sphere(lo.clone().add(hi).multiplyScalar(0.5), lo.distanceTo(hi) / 2);
    c.bounds = d.bounds;
    c.points = d.count;
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
    for (const l of this.layers.values()) {
      if (l.material ? l.hasRgb : l.rgbHint) rgb = true;
      for (const c of l.chunks) {
        total += c.points;
        if (c.object && l.visible) loaded += c.points;
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
    });
  }

  dispose(): void {
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    for (const u of this.unsubscribers) u();
    this.edl?.dispose();
    this.root.removeFromParent();
    this.decoder?.dispose();
    pointcloudStats.getState().forget(this.handle);
  }
}
