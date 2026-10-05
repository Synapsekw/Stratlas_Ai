import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture, type Object3D } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { buildTemplate, instantiate } from './mesh';
import { isMesh, PICK_LAYER } from './model';
import { SharedAssets } from './shared';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('assets shared between stages', () => {
  it('loads a key once for every holder and frees it after the last release', async () => {
    const free = vi.fn();
    const cache = new SharedAssets<{ url: string }>(free);
    const load = vi.fn((url: string) => Promise.resolve({ url }));
    const [a, b] = await Promise.all([
      cache.acquire('models/t1.glb', () => load('models/t1.glb')),
      cache.acquire('models/t1.glb', () => load('models/t1.glb')),
    ]);
    const c = await cache.acquire('models/t2.glb', () => load('models/t2.glb'));
    expect(load).toHaveBeenCalledTimes(2);
    expect(a.value).toBe(b.value);
    expect(cache.stats()).toEqual({
      held: { 'models/t1.glb': 2, 'models/t2.glb': 1 },
      loads: 2,
      hits: 1,
    });
    a.release();
    a.release(); // twice is once
    expect(free).not.toHaveBeenCalled();
    b.release();
    expect(free).toHaveBeenCalledTimes(1);
    expect(free).toHaveBeenCalledWith({ url: 'models/t1.glb' });
    // the next holder loads it again
    const d = await cache.acquire('models/t1.glb', () => load('models/t1.glb'));
    expect(load).toHaveBeenCalledTimes(3);
    d.release();
    c.release();
    expect(cache.stats().held).toEqual({});
  });

  it('forgets a failed load so a later holder can try again', async () => {
    const cache = new SharedAssets<number>(() => undefined);
    await expect(cache.acquire('x', () => Promise.reject(new Error('404')))).rejects.toThrow('404');
    const ok = await cache.acquire('x', () => Promise.resolve(7));
    expect(ok.value).toBe(7);
  });
});

/** A small glTF-like scene: a tagged pile and the ground, two materials, one texture. */
function scene(): { root: Object3D; tex: Texture } {
  const tex = new Texture();
  const pileMat = new MeshStandardMaterial({ name: 'Pile', map: tex });
  const groundMat = new MeshStandardMaterial({ name: 'Ground' });
  const root = new Group();
  root.name = 'Scene';
  const pile = new Mesh(new BoxGeometry(4, 2, 4), pileMat);
  pile.name = 'P01_e1';
  pile.position.set(10, 1, 0);
  const ground = new Mesh(new BoxGeometry(100, 0.2, 100), groundMat);
  ground.name = 'Ground';
  ground.userData.type = 'terrain';
  root.add(pile, ground);
  return { root, tex };
}

describe('a mesh template drawn by two stages', () => {
  it('shares geometry and textures and gives each stage its own materials', () => {
    const { root, tex } = scene();
    const t = buildTemplate(root, I, (o) => o !== root);
    const s1 = instantiate(t);
    const s2 = instantiate(t);
    const meshes = (o: Object3D) => {
      const out: Mesh[] = [];
      o.traverse((x) => {
        if (isMesh(x)) out.push(x);
      });
      return out;
    };
    const m1 = meshes(s1.group);
    const m2 = meshes(s2.group);
    expect(m1.length).toBe(m2.length);
    expect(m1.length).toBeGreaterThan(2); // originals plus merged draw meshes
    for (let i = 0; i < m1.length; i++) {
      const a = m1[i];
      const b = m2[i];
      if (!a || !b) throw new Error('mesh missing');
      expect(a.geometry).toBe(b.geometry);
      expect(a.material).not.toBe(b.material);
      expect(a.layers.mask).toBe(b.layers.mask);
    }
    // one copy per template material, textures shared
    expect(s1.materials).toHaveLength(2);
    const pile1 = s1.materials.find((m) => m.name === 'Pile') as MeshStandardMaterial;
    const pile2 = s2.materials.find((m) => m.name === 'Pile') as MeshStandardMaterial;
    expect(pile1.map).toBe(tex);
    expect(pile2.map).toBe(tex);
    // the terrain material is named for the land mask; the pile's is not
    expect(s1.terrain.map((m) => m.name)).toEqual(['Ground']);
    // merged draw meshes are never picked; the originals pick on their own layer
    expect(s1.merged.length).toBeGreaterThan(0);
    for (const m of s1.merged) {
      const hits: unknown[] = [];
      m.raycast(undefined as never, hits as never);
      expect(hits).toEqual([]);
      expect(Object.hasOwn(m, 'raycast')).toBe(true);
    }
    const pick = s1.root.getObjectByName('P01_e1');
    expect(pick && isMesh(pick) && pick.layers.isEnabled(PICK_LAYER)).toBe(true);
    // node marks travel with the clone
    expect(pick?.userData.aioNode).toBe(true);
    // a stage's material change stays in that stage
    s1.materials.forEach((m) => {
      m.clippingPlanes = [];
    });
    expect(s2.materials.every((m) => m.clippingPlanes === null)).toBe(true);
  });
});
