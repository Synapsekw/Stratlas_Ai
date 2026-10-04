import {
  registerAdapter,
  type AdapterContext,
  type LayerHandle,
  type SceneHandle,
} from '@aio/engine';
import type { LensModel } from '@aio/schema';
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Euler,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Quaternion,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector3,
  VideoTexture,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRONE_GLB_BASE64 } from './drone-glb';
import type { Flight } from './flight';
import { imageToRay } from './lens';
import { acquirePlayer, releasePlayer, type ClipPlayer } from './player';
import { interpolatePose } from './pose';
import { Projector, type ProjectorOptions } from './projector';
import { loadFlight, videoStore, type VideoLayer } from './runtime';

export type CameraMode = 'free' | 'follow' | 'drone';

/** Which flight paths the rig draws: every flight, only the active clip's flight, or none. */
export type FlightPathMode = 'all' | 'active' | 'off';

export interface FlightPathOptions {
  mode: FlightPathMode;
  /** Clips whose flight path the user hid (a path hides when every clip of it is listed). */
  hiddenClips?: ReadonlySet<string>;
}

/** Optional orbit-controls seam on the scene handle (target and enable flag). */
interface ControlsLike {
  target: Vector3;
  enabled: boolean;
}

function controlsOf(h: SceneHandle): ControlsLike | null {
  const c = (h as SceneHandle & { controls?: unknown }).controls;
  if (c && typeof c === 'object' && 'target' in c && (c as ControlsLike).target instanceof Vector3)
    return c as ControlsLike;
  return null;
}

/** The path choice per scene, kept when the rig is rebuilt (another project in the same scene). */
const pathChoice = new WeakMap<SceneHandle, FlightPathOptions>();

const PATH_START = new Color('#5ab0ff');
const PATH_END = new Color('#ff5a5a');

interface ClipEntry {
  layer: VideoLayer;
  flight: Flight | null;
  visible: boolean;
}

/** One drawn path per flight log; long flights are delivered as many clips sharing it. */
interface FlightPath {
  line: Line;
  clips: Set<string>;
}

function decodeBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}

/**
 * A screen-constant ring around the drone, drawn over everything, so the drone reads from outside
 * the asset; it pulses while the clip plays. Null without a 2D canvas (tests).
 */
function beaconSprite(): Sprite | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  g.strokeStyle = 'rgba(84, 212, 181, 1)';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(32, 32, 22, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(84, 212, 181, 0.16)';
  g.fill();
  g.fillStyle = 'rgba(84, 212, 181, 1)';
  g.beginPath();
  g.arc(32, 32, 3.5, 0, Math.PI * 2);
  g.fill();
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const s = new Sprite(
    new SpriteMaterial({
      map: tex,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      sizeAttenuation: false,
    }),
  );
  s.name = 'DroneBeacon';
  s.renderOrder = 30;
  s.visible = false;
  return s;
}

const BEACON_SIZE = 0.06;

/** Border of the image (and the four corner spokes) as camera-frame unit rays. */
function frustumRays(lens: LensModel): Vector3[] {
  const border: [number, number][] = [];
  const n = 16;
  for (let i = 0; i < n; i++) border.push([i / n, 0]);
  for (let i = 0; i < n; i++) border.push([1, i / n]);
  for (let i = 0; i < n; i++) border.push([1 - i / n, 1]);
  for (let i = 0; i < n; i++) border.push([0, 1 - i / n]);
  return border.map(([x, y]) => new Vector3(...imageToRay(lens, x, y)));
}

/**
 * Everything the video layers draw in one scene: flight paths, the drone marker and frustum at
 * the active clip's pose, the projector, and the follow / drone-eye camera modes.
 */
