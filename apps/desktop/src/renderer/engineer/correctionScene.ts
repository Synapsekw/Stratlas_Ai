import type { EngineStage, SavedView } from '@aio/engine';
import { componentExtras, meshAssemblies, resolveMaterials } from '@aio/modelling';
import type { ProcModel, Vec3 } from '@aio/schema';
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Material,
  type Object3D,
} from 'three';

export type CorrectionTransform = Matrix4 | readonly number[];
export interface CorrectionPin {
  point: Vec3;
  modelPoint: Vec3;
  camera: SavedView;
  layerId: string;
  componentId?: string;
}
export interface CorrectionPinOptions {
  modelToProject: CorrectionTransform;
  allowedLayerIds: readonly string[];
  onPin(pin: CorrectionPin): void;
  onCancel?(): void;
  onMiss?(reason: string): void;
}

/** Clone the explicit model-to-project affine transform; never guess an identity frame. */
function affineMatrix(transform: CorrectionTransform): Matrix4 | null {
  const elements = transform instanceof Matrix4 ? transform.elements : transform;
  if (elements.length !== 16 || !elements.every(Number.isFinite)) return null;
  if (elements[3] !== 0 || elements[7] !== 0 || elements[11] !== 0 || elements[15] !== 1)
    return null;
  const matrix = new Matrix4().fromArray(elements);
  const determinant = matrix.determinant();
  if (!Number.isFinite(determinant) || determinant === 0) return null;
  return matrix;
}

/** Project-local surface point back into the editable model frame, in metres. */
export function correctionModelPoint(
  point: readonly number[],
  transform: CorrectionTransform,
): Vec3 | null {
  const matrix = affineMatrix(transform);
  if (!matrix || point.length !== 3 || !point.every(Number.isFinite)) return null;
  matrix.invert();
  if (!matrix.elements.every(Number.isFinite)) return null;
  const result = new Vector3(point[0], point[1], point[2]).applyMatrix4(matrix).toArray();
  return result.every(Number.isFinite) ? result : null;
}

/** One real model/cloud surface click. Empty space never becomes a synthetic 3D location. */
export function armCorrectionPin(
  stage: EngineStage,
  options: CorrectionPinOptions,
): { dispose(): void } {
  const matrix = affineMatrix(options.modelToProject);
  if (!matrix)
    throw new Error('The model transform is invalid; a correction pin cannot be placed.');
  if (!options.allowedLayerIds.length)
    throw new Error('Choose model or cloud layers before placing a correction pin.');
  const allowed = new Set(options.allowedLayerIds);
  const canvas = stage.renderer.domElement;
  const keyTarget = canvas.ownerDocument.defaultView ?? window;
  const previousCursor = canvas.style.cursor;
  let active = true;
  let release: () => void = () => undefined;
  function dispose() {
    if (!active) return;
    active = false;
    release();
    keyTarget.removeEventListener('keydown', onKey, true);
    if (canvas.style.cursor === 'crosshair') canvas.style.cursor = previousCursor;
  }
  function onKey(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dispose();
    options.onCancel?.();
  }
  release = stage.claimClicks((event) => {
    if (!active || event.button !== 0) return false;
    const miss = (reason: string) => {
      options.onMiss?.(reason);
      return true;
    };
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return miss('The model view is not visible.');
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1 || Math.abs(y) > 1)
      return miss('Click within the model view.');
    const hit = stage.raycast(x, y);
    if (!hit) return miss('Click a visible model or point-cloud surface near the discrepancy.');
    let layerId: string | undefined;
    let componentId: string | undefined;
    for (let node: Object3D | null = hit.object; node; node = node.parent) {
      if (node.userData.aioGround || !node.visible)
        return miss('Choose an actual model or point-cloud surface.');
      if (!layerId && typeof node.userData.layerId === 'string') layerId = node.userData.layerId;
      if (!componentId && typeof node.userData.component === 'string')
        componentId = node.userData.component;
    }
    if (!layerId || !allowed.has(layerId))
      return miss('Choose a surface on this model or its source point cloud.');
    const point = hit.point.toArray();
    const modelPoint = correctionModelPoint(point, matrix);
    const camera = stage.saveView();
    if (
      !modelPoint ||
      !camera.position.every(Number.isFinite) ||
      !camera.target.every(Number.isFinite)
    )
      return miss('This surface does not have a valid location.');
    dispose();
    options.onPin({ point, modelPoint, camera, layerId, ...(componentId ? { componentId } : {}) });
    return true;
  });
  keyTarget.addEventListener('keydown', onKey, true);
  canvas.style.cursor = 'crosshair';
  return { dispose };
}

/** Only resources owned by these overlays are disposed, shared model layers are never touched. */
function disposeGroup(group: Group) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  group.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    const mesh = node as Mesh;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
      materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  group.removeFromParent();
  group.clear();
}

