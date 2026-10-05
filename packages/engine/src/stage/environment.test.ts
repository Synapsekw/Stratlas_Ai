import { PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import { depthStep, Environment, groundDrop } from './environment';

/** Enough of a renderer for the environment without WebGL; a canvas `height` px tall. */
function fakeRenderer(height?: number): WebGLRenderer {
  return {
    capabilities: { maxTextureSize: 4096, getMaxAnisotropy: () => 8 },
    toneMapping: 0,
    toneMappingExposure: 1,
    ...(height ? { domElement: { height } } : {}),
  } as unknown as WebGLRenderer;
}

/** Camera `dist` from `target`, looking down at it from 20 degrees; the environment sets near/far. */
function view(env: Environment, target: Vector3, dist: number) {
  const camera = new PerspectiveCamera(40, 1.6, 0.1, 20000);
  const e = (20 * Math.PI) / 180;
  camera.position.set(target.x + dist * Math.cos(e), target.y + dist * Math.sin(e), target.z);
  camera.lookAt(target);
  env.update(camera, target, 0);
  return camera;
}

const pixelAt = (cam: PerspectiveCamera, dist: number, height: number) =>
  (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / height;

describe('ground placement', () => {
  it('keeps the grid and the ground under model faces lying on y = 0 (a tank plinth)', () => {
    // HCl: a 10 m tank on a plinth whose top is at y = 0, orbited from 3 to 140 m
    const height = 1390;
    const env = new Environment(new Scene(), fakeRenderer(height));
    const target = new Vector3(0, 4.9, 0);
    env.setContentRadius(5.5, target);
    for (const dist of [3, 8, 20, 60, 140]) {
      const cam = view(env, target, dist);
      const grid = env.grid.position.y;
      const ground = env.ground.position.y;
      const step = depthStep(dist, cam.near, cam.far);
      const pixel = pixelAt(cam, dist, height);
      // plinth top (0) > grid > ground, each pair many depth steps and a pixel apart: no
      // triangle ties with another in the depth buffer, no grid line pokes through the plinth
      expect(-grid).toBeGreaterThan(8 * step);
      expect(-grid).toBeGreaterThanOrEqual(pixel);
      expect(grid - ground).toBeGreaterThan(8 * step);
      expect(grid - ground).toBeGreaterThanOrEqual(pixel);
      // and the whole drop is a couple of pixels, so the tank does not visibly float
      expect(-ground).toBeLessThanOrEqual(2.01 * pixel);
    }
  });

  it('scales the drop with the view, from a close-up to a whole plant', () => {
    const close = groundDrop(2, 0.01, 200, 0.001);
    expect(close.grid).toBeGreaterThanOrEqual(0.001);
    expect(close.ground).toBeLessThan(0.003);
    // zoomed far out on a 2.5 km plant the depth buffer is coarse: the steps set the drop
    const far = groundDrop(30000, 20, 60000, 20);
    expect(far.grid).toBeGreaterThan(12 * depthStep(30000, 20, 60000) * 0.99);
    expect(far.ground).toBeCloseTo(2 * far.grid, 9);
  });

  it('places a rescaled ground at the current drop, not back at y = 0', () => {
    const env = new Environment(new Scene(), fakeRenderer());
    const target = new Vector3(0, 4.9, 0);
    view(env, target, 20);
    const ground = env.ground.position.y;
    const grid = env.grid.position.y;
    expect(ground).toBeLessThan(grid);
    expect(grid).toBeLessThan(0);
    env.setContentRadius(6, target);
    expect(env.ground.position.y).toBe(ground);
    expect(env.grid.position.y).toBe(grid);
  });
});
