// Round 5 marks. 64-unit grid, two colours: ink (structure) and acc (accent).
// Every mark also works in one colour (pass the same value for both).

const f = (n) => +n.toFixed(2);
let uid = 0;
const rad = (d) => (d * Math.PI) / 180;

function gearPath(cx, cy, rRoot, rTip, teeth, phase = 0) {
  const pts = [];
  const step = 360 / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step + phase;
    // root, rise, tip, tip, fall
    for (const [da, r] of [[0, rRoot], [step * 0.18, rTip], [step * 0.5, rTip], [step * 0.68, rRoot]]) {
      pts.push([cx + r * Math.cos(rad(a + da)), cy + r * Math.sin(rad(a + da))]);
    }
  }
  return 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L') + 'Z';
}

export const MARKS = {
  // The augur's templum: a quarter of sky marked out, with a bird crossing it.
  auspex: {
    primary: ({ ink, acc }) =>
      `<path d="M8 56 V10 A46 46 0 0 1 54 56 Z" fill="none" stroke="${ink}" stroke-width="4" stroke-linejoin="round"/>` +
      `<path d="M8 33 A23 23 0 0 1 31 56" fill="none" stroke="${ink}" stroke-width="3"/>` +
      `<path d="M27 25 L35 31 L45 19" fill="none" stroke="${acc}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  // The main wheel of the Antikythera mechanism, fine-toothed like the
  // original, with a small bronze gear meshing on its rim.
  kythera: {
    primary: ({ ink, acc }) =>
      `<path d="${gearPath(27, 37, 21, 24, 36)} M${27 + 15.5} 37 A15.5 15.5 0 1 0 ${27 - 15.5} 37 A15.5 15.5 0 1 0 ${27 + 15.5} 37Z" fill="${ink}" fill-rule="evenodd"/>` +
      `<circle cx="27" cy="37" r="4" fill="${ink}"/>` +
      `<line x1="27" y1="37" x2="37.5" y2="26.5" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>` +
      `<path d="${gearPath(50.5, 13.5, 8.6, 11.4, 12, 8)} M53.5 13.5 A3 3 0 1 0 47.5 13.5 A3 3 0 1 0 53.5 13.5Z" fill="${acc}" fill-rule="evenodd"/>`,
  },
  // An eclipse: one body sliding across another, leaving a bright crescent.
  saros: {
    primary: ({ ink, acc }) => {
      const id = 'sar' + (++uid);
      return (
        `<defs><mask id="${id}"><rect width="64" height="64" fill="#fff"/><circle cx="38" cy="28" r="20" fill="#000"/></mask></defs>` +
        `<circle cx="29" cy="34" r="22" fill="${acc}" mask="url(#${id})"/>` +
        `<circle cx="38" cy="28" r="17.5" fill="none" stroke="${ink}" stroke-width="3.5"/>`
      );
    },
  },
  // Infinite time and space: a spiral unwinding from a single moment.
  zurvan: {
    primary: ({ ink, acc }) => {
      const pts = [];
      const turns = 2.6, a0 = 3, b = 1.47;
      for (let t = 0; t <= turns * 2 * Math.PI; t += 0.12) {
        const r = a0 + b * t;
        pts.push([32 + r * Math.cos(t - Math.PI / 2), 32 + r * Math.sin(t - Math.PI / 2)]);
      }
      const end = pts[pts.length - 1];
      return (
        `<path d="M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L')}" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<circle cx="32" cy="${f(32 - a0)}" r="3.6" fill="${acc}"/>` +
        `<circle cx="${f(end[0])}" cy="${f(end[1])}" r="3.6" fill="${acc}"/>`
      );
    },
  },
  // A solid block and its phantom double: the asset and its twin.
  eidolon: {
    primary: ({ ink, acc }) => {
      const cube = (dx, dy) => {
        const P = (x, y) => `${f(x + dx)} ${f(y + dy)}`;
        return { top: `M${P(22, 10)} L${P(36, 18)} L${P(22, 26)} L${P(8, 18)}Z`, left: `M${P(8, 18)} L${P(22, 26)} L${P(22, 42)} L${P(8, 34)}Z`, right: `M${P(22, 26)} L${P(36, 18)} L${P(36, 34)} L${P(22, 42)}Z`, out: `M${P(22, 10)} L${P(36, 18)} L${P(36, 34)} L${P(22, 42)} L${P(8, 34)} L${P(8, 18)}Z M${P(8, 18)} L${P(22, 26)} L${P(36, 18)} M${P(22, 26)} V${f(42 + dy)}` };
      };
      const g = cube(20, 0), s = cube(6, 16);
      return (
        `<g transform="translate(-10 -8.8) scale(1.2)"><path d="${g.out}" fill="none" stroke="${acc}" stroke-width="2.8" stroke-linejoin="round" stroke-dasharray="4 3"/>` +
        `<path d="${s.top}" fill="${ink}"/><path d="${s.left}" fill="${ink}" fill-opacity=".72"/><path d="${s.right}" fill="${ink}" fill-opacity=".45"/></g>`
      );
    },
  },
  // What was, what is, what will be: past and future cones meeting at now.
  calchas: {
    primary: ({ ink, acc }) =>
      `<path d="M10 8 H54 L32 32 Z" fill="none" stroke="${ink}" stroke-width="4" stroke-linejoin="round"/>` +
      `<path d="M10 56 H54 L32 32 Z" fill="${ink}"/>` +
      `<ellipse cx="32" cy="32" rx="16" ry="3.6" fill="none" stroke="${acc}" stroke-width="3"/>` +
      `<circle cx="32" cy="32" r="4" fill="${acc}"/>`,
  },
};

export function symbol(slug, colours, size = 64, extra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" ${extra} aria-hidden="true">${MARKS[slug].primary(colours)}</svg>`;
}

export function appIcon(slug, { ground, ink, acc }, size = 64, extra = '') {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" ${extra} aria-hidden="true">` +
    `<rect width="64" height="64" rx="14" fill="${ground}"/>` +
    `<g transform="translate(10.24 10.24) scale(0.68)">${MARKS[slug].primary({ ink, acc })}</g></svg>`
  );
}
