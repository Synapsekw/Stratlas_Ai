/**
 * The G12 quality targets on the real boundary model (plan "G12 Local AI helpers", ADR 0011):
 * outline overlap (IoU) of at least 0.85 on synthetic piles and under 1.5 s a click. The weights
 * are not in git, so this runs only where a pipeline pack with `models/sam` is at hand:
 *
 *   QUADRION_SAM_PACK=<pipeline pack folder> pnpm vitest run segment.model
 *
 * and is skipped everywhere else (CI checks the same code path with the plain-operator fixture
 * in `segment.test.ts`). Synthetic only: sand with seeded texture and shaded piles of a
 * near-ground colour, some with a touching neighbour.
 */
import type { Vec2 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { OrtLike } from '../maskAssist';
import { realOrt } from './fixtures/realOrt';
import { createSegmenter, findSegmentModel } from './segment';

const PACK = process.env.QUADRION_SAM_PACK ?? '';
const ort = realOrt();
const N = 1024;

/** A small seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Pile {
  x: number;
  y: number;
  /** Half axes and rotation of the elliptical toe, pixels and radians. */
  a: number;
  b: number;
  rot: number;
  colour: [number, number, number];
}

const inside = (p: Pile, x: number, y: number): number => {
  const dx = x - p.x;
  const dy = y - p.y;
  const u = (dx * Math.cos(p.rot) + dy * Math.sin(p.rot)) / p.a;
  const v = (-dx * Math.sin(p.rot) + dy * Math.cos(p.rot)) / p.b;
  return 1 - Math.hypot(u, v); // height of a cone over the toe, 0 at the toe
};

/** A crop with a target pile (and sometimes a neighbour), its truth mask and a click on it. */
function scene(seed: number) {
  const r = rng(seed);
  const sand: [number, number, number] = [214, 190, 150];
  const near = (k: number): [number, number, number] => [
    sand[0] + (r() - 0.5) * k,
    sand[1] + (r() - 0.5) * k,
    sand[2] + (r() - 0.5) * k,
  ];
  const target: Pile = {
    x: 380 + r() * 260,
    y: 380 + r() * 260,
    a: 140 + r() * 120,
    b: 110 + r() * 110,
    rot: r() * Math.PI,
    colour: near(seed % 3 === 0 ? 50 : 24),
  };
  const piles = [target];
  if (seed % 2 === 0) {
    const ang = r() * 2 * Math.PI;
    const d = Math.max(target.a, target.b) + 90;
    piles.push({
      x: target.x + d * Math.cos(ang),
      y: target.y + d * Math.sin(ang),
      a: 80 + r() * 40,
      b: 70 + r() * 40,
      rot: r() * Math.PI,
      colour: near(40),
    });
  }
  const tex = new Float32Array((N / 4 + 1) * (N / 4 + 1));
  for (let i = 0; i < tex.length; i++) tex[i] = r() - 0.5;
  const rgb = new Uint8Array(N * N * 3);
  const truth = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let c = sand;
      let h = 0;
      let hx = 0;
      let hy = 0;
      for (const p of piles) {
        const v = inside(p, x + 0.5, y + 0.5);
        if (v <= 0) continue;
        c = p.colour;
        h = v;
        hx = inside(p, x + 1.5, y + 0.5) - v;
        hy = inside(p, x + 0.5, y + 1.5) - v;
        // the pile drawn last is the one seen here
        truth[y * N + x] = p === target ? 1 : 0;
      }
      // light from the north-west on the cone's slope, and a little texture
      const shade = h > 0 ? 0.85 + 60 * (hx + hy) : 1;
      const t = 1 + 0.1 * (tex[Math.floor(y / 4) * (N / 4 + 1) + Math.floor(x / 4)] ?? 0);
      for (let k = 0; k < 3; k++) {
        rgb[(y * N + x) * 3 + k] = Math.max(0, Math.min(255, Math.round((c[k] ?? 0) * shade * t)));
      }
    }
  }
  const jitter = 0.3 * Math.min(target.a, target.b);
  const click: Vec2 = [target.x + (r() - 0.5) * jitter, target.y + (r() - 0.5) * jitter];
  const other = piles[1];
  const neighbour: Vec2 | null = other ? [other.x, other.y] : null;
  return { rgb, truth, click, neighbour };
}

