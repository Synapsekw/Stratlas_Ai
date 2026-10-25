import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { brand, lockupSvg, SYMBOL, symbolSvg, WORDMARK } from './index';

const kit = (name: string) =>
  readFileSync(new URL(`../../../docs/brand/quadrion/kit/lockup/${name}`, import.meta.url), 'utf8');

/** Numbers of a path, so the kit's two-decimal paths compare with ours after scaling. */
const numbers = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
const kitPaths = (svg: string) => [...svg.matchAll(/<path d="([^"]+)" fill="([^"]+)"/g)];

describe('lockupSvg', () => {
  it('on dark has the kit viewBox, the symbol and wordmark, in light ink and mint', () => {
    const svg = lockupSvg({ on: 'dark' });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 746\.11 156"/);
    for (const d of SYMBOL.pieces) expect(svg).toContain(`d="${d}"`);
    expect(svg).toContain(`d="${WORDMARK.quadrion}"`);
    expect(svg).toContain(`d="${WORDMARK.ai}"`);
    expect(svg).toContain('#EEF2F5');
    expect(svg).toContain('#5ED1B3');
    expect(svg).not.toContain('#11161C');
    expect(svg).toContain(`<title>${brand.productName}</title>`);
  });

  it('on light uses ink and teal', () => {
    const svg = lockupSvg({ on: 'light' });
    expect(svg).toContain('#11161C');
    expect(svg).toContain('#1A8C70');
    expect(svg).not.toContain('#EEF2F5');
    expect(svg).not.toContain('#5ED1B3');
  });

  it('places the pieces with the kit geometry and colours', () => {
    for (const [on, file] of [
      ['dark', 'quadrion-horizontal-on-dark.svg'],
      ['light', 'quadrion-horizontal-on-light.svg'],
    ] as const) {
      const ref = kit(file);
      const ours = lockupSvg({ on });
      // the symbol group's transform is the kit's
      expect(ours).toContain('<g transform="translate(34.15 34.15) scale(1.46)">');
      expect(ref).toContain('<g transform="translate(34.15 34.15) scale(1.46)">');
      expect(ours).toContain('<g transform="translate(147.92 58) scale(0.666667)">');
      const refPaths = kitPaths(ref);
      const ourPaths = kitPaths(ours);
      expect(ourPaths.map((m) => m[2])).toEqual(refPaths.map((m) => m[2]));
      // symbol pieces are identical; the wordmark is the kit's at two thirds
      for (let i = 0; i < 4; i++) expect(ourPaths[i]?.[1]).toBe(refPaths[i]?.[1]);
      for (let i = 4; i < refPaths.length; i++) {
        const a = numbers(ourPaths[i]?.[1] ?? '').map((n) => n * 0.666667);
        const b = numbers(refPaths[i]?.[1] ?? '');
        expect(a).toHaveLength(b.length);
        a.forEach((n, j) => {
          expect(Math.abs(n - (b[j] ?? NaN))).toBeLessThan(0.02);
        });
      }
    }
  });
});

describe('symbolSvg', () => {
  it('is the symbol alone on its own viewBox, quarters and tail coloured for the side', () => {
    const dark = symbolSvg({ on: 'dark' });
    expect(dark).toContain(`viewBox="${SYMBOL.viewBox}"`);
    expect(kitPaths(dark).map((m) => m[2])).toEqual(['#EEF2F5', '#EEF2F5', '#EEF2F5', '#5ED1B3']);
    expect(dark).not.toContain(WORDMARK.ai);
    const light = symbolSvg();
    expect(kitPaths(light).map((m) => m[2])).toEqual(['#11161C', '#11161C', '#11161C', '#1A8C70']);
    expect(light).toContain(`<title>${brand.productName}</title>`);
  });
});
