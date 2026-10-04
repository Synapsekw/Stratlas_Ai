// 3D views of issues for the report: the project's meshes in a small offscreen three.js scene.
import type { ProjectManifest, Vec3 } from '@aio/schema';
import { assetUrl } from '@aio/workspace';
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  RingGeometry,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { exteriorPose, snapshotPose } from './layout';

export interface Snapshotter {
  /** JPEG blob of the view at an issue, marked with its severity colour. */
  shoot(position: Vec3, normal: Vec3 | null, color: string): Promise<Blob | null>;
  dispose(): void;
}

export const VIEW_W = 960;
export const VIEW_H = 720;

/** Load the visible mesh layers once; null when the project has no mesh. */
export async function createSnapshotter(
  projectId: string,
  manifest: ProjectManifest,
): Promise<Snapshotter | null> {
  const meshes = manifest.layers.filter((l) => l.kind === 'mesh' && l.visible);
  if (meshes.length === 0) return null;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const scene = new Scene();
  scene.background = new Color('#dfe5ec');
  const content = new Group();
  scene.add(content);
  const materials = new Set<Material>();
  for (const layer of meshes) {
    if (layer.kind !== 'mesh') continue;
    try {
      const gltf = await loader.loadAsync(assetUrl(projectId, layer.src));
      const g = new Group();
      g.matrixAutoUpdate = false;
      g.matrix.copy(new Matrix4().fromArray(layer.transform));
      g.add(gltf.scene);
      gltf.scene.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material]) as Material[]) {
          m.side = DoubleSide;
          materials.add(m);
        }
      });
      content.add(g);
    } catch (e) {
      console.warn(`Report: mesh layer "${layer.name}" could not be loaded`, e);
    }
  }
  content.updateMatrixWorld(true);
  const box = new Box3().setFromObject(content);
  if (box.isEmpty()) return null;
  const center = box.getCenter(new Vector3());
  const radius = box.getSize(new Vector3()).length() / 2;

  scene.add(new HemisphereLight('#ffffff', '#6b7480', 2.2));
  scene.add(new AmbientLight('#ffffff', 0.6));
  const sun = new DirectionalLight('#ffffff', 1.6);
  sun.position
    .set(0.4, 1, 0.3)
    .multiplyScalar(radius * 2)
    .add(center);
  scene.add(sun);

  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(VIEW_W, VIEW_H, false);
  const camera = new PerspectiveCamera(50, VIEW_W / VIEW_H, 0.05, radius * 20);

  const pin = new Group();
  const dotMat = new MeshBasicMaterial({ depthTest: false, transparent: true });
  const ringMat = new MeshBasicMaterial({ depthTest: false, transparent: true, side: DoubleSide });
  const dot = new Mesh(new SphereGeometry(1, 20, 14), dotMat);
  const ring = new Mesh(new RingGeometry(1.6, 2.1, 40), ringMat);
  dot.renderOrder = 10;
  ring.renderOrder = 10;
  pin.add(dot, ring);
  scene.add(pin);

  const c = [center.x, center.y, center.z] as Vec3;
  return {
    async shoot(position, normal, color) {
      // A finding inside a hollow asset (a tank) is seen from outside, through the walls.
      let pose = snapshotPose(position, normal, c, radius);
      const inside = box.containsPoint(new Vector3(...pose.eye));
      if (inside) pose = exteriorPose(position, c, radius);
      for (const m of materials) {
        m.transparent = inside;
        m.opacity = inside ? 0.28 : 1;
        m.depthWrite = !inside;
      }
      const eye = new Vector3(...pose.eye);
      const target = new Vector3(...pose.target);
      const dist = eye.distanceTo(target);
      const dir = eye.clone().sub(target).normalize();
      camera.up.set(0, 1, 0);
      if (Math.abs(dir.y) > 0.95) camera.up.set(0, 0, -1);
      camera.position.copy(eye);
      camera.near = Math.max(0.01, dist / 200);
      camera.far = dist + radius * 4;
      camera.lookAt(target);
      camera.updateProjectionMatrix();
      dotMat.color.set(color);
      ringMat.color.set(color);
      pin.position.copy(target);
      pin.scale.setScalar(dist * 0.012);
      // the ring lies in the pin's XY plane: face it to the camera
      pin.quaternion.copy(camera.quaternion);
      renderer.render(scene, camera);
      return new Promise<Blob | null>((r) => {
        canvas.toBlob(r, 'image/jpeg', 0.84);
      });
    },
    dispose() {
      renderer.dispose();
    },
  };
}
