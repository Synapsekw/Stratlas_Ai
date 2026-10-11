# Quarter mark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Time steps icon with the Quarter mark everywhere it appears (brand kit, app and installer icons, title bar, launch screen) and add its three motions (Step out, Quarter turns, Full sequence).

**Architecture:** One geometry module in `@aio/brand` describes the mark. Still drawings (app symbol, kit, icons) use its exact outlines; a small motion engine in the desktop renderer turns the same geometry into polygons it can interpolate, and one React component (`BrandMotion`) plays a named motion. The launch screen keeps its own pointer springs and moves the pieces the component renders.

**Tech Stack:** TypeScript, React, Vitest (jsdom for components), Playwright for the Electron end to end spec, sharp for rasters, plain SVG. No new dependency.

**Spec:** `docs/plans/2026-10-11-quarter-mark-design.md`

## Global Constraints

- Branch `feat/quarter-mark`, worktree `.claude/worktrees/quarter-mark`. Never edit the main checkout. Stage by path, never `git add -A`. No `git stash`.
- Geometry values, verbatim from the spec: ring centre (29, 29); radii 10.5 and 23; quarter gap 2 per axis; tail square 21 wide at (35, 35); corner radius 1.6; bounds 4 to 56. Small cut: centre (28.5, 28.5), radii 8.5 and 24.5, corner 1.2, tail at (36, 36), 21 wide.
- Piece order is fixed everywhere: 0 north-west, 1 north-east, 2 south-west, 3 the tail. Piece 3 is the only accent-coloured piece.
- Colours come from the theme tokens through classes (`mark-piece`, `mark-tail`), never inline, so light and dark both work.
- Reduced motion (`:root[data-motion='reduce']` or `prefers-reduced-motion: reduce`): nothing moves.
- No `@aio/schema` change. `brand.json` is not touched.
- `quarter.ts` is imported directly by `.mjs` tools through Node's type stripping (as `tools/release/store-assets.mjs` already does with `marks.ts`): erasable TypeScript only, no enums, no parameter properties, no imports with side effects.
- Text in docs and the app: no client, site, tester or person names; no em or en dashes.
- Electron windows opened by tests stay off-screen (the e2e fixtures do this).
- Conventional commits, one per task.

## Review Focus

1. Reduced motion is on: the launch screen, the loader and About show the still mark and nothing animates. Pinned in Task 3 (component test) and Task 5 (existing reduced motion e2e test, updated selector).
2. The component unmounts or the window hides mid-animation: the frame loop stops and no late frame writes to a removed node. Pinned in Task 3.
3. Skip intro (or Esc) while Step out is running: the mark stands complete at once. Pinned in Task 3 (`still` flips to true) and Task 5 (e2e).
4. The mark at 16 px: icons of 32 px and less use the small cut, where the ring is one piece. Pinned in Task 1 (two small pieces) and Task 2 (the kit picks the small cut up to 32 px).
5. The moving mark at rest must be the same shape as the still mark, or the launch screen shows a different logo from the title bar. Pinned in Task 3 (bounds of the rest pose equal the still bounds).

## Execution DAG

```
T1 brand geometry
 ├── T2 kit + brand SVGs ──── T6 installer and Store images
 └── T3 motion engine + BrandMotion
      ├── T4 app symbol (SYMBOL, BrandSymbol, styles)
      ├── T5 launch screen
      ├── T7 loader placements
      └── T8 About sequence
T9 docs, checks, hand-off (after all)
```

| Batch | Tasks (run at once, no shared files) | Needs                  |
| ----- | ------------------------------------ | ---------------------- |
| 1     | T1                                   | nothing                |
| 2     | T2, T3                               | T1                     |
| 3     | T4, T5, T6, T7, T8                   | T2 (T6), T3 (the rest) |
| 4     | T9                                   | everything             |

Critical path: T1, T3, T5, T9 (the launch screen spec run the way CI runs it is the slowest check).

Within batch 3 the tree does not typecheck until T4 and T5 have both landed (T4 removes `layered`, T5 stops using it). Each task runs only its own test files; `pnpm check` runs once after the batch.

| Task | Packages and folders                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1   | `packages/brand/src`                                                                                                                                                                                   |
| T2   | `docs/brand/quadrion`, `packages/brand/*.svg`                                                                                                                                                          |
| T3   | `apps/desktop/src/renderer/shell` (new files only)                                                                                                                                                     |
| T4   | `packages/brand/src/marks.ts`, `packages/brand/src/index.test.ts`, `apps/desktop/src/renderer/shell/BrandMark.tsx`, `apps/desktop/src/renderer/styles.css`, `apps/desktop/src/renderer/help/print.css` |
| T5   | `apps/desktop/src/renderer/gate`, `apps/desktop/e2e/launch-gate.spec.ts`                                                                                                                               |
| T6   | `apps/desktop/build`, `docs/release/store-listing/images` (generated)                                                                                                                                  |
| T7   | `apps/desktop/src/renderer/screens/Projects.tsx`, `apps/desktop/src/renderer/globe/GlobeScreen.tsx`                                                                                                    |
| T8   | `apps/desktop/src/renderer/screens/settings/About.tsx`                                                                                                                                                 |
| T9   | `packages/brand/README.md`, `docs/TESTING.md`                                                                                                                                                          |

End to end specs changed: `apps/desktop/e2e/launch-gate.spec.ts` (T5). None added. Contract changes: none.

---

### Task 1: Brand geometry

**Files:**

- Create: `packages/brand/src/quarter.ts`
- Create: `packages/brand/src/quarter.test.ts`
- Modify: `packages/brand/src/index.ts` (add the export line)

**Interfaces:**

- Produces:
  - `type Pt = readonly [number, number]`
  - `interface QuarterCut { c: number; gap: number; r0: number; r1: number; corner: number; tail: { offset: number; size: number } }`
  - `QUARTER: QuarterCut`, `QUARTER_SMALL: QuarterCut`
  - `ringSection(cx, cy, r0, r1, a0, a1, corner): string` exact outline, true arcs
  - `roundSquare(x, y, size, corner): string`
  - `quarterPieces(cut?: QuarterCut): readonly [string, string, string, string]`
  - `quarterSmallPieces(cut?: QuarterCut): readonly [string, string]` (ring, tail)
  - `quarterBounds(cut: QuarterCut): { x: number; y: number; w: number; h: number }`
  - `sectorPolygon(cx, cy, r0, r1, a0, a1, steps?): Pt[]` sharp-cornered polygon, clockwise on screen
  - `quarterPolygons(cut?: QuarterCut): Pt[][]` four sharp polygons in piece order
  - `ringPolygons(cut?: QuarterCut): Pt[][]` the closed ring: like `quarterPolygons` but piece 3 is the south-east quarter