export class VideoRig {
  readonly projector: Projector;
  readonly group = new Group();
  private readonly clips = new Map<string, ClipEntry>();
  private readonly paths = new Map<Flight, FlightPath>();
  private readonly drone = new Group();
  private gimbal: Object3D | null = null;
  private props: Object3D[] = [];
  private readonly frustum: LineSegments;
  private readonly beacon = beaconSprite();
  private frustumRays: Vector3[] = [];
  private activeId: string | null = null;
  private player: ClipPlayer | null = null;
  private texture: VideoTexture | null = null;
  private lens: LensModel | null = null;
  private mode: CameraMode = 'free';
  private saved: { pos: Vector3; quat: Quaternion; up: Vector3; fov: number; near: number } | null =
    null;
  private lastPos: Vector3 | null = null;
  private hold: (() => void) | null = null;
  private playerOff: (() => void) | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly pose = { pos: new Vector3(), q: new Quaternion(), valid: false };
  projectionOn = true;
  pathsOn = true;
  /** Flight path display; independent of the clips, so hiding paths keeps the drone and video. */
  private pathMode: FlightPathMode = 'all';
  private hiddenPathClips: ReadonlySet<string> = new Set();
  /** When true the projection range follows the active flight's height (set false by the UI). */
  autoRange = true;