/** A screen-sized locator. Its origin is exactly the saved project point, never a lifted proxy. */
export function showCorrectionPin(
  stage: EngineStage,
  point: Vec3,
): { group: Group; dispose(): void } {
  if (!point.every(Number.isFinite))
    throw new Error('A correction pin needs a finite project position.');
  const group = new Group();
  group.name = 'engineering-correction-pin';
  group.position.fromArray(point);
  group.userData.correctionPin = true;
  const material = new MeshBasicMaterial({
    color: '#ffb547',
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const centre = new Mesh(new SphereGeometry(0.28, 12, 8), material);
  const ring = new Mesh(new TorusGeometry(1, 0.09, 6, 32), material);
  centre.renderOrder = 47;
  ring.renderOrder = 47;
  group.add(centre, ring);
  const update = () => {
    const height = stage.renderer.domElement.getBoundingClientRect().height;
    if (!(height > 0)) return;
    const distance = stage.camera.position.distanceTo(group.position);
    const metrePerPixel =
      (2 * distance * Math.tan((stage.camera.fov * Math.PI) / 360)) / (height * stage.camera.zoom);
    group.scale.setScalar(Math.max(0.001, metrePerPixel * 9));
    ring.quaternion.copy(stage.camera.quaternion);
  };
  update();
  const offFrame = stage.onFrame(update);
  stage.scene.add(group);
  stage.requestRender();
  let disposed = false;
  return {
    group,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      offFrame();
      disposeGroup(group);
      stage.requestRender();
    },
  };
}
export interface CorrectionComparisonOptions {
  before: ProcModel;
  after: ProcModel;
  modelToProject: CorrectionTransform;
  changedIds: readonly string[];
  layerId?: string;
  pickable?: boolean;
}

/** Detached, owned production meshes, with each assembly still carrying its stable component ID. */
function comparisonModel(
  model: ProcModel,
  stage: EngineStage,
  changed: ReadonlySet<string>,
  side: 'before' | 'after',
): Group {
  const result = meshAssemblies(model, {
    detail: model.run?.detail ?? 'standard',
    include: (assembly) => assembly.status !== 'rejected',
  });
  if (result.failed.length)
    throw new Error(
      `The correction preview could not build: ${result.failed.map((f) => f.id).join(', ')}.`,
    );
  const group = new Group();
  group.name = `engineering-correction-${side}`;
  const records = new Map(model.assemblies.map((assembly) => [assembly.id, assembly]));
  const definitions = new Map(resolveMaterials(model).map((material) => [material.id, material]));
  try {
    for (const component of result.components) {
      const record = records.get(component.id);
      if (!record) throw new Error(`Missing component record: ${component.id}.`);
      const node = new Group();
      node.name = component.id;
      node.position.fromArray(component.anchor);
      node.userData = {
        ...componentExtras(record, component.openings),
        correctionChanged: changed.has(component.id),
        correctionSide: side,
        readOnly: true,
      };
      group.add(node);
      for (const primitive of component.prims) {
        const definition = definitions.get(primitive.material);
        if (!definition) throw new Error(`Missing component material: ${primitive.material}.`);
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(primitive.positions, 3));
        geometry.setAttribute('normal', new Float32BufferAttribute(primitive.normals, 3));
        geometry.setIndex(primitive.indices);
        const material = new MeshStandardMaterial({
          color: changed.has(component.id)
            ? new Color(side === 'before' ? '#d89632' : '#2fb8a3')
            : new Color().setRGB(...(definition.baseColor.slice(0, 3) as [number, number, number])),
          opacity: definition.baseColor[3],
          transparent: definition.baseColor[3] < 1,
          metalness: definition.metallic,
          roughness: definition.roughness,
          emissive: definition.emissive ? new Color().setRGB(...definition.emissive) : new Color(0),
          side: definition.doubleSided ? DoubleSide : FrontSide,
          clippingPlanes: stage.clippingPlanes,
          clipShadows: true,
        });
        const mesh = new Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        node.add(mesh);
      }
    }
  } catch (error) {
    disposeGroup(group);
    throw error;
  }
  return group;
}

/**
 * Review geometry only; the caller owns original-layer visibility and decision persistence.
 * Switching revisions never changes camera, georeference, source visibility or editable data.
 */
export function attachCorrectionComparison(
  stage: EngineStage,
  options: CorrectionComparisonOptions,
) {
  const matrix = affineMatrix(options.modelToProject);
  if (!matrix)
    throw new Error('The model transform is invalid; correction comparison is unavailable.');
  if (options.pickable && !options.layerId)
    throw new Error('A selectable correction preview needs its own layer id.');
  const group = new Group();
  group.name = 'engineering-correction-comparison';
  group.matrixAutoUpdate = false;
  group.matrix.copy(matrix);
  group.userData.readOnly = true;
  if (options.layerId) group.userData.layerId = options.layerId;
  const changed = new Set(options.changedIds);
  const beforeGroup = comparisonModel(options.before, stage, changed, 'before');
  group.add(beforeGroup);
  let afterGroup: Group;
  try {
    afterGroup = comparisonModel(options.after, stage, changed, 'after');
    group.add(afterGroup);
  } catch (error) {
    disposeGroup(group);
    throw error;
  }
  beforeGroup.visible = false;
  stage.scene.add(group);
  group.updateMatrixWorld(true);
  // Opt-in only: registering content may trigger the engine's initial auto-fit, so retain
  // the review view explicitly when the caller requests component picking in this overlay.
  const camera = options.pickable ? stage.saveView() : null;
  const offTarget =
    options.pickable && options.layerId ? stage.addRaycastTarget(group, options.layerId) : null;
  if (camera) stage.restoreView(camera, false);
  stage.requestRender();
  let disposed = false;
  return {
    group,
    beforeGroup,
    afterGroup,
    show: (mode: 'before' | 'after') => {
      if (disposed) return;
      beforeGroup.visible = mode === 'before';
      afterGroup.visible = mode === 'after';
      stage.requestRender();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      offTarget?.();
      disposeGroup(group);
      stage.requestRender();
    },
  };
}
