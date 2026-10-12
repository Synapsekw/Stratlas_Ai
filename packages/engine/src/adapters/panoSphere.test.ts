import { BackSide, Color, Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { panoSphereMaterial } from './panoSphere';

function uniform(m: { material: { uniforms: Record<string, { value: unknown }> } }, k: string) {
  return m.material.uniforms[k]?.value;
}

describe('panoSphereMaterial', () => {
  it('renders the inside of the sphere', () => {
    expect(panoSphereMaterial(new Color(0x101418)).material.side).toBe(BackSide);
  });

  it('writes the frame uniforms', () => {
    const m = panoSphereMaterial(new Color(0x101418));
    m.setFrame(90, { hspanDeg: 210, vtopDeg: 40, vbotDeg: 49 });
    expect(uniform(m, 'heading')).toBe(90);
    expect(uniform(m, 'hspan')).toBe(210);
    expect(uniform(m, 'vtop')).toBe(40);
    expect(uniform(m, 'vbot')).toBe(49);
  });

  it('flags whether an image is set', () => {
    const m = panoSphereMaterial(new Color(0x101418));
    m.setImage(null);
    expect(uniform(m, 'hasMap')).toBe(0);
    m.setImage(new Texture());
    expect(uniform(m, 'hasMap')).toBe(1);
  });

  it('disposes the previous texture and the material', () => {
    const m = panoSphereMaterial(new Color(0x101418));
    const a = new Texture();
    const spyTex = vi.spyOn(a, 'dispose');
    m.setImage(a);
    m.setImage(null);
    expect(spyTex).toHaveBeenCalledTimes(1);
    const spy = vi.spyOn(m.material, 'dispose');
    m.dispose();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