- [ ] **Step 1: Write the failing test** (`packages/brand/src/quarter.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import {
  QUARTER,
  QUARTER_SMALL,
  quarterBounds,
  quarterPieces,
  quarterPolygons,
  quarterSmallPieces,
  ringPolygons,
  ringSection,
  roundSquare,
  sectorPolygon,
} from './quarter';

const numbers = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe('the Quarter mark', () => {
  it('has three quarters and a tail, each a closed outline', () => {
    const pieces = quarterPieces();
    expect(pieces).toHaveLength(4);
    for (const d of pieces) expect(d).toMatch(/^M[\d. -]+.*Z$/);
    // the quarters are ring sections (two long arcs), the tail has none
    expect(pieces[0].match(/A23 23/g)).toHaveLength(1);
    expect(pieces[0].match(/A10\.5 10\.5/g)).toHaveLength(1);
    expect(pieces[3]).not.toMatch(/A23 23/);
  });

  it('stays inside its bounds: 4 to 56 on both axes', () => {
    expect(quarterBounds(QUARTER)).toEqual({ x: 4, y: 4, w: 52, h: 52 });
    for (const poly of quarterPolygons())
      for (const [x, y] of poly) {
        expect(x).toBeGreaterThanOrEqual(4 - 1e-9);
        expect(x).toBeLessThanOrEqual(56 + 1e-9);
        expect(y).toBeGreaterThanOrEqual(4 - 1e-9);
        expect(y).toBeLessThanOrEqual(56 + 1e-9);
      }
  });

  it('starts the outer arc of the north-west quarter on the outer circle', () => {
    const [x, y] = numbers(ringSection(27, 27, 10.5, 23, 180, 270, 1.6));
    expect(Math.hypot((x ?? 0) - 27, (y ?? 0) - 27)).toBeCloseTo(23, 1);
  });

  it('rounds the tail with the corner radius', () => {
    expect(roundSquare(35, 35, 21, 1.6)).toBe(
      'M36.6 35H54.4A1.6 1.6 0 0 1 56 36.6V54.4A1.6 1.6 0 0 1 54.4 56H36.6A1.6 1.6 0 0 1 35 54.4V36.6A1.6 1.6 0 0 1 36.6 35Z',
    );
  });

  it('has a small cut of two pieces: one closed ring section and the tail', () => {
    const [ring, tail] = quarterSmallPieces();
    // 270 degrees of ring: both long arcs take the large-arc flag
    expect(ring).toMatch(/A24\.5 24\.5 0 1 1/);
    expect(ring).toMatch(/A8\.5 8\.5 0 1 0/);
    expect(tail).toMatch(/^M37\.2 36H/);
    expect(quarterBounds(QUARTER_SMALL)).toEqual({ x: 4, y: 4, w: 53, h: 53 });
  });

  it('draws polygons clockwise, in piece order, the tail last', () => {
    const polys = quarterPolygons();
    expect(polys).toHaveLength(4);
    expect(polys[3]).toEqual([
      [35, 35],
      [56, 35],
      [56, 56],
      [35, 56],
    ]);
    const area = (p: readonly (readonly [number, number])[]) =>
      p.reduce((a, [x, y], i) => {
        const [nx, ny] = p[(i + 1) % p.length] ?? [0, 0];
        return a + x * ny - nx * y;
      }, 0) / 2;
    for (const p of polys) expect(area(p)).toBeGreaterThan(0);
    expect(sectorPolygon(0, 0, 0, 10, 0, 90, 4)).toHaveLength(6);
  });

  it('closes the ring with a south-east quarter for the Step out motion', () => {
    const ring = ringPolygons();
    expect(ring).toHaveLength(4);
    // the fourth quarter sits south-east of the centre
    for (const [x, y] of ring[3] ?? []) {
      expect(x).toBeGreaterThanOrEqual(31 - 1e-9);
      expect(y).toBeGreaterThanOrEqual(31 - 1e-9);
    }
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run packages/brand/src/quarter.test.ts --retry=0`
Expected: FAIL, cannot resolve `./quarter`.

- [ ] **Step 3: Write `packages/brand/src/quarter.ts`**

```ts
/**
 * Geometry of the Quarter mark on the brand kit's 64 unit grid: three quarters of a ring and a
 * square tail, the fourth piece. Still drawings use the exact outlines (`quarterPieces`); motion
 * uses the sharp polygons (`quarterPolygons`), inset by the corner radius and drawn with a round
 * stroke of twice that radius, which gives the same shape. Angles are in degrees, clockwise from
 * the positive x axis (y points down). Pure functions; `.mjs` tools import this file directly.
 */

export type Pt = readonly [number, number];

export interface QuarterCut {
  /** Ring centre, x and y. */
  c: number;
  /** Each quarter is pushed this far from the centre on both axes. */
  gap: number;
  /** Inner and outer ring radius. */
  r0: number;
  r1: number;
  /** Corner radius of every piece. */
  corner: number;
  /** The tail: a square `size` wide, its top-left corner `offset` from the ring centre on both axes. */
  tail: { offset: number; size: number };
}

/** The mark (cut A1 of the 11 Oct 2026 board). */
export const QUARTER: QuarterCut = {
  c: 29,
  gap: 2,
  r0: 10.5,
  r1: 23,
  corner: 1.6,
  tail: { offset: 6, size: 21 },
};

/** 32 px and less: the three quarters close into one ring section, the tail sits a little off. */
export const QUARTER_SMALL: QuarterCut = {
  c: 28.5,
  gap: 0,
  r0: 8.5,
  r1: 24.5,
  corner: 1.2,
  tail: { offset: 7.5, size: 21 },
};

const n = (v: number) => String(+v.toFixed(2));
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Outline of a ring section from `a0` to `a1` with every corner rounded by `corner`. */
export function ringSection(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
  corner: number,
): string {
  const outer = r1 - corner;
  const inner = r0 + corner;
  const u0: Pt = [Math.cos(rad(a0)), Math.sin(rad(a0))];
  const u1: Pt = [Math.cos(rad(a1)), Math.sin(rad(a1))];
  // normals of the two straight edges, pointing into the section
  const n0: Pt = [-u0[1], u0[0]];
  const n1: Pt = [u1[1], -u1[0]];
  /** Centre of the corner circle where the edge along `u` meets the arc of radius `r`. */
  const centre = (u: Pt, inward: Pt, r: number): Pt => {
    const t = Math.sqrt(r * r - corner * corner);
    return [cx + u[0] * t + inward[0] * corner, cy + u[1] * t + inward[1] * corner];
  };
  const move = (p: Pt, v: Pt, k: number): Pt => [p[0] + v[0] * k, p[1] + v[1] * k];
  const radial = (p: Pt, r: number): Pt => [(p[0] - cx) / r, (p[1] - cy) / r];
  const a = centre(u0, n0, outer);
  const b = centre(u1, n1, outer);
  const c = centre(u1, n1, inner);
  const d = centre(u0, n0, inner);
  const at = (p: Pt) => `${n(p[0])} ${n(p[1])}`;
  const fillet = `A${n(corner)} ${n(corner)} 0 0 1 `;
  const large = a1 - a0 > 180 ? 1 : 0;
  return (
    `M${at(move(a, radial(a, outer), corner))}` +
    `A${n(r1)} ${n(r1)} 0 ${String(large)} 1 ${at(move(b, radial(b, outer), corner))}` +
    fillet +
    at(move(b, n1, -corner)) +
    `L${at(move(c, n1, -corner))}` +
    fillet +
    at(move(c, radial(c, inner), -corner)) +
    `A${n(r0)} ${n(r0)} 0 ${String(large)} 0 ${at(move(d, radial(d, inner), -corner))}` +
    fillet +
    at(move(d, n0, -corner)) +
    `L${at(move(a, n0, -corner))}` +
    fillet +
    at(move(a, radial(a, outer), corner)) +
    'Z'
  );
}

/** Outline of a square with rounded corners. */
export function roundSquare(x: number, y: number, size: number, corner: number): string {
  const r = `A${n(corner)} ${n(corner)} 0 0 1 `;
  const x1 = x + size;
  const y1 = y + size;
  return (
    `M${n(x + corner)} ${n(y)}H${n(x1 - corner)}${r}${n(x1)} ${n(y + corner)}` +
    `V${n(y1 - corner)}${r}${n(x1 - corner)} ${n(y1)}` +
    `H${n(x + corner)}${r}${n(x)} ${n(y1 - corner)}` +
    `V${n(y + corner)}${r}${n(x + corner)} ${n(y)}Z`
  );
}

/** Where each quarter's own centre sits and the angles it spans: north-west, north-east, south-west. */
const QUARTERS: readonly (readonly [number, number, number, number])[] = [
  [-1, -1, 180, 270],
  [1, -1, 270, 360],
  [-1, 1, 90, 180],
];

/** The mark as four outlines: three quarters, then the tail. */
export function quarterPieces(
  cut: QuarterCut = QUARTER,
): readonly [string, string, string, string] {
  const q = QUARTERS.map(([sx, sy, a0, a1]) =>
    ringSection(cut.c + sx * cut.gap, cut.c + sy * cut.gap, cut.r0, cut.r1, a0, a1, cut.corner),
  );
  const t = cut.c + cut.tail.offset;
  return [q[0] ?? '', q[1] ?? '', q[2] ?? '', roundSquare(t, t, cut.tail.size, cut.corner)];
}

/** The small cut as two outlines: the ring section, then the tail. */
export function quarterSmallPieces(cut: QuarterCut = QUARTER_SMALL): readonly [string, string] {
  const t = cut.c + cut.tail.offset;
  return [
    ringSection(cut.c, cut.c, cut.r0, cut.r1, 90, 360, cut.corner),
    roundSquare(t, t, cut.tail.size, cut.corner),
  ];
}

/** The square the mark occupies. */
export function quarterBounds(cut: QuarterCut): { x: number; y: number; w: number; h: number } {
  const min = cut.c - cut.gap - cut.r1;
  const size = cut.c + cut.tail.offset + cut.tail.size - min;
  return { x: min, y: min, w: size, h: size };
}

/** A ring section (a pie slice when `r0` is 0) as a sharp polygon, clockwise on screen. */
export function sectorPolygon(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
  steps = 12,
): Pt[] {
  const at = (r: number, i: number): Pt => {
    const a = rad(a0 + ((a1 - a0) * i) / steps);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) out.push(at(r1, i));
  if (r0 > 0) for (let i = steps; i >= 0; i--) out.push(at(r0, i));
  else out.push([cx, cy]);
  return out;
}

const quarterPolygon = (cut: QuarterCut, i: number): Pt[] => {
  const [sx, sy, a0, a1] = QUARTERS[i] ?? [0, 0, 0, 0];
  return sectorPolygon(cut.c + sx * cut.gap, cut.c + sy * cut.gap, cut.r0, cut.r1, a0, a1);
};

/** The mark as four sharp polygons in piece order (inset them by `corner` before stroking). */
export function quarterPolygons(cut: QuarterCut = QUARTER): Pt[][] {
  const t = cut.c + cut.tail.offset;
  const s = cut.tail.size;
  return [
    quarterPolygon(cut, 0),
    quarterPolygon(cut, 1),
    quarterPolygon(cut, 2),
    [
      [t, t],
      [t + s, t],
      [t + s, t + s],
      [t, t + s],
    ],
  ];
}

/** The closed ring the Step out motion starts from: the fourth piece is the south-east quarter. */
export function ringPolygons(cut: QuarterCut = QUARTER): Pt[][] {
  return [
    quarterPolygon(cut, 0),
    quarterPolygon(cut, 1),
    quarterPolygon(cut, 2),
    sectorPolygon(cut.c + cut.gap, cut.c + cut.gap, cut.r0, cut.r1, 0, 90),
  ];
}
```

- [ ] **Step 4: Export it.** In `packages/brand/src/index.ts`, next to `export { SYMBOL, WORDMARK } from './marks';` add:

```ts
export * from './quarter';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/brand --retry=0`
Expected: PASS (the new file and the existing `index.test.ts`). If a numeric expectation is off by rounding, fix the function, not the expectation, unless the expectation contradicts the spec values.

- [ ] **Step 6: Commit**

```bash
git add packages/brand/src/quarter.ts packages/brand/src/quarter.test.ts packages/brand/src/index.ts
git commit -m "feat(brand): geometry of the Quarter mark"
```

---

### Task 2: Brand kit and the brand package's SVGs

**Files:**

- Modify: `docs/brand/quadrion/build/kit.mjs`
- Regenerate: everything under `docs/brand/quadrion/kit/`
- Regenerate: `packages/brand/icon.svg`, `packages/brand/icon-small.svg`, `packages/brand/mark.svg`
- Create: `docs/brand/quadrion/quarter/index.html` (the round three board, as the record of the choice)

**Interfaces:**

- Consumes: `quarterPieces`, `quarterSmallPieces`, `quarterBounds`, `QUARTER`, `QUARTER_SMALL` from `packages/brand/src/quarter.ts` (import path from the script: `../../../../packages/brand/src/quarter.ts`).
- Produces: `packages/brand/icon.svg` (512 tile, `rx="112"`, ground `#11161C`, mark at scale 6.2 centred on its bounds), `packages/brand/icon-small.svg` (small cut at scale 7), `packages/brand/mark.svg` (the horizontal lockup on dark, no background). Task 6 rasterises the first two.

- [ ] **Step 1: Replace the mark in `kit.mjs`.** Delete `CENTRES`, the old `mark()` and `MB`. Add the import and:

```js
import {
  QUARTER,
  QUARTER_SMALL,
  quarterBounds,
  quarterPieces,
  quarterSmallPieces,
} from '../../../../packages/brand/src/quarter.ts';

// ---------- the mark: Quarter ----------
// Three quarters of a ring in ink and a square tail in the accent. No masks: the gaps are real.
function mark(ink, acc, { small = false } = {}) {
  const pieces = small ? quarterSmallPieces() : quarterPieces();
  return pieces
    .map((d, i) => `<path d="${d}" fill="${i === pieces.length - 1 ? acc : ink}"/>`)
    .join('');
}
const MB = quarterBounds(QUARTER);
const MB_SMALL = quarterBounds(QUARTER_SMALL);
```

Every caller passes `{ prefix }` today; drop that argument at each call (`horizontal`, `stacked`, `symbolDoc`, `icon`). Change the header comment's "the Time steps mark" to "the Quarter mark".

- [ ] **Step 2: Icons.** Replace `icon` and `iconSmall` with:

```js
// Master: same format as packages/brand/icon.svg (512 tile, rx 112). The small cut is drawn larger.
const icon = ({ small = false, title = 'Quadrion AI app icon' } = {}) => {
  const b = small ? MB_SMALL : MB,
    scale = small ? 7 : 6.2;
  return svgDoc(
    512,
    512,
    `<rect width="512" height="512" rx="112" fill="${C.ground}"/>` +
      `<g transform="translate(256 256) scale(${scale}) translate(${-(b.x + b.w / 2)} ${-(b.y + b.h / 2)})">${mark(C.ink, C.mint, { small })}</g>`,
    title,
  );
};
const iconSmall = () =>
  icon({ small: true, title: 'Quadrion AI app icon, small-size cut (16-32 px)' });
```

- [ ] **Step 3: Write the brand package's copies.** After the `W('favicon/favicon.svg', ICON_SMALL);` line add:

```js
// packages/brand holds the copies the app and the installers read; written here so they cannot drift
const brandDir = join(here, '../../../../packages/brand');
writeFileSync(join(brandDir, 'icon.svg'), ICON + '\n');
writeFileSync(join(brandDir, 'icon-small.svg'), ICON_SMALL + '\n');
writeFileSync(join(brandDir, 'mark.svg'), horizontal(C.ink, C.mint, null) + '\n');
```

Check how the three files end today (`tail -c 1`) and match it (drop the `'\n'` if they have no final newline) so `pnpm format:check` and the diff stay clean.

- [ ] **Step 4: Brand sheet text.** In the "brand sheet" section of `kit.mjs`, replace every sentence that describes the mark as plates or "Time steps" with the Quarter description: "Quarter: three quarters of a ring and a mint square. Three dimensions of space and a fourth that is different. It reads as a Q." Search the file for `plate`, `Time steps` and `step` and leave none that describes the mark.

- [ ] **Step 5: Run the generator**

Run (from `docs/brand/quadrion/build`): `npm install --no-audit --no-fund` once if `node_modules/opentype.js` is missing, then `node kit.mjs`
Expected: exits 0; `git status --short docs/brand/quadrion/kit packages/brand` lists the symbol, lockup, icon, favicon files, `index.html` and the three brand package SVGs as modified. The wordmark SVGs must be unchanged (`git diff --stat docs/brand/quadrion/kit/wordmark` prints nothing).

- [ ] **Step 6: Look at the result.** Read `docs/brand/quadrion/kit/icon/png/256x256.png`, `16x16.png` and `32x32.png` with the Read tool. Expected: a dark rounded tile with a white three-quarter ring and a mint square bottom right; at 16 and 32 px the ring is one piece. Read `packages/brand/mark.svg` rendered: `node -e "require('sharp')('packages/brand/mark.svg').png().toFile(process.env.TEMP+'/mark.png')"` from the repo root, then Read that PNG: the mark beside QUADRION AI, optically centred on the cap height.

- [ ] **Step 7: Add the board.** Copy the round three board to `docs/brand/quadrion/quarter/index.html` (source: the session scratchpad `marks/preview-q.html`, or read it back from the artifact). In the copy, replace the M3 note with "All four forms in turn." Run `node tools/agent/check-public-text.mjs docs/brand/quadrion/quarter/index.html docs/brand/quadrion/kit/index.html`; expected: no findings.

- [ ] **Step 8: Commit**

```bash
git add docs/brand/quadrion/build/kit.mjs docs/brand/quadrion/kit docs/brand/quadrion/quarter packages/brand/icon.svg packages/brand/icon-small.svg packages/brand/mark.svg
git commit -m "feat(brand): the brand kit draws the Quarter mark"
```

---

### Task 3: Motion engine and the BrandMotion component

**Files:**

- Create: `apps/desktop/src/renderer/shell/brandMotionEngine.ts`
- Create: `apps/desktop/src/renderer/shell/brandMotionEngine.test.ts`
- Create: `apps/desktop/src/renderer/shell/BrandMotion.tsx`
- Create: `apps/desktop/src/renderer/shell/BrandMotion.test.tsx`
- Create: `apps/desktop/src/renderer/shell/brandMotion.css`

The engine file is `brandMotionEngine.ts`, not `brandMotion.ts`: beside `BrandMotion.tsx` the shorter name collides on a case-insensitive file system, and the bundler then resolves `./BrandMotion` to the engine. Found while building; the rest pose tolerance in the engine test is 0.12 for the same kind of reason (the polygons sit 0.05 inside the exact outline).

**Interfaces:**

- Consumes: `QUARTER`, `quarterPolygons`, `ringPolygons`, `sectorPolygon`, `quarterBounds`, `type Pt` from `@aio/brand`.
- Produces (`brandMotionEngine.ts`):
  - `type MotionName = 'stepOut' | 'turns' | 'sequence'`
  - `interface Pose { label: string; rot: number; halo: number; opacity: readonly number[]; pts: readonly (readonly Pt[])[] }`
  - `interface Motion { name: MotionName; poses: readonly Pose[]; rest: Pose; lead: number; move: number; stagger: number; hold: number; back: boolean; loops: boolean; fromFirst: boolean }`
  - `interface PieceFrame { d: string; opacity: number; rot: number; halo: number }`
  - `POINTS = 48`, `STROKE = 2 * QUARTER.corner`
  - `getMotion(name: MotionName): Motion` (cached)
  - `motionLength(m: Motion): number` milliseconds of one pass
  - `frameAt(m: Motion, ms: number): { pieces: PieceFrame[]; pose: number; done: boolean }`
  - `restFrame(): PieceFrame[]`
  - `insetPolygon(p: readonly Pt[], r: number): Pt[]`, `resamplePolygon(p: readonly Pt[], count: number): Pt[]`
- Produces (`BrandMotion.tsx`):
  - `BrandMotion(props: { motion: MotionName; className?: string; still?: boolean; loop?: boolean; label?: string; onDone?: () => void })`. Renders `<svg class="bm {className}" viewBox={SYMBOL-independent '4 4 52 52'}>` holding four `<g data-piece="0..3">`, each with `<path class="bm-halo">` and `<path class="bm-shape mark-piece">` (piece 3: `bm-shape mark-tail`). Plays once on mount (and again when `motion` changes) unless `still`; `loop` repeats; `onDone` fires when a single pass ends or at once when still.
  - `BrandLoader(props: { className?: string; label?: string })`: `BrandMotion` with `motion="turns"` and `loop`.
- Produces (`brandMotion.css`): `.bm`, `.bm-shape`, `.bm-halo`, `.brand-loader`, `.pc-loader`, `.globe-loader`, `.about-lockup` (used by Tasks 5, 7 and 8, so they add no CSS of their own for these).

Timings (milliseconds): Step out `lead 260, move 600, stagger 40, hold 0`, `fromFirst: true`, poses `[ring, mark]`. Sequence `move 520, stagger 55, hold 360`, poses `[map, model, dates, globe, mark]`, starts from the rest pose. Turns `move 520, stagger 45, hold 200`, `back: true`, `loops: true`, poses are the mark at `rot` 90, 180, 270, 360.

The forms, on the mark's own grid (centred on (30, 30); these are the board's forms moved by (-2, -2)):

