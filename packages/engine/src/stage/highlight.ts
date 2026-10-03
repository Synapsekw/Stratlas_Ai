import {
  BackSide,
  Color,
  Group,
  Mesh,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  type Material,
  type Object3D,
  type Plane,
} from 'three';
import { isMesh } from '../adapters/model';
import { PALETTE } from '../palette';

/** Inverted-hull outline: back faces pushed out along the normal by a fixed number of pixels. */
const OUTLINE_VERT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
uniform float uWidth;
uniform vec2 uRes;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vec4 clip = projectionMatrix * mvPosition;
  vec3 n = normalize(normalMatrix * normal);
  vec2 dir = (projectionMatrix * vec4(n, 0.0)).xy;
  float len = length(dir);
  if (len > 1e-6) clip.xy += dir / len * uWidth * 2.0 / uRes * clip.w;
  gl_Position = clip;
  #include <clipping_planes_vertex>
}`;
const OUTLINE_FRAG = /* glsl */ `
#include <clipping_planes_pars_fragment>
uniform vec3 uColor;
void main() {
  #include <clipping_planes_fragment>
  gl_FragColor = vec4(uColor, 1.0);
  #include <colorspace_fragment>
}`;

type Mode = 'hover' | 'select';

interface Tintable extends Material {
  emissive?: Color;
  emissiveIntensity?: number;
}

/** Hover tint, selection tint and selection outline, drawn as overlays on the picked node. */
export class Highlighter {
  readonly group = new Group();
  private readonly tints = new Map<string, Material>();
  private readonly outline: ShaderMaterial;
  private current: Record<Mode, Object3D | null> = { hover: null, select: null };

  constructor(private readonly clippingPlanes: Plane[]) {
    this.group.name = 'engine:highlight';
    this.outline = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.common,
        {
          uWidth: { value: 2 },
          uRes: { value: new Vector2(1, 1) },
          uColor: { value: new Color(PALETTE.acc) },
        },
      ]),
      vertexShader: OUTLINE_VERT,
      fragmentShader: OUTLINE_FRAG,
      side: BackSide,
      clipping: true,
      fog: false,
    });
    this.outline.clippingPlanes = clippingPlanes;
  }

  setResolution(w: number, h: number) {
    (this.outline.uniforms.uRes?.value as Vector2 | undefined)?.set(w, h);
  }

  get selected() {
    return this.current.select;
  }

  get hovered() {
    return this.current.hover;
  }

  /** Returns true when something changed. */
  set(mode: Mode, node: Object3D | null): boolean {
    if (this.current[mode] === node) return false;
    this.current[mode] = node;
    this.rebuild();
    return true;
  }

  private tint(src: Material, mode: Mode): Material {
    const key = `${src.uuid}:${mode}`;
    let m = this.tints.get(key);
    if (!m) {
      const t = src.clone() as Tintable;
      if (t.emissive) {
        t.emissive = new Color(mode === 'select' ? PALETTE.acc : PALETTE.hover);
        t.emissiveIntensity = mode === 'select' ? 0.45 : 0.16;
      }
      t.polygonOffset = true;
      t.polygonOffsetFactor = -1;
      t.polygonOffsetUnits = -2;
      t.clippingPlanes = this.clippingPlanes;
      m = t;
      this.tints.set(key, m);
    }
    return m;
  }

  private rebuild() {
    this.group.clear();
    const add = (node: Object3D | null, mode: Mode) => {
      if (!node) return;
      node.updateWorldMatrix(true, true);
      node.traverse((o) => {
        if (!isMesh(o) || Array.isArray(o.material)) return;
        const src = o;
        const tinted = new Mesh(src.geometry, this.tint(src.material as Material, mode));
        tinted.matrixAutoUpdate = false;
        tinted.matrix.copy(src.matrixWorld);
        tinted.matrixWorld.copy(src.matrixWorld);
        tinted.raycast = () => undefined;
        tinted.renderOrder = 2;
        this.group.add(tinted);
        if (mode === 'select' && src.geometry.hasAttribute('normal')) {
          const hull = new Mesh(src.geometry, this.outline);
          hull.matrixAutoUpdate = false;
          hull.matrix.copy(src.matrixWorld);
          hull.matrixWorld.copy(src.matrixWorld);
          hull.raycast = () => undefined;
          hull.renderOrder = 3;
          this.group.add(hull);
        }
      });
    };
    if (this.current.hover !== this.current.select) add(this.current.hover, 'hover');
    add(this.current.select, 'select');
  }

  dispose() {
    this.group.clear();
    for (const m of this.tints.values()) m.dispose();
    this.tints.clear();
    this.outline.dispose();
  }
}
