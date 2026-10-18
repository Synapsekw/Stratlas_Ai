/**
 * Detected antennas in the 3D stage: a translucent box per unit coloured by kind, status by
 * outline style (never colour alone), a facing arrow, a highlight for the selected unit, and
 * picking a box with a click. Project E, N, Z map to the local frame as in the survey measure
 * scene (`../survey/measureScene`): x east, y up, z south.
 *
 * The inventory is stored in its survey date's own frame, like survey measurements: the boxes and
 * arrows are drawn moved by that date's line-up shift (`antennaShift`), as `measureDates`
 * `drawnPoints` moves a dated measurement.
 */
import type { EngineStage } from '@aio/engine';
import {
  type AntennaKind,
  type AntennasFile,
  type AntennaUnit,
  type DateShift,
  type ProjectManifest,
  type Vec3,
} from '@aio/schema';
import { t } from '@aio/ui';
import { captureShift, dateShiftOf } from '@aio/workspace';
import {
  BoxGeometry,
  BufferGeometry,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type Object3D,
} from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { Frame } from '../survey/measureScene';
import {
  antennaCentre,
  antennaMeasure,
  axisToLocal,
  facingTip,
  nameAnchor,
} from './antennaMeasure';
import { isAntennaDrawn, type AntennaLabelMode, type AntennaLabelSpot } from './antennaVisibility';

export const KIND_COLOURS: Record<AntennaKind, string> = {
  panel: '#4fb3ff',
  short: '#a78bfa',
  dish: '#34d399',
  other: '#f5a524',
};

export interface AntennaSceneState {
  file: AntennasFile | null;
  selected: string | null;
  hidden: Record<string, true>;
  /** Only this kind is drawn (the selected unit aside); absent or null: every kind. */
  solo?: AntennaKind | null;
  /** The line-up shift of the run's survey date (`antennaShift`); none when absent or null. */
  shift?: DateShift | null;
  /** Which labels show (the selected unit's always do); absent: 'all'. */
  labelMode?: AntennaLabelMode;
}

/**
 * How far the inventory is drawn from where it is stored: the line-up shift of the survey date
 * its cloud belongs to (the run's `captureId`, else the cloud layer's date in an older file), or
 * null when that date is not lined up or there is no open manifest.
 */
export function antennaShift(
  file: AntennasFile | null,
  manifest: Pick<ProjectManifest, 'captures' | 'layers'> | null,
): DateShift | null {
  if (!file || !manifest) return null;
  const { captureId, cloudLayer } = file.run;
  return captureId !== undefined
    ? captureShift(manifest, captureId)
    : dateShiftOf(manifest, cloudLayer);
}

const HIGHLIGHT_COLOUR = '#ffffff';
/** Scale of the selected unit's outline, a little outside the box so it reads as a halo. */
const HIGHLIGHT_SCALE = 1.08;
const CLICK_SLOP_PX = 4;
/** Fill opacity of the selected unit's box (others: 0.18, rejected 0.08). */
export const SELECTED_FILL = 0.35;
/** Width of the selected unit's edges, pixels. */
export const SELECTED_EDGE_PX = 3;
/** Render order of the selected unit's objects: over the other boxes, the GLB and the cloud. */
export const SELECTED_ORDER = 43;
/**
 * Render order of the selected unit's halo and dimension lines: transparent like the fill, and
 * drawn after it so the fill does not tint them and a blended GLB does not paint over them.
 */
export const SELECTED_OVERLAY_ORDER = 44;
const DIM_COLOUR = '#ffffff';

/** Whether the scene state draws this unit (`isAntennaDrawn`, solo absent counts as none). */
const drawn = (state: AntennaSceneState, unit: AntennaUnit): boolean =>
  isAntennaDrawn(
    { selected: state.selected, hidden: state.hidden, solo: state.solo ?? null },
    unit,
  );

/** A project axis (E, N, Z) as a local direction: x = E, y = Z, z = -N. */
const axisVector = (a: Vec3): Vector3 => new Vector3(...axisToLocal(a));

/** Orientation of the box in the local frame from its axes (across, up, outward). */
function orientation(box: AntennaUnit['box']): Quaternion {
  const x = axisVector(box.axes[0]);
  const y = axisVector(box.axes[1]);
  const z = axisVector(box.axes[2]);
  const m = new Matrix4().makeBasis(x, y, z);
  // A left-handed set of axes would shear the rotation: the box is symmetric, so flip outward.
  if (m.determinant() < 0) m.makeBasis(x, y, z.negate());
  return new Quaternion().setFromRotationMatrix(m);
}

