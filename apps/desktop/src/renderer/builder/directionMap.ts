import type { CameraDirection } from '@aio/geo';
import type { MapController } from '@aio/maps';
import type { LensModel, Quat, Vec3 } from '@aio/schema';
import { imageToRay } from '@aio/video';
import { Quaternion, Vector3 } from 'three';
import { drapeMesh, drawDrape, type LonLat } from './directionDrape';
import { angleDelta, headingTo, pitchForFarEdge } from './directionModel';

type MapLike = MapController['map'];

interface Projection {
  toLonLat(local: Vec3): [number, number];
  toLocal(lon: number, lat: number): Vec3;
}

export interface DirectionMapState {
  /** The camera now (calibrated position, direction in use), or null. */
  pose: { pos: Vec3; q: Quat } | null;
  /** Its heading, pitch and roll. */
  dir: CameraDirection | null;
  lens: LensModel;
  /** The picture to drape (a video frame, a photo) and its size, when it has one. */
  frame: { source: CanvasImageSource; width: number; height: number } | null;
  opacity: number;
  /** A look-at target to mark, local frame. */
  target: Vec3 | null;
  /** Clicks on the map pick a look-at target. */
  picking: boolean;
}

export interface DirectionMapEvents {
  /** The camera was turned on the map. */
  turn(patch: Partial<CameraDirection>): void;
  /** A drag starts or ends (one undo step per drag). */
  gesture(active: boolean): void;
  /** The map was clicked while picking: the ground point, local frame. */
  pick(local: Vec3): void;
}

const DRAPE = 'aio-dir-drape';
const HANDLE = 'aio-dir-handle';
/** The live footprint the map controller draws (its fill takes the drags). */
const FOOTPRINT = 'aio-drone-footprint';
const EMPTY = { type: 'FeatureCollection' as const, features: [] };
const DOT: [LonLat, LonLat, LonLat, LonLat] = [
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
];
/** Rotate handle distance from the drone on screen, pixels. */
const HANDLE_PX = 90;
/** Longest edge of the frame copy the drape is drawn from. */
const FRAME_PX = 640;
/** Pitch change per wheel notch over the footprint, degrees. */
const WHEEL_DEG = 1;

interface Ev {
  lngLat: { lng: number; lat: number };
  point: { x: number; y: number };
  originalEvent: MouseEvent;
  preventDefault(): void;
}

type Drag =
  | { kind: 'heading'; startAngle: number; startYaw: number }
  | { kind: 'roll'; startAngle: number; startRoll: number }
  | { kind: 'pitch' };

/**
 * "Align camera to map" on the 2D map: the current video frame laid on the ground where the
 * camera sees it. Drag the footprint (or the round handle on its arm) to turn the heading around
 * the drone, Shift-drag to roll, drag the square handle on the far edge or scroll over the
 * footprint to tilt. Clicks pick a look-at target while asked to.
 */