```ts
const rect = (x: number, y: number, w: number, h: number): Pt[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
const MAP = [rect(6, 6, 22, 22), rect(32, 6, 22, 22), rect(6, 32, 22, 22), rect(32, 32, 22, 22)];
const GLOBE = [
  sectorPolygon(28, 28, 0, 24, 180, 270),
  sectorPolygon(32, 28, 0, 24, 270, 360),
  sectorPolygon(28, 32, 0, 24, 90, 180),
  sectorPolygon(32, 32, 0, 24, 0, 90),
];
const DATES = [
  rect(2, 25.5, 9, 9),
  rect(16, 25.5, 9, 9),
  rect(30, 25.5, 9, 9),
  rect(43, 22.5, 15, 15),
];
/** A cube of edge 17, top vertex at (30, 18), and a plate lifted 11 above its top face: top, right, left, plate. */
function cube(): Pt[][] {
  const e = 17,
    cx = 30,
    y = 18,
    dx = e * Math.cos(Math.PI / 6),
    dy = e / 2;
  const top: Pt[] = [
    [cx, y],
    [cx + dx, y + dy],
    [cx, y + 2 * dy],
    [cx - dx, y + dy],
  ];
  return [
    top,
    [
      [cx, y + 2 * dy],
      [cx + dx, y + dy],
      [cx + dx, y + dy + e],
      [cx, y + 2 * dy + e],
    ],
    [
      [cx - dx, y + dy],
      [cx, y + 2 * dy],
      [cx, y + 2 * dy + e],
      [cx - dx, y + dy + e],
    ],
    top.map(([px, py]): Pt => [px, py - 11]),
  ];
}
```

