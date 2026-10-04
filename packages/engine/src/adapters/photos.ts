import type { Layer, PhotoRef } from '@aio/schema';
import { workspace as appWorkspace, type Workspace } from '@aio/workspace';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
} from 'three';
import type { StoreApi } from 'zustand/vanilla';
import { PALETTE } from '../palette';
import type { LayerAdapter, LayerHandle } from '../types';
import { MARKER_GLYPH, markerTexture } from './marker';

type PhotosLayer = Extract<Layer, { kind: 'photos' }>;
export type PosedPhoto = PhotoRef & {
  pos: [number, number, number];
  q: [number, number, number, number];
};

const DEG = Math.PI / 180;
const CLICK_SLOP_PX = 5;

/** Photos with a camera pose; the others cannot be drawn in 3D. */
export function posedPhotos(items: readonly PhotoRef[]): PosedPhoto[] {
  return items.filter((p): p is PosedPhoto => p.pos !== undefined && p.q !== undefined);
}

/** Photos with a place in the scene: posed ones, and ones with a position but no orientation. */
export type LocatedPhoto = PhotoRef & { pos: [number, number, number] };

export function locatedPhotos(items: readonly PhotoRef[]): LocatedPhoto[] {
  return items.filter((p): p is LocatedPhoto => p.pos !== undefined);
}

type Vec3 = readonly [number, number, number];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Median distance from each point to its nearest other point (sampled above 400 points). */
function medianNearest(positions: readonly Vec3[]): number | null {
  const sample =
    positions.length > 400
      ? positions.filter((_, i) => i % Math.ceil(positions.length / 400) === 0)
      : positions;
  const nearest: number[] = [];
  for (const a of sample) {
    let best = Infinity;
    for (const b of positions) {
      if (a === b) continue;
      const d = dist(a, b);
      if (d > 1e-4 && d < best) best = d;
    }
    if (Number.isFinite(best)) nearest.push(best);
  }
  if (!nearest.length) return null;
  nearest.sort((x, y) => x - y);
  return nearest[Math.floor(nearest.length / 2)] ?? null;
}

/** Share of the set's bounding-box diagonal a frustum is at least drawn at. */
const SPREAD_SHARE = 1 / 120;

/**
 * Frustum depth that reads at the spacing of the photos: 60 % of the median distance from each
 * photo to its nearest neighbour, so neighbouring frustums barely touch, but at least 1/120 of the
 * set's extent. Drones shoot photos in bursts from one hover point (centimetres apart), so the
 * spacing alone would shrink frustums over a kilometre-wide site to a few centimetres. Metres.
 */
export function frustumDepth(positions: readonly Vec3[]): number {
  if (positions.length < 2) return 1;
  const median = medianNearest(positions) ?? 1;
  const range = (k: 0 | 1 | 2) => {
    const v = positions.map((p) => p[k]);
    return Math.max(...v) - Math.min(...v);
  };
  const spread = Math.hypot(range(0), range(1), range(2));
  return Math.min(20, Math.max(0.08, median * 0.6, spread * SPREAD_SHARE));
}

/** Photos taken from (about) one point: the first one's position and the indices of all. */
export interface PhotoStation {
  pos: [number, number, number];
  photos: number[];
}

/** Groups photos whose positions lie within `radius` of a station's first photo, in order. */
export function photoStations(
  photos: readonly { pos: readonly [number, number, number] }[],
  radius: number,
): PhotoStation[] {
  const stations: PhotoStation[] = [];
  photos.forEach((p, i) => {
    const s = stations.find((st) => dist(st.pos, p.pos) <= radius);
    if (s) s.photos.push(i);
    else stations.push({ pos: [p.pos[0], p.pos[1], p.pos[2]], photos: [i] });
  });
  return stations;
}

/** Stations further apart than this many frustum depths are lost in the scene without a pin. */
const PIN_SPACING = 8;

/**
 * True when the frustums alone would be lost: stations sit many frustum depths apart (a few
 * photos over a site), unlike a dense set that outlines an asset from inside or around it.
 */