/** Status by line style: solid accepted, dashed draft, short faint dashes rejected. */
function outlineOf(unit: AntennaUnit, edges: EdgesGeometry, colour: string): LineSegments {
  let material: LineBasicMaterial;
  if (unit.status === 'accepted') {
    material = new LineBasicMaterial({ color: colour });
  } else if (unit.status === 'draft') {
    material = new LineDashedMaterial({ color: colour, dashSize: 0.08, gapSize: 0.05 });
  } else {
    material = new LineDashedMaterial({
      color: colour,
      dashSize: 0.02,
      gapSize: 0.04,
      transparent: true,
      opacity: 0.35,
    });
  }
  const line = new LineSegments(edges.clone(), material);
  if (unit.status !== 'accepted') line.computeLineDistances();
  line.raycast = () => undefined;
  return line;
}

/** The facing arrow, as the measure scene's `addFacing`: shaft, then head at 0.25 / 0.15 of it. */
function facingOf(unit: AntennaUnit, centre: Vec3, colour: string): LineSegments | null {
  const tip = facingTip(unit, centre);
  if (!tip || !unit.azimuthGridDeg) return null;
  const az = (unit.azimuthGridDeg.value * Math.PI) / 180;
  const length = Math.max(0.5, Math.min(unit.heightM.value, 5));
  const dx = Math.sin(az);
  const dz = -Math.cos(az);
  // perpendicular to the direction in the horizontal plane
  const px = -dz;
  const pz = dx;
  const head = (s: number): Vec3 => [
    tip[0] - dx * length * 0.25 + px * length * 0.15 * s,
    centre[1],
    tip[2] - dz * length * 0.25 + pz * length * 0.15 * s,
  ];
  const g = new BufferGeometry();
  g.setAttribute(
    'position',
    new Float32BufferAttribute([...centre, ...tip, ...head(1), ...tip, ...head(-1), ...tip], 3),
  );
  const rejected = unit.status === 'rejected';
  const line = new LineSegments(
    g,
    new LineBasicMaterial({
      color: colour,
      depthTest: false,
      transparent: rejected,
      opacity: rejected ? 0.35 : 1,
    }),
  );
  line.frustumCulled = false;
  line.raycast = () => undefined;
  return line;
}

/** The selected unit's edges: thick screen-space lines, dashed by status as `outlineOf`. */
function selectedOutlineOf(unit: AntennaUnit, edges: EdgesGeometry, colour: string): LineSegments2 {
  const dashed = unit.status !== 'accepted';
  const rejected = unit.status === 'rejected';
  const material = new LineMaterial({
    color: colour,
    linewidth: SELECTED_EDGE_PX,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    dashed,
    dashSize: rejected ? 0.02 : 0.08,
    gapSize: rejected ? 0.04 : 0.05,
  });
  const line = new LineSegments2(new LineSegmentsGeometry().fromEdgesGeometry(edges), material);
  if (dashed) line.computeLineDistances();
  line.frustumCulled = false;
  line.raycast = () => undefined;
  return line;
}

/** The selected unit's dimension lines, white and drawn over everything. */
function dimensionsOf(unit: AntennaUnit, frame: Frame, shift: DateShift | null): LineSegments {
  const { segments } = antennaMeasure(unit, frame, shift);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(segments.flat(2), 3));
  const line = new LineSegments(
    g,
    new LineBasicMaterial({
      color: DIM_COLOUR,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 1,
    }),
  );
  line.name = `antenna-dim:${unit.id}`;
  line.renderOrder = SELECTED_OVERLAY_ORDER;
  line.frustumCulled = false;
  line.raycast = () => undefined;
  return line;
}