The model pose has `halo: 2.2`, `opacity: [1, 0.5, 0.75, 1]` and its three faces are inset by a further 0.9 (the plate is not). Every other pose has `halo: 0` and full opacity.

- [ ] **Step 1: Write the failing engine test** (`brandMotionEngine.test.ts`)

```ts
import { QUARTER, quarterBounds } from '@aio/brand';
import { describe, expect, it } from 'vitest';
import {
  frameAt,
  getMotion,
  insetPolygon,
  motionLength,
  POINTS,
  resamplePolygon,
  restFrame,
} from './brandMotionEngine';

const points = (d: string) =>
  d
    .replace(/[MZ]/g, '')
    .split('L')
    .map((s) => s.trim().split(' ').map(Number) as [number, number]);

describe('polygons', () => {
  it('inset a clockwise square inward', () => {
    expect(
      insetPolygon(
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        1,
      ),
    ).toEqual([
      [1, 1],
      [9, 1],
      [9, 9],
      [1, 9],
    ]);
  });
  it('resample to a fixed count and keep every corner', () => {
    const out = resamplePolygon(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      POINTS,
    );
    expect(out).toHaveLength(POINTS);
    for (const c of [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
      expect(out.some(([x, y]) => x === c[0] && y === c[1])).toBe(true);
    // the first point is the one up and to the left of the centre
    expect(out[0]).toEqual([0, 0]);
  });
});

describe('the rest pose', () => {
  it('is four pieces of the same shape as the still mark', () => {
    const rest = restFrame();
    expect(rest).toHaveLength(4);
    const b = quarterBounds(QUARTER);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const piece of rest)
      for (const [x, y] of points(piece.d)) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    // polygons are inset by the corner radius and the round stroke puts it back; the rounded
    // corners stop 0.06 short of the ring's nominal edge, hence the tolerance
    const near = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThan(0.1);
    near(x0 - QUARTER.corner, b.x);
    near(y0 - QUARTER.corner, b.y);
    near(x1 + QUARTER.corner, b.x + b.w);
    near(y1 + QUARTER.corner, b.y + b.h);
    for (const piece of rest) expect(piece).toMatchObject({ opacity: 1, rot: 0, halo: 0 });
  });
});

describe('motions', () => {
  it('Step out starts on the closed ring and ends on the mark in about a second', () => {
    const m = getMotion('stepOut');
    expect(motionLength(m)).toBe(980);
    const first = frameAt(m, 0);
    expect(first.done).toBe(false);
    expect(first.pieces[3]?.d).not.toBe(restFrame()[3]?.d);
    // the three quarters do not move
    expect(first.pieces[0]?.d).toBe(restFrame()[0]?.d);
    const end = frameAt(m, 980);
    expect(end.done).toBe(true);
    expect(end.pieces.map((p) => p.d)).toEqual(restFrame().map((p) => p.d));
  });

  it('the sequence passes through four forms and ends on the mark', () => {
    const m = getMotion('sequence');
    expect(m.poses.map((p) => p.label)).toEqual(['Map', 'Model', 'Dates', 'Globe', 'Quarter']);
    expect(motionLength(m)).toBe(4865);
    expect(frameAt(m, 0).pieces.map((p) => p.d)).toEqual(restFrame().map((p) => p.d));
    expect(frameAt(m, 5000).done).toBe(true);
    // in the model the plate lifts off the cube: a halo keeps it apart
    const model = frameAt(m, 685 + 360 + 685).pieces;
    expect(model[3]?.halo).toBeCloseTo(2.2);
    expect(model[1]?.opacity).toBeCloseTo(0.5);
  });

  it('Quarter turns loops, a quarter at a time, and never reports done', () => {
    const m = getMotion('turns');
    expect(m.loops).toBe(true);
    const loop = motionLength(m);
    expect(loop).toBe(4 * (520 + 3 * 45 + 200));
    expect(frameAt(m, loop / 4 - 1).pieces[0]?.rot).toBeCloseTo(90, 0);
    expect(frameAt(m, loop * 3 + 10).done).toBe(false);
    // the same moment one loop later looks the same
    expect(frameAt(m, 300).pieces[3]?.rot).toBeCloseTo(frameAt(m, 300 + loop).pieces[3]?.rot ?? -1);
  });

  it('never produces a broken path', () => {
    for (const name of ['stepOut', 'turns', 'sequence'] as const) {
      const m = getMotion(name);
      for (let ms = 0; ms <= motionLength(m); ms += 37)
        for (const p of frameAt(m, ms).pieces) expect(p.d).not.toMatch(/NaN|undefined/);
    }
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/brandMotionEngine.test.ts --retry=0`
Expected: FAIL, cannot resolve `./brandMotion`.

