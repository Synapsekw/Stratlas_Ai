// Quadrion mark concepts. 64-unit grid, two colours: ink (structure) and acc
// (accent). Each also works in one colour (pass the same value twice).

const f = (n) => +n.toFixed(2);
let uid = 0;
const P = (cx, cy, r, deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy - r * Math.sin((deg * Math.PI) / 180)];
function sector(cx, cy, r, a0, a1) {
  const [x0, y0] = P(cx, cy, r, a0), [x1, y1] = P(cx, cy, r, a1);
  return `M${cx} ${cy} L${f(x0)} ${f(y0)} A${r} ${r} 0 0 0 ${f(x1)} ${f(y1)}Z`;
}
const rot = (pts, deg, cx = 32, cy = 32) =>
  pts.map(([x, y]) => {
    const a = (deg * Math.PI) / 180, dx = x - cx, dy = y - cy;
    return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
  });
const poly = (pts) => 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L') + 'Z';


// a stack of isometric plates, drawn bottom to top; each plate is cut where
// the plates above it overlap, so the mark works in one colour.
// centres: [[cx, cy], ...] bottom first; acc colours the top plate (null = none);
// extraAbove: a centre that is drawn by the caller but still cuts the plates below.
function stack(ink, acc, centres, hw, hh, extraAbove = null) {
  const plate = ([cx, cy]) => `M${cx} ${cy - hh} L${cx + hw} ${cy} L${cx} ${cy + hh} L${cx - hw} ${cy}Z`;
  const all = extraAbove ? [...centres, extraAbove] : centres;
  let defs = '', body = '';
  centres.forEach((c, i) => {
    const above = all.slice(i + 1);
    const top = i === centres.length - 1 && !extraAbove;
    if (above.length) {
      const id = 'q' + ++uid;
      defs += `<mask id="${id}"><rect width="64" height="64" fill="#fff"/>${above.map((a) => `<path d="${plate(a)}" fill="#000" stroke="#000" stroke-width="5" stroke-linejoin="round"/>`).join('')}</mask>`;
      body += `<path d="${plate(c)}" fill="${top && acc ? acc : ink}" mask="url(#${id})"/>`;
    } else body += `<path d="${plate(c)}" fill="${acc || ink}"/>`;
  });
  return `<defs>${defs}</defs>${body}`;
}