export function buildAntennaGroup(state: AntennaSceneState, frame: Frame): Group {
  const group = new Group();
  group.name = 'aio-telecom-antennas';
  group.renderOrder = 41;
  const shift = state.shift ?? null;
  for (const unit of state.file?.units ?? []) {
    if (!drawn(state, unit)) continue;
    const selected = state.selected === unit.id;
    const order = selected ? SELECTED_ORDER : 41;
    const colour = KIND_COLOURS[unit.kind];
    const [w, h, d] = unit.box.extents;
    const centre = antennaCentre(unit, frame, shift);
    const quat = orientation(unit.box);
    const boxGeometry = new BoxGeometry(w, h, d);
    const rejected = unit.status === 'rejected';

    const mesh = new Mesh(
      boxGeometry,
      new MeshBasicMaterial({
        color: colour,
        transparent: true,
        opacity: selected ? SELECTED_FILL : rejected ? 0.08 : 0.18,
        depthWrite: false,
        depthTest: !selected,
      }),
    );
    mesh.name = `antenna-box:${unit.id}`;
    mesh.userData.antennaId = unit.id;
    mesh.position.set(centre[0], centre[1], centre[2]);
    mesh.quaternion.copy(quat);
    mesh.renderOrder = order;
    group.add(mesh);

    const edges = new EdgesGeometry(boxGeometry);
    const outline = selected
      ? selectedOutlineOf(unit, edges, colour)
      : outlineOf(unit, edges, colour);
    outline.name = `antenna-outline:${unit.id}`;
    outline.position.copy(mesh.position);
    outline.quaternion.copy(quat);
    outline.renderOrder = order;
    group.add(outline);

    const arrow = facingOf(unit, centre, colour);
    if (arrow) {
      arrow.name = `antenna-facing:${unit.id}`;
      arrow.renderOrder = order;
      group.add(arrow);
    }

    if (selected) {
      const halo = new LineSegments(
        edges.clone(),
        new LineBasicMaterial({
          color: HIGHLIGHT_COLOUR,
          depthTest: false,
          transparent: true,
          opacity: 1,
        }),
      );
      halo.name = 'antenna-highlight';
      halo.userData.antennaId = unit.id;
      halo.position.copy(mesh.position);
      halo.quaternion.copy(quat);
      halo.scale.setScalar(HIGHLIGHT_SCALE);
      halo.renderOrder = SELECTED_OVERLAY_ORDER;
      halo.raycast = () => undefined;
      group.add(halo);
      group.add(dimensionsOf(unit, frame, shift));
    }
    edges.dispose();
  }
  return group;
}

/** A pin's text: the unit's number, the digits its name ends in ("14" of "A14"), else the name. */
export function unitNumber(name: string): string {
  return /(\d+)$/.exec(name)?.[1] ?? name;
}

/**
 * The labels the 3D view places: the selected unit's full measurement labels (name with height,
 * the three dimensions, the angles) in every mode, and in mode 'all' a numbered pin over every
 * other drawn unit, where its name would sit.
 */
export function antennaLabelSpots(state: AntennaSceneState, frame: Frame): AntennaLabelSpot[] {
  const shift = state.shift ?? null;
  const pins = (state.labelMode ?? 'all') === 'all';
  const spots: AntennaLabelSpot[] = [];
  for (const unit of state.file?.units ?? []) {
    if (!drawn(state, unit)) continue;
    if (state.selected === unit.id) {
      spots.push(...antennaMeasure(unit, frame, shift).spots);
      continue;
    }
    if (!pins) continue;
    spots.push({
      key: `${unit.id}:pin`,
      text: unitNumber(unit.name),
      at: nameAnchor(unit, frame, shift),
      kind: 'pin',
      selected: false,
      align: 'centre',
      unitId: unit.id,
      colour: KIND_COLOURS[unit.kind],
      title: t('telecom.antennas.labels.pin', {
        name: unit.name,
        kind: t(`telecom.antennas.card.kind.${unit.kind}`),
        status: t(`telecom.antennas.status.${unit.status}`),
      }),
    });
  }
  return spots;
}

/**
 * Whether two scene states draw the same thing (the same file, selection, visibility, labels mode
 * and shift).
 */
export function sameSceneState(a: AntennaSceneState, b: AntennaSceneState): boolean {
  return (
    a.file === b.file &&
    a.selected === b.selected &&
    a.hidden === b.hidden &&
    (a.solo ?? null) === (b.solo ?? null) &&
    (a.labelMode ?? 'all') === (b.labelMode ?? 'all') &&
    JSON.stringify(a.shift ?? null) === JSON.stringify(b.shift ?? null)
  );
}

/**
 * `antennaLabelSpots` computed once per drawn state: the labels and the card both ask on every
 * frame, and the spots change only when the state does.
 */
