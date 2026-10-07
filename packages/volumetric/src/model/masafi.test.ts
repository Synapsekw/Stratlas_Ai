/**
 * Parity on the real Masafi package (E:\Stratlas Data\projects\masafi, or QUADRION_MASAFI):
 * every pile, date and base recomputed from the kit's 10 cm grids equals volumes.json within
 * 0.5 %. Skipped where the project is not present. Read-only.
 */
import { VolumesFile } from '@aio/schema';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { editGeometry, editVolumes, simplifyRing } from './edit';
import { localToEN, pileSurface } from './frame';
import { decodeCoarse, decodeDsm, decodePile } from './kitdata';
import { BASE_IDS, pileChange, pileVolume } from './volume';

const ROOT =
  process.env.QUADRION_MASAFI ??
  process.env.STRATLAS_MASAFI ??
  'E:\\Stratlas Data\\projects\\masafi';
const present = existsSync(join(ROOT, 'volumes.json'));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Relative difference against the larger of the kit figure and 10 m³ (the importer's check). */
const rel = (a: number, kit: number) => Math.abs(a - kit) / Math.max(Math.abs(kit), 10);

describe.skipIf(!present)('Masafi volumes recomputed from the kit grids', () => {
  it('match volumes.json within 0.5 % for every pile, date and base', async () => {
    const vols = VolumesFile.parse(JSON.parse(read('volumes.json')));
    let worst = 0;
    let count = 0;
    for (const pile of vols.piles) {
      const g = await decodePile(read(`legacy/data/piles/${pile.id}.js`));
      for (const [epoch, ep] of Object.entries(pile.epochs)) {
        for (const b of BASE_IDS) {
          const v = pileVolume(g, epoch, b);
          if (!v) throw new Error(`${pile.id} ${epoch} has no grid`);
          worst = Math.max(worst, rel(v.net, ep.volumes[b].net), rel(v.fill, ep.volumes[b].fill));
          count++;
        }
      }
      const first = vols.captures[0]?.epoch ?? 'e1';
      const last = vols.captures.at(-1)?.epoch ?? 'e2';
      const c = pileChange(g, first, last, vols.deadbandM);
      worst = Math.max(worst, rel(c.net, pile.change.net));
    }
    expect(count).toBe(152);
    expect(worst).toBeLessThan(0.005);
  }, 60_000);

  it('refits the bases to an edited line as the kit viewer does (P02, 10 Jan 2021)', async () => {
    // The original review shows 7,637 m³ (triangulated toe) when an edit of P02 on 10 Jan starts:
    // the automatic toe line, simplified at 0.6 m, with every base refitted to it.
    const vols = VolumesFile.parse(JSON.parse(read('volumes.json')));
    const origin: [number, number, number] = [212624, 3201610.5, 51];
    const pile = vols.piles.find((p) => p.id === 'P02');
    const ring = pile?.epochs.e2?.ring.map((q) => localToEN(origin, q));
    if (!ring) throw new Error('P02 e2 missing');
    const g = await decodePile(read('legacy/data/piles/P02.js'));
    const dsm = await decodeDsm(read('legacy/data/dsm_e2.js'));
    const geo = editGeometry(simplifyRing(ring, 0.6), pileSurface(g, 'e2', dsm));
    if (!geo) throw new Error('no geometry');
    const r = editVolumes(geo, dsm.x0, dsm.y1);
    expect(Math.round(r.volumes.tin.net)).toBe(7637);
  });

  it('decodes the site DSM and the coarse pile masks on the same grid', async () => {
    const vols = VolumesFile.parse(JSON.parse(read('volumes.json')));
    const epochs = vols.captures.map((c) => c.epoch);
    const dsm = await decodeDsm(read(`legacy/data/dsm_${epochs[0] ?? 'e1'}.js`));
    const coarse = await decodeCoarse(read('legacy/data/vol.js'), epochs);
    expect(dsm.res).toBe(coarse.res);
    expect([dsm.x0, dsm.y1]).toEqual([coarse.x0, coarse.y1]);
    expect(Object.keys(coarse.piles).sort()).toEqual(vols.piles.map((p) => p.id).sort());
    expect(dsm.valid.some((v) => v === 1)).toBe(true);
  });
});
