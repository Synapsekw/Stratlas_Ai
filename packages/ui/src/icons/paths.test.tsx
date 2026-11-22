// The Mission icon set: every icon is line art on the 20 px grid; the stroke width, caps and
// joins come from `svg.i` (mission.css), so no icon sets its own.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ICONS, type IconName } from './paths';

const markup = (name: IconName) => renderToStaticMarkup(<svg>{ICONS[name]}</svg>);

/** The absolute move-to points of an icon's paths (where each stroke starts). */
function moveTos(svg: string): [number, number][] {
  const out: [number, number][] = [];
  for (const d of svg.matchAll(/ d="([^"]+)"/g))
    for (const m of (d[1] ?? '').matchAll(/M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g))
      out.push([Number(m[1]), Number(m[2])]);
  return out;
}

describe('icon set', () => {
  it('leaves the stroke to the set: no icon sets its own width, caps or joins', () => {
    for (const name of Object.keys(ICONS) as IconName[])
      expect(markup(name), name).not.toMatch(/stroke-(width|linecap|linejoin)=/);
  });

  it('has a tower: a lattice mast with radiating arcs, not the telemetry chart', () => {
    const svg = markup('tower');
    expect(svg).not.toBe(markup('telemetry'));
    // line art only: paths, no filled shapes
    expect(svg).toMatch(/<path /);
    expect(svg).not.toMatch(/<(rect|circle|ellipse|polygon)/);
    // arcs for the radio waves
    expect(svg).toMatch(/ d="[^"]*a[\d.]/);
    // every stroke starts on the 20 px grid, inside the 1 px margin
    const starts = moveTos(svg);
    expect(starts.length).toBeGreaterThan(3);
    for (const [x, y] of starts) {
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(19);
      expect(y).toBeGreaterThanOrEqual(1);
      expect(y).toBeLessThanOrEqual(19);
    }
  });
});