export function labelSpotsCache(frame: Frame): (state: AntennaSceneState) => AntennaLabelSpot[] {
  let last: { state: AntennaSceneState; spots: AntennaLabelSpot[] } | null = null;
  return (state) => {
    if (last && sameSceneState(last.state, state)) return last.spots;
    last = { state, spots: antennaLabelSpots(state, frame) };
    return last.spots;
  };
}

/** Give every fat-line material in the group the canvas size it is drawn at, CSS pixels. */
function setLineResolution(group: Group, width: number, height: number): void {
  group.traverse((o: Object3D) => {
    const mat = (o as Partial<Mesh>).material;
    if (mat instanceof LineMaterial) mat.resolution.set(width, height);
  });
}

function disposeGroup(group: Group): void {
  group.traverse((o: Object3D) => {
    const m = o as Partial<Mesh>;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat))
      mat.forEach((x) => {
        x.dispose();
      });
    else mat?.dispose();
  });
  group.clear();
}

const raycaster = new Raycaster();

/** The id of the unit whose box is under the cursor (normalised device coordinates), or null. */
export function pickAntennaAt(group: Group, camera: Camera, ndc: [number, number]): string | null {
  group.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  raycaster.setFromCamera(new Vector2(ndc[0], ndc[1]), camera);
  const hits = raycaster.intersectObjects(
    group.children.filter((c) => c instanceof Mesh),
    false,
  );
  const id: unknown = hits[0]?.object.userData.antennaId;
  return typeof id === 'string' ? id : null;
}

/** Draw the antennas in the stage and report a click on a box. Returns the detach. */
export function attachAntennaLayer(
  stage: EngineStage,
  frame: Frame,
  opts: {
    getState(): AntennaSceneState;
    subscribe(cb: () => void): () => void;
    onPick(id: string): void;
  },
): () => void {
  const canvas = stage.renderer.domElement;
  let size = { w: canvas.clientWidth, h: canvas.clientHeight };
  const build = (state: AntennaSceneState) => {
    const g = buildAntennaGroup(state, frame);
    setLineResolution(g, size.w, size.h);
    return g;
  };
  let built = opts.getState();
  let group = build(built);
  stage.scene.add(group);

  // a store change that draws nothing new (a note, the filter, a reveal) keeps the group
  const rebuild = () => {
    const next = opts.getState();
    if (sameSceneState(built, next)) return;
    built = next;
    stage.scene.remove(group);
    disposeGroup(group);
    group = build(next);
    stage.scene.add(group);
    stage.requestRender();
  };
  const off = opts.subscribe(rebuild);
  // fat lines are sized in screen pixels: follow the canvas when it is resized
  const offFrame = stage.onFrame(() => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === size.w && h === size.h) return;
    size = { w, h };
    setLineResolution(group, w, h);
  });

  let down: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent) => {
    down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };
  const onUp = (e: PointerEvent) => {
    const start = down;
    down = null;
    if (!start || e.button !== 0) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) >= CLICK_SLOP_PX) return;
    const r = canvas.getBoundingClientRect();
    const ndc: [number, number] = [
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    ];
    const id = pickAntennaAt(group, stage.camera, ndc);
    if (id) opts.onPick(id);
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  stage.requestRender();

  return () => {
    off();
    offFrame();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointerup', onUp);
    stage.scene.remove(group);
    disposeGroup(group);
    stage.requestRender();
  };
}

/** Mirrors `isReferenceSurface` in measureScene.ts (not exported): flat ground and rasters. */
function isReferenceSurface(object: Object3D): boolean {
  let node: Object3D | null = object;
  while (node) {
    if (
      node.name === 'env:ground' ||
      node.userData.aioGround === true ||
      node.userData.aioRaster === true
    )
      return true;
    node = node.parent;
  }
  return false;
}

/**
 * Take the next click on the stage as the tower: the local point under the cursor on a cloud or
 * mesh surface (the ground plane does not count). Returns the disarm.
 */
export function armTowerPick(
  stage: EngineStage,
  onPoint: (local: [number, number, number]) => void,
): () => void {
  const canvas = stage.renderer.domElement;
  return stage.claimClicks((e) => {
    const r = canvas.getBoundingClientRect();
    const hit = stage.raycast(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    if (!hit || isReferenceSurface(hit.object)) return false;
    onPoint([hit.point.x, hit.point.y, hit.point.z]);
    return true;
  });
}