- [ ] **Step 3: Write `brandMotionEngine.ts`.** Port the board's engine (it is proven there) to typed code with these parts:

  - `insetPolygon`: normalise to clockwise (shoelace area, reverse when negative), then move each vertex by `(n1 + n2) * r / (1 + n1.n2)` where `n1`, `n2` are the inward normals `(-dy, dx) / len` of the edges before and after it. Round results with `+v.toFixed(6)` so the square test is exact.
  - `resamplePolygon`: keep every vertex; share `count - vertices` extra points between edges in proportion to edge length (largest remainder for the leftovers), evenly spaced on each edge; then rotate the list so it starts at the point with the largest `(-dx - dy) / length` measured from the centre of the bounding box.
  - `pose(label, polys, { rot = 0, halo = 0, opacity = [1, 1, 1, 1], extraInset = [0, 0, 0, 0] })`: `pts = polys.map((p, i) => resamplePolygon(insetPolygon(p, QUARTER.corner + extraInset[i]), POINTS))`.
  - Easing: `inOut(t) = t < 0.5 ? 4t³ : 1 - (-2t + 2)³ / 2`; `backOut(t) = 1 + 2.1(t - 1)³ + 1.1(t - 1)²`. The last transition of a non-looping motion uses `backOut`; every transition of a `back` motion uses `backOut`; the rest use `inOut`. Opacity and halo use the eased value clamped to 0..1; points and `rot` use it unclamped.
  - `frameAt`: one transition lasts `move + 3 * stagger`; piece `i` starts `i * stagger` late. A segment is a transition plus `hold`. With `fromFirst` the motion holds `poses[0]` for `lead`, then runs `poses.length - 1` segments (no hold after the last); otherwise it runs `poses.length` segments from `rest` (no hold after the last). A looping motion keeps the hold after the last segment and takes `ms` modulo its length; its first segment starts from `rest` with `rot` 0. `pose` in the result is the index of the pose being approached or held. `done` is `ms >= motionLength(m)` for non-looping motions and always false for looping ones. Path data: `M x y L x y ... Z` with `toFixed(2)`.
  - `motionLength`: `fromFirst`: `lead + (poses.length - 1) * (move + 3 * stagger) + (poses.length - 2) * hold`; looping: `poses.length * (move + 3 * stagger + hold)`; otherwise `poses.length * (move + 3 * stagger) + (poses.length - 1) * hold`.
  - `restFrame`: the rest pose as `PieceFrame[]` (`rot: 0`, `halo: 0`, `opacity: 1`).

- [ ] **Step 4: Run the engine tests**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/brandMotionEngine.test.ts --retry=0`
Expected: PASS.

- [ ] **Step 5: Write the failing component test** (`BrandMotion.test.tsx`; copy the jsdom pragma and the render and cleanup helpers from `apps/desktop/src/renderer/shell/PanelHandle.test.tsx`, which is the pattern this folder uses)

```tsx
// (jsdom pragma and render helper as in PanelHandle.test.tsx)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandLoader, BrandMotion } from './BrandMotion';
import { restFrame } from './brandMotionEngine';

afterEach(() => {
  vi.useRealTimers();
  delete document.documentElement.dataset.motion;
});

