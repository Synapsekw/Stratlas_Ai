import {
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
} from 'three';
import { describe, expect, it } from 'vitest';
import { meshTemplates } from './mesh';

describe('mesh templates', () => {
  // Soak, 8 Oct: a GLB's stockpile outlines (LineSegments) were never disposed.
  it('free the lines and points of a template with its meshes when the last holder lets go', async () => {
    const parts = [
      new Mesh(new BufferGeometry(), new MeshStandardMaterial()),
      new LineSegments(new BufferGeometry(), new LineBasicMaterial()),
      new Points(new BufferGeometry(), new PointsMaterial()),
    ];
    const group = new Group();
    group.add(...parts);
    const freed: string[] = [];
    for (const p of parts) {
      p.geometry.addEventListener('dispose', () => freed.push(`${p.type} geometry`));
      p.material.addEventListener('dispose', () => freed.push(`${p.type} material`));
    }
    const lease = await meshTemplates.acquire('test:outlines', () =>
      Promise.resolve({ group, seaTop: null, terrain: new Set() }),
    );
    lease.release();
    expect(freed.sort()).toEqual([
      'LineSegments geometry',
      'LineSegments material',
      'Mesh geometry',
      'Mesh material',
      'Points geometry',
      'Points material',
    ]);
  });
});