  constructor(
    readonly handle: SceneHandle,
    projectorOptions: Partial<ProjectorOptions> = {},
  ) {
    this.projector = new Projector(projectorOptions);
    const paths = pathChoice.get(handle);
    if (paths) this.setFlightPaths(paths);
    this.group.name = 'VideoRig';
    this.drone.name = 'Drone';
    this.drone.visible = false;
    new GLTFLoader().parse(
      decodeBase64(DRONE_GLB_BASE64),
      '',
      (g) => {
        this.drone.add(g.scene);
        g.scene.traverse((o) => {
          if (o.name.startsWith('Prop_')) this.props.push(o);
          if (o.name === 'Gimbal') this.gimbal = o;
        });
        handle.requestRender();
      },
      (e) => {
        console.warn('Drone model failed to load', e);
      },
    );
    const fg = new BufferGeometry();
    fg.setAttribute('position', new BufferAttribute(new Float32Array(72 * 3 * 2), 3));
    this.frustum = new LineSegments(
      fg,
      new LineBasicMaterial({
        color: 0xffd166,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    );
    this.frustum.renderOrder = 20;
    this.frustum.frustumCulled = false;
    this.frustum.visible = false;
    this.group.add(this.drone, this.frustum);
    if (this.beacon) this.group.add(this.beacon);
    handle.scene.add(this.group);
    this.offs.push(handle.onFrame(this.frame));
    this.offs.push(
      videoStore().subscribe((s, p) => {
        if (s.activeClip !== p.activeClip) this.syncActive();
        if (s.nowMs !== p.nowMs || s.activeClip !== p.activeClip || s.hidden !== p.hidden)
          handle.requestRender();
      }),
    );
  }

  get size(): number {
    return this.clips.size;
  }

  async addLayer(layer: VideoLayer, ctx: AdapterContext): Promise<void> {
    const entry: ClipEntry = { layer, flight: null, visible: true };
    this.clips.set(layer.id, entry);
    const flight = await loadFlight(ctx.url(layer.flight.src));
    if (this.clips.get(layer.id) !== entry) return;
    entry.flight = flight;
    let path = this.paths.get(flight);
    if (!path) {
      path = { line: this.buildPath(flight), clips: new Set() };
      path.line.userData.videoLayer = layer.id;
      this.paths.set(flight, path);
      this.group.add(path.line);
    }
    path.clips.add(layer.id);
    this.syncActive();
    this.handle.requestRender();
  }

  removeLayer(id: string) {
    const e = this.clips.get(id);
    if (!e) return;
    this.clips.delete(id);
    const path = e.flight ? this.paths.get(e.flight) : undefined;
    if (path && e.flight) {
      path.clips.delete(id);
      if (path.clips.size === 0) {
        this.paths.delete(e.flight);
        this.group.remove(path.line);
        path.line.geometry.dispose();
        (path.line.material as LineBasicMaterial).dispose();
      }
    }
    if (this.activeId === id) this.syncActive();
    this.handle.requestRender();
  }

  setLayerVisible(id: string, v: boolean) {
    const e = this.clips.get(id);
    if (!e) return;
    e.visible = v;
    this.handle.requestRender();
  }

  /** Show every flight path, only the active clip's, or none; and hide single flights. */
  setFlightPaths(o: FlightPathOptions) {
    this.pathMode = o.mode;
    if (o.hiddenClips) this.hiddenPathClips = o.hiddenClips;
    this.handle.requestRender();
  }

  get flightPaths(): { mode: FlightPathMode; hiddenClips: ReadonlySet<string> } {
    return { mode: this.pathMode, hiddenClips: this.hiddenPathClips };
  }

  setCameraMode(mode: CameraMode) {
    if (mode === this.mode) return;
    const cam = this.handle.camera;
    const controls = controlsOf(this.handle);
    if (this.mode === 'drone' && this.saved) {
      cam.position.copy(this.saved.pos);
      cam.quaternion.copy(this.saved.quat);
      cam.up.copy(this.saved.up);
      cam.fov = this.saved.fov;
      cam.near = this.saved.near;
      cam.updateProjectionMatrix();
      if (controls) controls.enabled = true;
      this.saved = null;
    }
    if (mode === 'drone') {
      this.saved = {
        pos: cam.position.clone(),
        quat: cam.quaternion.clone(),
        up: cam.up.clone(),
        fov: cam.fov,
        near: cam.near,
      };
      if (controls) controls.enabled = false;
    }
    this.mode = mode;
    this.lastPos = null;
    this.handle.requestRender();
  }

  get cameraMode(): CameraMode {
    return this.mode;
  }

  /** Current projector pose, if a clip is active and has a flight. */
  currentPose(): { pos: Vector3; q: Quaternion } | null {
    return this.pose.valid ? { pos: this.pose.pos.clone(), q: this.pose.q.clone() } : null;
  }

  private buildPath(f: Flight): Line {
    const n = f.samples.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const c = new Color();
    const dur = Math.max(1, f.durationMs);
    f.samples.forEach((s, i) => {
      pos.set(s.pos, i * 3);
      c.copy(PATH_START).lerp(PATH_END, s.t / dur);
      col.set([c.r, c.g, c.b], i * 3);
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('color', new BufferAttribute(col, 3));
    const line = new Line(
      g,
      new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35 }),
    );
    line.renderOrder = 5;
    return line;
  }

  /** Follow the workspace's active clip: player, texture, lens. */
  private syncActive() {
    const id = videoStore().getState().activeClip;
    const want = id && this.clips.get(id)?.flight ? id : null;
    if (want === this.activeId) return;
    if (this.activeId) {
      this.texture?.dispose();
      this.texture = null;
      this.projector.setTexture(null);
      this.playerOff?.();
      this.playerOff = null;
      releasePlayer(this.activeId);
      this.player = null;
      this.hold?.();
      this.hold = null;
    }
    this.activeId = want;
    for (const path of this.paths.values()) {
      const m = path.line.material as LineBasicMaterial;
      const on = want !== null && path.clips.has(want);
      m.opacity = on ? 1 : 0.3;
      m.depthTest = !on;
      path.line.renderOrder = on ? 6 : 5;
    }
    const entry = want ? this.clips.get(want) : undefined;
    if (!want || !entry?.flight) {
      this.projector.setEnabled(false);
      this.projector.detachAll();
      this.drone.visible = this.frustum.visible = false;
      if (this.beacon) this.beacon.visible = false;
      this.pose.valid = false;
      return;
    }
    const player = acquirePlayer(want);
    this.player = player;
    const tex = new VideoTexture(player.video);
    tex.colorSpace = SRGBColorSpace;
    this.texture = tex;
    this.projector.setTexture(tex);
    if (this.autoRange) {
      // paint out to about 8x the flight height: covers the footprint, cuts the horizon smear
      const top = Math.max(...entry.flight.samples.map((s) => s.pos[1]));
      this.projector.setOptions({ maxDistance: Math.min(5000, Math.max(30, top * 8)) });
    }
    this.lens = entry.layer.lens;
    this.projector.setLens(entry.layer.lens);
    this.frustumRays = frustumRays(entry.layer.lens);
    const onPlay = () => {
      this.hold ??= this.handle.holdContinuous('video playback');
    };
    const onStop = () => {
      this.hold?.();
      this.hold = null;
      this.handle.requestRender();
    };
    const v = player.video;
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onStop);
    v.addEventListener('seeked', onStop);
    v.addEventListener('loadeddata', onStop);
    this.playerOff = () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onStop);
      v.removeEventListener('seeked', onStop);
      v.removeEventListener('loadeddata', onStop);
    };
    if (player.playing) onPlay();
  }

  private readonly frame = () => {
    const s = videoStore().getState();
    const entry = this.activeId ? this.clips.get(this.activeId) : undefined;
    const flight = entry?.flight;
    for (const path of this.paths.values()) {
      let shown = false;
      let userHidden = true;
      for (const id of path.clips) {
        if (this.clips.get(id)?.visible === true && !s.hidden[id]) shown = true;
        if (!this.hiddenPathClips.has(id)) userHidden = false;
      }
      const wanted =
        this.pathMode === 'all' ||
        (this.pathMode === 'active' && s.activeClip !== null && path.clips.has(s.activeClip));
      path.line.visible = this.pathsOn && shown && wanted && !userHidden;
    }
    if (!entry || !flight || !this.player) {
      this.pose.valid = false;
      return;
    }
    const layerVisible = entry.visible && !s.hidden[entry.layer.id];
    const p = interpolatePose(flight.samples, s.nowMs - flight.startUtcMs);
    this.pose.pos.fromArray(p.pos);
    this.pose.q.fromArray(p.q);
    this.pose.valid = true;
    const win = this.player.window;
    const covered =
      this.player.status !== 'error' &&
      s.nowMs >= win.startMs &&
      (Number.isFinite(this.player.video.duration) ? s.nowMs <= win.endMs : true) &&
      this.player.video.readyState >= 2;

    const cam = this.handle.camera;
    const camDist = cam.position.distanceTo(this.pose.pos);
    const drone = this.mode === 'drone';

    // drone marker: heading from the camera, level body; gimbal carries the pitch
    const e = new Euler().setFromQuaternion(this.pose.q, 'YXZ');
    this.drone.position.copy(this.pose.pos);
    this.drone.quaternion.setFromEuler(new Euler(0, e.y, 0, 'YXZ'));
    if (this.gimbal) this.gimbal.rotation.x = e.x;
    if (this.player.playing) for (const pr of this.props) pr.rotation.y += 0.9;
    this.drone.scale.setScalar(Math.min(120, Math.max(1, (camDist * 0.03) / 0.35)));
    this.drone.visible = layerVisible && !drone;
    if (this.beacon) {
      this.beacon.visible = layerVisible && !drone;
      this.beacon.position.copy(this.pose.pos);
      const playing = this.player.playing;
      const k = playing ? 0.5 + 0.5 * Math.sin(performance.now() / 160) : 0;
      this.beacon.scale.setScalar(BEACON_SIZE * (1 + 0.35 * k));
      this.beacon.material.opacity = playing ? 0.95 - 0.45 * k : 0.8;
    }

    // frustum: border rays to a length that reads at this zoom, clipped at the ground plane
    this.updateFrustum(Math.min(400, Math.max(0.6, camDist * 0.12)));
    this.frustum.visible = layerVisible && !drone;

    // projector
    this.projector.setEnabled(this.projectionOn && layerVisible && covered);
    if (this.projector.enabled) {
      this.projector.setPose(this.pose.pos, this.pose.q);
      this.projector.attach(this.handle.projectionReceivers());
      this.projector.updateDepth(this.handle.renderer, this.handle.scene);
    }

    // camera modes
    const controls = controlsOf(this.handle);
    if (this.mode === 'follow') {
      if (this.lastPos) {
        const d = this.pose.pos.clone().sub(this.lastPos);
        cam.position.add(d);
        controls?.target.add(d);
      }
      this.lastPos = this.pose.pos.clone();
    } else if (drone && this.lens) {
      cam.position.copy(this.pose.pos);
      cam.quaternion.copy(this.pose.q);
      cam.up.set(0, 1, 0).applyQuaternion(this.pose.q);
      const vfov = (this.lens.hfovDeg / this.lens.aspect) * (Math.PI / 180);
      const pinV =
        this.lens.model === 'pinhole'
          ? 2 * Math.atan(Math.tan((this.lens.hfovDeg * Math.PI) / 360) / this.lens.aspect)
          : Math.min(vfov, (100 * Math.PI) / 180);
      const want = (pinV * 180) / Math.PI;
      if (Math.abs(cam.fov - want) > 1e-3 || cam.near > 0.05) {
        cam.fov = want;
        cam.near = 0.05;
        cam.updateProjectionMatrix();
      }
      cam.updateMatrixWorld();
      if (controls)
        controls.target.copy(this.pose.pos).add(new Vector3(0, 0, -1).applyQuaternion(this.pose.q));
    }
  };

  private updateFrustum(len: number) {
    const attr = this.frustum.geometry.getAttribute('position') as BufferAttribute;
    const arr = attr.array as Float32Array;
    const o = this.pose.pos;
    const pts = this.frustumRays.map((r) => {
      const d = r.clone().applyQuaternion(this.pose.q);
      let L = len;
      if (d.y < -1e-3) L = Math.min(L, o.y / -d.y);
      return o.clone().addScaledVector(d, Math.max(0, L));
    });
    let k = 0;
    const put = (v: Vector3) => {
      arr[k++] = v.x;
      arr[k++] = v.y;
      arr[k++] = v.z;
    };
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      put(pts[i] ?? o);
      put(pts[(i + 1) % n] ?? o);
    }
    for (let i = 0; i < n; i += n / 4) {
      put(o);
      put(pts[i] ?? o);
    }
    this.frustum.geometry.setDrawRange(0, k / 3);
    attr.needsUpdate = true;
  }

  dispose() {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.playerOff?.();
    if (this.activeId) releasePlayer(this.activeId);
    this.hold?.();
    this.texture?.dispose();
    this.beacon?.material.map?.dispose();
    this.beacon?.material.dispose();
    this.projector.dispose();
    this.handle.scene.remove(this.group);
    this.group.traverse((o) => {
      const m = o as Partial<Line>;
      m.geometry?.dispose();
    });
    this.handle.requestRender();
  }
}

