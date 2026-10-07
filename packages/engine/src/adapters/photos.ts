import type { Layer, PhotoRef } from '@aio/schema';
import { workspace as appWorkspace, type Workspace } from '@aio/workspace';
import {
  Box3,
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
  Vector2,
  Vector3,
} from 'three';
import type { StoreApi } from 'zustand/vanilla';
import { PALETTE } from '../palette';
import type { LayerAdapter, LayerHandle } from '../types';
import { MarkerLayer } from './markers';

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

/** Photos taken within this many metres of each other share one marker (one per place). */
export const STATION_M = 1.5;
const BASE = new Color(PALETTE.hover);
const SELECTED = new Color(PALETTE.acc);

/**
 * `photos` layers: every posed photo as a small camera frustum. One merged line draw for the
 * outlines and one instanced mesh for the image planes, which is also what clicks hit. Every place
 * photos were taken from gets one marker (photos within STATION_M share it; icons that would
 * overlap on screen merge with a count, see MarkerLayer); where the frustums would be lost at the
 * scale of the scene (a few photos over a site) the places also get a stem to the ground. A click
 * on a frustum or a single marker selects the photo in the workspace; a merged marker lists its
 * photos
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
      planes.name = 'photo-planes';
      // which photo an instance is (right-click menus)
      planes.userData.photoIds = photos.map((p) => p.id);
      group.userData.photosLayer = layer.id;
      group.add(ghost, lines, planes);

      // markers: one icon per place (photos taken within STATION_M of each other), merged further
      // on screen where icons would overlap, with a count; sparse sets get a stem to the ground
      const stations = photoStations(located, STATION_M);
      const stemmed = needsPins(photoStations(located, depth), depth)
        ? stations
        : stations.filter((st) => st.photos.some((i) => located[i]?.q === undefined));
      const stemGeo = new BufferGeometry();
      stemGeo.setAttribute(
        'position',
        new BufferAttribute(
          new Float32Array(
            stemmed.flatMap(({ pos: [x, y, z] }) => [x, y, z, x, Math.min(0, y), z]),
          ),
          3,
        ),
      );
      stemGeo.computeBoundingSphere();
      const stemMat = new LineBasicMaterial({
        color: PALETTE.hover,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      });
      const stems = new LineSegments(stemGeo, stemMat);
      stems.name = 'photo-stems';
      stems.renderOrder = 3;
      if (stemmed.length) group.add(stems);
      scene.scene.add(group);

      const selectedIds = new Set<number>();
      const select = (i: number) => {
        const p = located[i];
        if (p) store.getState().select({ kind: 'photo', id: p.id, layer: layer.id });
      };
      const markers = new MarkerLayer({
        scene,
        kind: 'photo',
        sites: stations.map((st) => ({ pos: st.pos, members: st.photos })),
        member: (i) => {
          const p = located[i];
          const full = p ? ctx.url(p.src) : undefined;
          return {
            id: p?.id ?? '',
            takenAt: p?.takenAt,
            full,
            thumb: full?.startsWith('aio://project/')
              ? full.replace(/^aio:\/\/project\//, 'aio://thumb/')
              : undefined,
          };
        },
        open: select,
        selected: () => selectedIds,
      });

      // the photos under a pointer on a marker (right-click menus): a merged marker lists them all
      group.userData.photoIdsAt = (x: number, y: number): string[] | null =>
        group.visible
          ? (markers.membersAt(x, y)?.flatMap((i) => (located[i] ? [located[i].id] : [])) ?? null)
          : null;

      // selection highlight
      let selected = -1;
      const paint = () => {
        const s = store.getState().selection;
        const mine = s?.kind === 'photo' && (s.layer === undefined || s.layer === layer.id);
        const j = mine ? located.findIndex((p) => p.id === s.id) : -1;
        selectedIds.clear();
        if (j >= 0) selectedIds.add(j);
        markers.refresh();
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

      // clicks on a frustum: the nearest image plane in front of any other content (the markers
      // claim their own clicks)
      const el = scene.renderer.domElement;
      const rc = new Raycaster();
      let down: { x: number; y: number } | null = null;
      const onDown = (e: PointerEvent) => {
        down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
      };
      const onUp = (e: PointerEvent) => {
        const d = down;
        down = null;
        if (!d || !group.visible || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX)
          return;
        if (markers.hits(e.clientX, e.clientY)) return;
        const r = el.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 2 - 1;
        const y = -((e.clientY - r.top) / r.height) * 2 + 1;
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
      // where the photos were taken frames the view while there is no model or cloud
      const placed = new Box3().setFromPoints(located.map((p) => new Vector3(...p.pos)));
      const unbound = scene.addContentBounds(() =>
        group.visible && !placed.isEmpty() ? placed : null,
      );
      scene.requestRender();

      return Promise.resolve({
        setVisible(visible: boolean) {
          group.visible = visible;
          markers.setVisible(visible);
          scene.requestRender();
        },
        dispose() {
          unsub();
          unbound();
          markers.dispose();
          el.removeEventListener('pointerdown', onDown);
          el.removeEventListener('pointerup', onUp);
          scene.scene.remove(group);
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