/** Overlap over union of a ring (pixels, y down) and a mask, by scanlines. */
function ringIou(ring: readonly Vec2[], truth: Uint8Array): number {
  let both = 0;
  let either = 0;
  for (let y = 0; y < N; y++) {
    const py = y + 0.5;
    const xs: number[] = [];
    ring.forEach((a, k) => {
      const b = ring[(k + 1) % ring.length] ?? a;
      if (a[1] <= py !== b[1] <= py) xs.push(a[0] + ((py - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    });
    xs.sort((p, q) => p - q);
    for (let x = 0; x < N; x++) {
      let inRing = false;
      for (const v of xs) if (v < x + 0.5) inRing = !inRing;
      const t = (truth[y * N + x] ?? 0) > 0;
      if (inRing && t) both++;
      if (inRing || t) either++;
    }
  }
  return either ? both / either : 0;
}

describe('the pack boundary model on synthetic piles (needs QUADRION_SAM_PACK)', () => {
  it.runIf(PACK && ort)(
    'outlines every pile with IoU 0.85 or more (a touching neighbour may take one Remove area click), in under 1.5 s a click',
    async () => {
      const found = await findSegmentModel(PACK);
      expect(found, 'QUADRION_SAM_PACK has no usable models/sam').toMatchObject({ ok: true });
      const seg = createSegmenter({
        packDir: () => Promise.resolve(PACK),
        loadRuntime: () => Promise.resolve(ort as unknown as OrtLike),
      });
      const ious: number[] = [];
      const ms: number[] = [];
      /** Scenes that needed the Remove area click on the neighbour. */
      const refined: number[] = [];
      const up = ([e, n]: Vec2): Vec2 => [e, N - n];
      for (let seed = 1; seed <= 12; seed++) {
        const s = scene(seed);
        // the crop in a frame where a pixel is a metre and north is up
        const crop = { key: `scene-${String(seed)}`, size: N, x0: 0, y1: N, res: 1, rgb: s.rgb };
        const t0 = performance.now();
        const r = await seg.suggest({ click: up(s.click), crop });
        ms.push(performance.now() - t0);
        expect(r.ok, `scene ${String(seed)}`).toBe(true);
        if (!r.ok) continue;
        let iou = ringIou(r.ring.map(up), s.truth);
        if (iou < 0.85 && s.neighbour) {
          // a touching neighbour was taken along: one Remove area click on it
          const again = await seg.suggest({
            click: up(s.click),
            crop: { ...crop, rgb: undefined },
            refine: [{ at: up(s.neighbour), include: false }],
          });
          expect(again.ok, `scene ${String(seed)}, refined`).toBe(true);
          if (again.ok) iou = ringIou(again.ring.map(up), s.truth);
          refined.push(seed);
        }
        ious.push(iou);
      }
      const worst = Math.min(...ious);
      // the first click also loads the model
      const clicks = ms.slice(1).sort((a, b) => a - b);
      const median = clicks[clicks.length >> 1] ?? Infinity;
      expect(
        worst,
        `IoU per scene: ${ious.map((v) => v.toFixed(3)).join(', ')}`,
      ).toBeGreaterThanOrEqual(0.85);
      expect(
        refined.length,
        `scenes that needed a Remove area click: ${refined.join(', ')}`,
      ).toBeLessThanOrEqual(2);
      expect(median, `click times (ms): ${ms.map((v) => v.toFixed(0)).join(', ')}`).toBeLessThan(
        1500,
      );
    },
    300_000,
  );
});