export function needsPins(stations: readonly PhotoStation[], depth: number): boolean {
  if (stations.length < 2) return stations.length === 1;
  const spacing = medianNearest(stations.map((s) => s.pos)) ?? 0;
  return spacing > PIN_SPACING * depth;
}

/** Half extents of the image plane at depth 1 for a lens (wide lenses drawn at 100 degrees). */
export function imageHalfExtents(lens: PhotoRef['lens']): [number, number] {
  const hfov = Math.min(100, lens?.hfovDeg ?? 70);
  const aspect = lens?.aspect ?? 4 / 3;
  const hx = Math.tan((hfov * DEG) / 2);
  return [hx, hx / aspect];
}

/** Unit frustum (apex at the origin, image plane at z = -1, looking down -Z like three cameras). */
function frustumLines(hx: number, hy: number): Float32Array {
  const c = [
    [-hx, hy, -1],
    [hx, hy, -1],
    [hx, -hy, -1],
    [-hx, -hy, -1],
  ] as const;
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    if (!a || !b) continue;
    out.push(0, 0, 0, ...a, ...a, ...b);
  }
  // a tick on the top edge marks "up" in the image
  out.push(-hx * 0.3, hy, -1, 0, hy * 1.35, -1, 0, hy * 1.35, -1, hx * 0.3, hy, -1);
  return new Float32Array(out);
}

function imageQuad(hx: number, hy: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-hx, hy, -1, hx, hy, -1, hx, -hy, -1, -hx, -hy, -1]), 3),
  );
  g.setIndex([0, 2, 1, 0, 3, 2]);
  g.computeBoundingSphere();
  return g;
}

/** Instance transform: the photo pose, scaled to the frustum depth. */
export function photoMatrix(p: PosedPhoto, depth: number, out = new Matrix4()): Matrix4 {
  return out.compose(
    new Vector3(...p.pos),
    new Quaternion(...p.q),
    new Vector3(depth, depth, depth),
  );
}

/** Pin size as a share of the viewport height (sprites without size attenuation), as panoramas. */
const PIN = 0.034;
const PIN_HOVER = 0.042;
const BASE = new Color(PALETTE.hover);
const SELECTED = new Color(PALETTE.acc);

/**
 * `photos` layers: every posed photo as a small camera frustum. One merged line draw for the
 * outlines and one instanced mesh for the image planes, which is also what clicks hit. Where the
 * frustums would be lost at the scale of the scene (a few photos over a site) every station gets
 * a pin with a stem to the ground, as panoramas do; photos with a position but no orientation
 * always get one. A click on a frustum or pin selects the photo in the workspace
 * (`{ kind: 'photo', id, layer }`); the selected photo is drawn in the accent colour.
 */
