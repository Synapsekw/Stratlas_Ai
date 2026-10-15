import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  ShaderMaterial,
  type Material,
  type Object3D,
} from 'three';
import { describe, expect, it } from 'vitest';
import { Highlighter, MAX_TINTS } from './highlight';

/** Two components sharing the steel material: a three-mesh warning light and a flue. */
function scene() {
  const steel = new MeshStandardMaterial({ name: 'steel', color: 0x808080 });
  const lens = new MeshStandardMaterial({ name: 'lens', color: 0xff0000 });
  const paint = new MeshStandardMaterial({ name: 'paint', color: 0xffffff });
  const box = () => new BoxGeometry(1, 1, 1);
  const light = new Group();
  light.name = 'light-l1-2';
  light.userData = { component: 'light-l1-2' };
  light.add(new Mesh(box(), steel), new Mesh(box(), lens), new Mesh(box(), paint));
  const flue = new Group();
  flue.name = 'flue-1';
  flue.userData = { component: 'flue-1' };
  flue.add(new Mesh(box(), steel));
  const root = new Group();
  root.add(light, flue);
  root.updateMatrixWorld(true);
  return { steel, lens, paint, light, flue, root };
}

const meshes = (o: Object3D) => o.children.filter((c): c is Mesh => c instanceof Mesh);
const drawn = (h: Highlighter) =>
  meshes(h.group).filter((m) => !(m.material instanceof ShaderMaterial));
const hulls = (h: Highlighter) =>
  meshes(h.group).filter((m) => m.material instanceof ShaderMaterial);

describe('Highlighter', () => {
  it('tints a whole component without touching the materials it shares', () => {
    const s = scene();
    const before = s.steel.color.getHex();
    const emissiveBefore = s.steel.emissive.getHex();
    const own = new Map(
      [...meshes(s.light), ...meshes(s.flue)].map((m) => [m, m.material as Material]),
    );
    const h = new Highlighter([]);
    expect(h.set('select', s.light)).toBe(true);

    // every mesh of the warning light gets a tinted overlay and an outline shell
    const tinted = drawn(h);
    expect(tinted).toHaveLength(3);
    expect(hulls(h)).toHaveLength(3);
    expect(new Set(tinted.map((m) => m.geometry))).toEqual(
      new Set(meshes(s.light).map((m) => m.geometry)),
    );
    for (const m of tinted) {
      const mat = m.material as MeshStandardMaterial;
      // a clone, never the shared material itself
      expect([s.steel, s.lens, s.paint]).not.toContain(mat);
      expect(mat.emissiveIntensity).toBeGreaterThan(0);
    }
    expect(tinted.map((m) => (m.material as Material).name).sort()).toEqual([
      'lens',
      'paint',
      'steel',
    ]);

    // the flue shares the steel material: its colour and emissive stay as they were
    expect(s.steel.color.getHex()).toBe(before);
    expect(s.steel.emissive.getHex()).toBe(emissiveBefore);
    for (const [m, mat] of own) expect(m.material).toBe(mat);

    // clearing removes every overlay and leaves the scene's materials as they were
    expect(h.set('select', null)).toBe(true);
    expect(h.group.children).toHaveLength(0);
    for (const [m, mat] of own) expect(m.material).toBe(mat);
    expect(s.steel.color.getHex()).toBe(before);
    h.dispose();
  });

  it('keeps a bounded number of tinted material copies', () => {
    const h = new Highlighter([]);
    const disposed: string[] = [];
    for (let i = 0; i < MAX_TINTS + 10; i++) {
      const g = new Group();
      const mat = new MeshStandardMaterial({ name: `m${String(i)}` });
      g.add(new Mesh(new BoxGeometry(1, 1, 1), mat));
      h.set('hover', g);
      const tinted = drawn(h)[0]?.material as Material | undefined;
      tinted?.addEventListener('dispose', () => disposed.push(String(i)));
    }
    // the cache was emptied once it passed the bound: the early copies were freed
    expect(disposed.length).toBeGreaterThan(0);
    expect(disposed.length).toBeLessThanOrEqual(MAX_TINTS + 1);
    h.dispose();
  });

  it('leaves hidden meshes out of the highlight and follows a visibility change on refresh', () => {
    const s = scene();
    const h = new Highlighter([]);
    const lens = meshes(s.light)[1];
    if (!lens) throw new Error('no lens');
    lens.visible = false;
    h.set('hover', s.light);
    expect(drawn(h)).toHaveLength(2);
    expect(hulls(h)).toHaveLength(0);
    s.light.visible = false;
    h.refresh();
    expect(h.group.children).toHaveLength(0);
    s.light.visible = true;
    lens.visible = true;
    h.refresh();
    expect(drawn(h)).toHaveLength(3);
    h.dispose();
  });
});