export const MARKS = {
  layersStep: {
    title: 'Time steps',
    idea: 'The four plates step forward as they rise, like captures moving through time. The leaning silhouette is what separates it from the generic layers icon.',
    draw: ({ ink, acc }) => stack(ink, acc, [[26, 50], [30, 40], [34, 30], [38, 20]], 21, 8),
  },
  layersQuad: {
    title: 'Quad top',
    idea: 'The lit top plate is cut into four tiles, like a map split into quadrants: the "quad" in Quadrion, sitting on the stack of captures.',
    draw: ({ ink, acc }) => {
      const base = stack(ink, null, [[32, 48], [32, 38], [32, 28]], 24, 9, [32, 18]);
      const y = 18, T = [32, y - 9], R = [56, y], B = [32, y + 9], L = [8, y], C = [32, y];
      const TR = [44, y - 4.5], RB = [44, y + 4.5], BL = [20, y + 4.5], LT = [20, y - 4.5];
      const tiles = [[T, TR, C, LT], [TR, R, RB, C], [C, RB, B, BL], [LT, C, BL, L]].map((q) => {
        const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
        return poly(q.map(([x, yy]) => [cx + (x - cx) * 0.84, cy + (yy - cy) * 0.84]));
      });
      return base + tiles.map((d) => `<path d="${d}" fill="${acc}"/>`).join('');
    },
  },
  layersAxis: {
    title: 'Shared axis',
    idea: 'One vertical axis threads all four plates: every layer tied to the same point on the ground. Carries the plumb line from the Stratlas mark into the new name.',
    draw: ({ ink, acc }) => {
      const id = 'q' + ++uid;
      const s = stack(ink, acc, [[32, 50], [32, 40], [32, 30], [32, 20]], 23, 8.5);
      return `<defs><mask id="${id}"><rect width="64" height="64" fill="#fff"/><rect x="28.5" y="0" width="7" height="64" fill="#000"/></mask></defs>` +
        `<g mask="url(#${id})">${s}</g><line x1="32" y1="9" x2="32" y2="61" stroke="${acc}" stroke-width="3"/><circle cx="32" cy="7" r="4" fill="${acc}"/>`;
    },
  },

  tesseract: {
    title: 'Tesseract',
    idea: 'A four-dimensional cube drawn flat: a cube inside a cube, joined at every corner. Three dimensions plus time, which is exactly what the app shows.',
    draw: ({ ink, acc }) =>
      `<rect x="7" y="7" width="50" height="50" rx="2" fill="none" stroke="${ink}" stroke-width="4"/>` +
      `<path d="M9 9 L23 23 M55 9 L41 23 M55 55 L41 41 M9 55 L23 41" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>` +
      `<rect x="21" y="21" width="22" height="22" rx="1.5" fill="${acc}"/>`,
  },
  quadrants: {
    title: 'Four quadrants',
    idea: 'Four quarters of one circle, each a little larger than the last: four kinds of capture, and the dimensions growing into one whole. The largest is lit.',
    draw: ({ ink, acc }) =>
      `<path d="${sector(30, 30, 13, 90, 180)}" fill="${ink}"/>` +
      `<path d="${sector(34, 30, 17, 0, 90)}" fill="${ink}"/>` +
      `<path d="${sector(34, 34, 21, 270, 360)}" fill="${ink}"/>` +
      `<path d="${sector(30, 34, 25, 180, 270)}" fill="${acc}"/>`,
  },
  qaxis: {
    title: 'Q on a timeline',
    idea: 'A Q whose tail runs out along a timeline with two date ticks: the asset, and every survey of it laid out in time.',
    draw: ({ ink, acc }) =>
      `<circle cx="25" cy="27" r="17" fill="none" stroke="${ink}" stroke-width="6.5"/>` +
      `<path d="M25 44 H58" stroke="${acc}" stroke-width="6" stroke-linecap="round"/>` +
      `<path d="M42 37 V51 M53 39 V49" stroke="${acc}" stroke-width="3.5" stroke-linecap="round"/>` +
      `<circle cx="25" cy="27" r="4.5" fill="${acc}"/>`,
  },
  axes: {
    title: 'Three axes and time',
    idea: 'The x, y and z axes of the 3D scene meeting at one point, with time wrapped around them in the accent colour.',
    draw: ({ ink, acc }) => {
      const [ax, ay] = P(32, 36, 13, 200), [bx, by] = P(32, 36, 13, 120);
      return (
        `<path d="M32 36 V6 M32 36 L56 50 M32 36 L8 50" stroke="${ink}" stroke-width="4.5" stroke-linecap="round"/>` +
        `<path d="M${f(ax)} ${f(ay)} A13 13 0 1 0 ${f(bx)} ${f(by)}" fill="none" stroke="${acc}" stroke-width="4" stroke-linecap="round"/>` +
        `<path d="M${f(bx - 5.5)} ${f(by - 1.5)} L${f(bx + 1)} ${f(by - 4)} L${f(bx + 1.5)} ${f(by + 3)}Z" fill="${acc}"/>` +
        `<circle cx="32" cy="36" r="4" fill="${ink}"/>`
      );
    },
  },
  layers: {
    title: 'Four layers',
    idea: 'Model, point cloud, map and video as four plates in one stack, the top one lit. Carries on the layered idea from Stratlas, but it is close to the common "layers" icon, so it is the hardest to own.',
    draw: ({ ink, acc }) => {
      const plate = (y) => `M32 ${y - 9} L56 ${y} L32 ${y + 9} L8 ${y}Z`;
      const ys = [48, 38, 28, 18];
      let defs = '', body = '';
      ys.forEach((y, i) => {
        const above = ys.slice(i + 1);
        if (above.length) {
          const id = 'q' + ++uid;
          defs += `<mask id="${id}"><rect width="64" height="64" fill="#fff"/>${above.map((a) => `<path d="${plate(a)}" fill="#000" stroke="#000" stroke-width="5" stroke-linejoin="round"/>`).join('')}</mask>`;
          body += `<path d="${plate(y)}" fill="${ink}" mask="url(#${id})"/>`;
        } else body += `<path d="${plate(y)}" fill="${acc}"/>`;
      });
      return `<defs>${defs}</defs>${body}`;
    },
  },
  quadrant: {
    title: 'The quadrant',
    idea: "The astronomer's and surveyor's quadrant: a quarter circle graduated in degrees, with a sight line to one point. Measuring, from a fixed place.",
    draw: ({ ink, acc }) => {
      let ticks = '';
      for (let a = 0; a <= 90; a += 15) {
        const [x0, y0] = P(9, 55, a % 45 === 0 ? 37 : 40, a), [x1, y1] = P(9, 55, 46, a);
        ticks += `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" stroke="${ink}" stroke-width="2.6"/>`;
      }
      const [sx, sy] = P(9, 55, 46, 52);
      return (
        `<path d="M9 55 V9 A46 46 0 0 1 55 55 Z" fill="none" stroke="${ink}" stroke-width="4" stroke-linejoin="round"/>` + ticks +
        `<line x1="9" y1="55" x2="${f(sx)}" y2="${f(sy)}" stroke="${acc}" stroke-width="4" stroke-linecap="round"/>` +
        `<circle cx="${f(sx)}" cy="${f(sy)}" r="4.5" fill="${acc}"/><circle cx="9" cy="55" r="4" fill="${ink}"/>`
      );
    },
  },
  squareq: {
    title: 'Square Q',
    idea: 'A square frame (the site, the survey area) broken at one corner by a diagonal that becomes the tail of a Q. Reads as a frame, a map tile and a letter.',
    draw: ({ ink, acc }) =>
      `<path d="M40 54 H14 Q10 54 10 50 V14 Q10 10 14 10 H50 Q54 10 54 14 V40" fill="none" stroke="${ink}" stroke-width="6.5" stroke-linecap="round"/>` +
      `<path d="M36 36 L56 56" stroke="${acc}" stroke-width="6.5" stroke-linecap="round"/>` +
      `<rect x="22" y="22" width="9" height="9" rx="1" fill="${acc}"/>`,
  },
  facets: {
    title: 'Four facets',
    idea: 'A diamond cut into four facets: one object seen from four sides. Reads as a compass point and as a gem.',
    draw: ({ ink, acc }) => {
      const g = 2.2;
      return (
        `<path d="M${32 + g} ${6} L${58} ${32 - g} L${32 + g} ${32 - g}Z" fill="${acc}"/>` +
        `<path d="M${58} ${32 + g} L${32 + g} ${58} L${32 + g} ${32 + g}Z" fill="${ink}"/>` +
        `<path d="M${32 - g} ${58} L${6} ${32 + g} L${32 - g} ${32 + g}Z" fill="${ink}" fill-opacity=".7"/>` +
        `<path d="M${6} ${32 - g} L${32 - g} ${6} L${32 - g} ${32 - g}Z" fill="${ink}" fill-opacity=".45"/>`
      );
    },
  },
};

export const ORDER = ['tesseract', 'qaxis', 'squareq', 'quadrants', 'layers', 'axes', 'quadrant', 'facets'];

export function symbol(slug, c, size = 64) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">${MARKS[slug].draw(c)}</svg>`;
}

export function appIcon(slug, { ground, ink, acc }, size = 64) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">` +
    `<rect width="64" height="64" rx="14" fill="${ground}"/>` +
    `<g transform="translate(10.24 10.24) scale(0.68)">${MARKS[slug].draw({ ink, acc })}</g></svg>`
  );
}
