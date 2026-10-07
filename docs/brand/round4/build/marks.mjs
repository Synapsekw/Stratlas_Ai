// Round 4 marks. Each symbol sits on a 64-unit grid and takes two colours:
// ink (the structure) and acc (the one accent). Nothing depends on a font,
// so every mark works in one colour (pass the same value for ink and acc).

const f = (n) => +n.toFixed(2);
let uid = 0;

// smooth closed blob through n points (Catmull-Rom to cubic Bezier)
function blob(cx, cy, R, wobble, phase, n = 14, squash = 0.78) {
  const p = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = R * (1 + wobble * Math.sin(2 * t + phase) + wobble * 0.5 * Math.cos(3 * t - phase));
    p.push([cx + r * Math.cos(t), cy + r * Math.sin(t) * squash]);
  }
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + 'Z';
}

// annular sector between angles a0..a1 (degrees, 0 = east, counter-clockwise up)
function sector(cx, cy, r0, r1, a0, a1) {
  const pt = (r, a) => [cx + r * Math.cos((a * Math.PI) / 180), cy - r * Math.sin((a * Math.PI) / 180)];
  const [x1, y1] = pt(r1, a0), [x2, y2] = pt(r1, a1), [x3, y3] = pt(r0, a1), [x4, y4] = pt(r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${f(x1)} ${f(y1)} A${r1} ${r1} 0 ${large} 0 ${f(x2)} ${f(y2)} L${f(x3)} ${f(y3)} A${r0} ${r0} 0 ${large} 1 ${f(x4)} ${f(y4)}Z`;
}

export const MARKS = {
  // Keystone arch: five voussoirs, the keystone in accent. The piece that holds
  // the structure whole, standing on one ground line.
  integrum: {
    primary: ({ ink, acc }) => {
      const segs = [];
      const gap = 3.2, n = 5, span = 180 / n;
      for (let i = 0; i < n; i++) {
        const a0 = i * span + gap / 2, a1 = (i + 1) * span - gap / 2;
        const key = i === 2;
        segs.push(`<path d="${sector(32, 44, 13, key ? 28.5 : 26, a0, a1)}" fill="${key ? acc : ink}"/>`);
      }
      return segs.join('') + `<rect x="4" y="48" width="56" height="4" fill="${ink}"/>`;
    },
  },
  // Three capture rays (model, map, video) converging into one fused core.
  fusor: {
    primary: ({ ink, acc }) => {
      const rays = [-90, 30, 150].map((a) => {
        const r = (a * Math.PI) / 180;
        const x0 = 32 + 27 * Math.cos(r), y0 = 33 + 27 * Math.sin(r);
        const x1 = 32 + 12.5 * Math.cos(r), y1 = 33 + 12.5 * Math.sin(r);
        return `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" stroke="${ink}" stroke-width="5.5" stroke-linecap="round"/>`;
      });
      return (
        `<circle cx="32" cy="33" r="21" fill="none" stroke="${ink}" stroke-width="3"/>` +
        rays.join('') +
        `<circle cx="32" cy="33" r="7.5" fill="${acc}"/>`
      );
    },
  },
  // Geology block diagram of a syncline: the front face shows strata folded
  // down together, the side face carries them back. Middle layer in accent.
  syncline: {
    primary: ({ ink, acc }) => {
      const id = 'syn' + (++uid);
      const radii = [[26, ink], [34, acc], [42, ink]];
      const bands = radii.map(([r, c]) => `<circle cx="27" cy="10" r="${r}" fill="none" stroke="${c}" stroke-width="4.5"/>`).join('');
      const side = radii
        .map(([r, c]) => { const y = 10 + Math.sqrt(r * r - 17 * 17); return `<line x1="44" y1="${f(y)}" x2="56" y2="${f(y - 12)}" stroke="${c}" stroke-width="4.5"/>`; })
        .join('');
      return (
        `<defs><clipPath id="${id}"><rect x="10" y="24" width="34" height="32"/></clipPath></defs>` +
        `<g clip-path="url(#${id})">${bands}</g>` + side +
        `<path d="M10 24 L22 12 H56 V44 L44 56 H10 Z M10 24 H44 L56 12 M44 24 V56" fill="none" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/>`
      );
    },
  },
  // The alidade: a sighting rule with two vanes, pivoting on a graduated ring,
  // aimed at the sighted point.
  alidade: {
    primary: ({ ink, acc }) => {
      const ticks = [];
      for (let a = 0; a < 360; a += 30) {
        const r = (a * Math.PI) / 180;
        ticks.push(`<line x1="${f(32 + 17 * Math.cos(r))}" y1="${f(34 + 17 * Math.sin(r))}" x2="${f(32 + 20.5 * Math.cos(r))}" y2="${f(34 + 20.5 * Math.sin(r))}" stroke="${ink}" stroke-width="2"/>`);
      }
      const ux = 0.819, uy = -0.573, px = 0.573, py = 0.819;
      const e1 = [32 - 25 * ux, 34 - 25 * uy], e2 = [32 + 25 * ux, 34 + 25 * uy];
      const vane = ([x, y]) => `<line x1="${f(x - 6 * px)}" y1="${f(y - 6 * py)}" x2="${f(x + 6 * px)}" y2="${f(y + 6 * py)}" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>`;
      return (
        `<circle cx="32" cy="34" r="23" fill="none" stroke="${ink}" stroke-width="3"/>` +
        ticks.join('') +
        `<line x1="${f(e1[0])}" y1="${f(e1[1])}" x2="${f(e2[0])}" y2="${f(e2[1])}" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>` +
        vane(e1) + vane(e2) +
        `<circle cx="32" cy="34" r="4.5" fill="${acc}"/>` +
        `<circle cx="${f(32 + 33 * ux)}" cy="${f(34 + 33 * uy)}" r="3.6" fill="${acc}"/>`
      );
    },
  },
  // Half graticule, half clock face: where and when in one dial.
  chronotope: {
    primary: ({ ink, acc }) => {
      const ticks = [];
      for (let a = 0; a <= 180; a += 30) {
        const r = ((a - 90) * Math.PI) / 180;
        const len = a % 90 === 0 ? 7 : 4.5;
        ticks.push(`<line x1="${f(32 + (21 - len) * Math.cos(r))}" y1="${f(32 + (21 - len) * Math.sin(r))}" x2="${f(32 + 21 * Math.cos(r))}" y2="${f(32 + 21 * Math.sin(r))}" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>`);
      }
      const ha = (-45 * Math.PI) / 180;
      return (
        `<circle cx="32" cy="32" r="25" fill="none" stroke="${ink}" stroke-width="4"/>` +
        `<path d="M32 9 A12 23 0 0 0 32 55" fill="none" stroke="${ink}" stroke-width="2.6"/>` +
        `<line x1="9" y1="32" x2="32" y2="32" stroke="${ink}" stroke-width="2.6"/>` +
        `<path d="M13 21 Q22 23.5 32 23.5 M13 43 Q22 40.5 32 40.5" fill="none" stroke="${ink}" stroke-width="2"/>` +
        ticks.join('') +
        `<line x1="32" y1="32" x2="${f(32 + 17 * Math.cos(ha))}" y2="${f(32 + 17 * Math.sin(ha))}" stroke="${acc}" stroke-width="4.5" stroke-linecap="round"/>` +
        `<circle cx="32" cy="32" r="4.5" fill="${acc}"/>`
      );
    },
  },
  // Three contour lines round a summit; the changed line in accent.
  isoline: {
    primary: ({ ink, acc }) =>
      `<path d="${blob(30, 34, 26, 0.12, 0.4, 14, 0.88)}" fill="none" stroke="${ink}" stroke-width="3.4"/>` +
      `<path d="${blob(33, 30.5, 18, 0.14, 1.2, 14, 0.88)}" fill="none" stroke="${acc}" stroke-width="3.4"/>` +
      `<path d="${blob(36, 27.5, 10.5, 0.16, 2.2, 12, 0.88)}" fill="none" stroke="${ink}" stroke-width="3.4"/>` +
      `<path d="${blob(38.5, 25, 3.6, 0.1, 0.5, 10, 0.9)}" fill="none" stroke="${ink}" stroke-width="3"/>`,
  },
};

export function symbol(slug, colours, size = 64, extra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" ${extra} aria-hidden="true">${MARKS[slug].primary(colours)}</svg>`;
}

// app icon: rounded tile on the brand ground, mark at 68%
export function appIcon(slug, { ground, ink, acc }, size = 64, extra = '') {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" ${extra} aria-hidden="true">` +
    `<rect width="64" height="64" rx="14" fill="${ground}"/>` +
    `<g transform="translate(10.24 10.24) scale(0.68)">${MARKS[slug].primary({ ink, acc })}</g></svg>`
  );
}