export class DirectionMapOverlay {
  private readonly canvas = document.createElement('canvas');
  private readonly frame = document.createElement('canvas');
  private state: DirectionMapState | null = null;
  private drag: Drag | null = null;
  private raf = 0;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly map: MapLike,
    private readonly proj: Projection,
    private readonly on: DirectionMapEvents,
  ) {
    this.canvas.width = this.canvas.height = 2;
    const before = map.getLayer('aio-flights-line') ? 'aio-flights-line' : undefined;
    map.addSource(DRAPE, { type: 'canvas', canvas: this.canvas, coordinates: DOT, animate: true });
    map.addLayer(
      {
        id: DRAPE,
        type: 'raster',
        source: DRAPE,
        paint: { 'raster-opacity': 0.6, 'raster-fade-duration': 0 },
      },
      before,
    );
    map.addSource(HANDLE, { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: `${HANDLE}-line`,
      type: 'line',
      source: HANDLE,
      filter: ['==', ['get', 'role'], 'arm'],
      paint: { 'line-color': '#ffd166', 'line-width': 2, 'line-dasharray': [2, 1.5] },
    });
    map.addLayer({
      id: `${HANDLE}-target`,
      type: 'circle',
      source: HANDLE,
      filter: ['==', ['get', 'role'], 'target'],
      paint: {
        'circle-radius': 6,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#ff7b72',
        'circle-stroke-width': 2.5,
      },
    });
    map.addLayer({
      id: `${HANDLE}-tilt`,
      type: 'circle',
      source: HANDLE,
      filter: ['==', ['get', 'role'], 'tilt'],
      paint: {
        'circle-radius': 6,
        'circle-color': '#73ebc8',
        'circle-stroke-color': '#1b1f24',
        'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: `${HANDLE}-pt`,
      type: 'circle',
      source: HANDLE,
      filter: ['==', ['get', 'role'], 'handle'],
      paint: {
        'circle-radius': 8,
        'circle-color': '#ffd166',
        'circle-stroke-color': '#1b1f24',
        'circle-stroke-width': 2,
      },
    });

    const ground = (e: Ev) => this.proj.toLocal(e.lngLat.lng, e.lngLat.lat);
    const hits = (e: Ev, layer: string) =>
      !!map.getLayer(layer) &&
      map.queryRenderedFeatures([e.point.x, e.point.y], { layers: [layer] }).length > 0;
    const begin = (e: Ev, drag: Drag) => {
      e.preventDefault();
      this.drag = drag;
      map.dragPan.disable();
      this.on.gesture(true);
    };
    const down = (e: Ev) => {
      const s = this.state;
      if (!s?.pose || !s.dir || s.picking || e.originalEvent.button !== 0) return;
      const angle = headingTo(s.pose.pos, ground(e));
      if (hits(e, `${HANDLE}-tilt`)) begin(e, { kind: 'pitch' });
      else if (hits(e, `${HANDLE}-pt`))
        begin(e, { kind: 'heading', startAngle: angle, startYaw: s.dir.yaw });
      else if (hits(e, FOOTPRINT)) {
        if (e.originalEvent.shiftKey)
          begin(e, { kind: 'roll', startAngle: angle, startRoll: s.dir.roll });
        else begin(e, { kind: 'heading', startAngle: angle, startYaw: s.dir.yaw });
      }
    };
    const move = (e: Ev) => {
      const s = this.state;
      const d = this.drag;
      if (!d || !s?.pose) return;
      const p = ground(e);
      if (d.kind === 'pitch') {
        const dist = Math.hypot(p[0] - s.pose.pos[0], p[2] - s.pose.pos[2]);
        this.on.turn({ pitch: pitchForFarEdge(s.pose.pos[1], dist, s.lens) });
        return;
      }
      const delta = angleDelta(d.startAngle, headingTo(s.pose.pos, p));
      if (d.kind === 'heading') this.on.turn({ yaw: d.startYaw + delta });
      else this.on.turn({ roll: Math.max(-180, Math.min(180, d.startRoll + delta)) });
    };
    const up = () => {
      if (!this.drag) return;
      this.drag = null;
      map.dragPan.enable();
      this.on.gesture(false);
    };
    const hover = (e: Ev) => {
      if (this.drag) return;
      const s = this.state;
      const c = map.getCanvas().style;
      if (s?.picking) c.cursor = 'crosshair';
      else if (hits(e, `${HANDLE}-tilt`)) c.cursor = 'ns-resize';
      else if (hits(e, `${HANDLE}-pt`) || hits(e, FOOTPRINT)) c.cursor = 'grab';
      else c.cursor = '';
    };
    const click = (e: Ev) => {
      if (!this.state?.picking) return;
      const p = ground(e);
      this.on.pick([p[0], 0, p[2]]);
    };
    const wheel = (e: Ev & { originalEvent: WheelEvent }) => {
      const s = this.state;
      if (!s?.dir || !hits(e, FOOTPRINT)) return;
      e.preventDefault();
      const step = e.originalEvent.deltaY > 0 ? -WHEEL_DEG : WHEEL_DEG;
      this.on.gesture(true);
      this.on.turn({ pitch: Math.max(-90, Math.min(30, s.dir.pitch + step)) });
      this.on.gesture(false);
    };
    const redraw = () => {
      this.schedule();
    };
    const ons: [string, (e: never) => void][] = [
      ['mousedown', down],
      ['mousemove', move],
      ['mousemove', hover],
      ['mouseup', up],
      ['click', click],
      ['wheel', wheel],
      ['zoom', redraw],
    ];
    for (const [type, fn] of ons) map.on(type as 'click', fn as never);
    this.offs.push(() => {
      for (const [type, fn] of ons) map.off(type as 'click', fn as never);
      if (this.drag) map.dragPan.enable();
    });
  }

  /** Draw the camera, frame and handles as they are now (once per animation frame). */
  update(state: DirectionMapState): void {
    this.state = state;
    this.schedule();
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw() {
    const s = this.state;
    const map = this.map;
    if (!s || !map.getSource(DRAPE)) return;
    if (map.getLayer(DRAPE)) map.setPaintProperty(DRAPE, 'raster-opacity', s.opacity);
    const handle = map.getSource(HANDLE) as { setData(d: unknown): void } | undefined;
    const drape = map.getSource(DRAPE) as
      { setCoordinates(c: LonLat[]): void; play?(): void } | undefined;
    const features: unknown[] = [];
    const point = (role: string, p: Vec3) => ({
      type: 'Feature',
      properties: { role },
      geometry: { type: 'Point', coordinates: this.proj.toLonLat(p) },
    });
    if (s.target) features.push(point('target', s.target));
    const pose = s.pose;
    if (pose) {
      const q = new Quaternion(...pose.q);
      const f = new Vector3(0, 0, -1).applyQuaternion(q);
      const h = Math.hypot(f.x, f.z);
      const at = this.proj.toLonLat(pose.pos);
      const mpp = (40_075_016.686 * Math.cos((at[1] * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
      const len = HANDLE_PX * mpp;
      const dx = h > 1e-6 ? f.x / h : 0;
      const dz = h > 1e-6 ? f.z / h : -1;
      const tip: Vec3 = [pose.pos[0] + dx * len, 0, pose.pos[2] + dz * len];
      features.push(
        {
          type: 'Feature',
          properties: { role: 'arm' },
          geometry: { type: 'LineString', coordinates: [at, this.proj.toLonLat(tip)] },
        },
        point('handle', tip),
      );
      // the tilt handle: where the middle of the frame's top edge meets the ground
      const top = new Vector3(...imageToRay(s.lens, 0.5, 0)).applyQuaternion(q);
      const reach = Math.min(3000, Math.max(50, pose.pos[1] * 8));
      const along = top.y < -1e-6 ? Math.min(reach, pose.pos[1] / -top.y) : reach;
      const far: Vec3 = [pose.pos[0] + top.x * along, 0, pose.pos[2] + top.z * along];
      features.push(point('tilt', far));
    }
    handle?.setData({ type: 'FeatureCollection', features });

    const v = s.frame;
    const mesh =
      pose && v && v.width > 0 && v.height > 0
        ? drapeMesh(pose, s.lens, (p) => this.proj.toLonLat(p))
        : null;
    if (!mesh || !v) {
      drape?.setCoordinates(DOT);
      return;
    }
    // a small copy of the frame: the drape draws it once per grid triangle
    const k = Math.min(1, FRAME_PX / Math.max(v.width, v.height));
    const fw = Math.max(1, Math.round(v.width * k));
    const fh = Math.max(1, Math.round(v.height * k));
    if (this.frame.width !== fw || this.frame.height !== fh) {
      this.frame.width = fw;
      this.frame.height = fh;
    }
    this.frame.getContext('2d')?.drawImage(v.source, 0, 0, fw, fh);
    if (this.canvas.width !== mesh.width || this.canvas.height !== mesh.height) {
      this.canvas.width = mesh.width;
      this.canvas.height = mesh.height;
    }
    const g = this.canvas.getContext('2d');
    if (g) drawDrape(g, this.frame, fw, fh, mesh);
    drape?.setCoordinates(mesh.corners);
    drape?.play?.();
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const off of this.offs) off();
    const map = this.map;
    map.getCanvas().style.cursor = '';
    for (const id of [
      DRAPE,
      `${HANDLE}-line`,
      `${HANDLE}-target`,
      `${HANDLE}-tilt`,
      `${HANDLE}-pt`,
    ])
      if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [DRAPE, HANDLE]) if (map.getSource(id)) map.removeSource(id);
  }
}
