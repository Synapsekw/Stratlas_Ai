/**
 * The coverage in the 3D view (spec D23): the view's picture draped on the ground as a flat sheet
 * at the tower-base ground height (Phase 1 assumes flat ground, D17), and each source's
 * boresight as a thin arrow from the antenna, along its azimuth and mechanical downtilt. Project
 * E, N, Z map to the local frame as everywhere else: x east, y up, z south (`projectToLocal`).
 * The eye hides the whole group; the opacity is the sheet's.
 */
import type { SceneHandle } from '@aio/engine';
import {
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import type { CoverageImage } from './coverageImage';

/** The sheet floats this far above the ground, so it does not fight the ground for depth. */
export const DRAPE_LIFT_M = 0.3;
export const SCENE_GROUP = 'rf-coverage';

export interface SceneArrow {
  /** Local frame start. */
  from: [number, number, number];
  /** Unit direction, local frame. */
  dir: [number, number, number];
  lengthM: number;
  colour: string;
}

export interface CoverageSceneDraw {
  /** The picture and where it lies: local centre (x, z), size (east, north) and ground y. */
  sheet: {
    image: CoverageImage;
    /** Changes when the picture does (so the texture is uploaded only then). */
    key: string;
    centre: [number, number];
    sizeM: [number, number];
    groundY: number;
  } | null;
  arrows: SceneArrow[];
  visible: boolean;
  opacity: number;
}

export interface CoverageSceneView {
  draw(d: CoverageSceneDraw): void;
  /** The group, for tests and the e2e (`scene.getObjectByName('rf-coverage')`). */
  readonly group: Group;
  dispose(): void;
}

/** Arrow segments: the shaft and a two-line head. */
export function arrowSegments(a: SceneArrow): number[] {
  const [x, y, z] = a.from;
  const [dx, dy, dz] = a.dir;
  const L = a.lengthM;
  const tip: [number, number, number] = [x + dx * L, y + dy * L, z + dz * L];
  // a sideways axis in the horizontal plane
  const h = Math.hypot(dx, dz) || 1;
  const sx = -dz / h;
  const sz = dx / h;
  const back = L * 0.15;
  const wing = L * 0.07;
  const head = (s: number): number[] => [
    ...tip,
    tip[0] - dx * back + sx * wing * s,
    tip[1] - dy * back,
    tip[2] - dz * back + sz * wing * s,
  ];
  return [x, y, z, ...tip, ...head(1), ...head(-1)];
}

export function attachCoverageScene(scene: SceneHandle): CoverageSceneView {
  const group = new Group();
  group.name = SCENE_GROUP;
  const material = new MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  let mesh: Mesh<PlaneGeometry, MeshBasicMaterial> | null = null;
  let texture: DataTexture | null = null;
  let shownKey: string | null = null;
  const lineMaterials: LineBasicMaterial[] = [];
  let lines: LineSegments[] = [];
  scene.scene.add(group);

  const clearLines = () => {
    for (const l of lines) {
      group.remove(l);
      l.geometry.dispose();
    }
    for (const m of lineMaterials) m.dispose();
    lines = [];
    lineMaterials.length = 0;
  };

  return {
    group,
    draw(d) {
      group.visible = d.visible;
      material.opacity = d.opacity;
      const s = d.sheet;
      if (!s) {
        if (mesh) {
          group.remove(mesh);
          mesh.geometry.dispose();
          mesh = null;
        }
        texture?.dispose();
        texture = null;
        shownKey = null;
      } else {
        if (shownKey !== s.key) {
          texture?.dispose();
          texture = new DataTexture(
            s.image.data,
            s.image.width,
            s.image.height,
            RGBAFormat,
            UnsignedByteType,
          );
          texture.colorSpace = SRGBColorSpace;
          texture.magFilter = NearestFilter;
          texture.minFilter = NearestFilter;
          texture.generateMipmaps = false;
          texture.needsUpdate = true;
          material.map = texture;
          material.needsUpdate = true;
          shownKey = s.key;
        }
        if (!mesh) {
          mesh = new Mesh(new PlaneGeometry(1, 1), material);
          // +90 degrees about x: the plane lies flat with v = 0 to the north, so the texture's
          // first row (the grid's top row, row 0) is the north edge
          mesh.rotation.x = Math.PI / 2;
          mesh.renderOrder = 1;
          group.add(mesh);
        }
        mesh.scale.set(s.sizeM[0], s.sizeM[1], 1);
        mesh.position.set(s.centre[0], s.groundY + DRAPE_LIFT_M, s.centre[1]);
      }
      clearLines();
      for (const a of d.arrows) {
        const g = new BufferGeometry();
        g.setAttribute('position', new Float32BufferAttribute(arrowSegments(a), 3));
        const m = new LineBasicMaterial({ color: a.colour, depthTest: false, transparent: true });
        lineMaterials.push(m);
        const l = new LineSegments(g, m);
        l.renderOrder = 2;
        lines.push(l);
        group.add(l);
      }
      scene.requestRender();
    },
    dispose() {
      clearLines();
      if (mesh) mesh.geometry.dispose();
      texture?.dispose();
      material.dispose();
      scene.scene.remove(group);
      scene.requestRender();
    },
  };
}
