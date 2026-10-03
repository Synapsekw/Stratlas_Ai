import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Mesh,
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
