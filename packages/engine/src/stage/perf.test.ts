import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Scene,
} from 'three';
import { describe, expect, it } from 'vitest';
import { estimateGpuBytes, formatPerf } from './perf';

describe('estimateGpuBytes', () => {
  it('counts geometry buffers once each, including offscreen scenes (EDL clouds)', () => {
    const scene = new Scene();
    const box = new BoxGeometry(1, 1, 1); // 24 vertices: 288 + 288 + 192 bytes, 36 uint16 indices
    const mat = new MeshStandardMaterial();
    scene.add(new Mesh(box, mat), new Mesh(box, mat)); // shared geometry counts once
    const cloud = new Scene();
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Uint16Array(30), 3)); // 60 bytes
    cloud.add(new Points(g, new PointsMaterial()));
    const quad = new Group();
    quad.userData.offscreen = [cloud];
    scene.add(quad);
    expect(estimateGpuBytes([scene])).toBe(288 + 288 + 192 + 72 + 60);
  });

  it('adds textures with their mip chain', () => {
    const scene = new Scene();
    const tex = new DataTexture(new Uint8Array(64 * 64 * 4), 64, 64);
    scene.add(new Mesh(new BufferGeometry(), new MeshStandardMaterial({ map: tex })));
    expect(estimateGpuBytes([scene])).toBe(Math.round((64 * 64 * 4 * 4) / 3));
  });
});

describe('formatPerf', () => {
  it('shows fps, frame time percentiles, points, draws and GPU memory', () => {
    const text = formatPerf({
      fps: 59.9,
      p50: 16.6,
      p95: 18.04,
      frames: 120,
      points: 6_250_000,
      calls: 412,
      triangles: 1_200_000,
      gpuBytes: 1.5 * 2 ** 30,
      cpuMs: 3.2,
    });
    expect(text).toContain('60 fps');
    expect(text).toContain('p50 16.6 ms');
    expect(text).toContain('p95 18.0 ms');
    expect(text).toContain('points 6.25 M');
    expect(text).toContain('draws 412');
    expect(text).toContain('GPU ~1.50 GB');
    expect(text).toContain('Ctrl+Shift+F');
    expect(text).not.toMatch(/[–—]/);
  });
});