const rigs = new WeakMap<SceneHandle, VideoRig>();

/** The video rig of a scene, created on first use. */
export function videoRig(handle: SceneHandle): VideoRig {
  let rig = rigs.get(handle);
  if (!rig) {
    rig = new VideoRig(handle);
    rigs.set(handle, rig);
  }
  return rig;
}

/** Follow-cam and drone-eye views for the UI. */
export function setCameraMode(handle: SceneHandle, mode: CameraMode): void {
  videoRig(handle).setCameraMode(mode);
}

/**
 * Flight paths for the UI: all, the active clip's flight only, or none, plus clips whose path is
 * hidden. Remembered for the scene, so a rig built later (next project) starts with it.
 */
export function setFlightPaths(handle: SceneHandle, o: FlightPathOptions): void {
  pathChoice.set(handle, { ...pathChoice.get(handle), ...o });
  rigs.get(handle)?.setFlightPaths(o);
}

/** Projection opacity, vignette and on/off for the UI. */
export function setProjection(
  handle: SceneHandle,
  o: Partial<ProjectorOptions> & { enabled?: boolean; paths?: boolean },
): void {
  const rig = videoRig(handle);
  const { enabled, paths, ...rest } = o;
  if (enabled !== undefined) rig.projectionOn = enabled;
  if (paths !== undefined) rig.pathsOn = paths;
  if (rest.maxDistance !== undefined) rig.autoRange = false;
  rig.projector.setOptions(rest);
  handle.requestRender();
}

let registered = false;

/**
 * Registers the `video` layer adapter with @aio/engine: flight path, drone marker and frustum,
 * and the projector that drapes the active clip's frame on `projectionReceivers()`.
 */
export function registerVideoAdapters(): void {
  if (registered) return;
  registered = true;
  registerAdapter({
    kind: 'video',
    create(layer, ctx): Promise<LayerHandle> {
      const rig = videoRig(ctx.scene);
      const ready = rig.addLayer(layer, ctx);
      const handle: LayerHandle = {
        setVisible: (v) => {
          rig.setLayerVisible(layer.id, v);
        },
        dispose: () => {
          rig.removeLayer(layer.id);
          if (rig.size === 0) {
            rig.dispose();
            rigs.delete(ctx.scene);
          }
        },
      };
      return ready.then(() => handle);
    },
  });
}