export function createPhotosAdapter(
  store: StoreApi<Workspace> = appWorkspace,
): LayerAdapter<'photos'> {
  return {
    kind: 'photos',
    create(layer: PhotosLayer, ctx): Promise<LayerHandle> {
      const photos = posedPhotos(layer.items);
      const located = locatedPhotos(layer.items);
      const scene = ctx.scene;
      const group = new Group();
      group.name = `photos:${layer.id}`;
      group.userData.aioLayer = layer.id;
      const depth = frustumDepth(located.map((p) => p.pos));
      const [hx, hy] = imageHalfExtents(photos[0]?.lens);

      // outlines: one LineSegments with every frustum baked in
      const unit = frustumLines(hx, hy);
      const pos = new Float32Array(unit.length * photos.length);
      const m = new Matrix4();
      const v = new Vector3();
      photos.forEach((p, i) => {
        photoMatrix(p, depth, m);
        for (let k = 0; k < unit.length; k += 3) {
          v.set(unit[k] ?? 0, unit[k + 1] ?? 0, unit[k + 2] ?? 0).applyMatrix4(m);
          pos.set([v.x, v.y, v.z], i * unit.length + k);
        }
      });
      const lineGeo = new BufferGeometry();
      lineGeo.setAttribute('position', new BufferAttribute(pos, 3));
      lineGeo.computeBoundingSphere();
      const lineMat = new LineBasicMaterial({
        color: PALETTE.hover,
        transparent: true,
        opacity: 0.55,
        clippingPlanes: scene.clippingPlanes,
      });
      const lines = new LineSegments(lineGeo, lineMat);
      lines.renderOrder = 4;
      // a faint ghost through walls, so photos taken inside an asset show where they were taken
      const ghostMat = new LineBasicMaterial({
        color: PALETTE.hover,
        transparent: true,
        opacity: 0.12,
        depthTest: false,
        depthWrite: false,
        clippingPlanes: scene.clippingPlanes,
      });
      const ghost = new LineSegments(lineGeo, ghostMat);
      ghost.renderOrder = 3;

      // image planes: instanced, for picking and the selected highlight
      const quad = imageQuad(hx, hy);
      const fillMat = new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.16,
        side: DoubleSide,
        depthWrite: false,
        clippingPlanes: scene.clippingPlanes,
      });
      const planes = new InstancedMesh(quad, fillMat, Math.max(1, photos.length));
      planes.count = photos.length;
      photos.forEach((p, i) => {
        planes.setMatrixAt(i, photoMatrix(p, depth, m));
        planes.setColorAt(i, BASE);
      });
      planes.instanceMatrix.needsUpdate = true;
      planes.computeBoundingSphere();
      planes.renderOrder = 4;
      group.add(ghost, lines, planes);

      // pins: a marker per station (photos shot from one hover point) with a stem to the ground,
      // drawn over everything at a fixed screen size, where frustums alone would be lost (a few
      // photos over a site) and for photos with a position but no orientation
      const stations = photoStations(located, depth);
      const pinAll = needsPins(stations, depth);
      const pinned = stations.filter(
        (st) => pinAll || st.photos.some((i) => located[i]?.q === undefined),
      );
      const texOff = pinned.length ? markerTexture(MARKER_GLYPH.photo, false) : null;
      const texOn = pinned.length ? markerTexture(MARKER_GLYPH.photo, true) : null;
      const pins = pinned.map((st, i) => {
        const pin = new Sprite(
          new SpriteMaterial({
            map: texOff,
            color: texOff ? 0xffffff : PALETTE.hover,
            depthTest: false,
            depthWrite: false,
            sizeAttenuation: false,
            transparent: true,
          }),
        );
        pin.position.set(...st.pos);
        pin.scale.set(PIN, PIN, 1);
        pin.renderOrder = 30;
        pin.userData.pinIndex = i;
        pin.name = `photo-pin:${located[st.photos[0] ?? 0]?.id ?? i}`;
        return pin;
      });
      const stemGeo = new BufferGeometry();
      stemGeo.setAttribute(
        'position',
        new BufferAttribute(
          new Float32Array(pinned.flatMap(({ pos: [x, y, z] }) => [x, y, z, x, Math.min(0, y), z])),
          3,
        ),
      );
      stemGeo.computeBoundingSphere();
      const stemMat = new LineBasicMaterial({
        color: PALETTE.hover,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
      const stems = new LineSegments(stemGeo, stemMat);
      stems.renderOrder = 3;
      if (pins.length) group.add(stems, ...pins);
      scene.scene.add(group);

      let hoveredPin = -1;
      let selectedPin = -1;
      const paintPin = (i: number) => {
        const pin = pins[i];
        if (!pin) return;
        const on = i === hoveredPin || i === selectedPin;
        pin.material.map = on ? texOn : texOff;
        pin.material.color.set(texOff ? 0xffffff : on ? PALETTE.acc : PALETTE.hover);
        const k = i === hoveredPin ? PIN_HOVER : PIN;
        pin.scale.set(k, k, 1);
      };

      // selection highlight
      let selected = -1;
      const paint = () => {
        const s = store.getState().selection;
        const mine = s?.kind === 'photo' && (s.layer === undefined || s.layer === layer.id);
        const j = mine ? located.findIndex((p) => p.id === s.id) : -1;
        const pin = j >= 0 ? pinned.findIndex((st) => st.photos.includes(j)) : -1;
        if (pin !== selectedPin) {
          const was = selectedPin;
          selectedPin = pin;
          paintPin(was);
          paintPin(pin);
          scene.requestRender();
        }
        const i = mine ? photos.findIndex((p) => p.id === s.id) : -1;
        if (i === selected) return;
        if (selected >= 0) planes.setColorAt(selected, BASE);
        if (i >= 0) planes.setColorAt(i, SELECTED);
        selected = i;
        if (planes.instanceColor) planes.instanceColor.needsUpdate = true;
        scene.requestRender();
      };
      paint();
      const unsub = store.subscribe((s, prev) => {
        if (s.selection !== prev.selection) paint();
      });

      // clicks: the nearest image plane in front of any other content
      const el = scene.renderer.domElement;
      const rc = new Raycaster();
      let down: { x: number; y: number } | null = null;
      const ndc = (e: PointerEvent): [number, number] => {
        const r = el.getBoundingClientRect();
        return [
          ((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1,
        ];
      };
      /** Index of the pin under a pointer (pins draw over everything), or -1. */
      const pickPin = (x: number, y: number): number => {
        if (!pins.length || !group.visible) return -1;
        rc.setFromCamera(new Vector2(x, y), scene.camera);
        const i = rc.intersectObjects(pins, false)[0]?.object.userData.pinIndex as
          number | undefined;
        return i ?? -1;
      };
      let hoverRaf = 0;
      let hoverEvent: PointerEvent | null = null;
      const onMove = (e: PointerEvent) => {
        if (!pins.length || e.pointerType !== 'mouse' || e.buttons !== 0) return;
        hoverEvent = e;
        if (hoverRaf) return;
        // after the stage's own hover frame, so the pin cursor wins
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = 0;
          const ev = hoverEvent;
          if (!ev) return;
          const i = pickPin(...ndc(ev));
          if (i !== hoveredPin) {
            const was = hoveredPin;
            hoveredPin = i;
            paintPin(was);
            paintPin(i);
            scene.requestRender();
          }
          if (i >= 0) el.style.cursor = 'pointer';
        });
      };
      const onLeave = () => {
        hoverEvent = null;
        if (hoveredPin < 0) return;
        const was = hoveredPin;
        hoveredPin = -1;
        paintPin(was);
        scene.requestRender();
      };
      const onDown = (e: PointerEvent) => {
        down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
      };
      const onUp = (e: PointerEvent) => {
        const d = down;
        down = null;
        if (!d || !group.visible || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX)
          return;
        const [x, y] = ndc(e);
        const station = pinned[pickPin(x, y)];
        const first = station && located[station.photos[0] ?? -1];
        if (first) {
          store.getState().select({ kind: 'photo', id: first.id, layer: layer.id });
          return;
        }
        rc.setFromCamera(new Vector2(x, y), scene.camera);
        const hit = rc.intersectObject(planes, false)[0];
        if (hit?.instanceId === undefined) return;
        const behind = scene.raycast(x, y);
        if (behind && behind.object !== planes && behind.distance < hit.distance - depth * 0.5)
          return;
        const photo = photos[hit.instanceId];
        if (photo) store.getState().select({ kind: 'photo', id: photo.id, layer: layer.id });
      };
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerleave', onLeave);
      scene.requestRender();

      return Promise.resolve({
        setVisible(visible: boolean) {
          group.visible = visible;
          scene.requestRender();
        },
        dispose() {
          unsub();
          el.removeEventListener('pointerdown', onDown);
          el.removeEventListener('pointerup', onUp);
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerleave', onLeave);
          cancelAnimationFrame(hoverRaf);
          scene.scene.remove(group);
          for (const pin of pins) pin.material.dispose();
          texOff?.dispose();
          texOn?.dispose();
          stemGeo.dispose();
          stemMat.dispose();
          lineGeo.dispose();
          lineMat.dispose();
          ghostMat.dispose();
          quad.dispose();
          fillMat.dispose();
          planes.dispose();
          scene.requestRender();
        },
      });
    },
  };
}

export const photosAdapter = createPhotosAdapter();
