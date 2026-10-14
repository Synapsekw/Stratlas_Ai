import { describe, expect, it } from 'vitest';
import { mtlDiffuseMaps, mtlMapFile } from './mtl';

describe('mtlMapFile', () => {
  it('keeps a file name with spaces whole', () => {
    expect(mtlMapFile('Tower stack 3D_texture.jpg')).toBe('Tower stack 3D_texture.jpg');
  });
  it('skips options and their values before a spaced name', () => {
    expect(mtlMapFile('-s 1 1 1 -bm 0.5 my tex.png')).toBe('my tex.png');
    expect(mtlMapFile('-clamp on tex.png')).toBe('tex.png');
    expect(mtlMapFile('-o 0.5 tex.png')).toBe('tex.png');
    expect(mtlMapFile('-mm 0 1 tex.png')).toBe('tex.png');
  });
  it('turns backslashes into slashes and drops quotes', () => {
    expect(mtlMapFile('textures\\wall a.jpg')).toBe('textures/wall a.jpg');
    expect(mtlMapFile('"my tex.png"')).toBe('my tex.png');
  });
  it('is null when only options are left', () => {
    expect(mtlMapFile('-s 1 1 1')).toBeNull();
    expect(mtlMapFile('   ')).toBeNull();
  });
});

describe('mtlDiffuseMaps', () => {
  it('lists every map_Kd once, tabs and spaces alike', () => {
    const mtl = 'newmtl a\nmap_Kd a b.jpg\nnewmtl b\nmap_Kd\t-s 2 2 2 a b.jpg\nmap_Bump n.png\n';
    expect(mtlDiffuseMaps(mtl)).toEqual(['a b.jpg']);
  });
});
