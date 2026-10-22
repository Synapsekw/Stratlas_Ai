import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Mesh,
  Quaternion,
  Scene,
  Texture,
  Vector3,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderLib,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import { PROJECTOR_DEPTH_LAYER, Projector, injectProjector } from './projector';

describe('injectProjector', () => {
  it('adds the projection term before colour space conversion of built-in materials', () => {
    for (const lib of [ShaderLib.standard, ShaderLib.basic, ShaderLib.lambert, ShaderLib.phong]) {
      const sh = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
      expect(injectProjector(sh)).toBe(true);
      expect(sh.vertexShader).toContain('vAioProjW = (modelMatrix * aioP).xyz');
      const fs = sh.fragmentShader;
      expect(fs.indexOf('aioProjWeight(aioUv)')).toBeLessThan(
        fs.indexOf('#include <colorspace_fragment>'),
      );
      expect(fs.indexOf('aioProjWeight(aioUv)')).toBeGreaterThan(
        fs.indexOf('#include <tonemapping_fragment>'),
      );
    }
  });
  it('leaves shaders without the anchors alone', () => {
    const sh = { vertexShader: 'void main(){}', fragmentShader: 'void main(){}' };
    expect(injectProjector(sh)).toBe(false);
    expect(sh.vertexShader).toBe('void main(){}');
  });
});

describe('Projector material patching', () => {
  it('patches shared materials once, chains their own hooks and restores them', () => {
    const own = new MeshStandardMaterial();
    let ownCalled = 0;
    own.onBeforeCompile = () => {
      ownCalled++;
    };
    const plain = new MeshBasicMaterial();
    const a = new Mesh(new BoxGeometry(), own);
    const b = new Mesh(new BoxGeometry(), [own, plain]);
    const p = new Projector();
    const keyBefore = plain.customProgramCacheKey();
    p.attach([a, b]);
    p.attach([a, b]);
    expect(p.patchedCount).toBe(2);
    expect(plain.customProgramCacheKey()).not.toBe(keyBefore);
    expect(a.layers.isEnabled(PROJECTOR_DEPTH_LAYER)).toBe(true);

    const sh = {
      vertexShader: ShaderLib.standard.vertexShader,
      fragmentShader: ShaderLib.standard.fragmentShader,
      uniforms: {},
    } as unknown as WebGLProgramParametersWithUniforms;
    own.onBeforeCompile(sh, {} as WebGLRenderer);
    expect(ownCalled).toBe(1);
    expect(Object.keys(sh.uniforms)).toContain('aioProjTex');

    p.detachAll();
    expect(p.patchedCount).toBe(0);
    expect(plain.customProgramCacheKey()).toBe(keyBefore);
    expect(Object.hasOwn(plain, 'onBeforeCompile')).toBe(false);
    own.onBeforeCompile(sh, {} as WebGLRenderer);
    expect(ownCalled).toBe(2);
    expect(a.layers.isEnabled(PROJECTOR_DEPTH_LAYER)).toBe(false);
  });
});

describe('Projector distance map', () => {
  const renderer = () => {
    const calls = { render: 0 };
    const r = {
      autoClear: true,
      shadowMap: { autoUpdate: true },
      getRenderTarget: () => null,
      setRenderTarget: () => undefined,
      getClearColor: (c: unknown) => c,
      getClearAlpha: () => 1,
      setClearColor: () => undefined,
      clear: () => undefined,
      render: () => {
        calls.render += 1;
      },
    };
    return { r: r as unknown as WebGLRenderer, calls };
  };
  const setup = () => {
    const p = new Projector();
    p.setTexture(new Texture());
    p.setLens({ model: 'pinhole', hfovDeg: 80, aspect: 16 / 9 });
    p.setEnabled(true);
    const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    const scene = new Scene();
    scene.add(mesh);
    return { p, mesh, scene };
  };
  const frame = (
    p: Projector,
    r: WebGLRenderer,
    scene: Scene,
    meshes: Mesh[],
    pos: Vector3,
    q: Quaternion,
  ) => {
    p.setPose(pos, q);
    p.attach(meshes);
    p.updateDepth(r, scene);
  };

  it('is drawn again only when the pose or the receivers change', () => {
    const { p, mesh, scene } = setup();
    const { r, calls } = renderer();
    const pos = new Vector3(1, 50, 2);
    const q = new Quaternion();
    frame(p, r, scene, [mesh], pos, q);
    expect(calls.render).toBe(1);
    // a paused clip while the view orbits: same pose, same receivers, every frame
    for (let i = 0; i < 10; i++) frame(p, r, scene, [mesh], pos.clone(), q.clone());
    expect(calls.render).toBe(1);
    expect(p.depthRenders).toBe(1);
    // the clip plays: the pose moves
    frame(p, r, scene, [mesh], new Vector3(1, 51, 2), q);
    expect(calls.render).toBe(2);
    frame(p, r, scene, [mesh], new Vector3(1, 51, 2), new Quaternion(0, 0.1, 0, 1).normalize());
    expect(calls.render).toBe(3);
  });

  it('is drawn again when a receiver comes, goes or moves', () => {
    const { p, mesh, scene } = setup();
    const { r, calls } = renderer();
    const pos = new Vector3(0, 40, 0);
    const q = new Quaternion();
    frame(p, r, scene, [mesh], pos, q);
    const other = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    frame(p, r, scene, [mesh, other], pos, q);
    expect(calls.render).toBe(2);
    frame(p, r, scene, [mesh], pos, q);
    expect(calls.render).toBe(3);
    mesh.position.set(0, 3, 0);
    mesh.updateMatrixWorld(true);
    frame(p, r, scene, [mesh], pos, q);
    expect(calls.render).toBe(4);
    frame(p, r, scene, [mesh], pos, q);
    expect(calls.render).toBe(4);
  });
});