describe('BrandMotion', () => {
  it('renders four pieces in order, the tail last, coloured by class', () => {
    const { container } = render(<BrandMotion motion="stepOut" still label="Quadrion AI" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('Quadrion AI');
    const groups = [...container.querySelectorAll('g[data-piece]')];
    expect(groups.map((g) => g.getAttribute('data-piece'))).toEqual(['0', '1', '2', '3']);
    expect(groups[0]?.querySelector('.bm-shape')?.classList.contains('mark-piece')).toBe(true);
    expect(groups[3]?.querySelector('.bm-shape')?.classList.contains('mark-tail')).toBe(true);
    // no inline colour: the theme decides
    for (const p of container.querySelectorAll('path')) expect(p.getAttribute('fill')).toBeNull();
  });

  it('stands at rest when still, and says so at once', () => {
    const done = vi.fn();
    const { container } = render(<BrandMotion motion="sequence" still onDone={done} />);
    const shapes = [...container.querySelectorAll('.bm-shape')].map((p) => p.getAttribute('d'));
    expect(shapes).toEqual(restFrame().map((p) => p.d));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('does not move under reduced motion', () => {
    document.documentElement.dataset.motion = 'reduce';
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const { container } = render(<BrandLoader />);
    expect(raf).not.toHaveBeenCalled();
    expect(container.querySelector('.bm-shape')?.getAttribute('d')).toBe(restFrame()[0]?.d);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('stops its frame loop when it unmounts', () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const { unmount } = render(<BrandMotion motion="turns" loop />);
    unmount();
    expect(cancel).toHaveBeenCalled();
  });

  it('jumps to rest when still turns on mid-play', () => {
    const { container, rerender } = render(<BrandMotion motion="stepOut" />);
    rerender(<BrandMotion motion="stepOut" still />);
    expect(container.querySelectorAll('.bm-shape')[3]?.getAttribute('d')).toBe(restFrame()[3]?.d);
  });
});
```

If `PanelHandle.test.tsx` does not expose `rerender` or `unmount`, build the same on `react-dom/client` `createRoot` as that file does; do not add a testing library.

- [ ] **Step 6: Run it and see it fail**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/BrandMotion.test.tsx --retry=0`
Expected: FAIL, cannot resolve `./BrandMotion`.

- [ ] **Step 7: Write `BrandMotion.tsx`.**

  - Import `./brandMotion.css`.
  - `reduced()` is `document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches` (guard `matchMedia` for jsdom: treat a missing function as false).
  - Render the rest frame in JSX so the first paint is the complete mark (`d` from `restFrame()`, `strokeWidth={STROKE}`, `strokeLinejoin="round"`). The halo path starts hidden (`display: none`).
  - One `useEffect` keyed on `motion`, `still`, `loop`: when `still || reduced()`, write the rest frame to the paths, call `onDone` once and return. Otherwise start a `requestAnimationFrame` loop: `ms = now - start`; for a looping motion pass `ms` straight to `frameAt`; for a single pass with `loop` set, restart 2400 ms after it ends. Each frame writes `d`, `opacity`, and on the two paths of a piece `transform="rotate(a 29 29)"` only when `rot % 360` is not 0 (remove the attribute otherwise). The halo path gets the same `d`, `stroke-width = STROKE + 2 * halo`, and is shown only while `halo > 0.02`. Never set `transform` on the `g[data-piece]` elements: the launch screen owns those.
  - Skip frames while `document.hidden`; on `visibilitychange` back to visible, continue from where it stopped (shift `start` by the hidden time). The cleanup cancels the frame, removes the listener.
  - `onDone` is read through a ref so a new function identity does not restart the motion.
  - With `label`: `role="img"` and `aria-label`; without: `aria-hidden`.

- [ ] **Step 8: Write `brandMotion.css`**

```css
/* The moving Quarter mark (BrandMotion). Pieces take the theme's foreground and accent through
   .mark-piece and .mark-tail (styles.css); the stroke rounds the corners. */
.bm {
  overflow: visible;
}
.bm-shape.mark-piece {
  stroke: var(--fg-0);
}
.bm-shape.mark-tail {
  stroke: var(--acc);
}
/* keeps the lifted plate apart from the cube in the model form; set --bm-ground to the surface */
.bm-halo {
  fill: var(--bm-ground, var(--bg-0));
  stroke: var(--bm-ground, var(--bg-0));
}
.brand-loader {
  width: 24px;
  height: 24px;
  flex: none;
}
/* a project card while it opens */
.pc-loader {
  width: 14px;
  height: 14px;
}
/* the globe before its first frame */
.globe-loader {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 44px;
  height: 44px;
}
.about-lockup .lockup-mark {
  width: 32px;
  height: 32px;
}
```

- [ ] **Step 9: Run both test files**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/brandMotionEngine.test.ts apps/desktop/src/renderer/shell/BrandMotion.test.tsx --retry=0`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/renderer/shell/brandMotionEngine.ts apps/desktop/src/renderer/shell/brandMotionEngine.test.ts apps/desktop/src/renderer/shell/BrandMotion.tsx apps/desktop/src/renderer/shell/BrandMotion.test.tsx apps/desktop/src/renderer/shell/brandMotion.css
git commit -m "feat(desktop): the Quarter mark's motion engine and component"
```

---

### Task 4: The app symbol

**Files:**

- Modify: `packages/brand/src/marks.ts` (the `SYMBOL` block and the file comment)
- Modify: `packages/brand/src/index.test.ts:74-80`
- Modify: `apps/desktop/src/renderer/shell/BrandMark.tsx` (`BrandSymbol` only)
- Modify: `apps/desktop/src/renderer/styles.css:159-185`
- Modify: `apps/desktop/src/renderer/help/print.css:32-46`

**Interfaces:**

- Consumes: `quarterPieces`, `quarterSmallPieces` from `./quarter`.
- Produces: `SYMBOL = { viewBox: '4 4 52 52', pieces: readonly [string, string, string, string], smallViewBox: '4 4 53 53', small: readonly [string, string] }`; `BrandSymbol({ className?, small?, label? })` (the `layered` prop is gone); CSS classes `mark-piece` and `mark-tail` replace `mark-plate` and `mark-top`.

- [ ] **Step 1: Change the brand test first.** Replace the `marks` test in `packages/brand/src/index.test.ts` with:

```ts
describe('marks', () => {
  it('has a four-piece symbol, a two-piece small cut and a two-part outlined wordmark', () => {
    expect(SYMBOL.pieces).toHaveLength(4);
    expect(SYMBOL.small).toHaveLength(2);
    expect(SYMBOL.viewBox).toBe('4 4 52 52');
    for (const d of [...SYMBOL.pieces, ...SYMBOL.small]) expect(d).toMatch(/^M.*Z$/);
    expect(WORDMARK.quadrion.length).toBeGreaterThan(1000);
    expect(WORDMARK.ai).toMatch(/^M/);
  });
});
```

Run: `pnpm vitest run packages/brand/src/index.test.ts --retry=0`. Expected: FAIL (`SYMBOL.pieces` is undefined).

- [ ] **Step 2: Replace `SYMBOL` in `marks.ts`**

```ts
import { quarterPieces, quarterSmallPieces } from './quarter';

/** Symbol: three quarters of a ring and the tail, the lit fourth piece. It reads as a Q. */
export const SYMBOL = {
  viewBox: '4 4 52 52',
  /** North-west, north-east and south-west quarters, then the tail. */
  pieces: quarterPieces(),
  /** The small-size cut for 32 px and less: the ring closed into one piece, then the tail. */
  smallViewBox: '4 4 53 53',
  small: quarterSmallPieces(),
} as const;
```

Update the file comment: "the quarters and QUADRION take the foreground, the tail and AI the accent". Run the brand tests; expected: PASS.

- [ ] **Step 3: Rewrite `BrandSymbol`**

```tsx
/**
 * The Quadrion AI symbol (brand kit): three quarters of a ring and a square tail, the lit fourth
 * piece. The quarters take `--fg-0` and the tail `--acc` (styles.css `.mark-piece`, `.mark-tail`),
 * so it follows the theme. `small` uses the small-size cut (the ring in one piece) for 32 px and
 * less. `label` makes the symbol an image with that accessible name; without it the symbol is
 * decoration. The moving mark is `BrandMotion`.
 */
export function BrandSymbol({
  className = 'mark',
  small = false,
  label,
}: {
  className?: string;
  small?: boolean;
  label?: string;
}) {
  const pieces: readonly string[] = small ? SYMBOL.small : SYMBOL.pieces;
  return (
    <svg
      className={className}
      viewBox={small ? SYMBOL.smallViewBox : SYMBOL.viewBox}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {pieces.map((d, i) => (
        <path key={d} d={d} className={i === pieces.length - 1 ? 'mark-tail' : 'mark-piece'} />
      ))}
    </svg>
  );
}
```

Remove the `useId` import if nothing else in the file uses it.

- [ ] **Step 4: Styles.** In `styles.css` rename `.mark-plate` to `.mark-piece` and `.mark-top` to `.mark-tail`; set `.mark` to `width: 21px; height: 21px` and `.lockup-mark` to `width: 32px; height: 32px` (the symbol is square now). In `print.css` rename the same two selectors and, if `.pg-mark .lockup-mark` sets a width and height, make them equal to its current height. Then `grep -rn "mark-plate\|mark-top" apps packages tools docs --include=*.css --include=*.tsx --include=*.ts --include=*.mjs`; expected: no hits outside `docs/plans`.

- [ ] **Step 5: Commit**

```bash
git add packages/brand/src/marks.ts packages/brand/src/index.test.ts apps/desktop/src/renderer/shell/BrandMark.tsx apps/desktop/src/renderer/styles.css apps/desktop/src/renderer/help/print.css
git commit -m "feat(desktop): the title bar and lockups draw the Quarter mark"
```

---

### Task 5: Launch screen

**Files:**

- Modify: `apps/desktop/src/renderer/gate/motion.ts`
- Modify: `apps/desktop/src/renderer/gate/motion.test.ts`
- Modify: `apps/desktop/src/renderer/gate/LaunchGate.tsx` (import, the plate lookup near line 315, the mark near line 431, the comment near line 46)
- Modify: `apps/desktop/src/renderer/gate/gate.css` (`.qg-mark` near line 56; the intro block near lines 324 to 375)
- Modify: `apps/desktop/e2e/launch-gate.spec.ts:118-131` and `:184-186`

**Interfaces:**

- Consumes: `BrandMotion` from `../shell/BrandMotion` (four `g[data-piece]`, piece 3 is the tail, class `mark-tail` on its shape).
- Produces: `pieceOffsets(mx: number, my: number): [number, number][]` (replaces `plateOffsets`).

- [ ] **Step 1: Change the unit test first.** Replace the `the plates` block in `motion.test.ts` with:

```ts
describe('the pieces', () => {
  it('stand still with the pointer at the centre', () => {
    for (const [dx, dy] of pieceOffsets(0, 0)) {
      expect(dx).toBeCloseTo(0);
      expect(dy).toBeCloseTo(0);
    }
  });

  it('move toward the pointer, the tail furthest', () => {
    const xs = pieceOffsets(1, 0).map(([dx]) => dx);
    expect(xs).toHaveLength(4);
    expect(xs[3]).toBeGreaterThan(Math.max(xs[0] ?? 0, xs[1] ?? 0, xs[2] ?? 0));
  });

  it('open the ring as the pointer leaves the centre: each piece moves out along its own diagonal', () => {
    const [nw, ne, sw, tail] = pieceOffsets(0, 1);
    expect(nw?.[0]).toBeLessThan(0);
    expect(ne?.[0]).toBeGreaterThan(0);
    expect(sw?.[0]).toBeLessThan(0);
    expect(tail?.[0]).toBeGreaterThan(0);
    // straight down: the two lower pieces travel further down than the two upper ones
    expect(sw?.[1]).toBeGreaterThan(nw?.[1] ?? 0);
    expect(tail?.[1]).toBeGreaterThan(ne?.[1] ?? 0);
  });

  it('read the pointer from the window centre', () => {
    expect(pointerTarget(720, 450, 1440, 900)).toEqual([0, 0]);
    expect(pointerTarget(0, 900, 1440, 900)).toEqual([-1, 1]);
    expect(pointerTarget(10, 10, 0, 0)).toEqual([0, 0]);
  });
});
```

Update the import (`pieceOffsets`). Run: `pnpm vitest run apps/desktop/src/renderer/gate/motion.test.ts --retry=0`. Expected: FAIL (`pieceOffsets` is not exported).

- [ ] **Step 2: Replace `DEPTH`, `SPREAD` and `plateOffsets` in `motion.ts`**

```ts
/** How far each piece (north-west, north-east, south-west, tail) travels at full deflection, in symbol units. */
const DEPTH = [1, 1.6, 2.2, 5] as const;
/** The way each piece moves as the ring opens: out along its own diagonal. */
const OUT: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];
/** How far the ring opens at full deflection, in symbol units. */
const OPEN = 0.9;

/**
 * Offset of each piece for the smoothed pointer `mx`, `my` in -1..1 from the window centre: the
 * tail travels furthest, and the ring opens as the pointer leaves the centre.
 */
export function pieceOffsets(mx: number, my: number): [number, number][] {
  const opened = Math.min(1, Math.hypot(mx, my)) * OPEN;
  return DEPTH.map((depth, i) => {
    const [ox, oy] = OUT[i] ?? [0, 0];
    return [mx * depth + ox * opened, my * depth * 0.6 + oy * opened];
  });
}
```

Update the file comment ("the four pieces separate in depth toward the pointer") and `MAX_DT`'s ("so a stall does not throw the pieces"). Run the unit test; expected: PASS.

- [ ] **Step 3: `LaunchGate.tsx`.** Import `BrandMotion` from `'../shell/BrandMotion'` and keep `BrandWordmark` from `'../shell/BrandMark'` (drop `BrandSymbol`); import `pieceOffsets` in place of `plateOffsets`. Replace the mark:

```tsx
<BrandMotion
  className="qg-mark"
  motion="stepOut"
  still={reduce || instant}
  label={brand.productName}
/>
```

Rename `plates` to `pieces` and `placePlates` to `placePieces`, select `[data-piece="${String(i)}"]`, call `pieceOffsets`. Reword the two comments that say "plates" (near lines 46 and 346). The rule "the pieces belong to the intro until it ends, then to the pointer" stays exactly as it is.

- [ ] **Step 4: `gate.css`.** `.qg-mark`: `width: clamp(56px, 6.4vw, 76px); aspect-ratio: 1; height: auto; overflow: visible;` and reword its comment ("the symbol is square: 52 of the kit's 64 units"). In the intro block delete the five `.plate` and `.p1` to `.p4` rules and `@keyframes qg-drop` and `qg-light` if nothing else uses them (`grep -n "qg-drop\|qg-light" apps/desktop/src/renderer/gate/gate.css`), and add:

```css
/* the mark comes up as a closed ring; BrandMotion then steps the fourth piece out */
:root:not([data-motion='reduce']) .qg[data-phase='intro']:not([data-instant]) .qg-mark {
  animation: qg-mark-in 320ms var(--qg-ease) both;
}
```

with, beside the other keyframes:

```css
@keyframes qg-mark-in {
  from {
    opacity: 0;
    transform: scale(0.92);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
```

Change the glow rule's selector from `.qg-mark .p4` to `.qg-mark .mark-tail` and its comment to "after the intro the tail glows a little". Reword the block comment: "the mark comes up as a closed ring and its fourth piece steps out, the wordmark is revealed behind a scan line, ...". The wordmark, tagline and welcome timings do not change.

- [ ] **Step 5: e2e spec.** In `launch-gate.spec.ts` change the comment to "the pointer moves the pieces (fine pointers only), the tail furthest", the selector to `` `.qg-mark g[data-piece="${String(i)}"]` `` and the reduced motion count to `document.querySelectorAll('.qg-mark g[data-piece][transform]').length`. The two assertions (`shift[1] > 0.5`, `shift[1] > shift[0]`) stay.

- [ ] **Step 6: Run the unit tests of the folder**

Run: `pnpm vitest run apps/desktop/src/renderer/gate --retry=0`
Expected: PASS. (The e2e spec runs in Task 9, once batch 3 is whole.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/gate/motion.ts apps/desktop/src/renderer/gate/motion.test.ts apps/desktop/src/renderer/gate/LaunchGate.tsx apps/desktop/src/renderer/gate/gate.css apps/desktop/e2e/launch-gate.spec.ts
git commit -m "feat(desktop): the launch screen opens with the Quarter mark stepping out"
```

---

### Task 6: Installer and Store images

**Files:**

- Regenerate: `apps/desktop/build/icon.ico`, `icon.icns`, `icon.png`, `icons/*.png`, `appx/*`
- Regenerate: `docs/release/store-listing/images/*`
- Modify (comments only): `tools/release/icon-render.mjs:11` ("larger mark, the ring in one piece")

**Interfaces:**

- Consumes: `packages/brand/icon.svg` and `icon-small.svg` from Task 2.

- [ ] **Step 1: Run the icon tools**

Run: `pnpm icons`
Expected: exits 0; `git status --short apps/desktop/build docs/release/store-listing` shows only modified files, no deletions and no new names.

- [ ] **Step 2: Look.** Read `apps/desktop/build/icons/256x256.png`, `apps/desktop/build/icons/16x16.png` and one wide tile (`apps/desktop/build/appx/Wide310x150Logo.scale-200.png`). Expected: the Quarter mark on the dark tile, centred; the ring in one piece at 16 px.

- [ ] **Step 3: Run the release tool tests**

Run: `pnpm vitest run tools/release --retry=0`
Expected: PASS (size budgets and asset lists are unchanged).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/build docs/release/store-listing/images tools/release/icon-render.mjs
git commit -m "chore(release): app, installer and Store images with the Quarter mark"
```

---

### Task 7: Loader placements

**Files:**

- Modify: `apps/desktop/src/renderer/screens/Projects.tsx:128-133`
- Modify: `apps/desktop/src/renderer/globe/GlobeScreen.tsx:249`

**Interfaces:**

- Consumes: `BrandLoader({ className?, label? })` from `../shell/BrandMotion` (Projects) and `'../shell/BrandMotion'` relative to `globe/` (Globe); classes `pc-loader` and `globe-loader` already exist in `brandMotion.css`.

- [ ] **Step 1: Projects.** Replace `<span className="spin" />` inside `.pc-busy` with `<BrandLoader className="pc-loader" />` and add the import. The word "Opening" beside it stays, so the loader has no label.

- [ ] **Step 2: Globe.** Change the loading return to:

```tsx
if (!loaded)
  return (
    <section className="globe-screen" aria-busy="true" data-surface="dark">
      <BrandLoader className="globe-loader" />
    </section>
  );
```

and add the import. `aria-busy` on the section already tells assistive technology, so the loader stays decorative.

- [ ] **Step 3: Check nothing else broke**

Run: `pnpm vitest run apps/desktop/src/renderer/screens apps/desktop/src/renderer/globe --retry=0`
Expected: PASS. If a test asserted `.spin` inside a project card (`grep -rn "\.spin" apps/desktop/src apps/desktop/e2e --include=*.ts --include=*.tsx`), point it at `.pc-loader`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/screens/Projects.tsx apps/desktop/src/renderer/globe/GlobeScreen.tsx
git commit -m "feat(desktop): the Quarter mark turns while a project opens and the globe loads"
```

---

### Task 8: About plays the full sequence

**Files:**

- Modify: `apps/desktop/src/renderer/screens/settings/About.tsx` (the import on line 7 and the one place `<BrandLockup />` is rendered)

**Interfaces:**

- Consumes: `BrandMotion` from `'../../shell/BrandMotion'`, `BrandWordmark` from `'../../shell/BrandMark'`; class `about-lockup` from `brandMotion.css`.

- [ ] **Step 1: Replace the lockup.** Where About renders `<BrandLockup />` (keep any `className` it passes, adding `about-lockup`):

```tsx
<span className="lockup about-lockup">
  <BrandMotion className="lockup-mark" motion="sequence" />
  <BrandWordmark className="lockup-word" />
</span>
```

Remove the `BrandLockup` import if it is no longer used in the file. The wordmark carries the accessible name, so the mark stays decorative.

- [ ] **Step 2: Match the halo to the surface.** Find the background of the element that contains the lockup (the class on its parent in `About.tsx`, then that class in the settings styles). If it is not `var(--bg-0)`, add `style={{ ['--bm-ground' as string]: 'var(--<that token>)' }}` to the span so the lifted plate's halo is the colour behind it.

- [ ] **Step 3: Check**

Run: `pnpm vitest run apps/desktop/src/renderer/screens/settings --retry=0`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/screens/settings/About.tsx
git commit -m "feat(desktop): About plays the mark's full sequence"
```

---

### Task 9: Docs, checks and hand-off

**Files:**

- Modify: `packages/brand/README.md`
- Modify: `docs/TESTING.md:501`, `:551`, `:553`

- [ ] **Step 1: README.** In `packages/brand/README.md`: `icon-small.svg` is "its small-size cut (the ring in one piece), used from 32 px down"; `src/marks.ts` is "the symbol (four pieces and a small cut) and the outlined wordmark as path data"; add a line: "`src/quarter.ts`: the geometry of the mark. The kit (`docs/brand/quadrion/build/kit.mjs`) draws from it and writes `icon.svg`, `icon-small.svg` and `mark.svg` here; run it, then `pnpm icons`, after a change."

- [ ] **Step 2: Test steps.** In `docs/TESTING.md`:
  - line 501: "the title bar shows the new mark (three quarters of a ring and a mint square, a Q) and the outlined QUADRION AI wordmark; the taskbar and window icon are the new icon. A pinned shortcut can keep the old picture until Windows refreshes its icon cache."
  - line 551: "The intro takes about a second: the mark comes up as a closed ring, its fourth piece steps out and becomes the mint square, QUADRION AI appears behind a scan line, then "Four dimensions. One view.", then the welcome comes into focus."
  - line 553: "Move the mouse: the points under it light up mint, and the pieces of the mark lean toward the pointer, the mint square most. Leave the mouse still for 4 seconds: everything drifts back to the centre."
  - after line 553 add: "- [ ] Open a project from **Projects**: while it opens, the card shows the mark turning a quarter at a time beside "Opening". **Settings**, **About**: the mark forms a map, a model, a row of dates and a globe, then settles."

- [ ] **Step 3: Public text and formatting**

Run: `node tools/agent/check-public-text.mjs docs/plans/2026-10-11-quarter-mark-design.md docs/plans/2026-10-11-quarter-mark.md docs/TESTING.md packages/brand/README.md`
Expected: no findings.
Run: `pnpm format` then `git status --short`; stage only files this branch owns.

- [ ] **Step 4: The whole check**

Run: `pnpm check`
Expected: lint, format, typecheck and tests all pass. Quote the last lines in the hand-off.

- [ ] **Step 5: The launch screen spec the way CI runs it** (CONTRIBUTING.md, "End to end the way CI runs it")

Run: `pnpm demo:build --quick`, then from `apps/desktop`, with `QUADRION_WINDOW_SIZE=1100x700` and `QUADRION_E2E_SWGL=1`: `pnpm exec playwright test e2e/launch-gate.spec.ts e2e/smoke.spec.ts --workers=1`
Expected: all pass. Read the launch screenshot the spec writes and confirm the mark stands beside the wordmark, complete.

- [ ] **Step 6: Commit and hand off**

```bash
git add packages/brand/README.md docs/TESTING.md
git commit -m "docs: the Quarter mark in the brand notes and the test steps"
node tools/agent/finish-task.mjs
```

Send the printed hand-off to the session named "Orchestrator" (ListAgents; with none running, ask the founder as CLAUDE.md says). Merge order: none needed. Contract changes: none. Note for the Orchestrator: `apps/desktop/build` and `docs/release/store-listing/images` are regenerated binaries; on a conflict there, take this branch's files or re-run `pnpm icons`.

- [ ] **Step 7: How to test, and wrap up.** Give the founder the numbered walkthrough (title bar and taskbar icon, launch screen intro and pointer, a project opening, About, reduced motion in Settings, Appearance), then run `/wrapup`.

## Follow-ups (not in this branch)

- Retake the user guide screenshots that show the title bar.
- The Short motion (map, globe, mark) if a use turns up.
- A larger loader on the Jobs screen once its redesign has landed.
