import type { z } from 'zod';
import type { AssetTag, ClassCatalogue, SeverityModel } from '@aio/schema';

type Tag = z.infer<typeof AssetTag>;

/** Issue severity for stockpile yards: simple three levels (no issues are imported). */
export const STOCKPILE_SEVERITY_MODEL: SeverityModel = {
  id: 'stockpile',
  name: 'Stockpile',
  levels: [
    {
      value: 1,
      label: 'Low',
      color: '#2f9e44',
      criteria: 'Housekeeping: no effect on safety, access or the measured volume.',
      action: 'Note and check at the next survey.',
    },
    {
      value: 2,
      label: 'Medium',
      color: '#f08c00',
      criteria: 'Affects access, drainage or the volume figure; no immediate danger.',
      action: 'Correct within the next operating week.',
    },
    {
      value: 3,
      label: 'High',
      color: '#e03131',
      criteria: 'Danger to people or plant (unstable face, blocked haul road, boundary breach).',
      action: 'Stop work at the pile and correct before it resumes.',
    },
  ],
};

export const STOCKPILE_CATALOGUE: ClassCatalogue = {
  id: 'stockpile',
  name: 'Stockpile yard',
  assetType: 'stockpile',
  classes: [
    {
      id: 'spillage',
      label: 'Spillage',
      color: '#c2410c',
      hotkey: 's',
      severityModel: 'stockpile',
    },
    {
      id: 'unsafe-slope',
      label: 'Unsafe slope',
      color: '#b91c1c',
      hotkey: 'u',
      severityModel: 'stockpile',
    },
    {
      id: 'encroachment',
      label: 'Encroachment',
      color: '#7c3aed',
      hotkey: 'e',
      severityModel: 'stockpile',
    },
  ],
};

export interface PyramidLevelPlan {
  z: number;
  cols: number;
  rows: number;
}

/**
 * Plan a `kit-pyramid` from the kit's ortho tiles (`tiles/<epoch>/<z>/<x>_<y>.webp`, top-left
 * anchored, each level half the resolution of the next). Every kept level (`zMin` to the finest)
 * must span the same ground, so the finest level's columns and rows are rounded up to a multiple
 * of `2^(levels - 1)`. Tiles outside the source (no data) are listed with `present: false`.
 */
export function orthoPyramidPlan(
  source: readonly { z: number; x: number; y: number }[],
  zMin: number,
): { levels: PyramidLevelPlan[]; tiles: { z: number; x: number; y: number; present: boolean }[] } {
  const zMax = Math.max(...source.map((t) => t.z));
  let cols = 0;
  let rows = 0;
  for (const t of source) {
    const k = 2 ** (zMax - t.z);
    cols = Math.max(cols, (t.x + 1) * k);
    rows = Math.max(rows, (t.y + 1) * k);
  }
  const step = 2 ** (zMax - zMin);
  cols = Math.ceil(cols / step) * step;
  rows = Math.ceil(rows / step) * step;
  const have = new Set(source.map((t) => `${t.z}/${t.x}/${t.y}`));
  const levels: PyramidLevelPlan[] = [];
  const tiles: { z: number; x: number; y: number; present: boolean }[] = [];
  for (let z = zMin; z <= zMax; z++) {
    const k = 2 ** (zMax - z);
    const level = { z, cols: cols / k, rows: rows / k };
    levels.push(level);
    for (let y = 0; y < level.rows; y++)
      for (let x = 0; x < level.cols; x++)
        tiles.push({ z, x, y, present: have.has(`${z}/${x}/${y}`) });
  }
  return { levels, tiles };
}

/** GLB node of a pile surface at one survey date. */
export const pileNode = (pile: string, epoch: string) => `${pile}_${epoch}`;

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const formatM3 = (v: number) => `${nf0.format(Math.round(v))} m³`;

/** Mesh tags for the pile nodes of one date: the pile ID, with its default-base volume. */
export function pileTags(piles: readonly { id: string; net: number }[], epoch: string): Tag[] {
  return piles.map((p) => ({ node: pileNode(p.id, epoch), tag: p.id, area: formatM3(p.net) }));
}

export interface VolumePair {
  pile: string;
  epoch: string;
  base: string;
  computed: number;
  kit: number;
}

/**
 * Largest relative difference between recomputed and kit volumes. The kit rounds to 0.1 m³, so
 * differences are taken relative to the larger of the kit figure and 10 m³.
 */
export function volumeCheck(pairs: readonly VolumePair[]): {
  maxRel: number;
  worst: VolumePair | null;
  within: (tol: number) => boolean;
} {
  let maxRel = 0;
  let worst: VolumePair | null = null;
  for (const p of pairs) {
    const rel = Math.abs(p.computed - p.kit) / Math.max(Math.abs(p.kit), 10);
    if (!worst || rel > maxRel) {
      maxRel = rel;
      worst = p;
    }
  }
  return { maxRel, worst, within: (tol) => maxRel <= tol };
}
