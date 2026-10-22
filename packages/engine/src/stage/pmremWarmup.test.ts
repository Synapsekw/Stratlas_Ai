import {
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  type Camera,
  type Object3D,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { fakeWarmRenderer } from './fakeWarmRenderer';
import { ProgramWarmup } from './programWarmup';
import { warmPmrem } from './pmremWarmup';

/** A warm-up renderer that also holds a render target, as the light map's passes set one. */
function setup() {
  const warm = fakeWarmRenderer({ parallel: true });
  let target: WebGLRenderTarget | null = null;
  const targets: (WebGLRenderTarget | null)[] = [];
  const renderer = Object.assign(warm.renderer, {
    getRenderTarget: () => target,
    setRenderTarget: (t: WebGLRenderTarget | null) => {
      target = t;
    },
  }) as unknown as WebGLRenderer;
  const warmup = new ProgramWarmup(renderer, { pollMs: 1 });
  const compile = (o: Object3D, c: Camera, s: Scene) => {
    targets.push(target);
    return warmup.compile(o, c, s);
  };
  return { warm, renderer, compile, targets };
}

const source = () => {
  const scene = new Scene();
  scene.add(new Mesh(new SphereGeometry(), new ShaderMaterial({ name: 'dome' })));
  return scene;
};

describe('warmPmrem', () => {
  it('makes the programs fromScene draws a light map of that size with, into a target', async () => {
    const { warm, renderer, compile, targets } = setup();
    const pmrem = new PMREMGenerator(renderer);
    const made = warmPmrem(renderer, pmrem, 128, source(), compile);
    const names = warm.programs.map((p) => p.key.split('/')[0]);
    expect(names).toEqual(['PMREM.Background', 'dome', 'PMREMGGXConvolution']);
    // made for the light map's target, and the renderer's own target given back
    expect(targets.every((t) => t !== null)).toBe(true);
    expect(renderer.getRenderTarget()).toBeNull();
    let done = false;
    void made.ready?.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    warm.finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(true);
    // the generator keeps the convolution it made for that size: fromScene uses it
    const own = (pmrem as unknown as { _ggxMaterial: ShaderMaterial | null })._ggxMaterial;
    expect(own?.name).toBe('PMREMGGXConvolution');
    made.release();
  });

  it('keeps its background box until released', () => {
    const { renderer, compile } = setup();
    const made = warmPmrem(renderer, new PMREMGenerator(renderer), 128, source(), compile);
    const disposed: string[] = [];
    const spy = vi.spyOn(MeshBasicMaterial.prototype, 'dispose').mockImplementation(function (
      this: MeshBasicMaterial,
    ) {
      disposed.push(this.name);
    });
    try {
      made.release();
    } finally {
      spy.mockRestore();
    }
    expect(disposed).toEqual(['PMREM.Background']);
  });

  it('answers nothing to wait for on a generator it does not know', () => {
    const { renderer, compile } = setup();
    const odd = {} as unknown as PMREMGenerator;
    expect(warmPmrem(renderer, odd, 128, source(), compile).ready).toBeNull();
  });
});
