import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RfCatalogue, type RfCatalogueEntry } from '@aio/schema';
import { entryBandRanges, getEntry, mergeCatalogues, searchCatalogue } from './catalogue';

const dir = fileURLToPath(new URL('../catalogue/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const all: RfCatalogueEntry[] = files.flatMap(
  (f) => (JSON.parse(readFileSync(dir + f, 'utf8')) as { entries: RfCatalogueEntry[] }).entries,
);

describe('seed catalogue', () => {
  it('has files', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  it.each(files)('%s passes RfCatalogue', (f) => {
    const r = RfCatalogue.safeParse(JSON.parse(readFileSync(dir + f, 'utf8')));
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
  });
  it('has unique ids across files', () => {
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
  });
  it('every entry has a source and none is verified', () => {
    for (const e of all) {
      expect(e.source.length).toBeGreaterThan(3);
      expect(e.verified).toBe(false);
    }
  });
  it('covers the generic set', () => {
    const generic = all.filter((e) => e.vendor === 'Generic');
    const panels = generic.filter((e) => e.kind === 'antenna');
    expect(
      panels.filter((e) => e.ports.some((p) => p.hBeamwidthDeg === 65)).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      panels.filter((e) => e.ports.some((p) => p.hBeamwidthDeg === 33)).length,
    ).toBeGreaterThanOrEqual(1);
    expect(generic.filter((e) => e.kind === 'radio').length).toBeGreaterThanOrEqual(2);
    expect(generic.filter((e) => e.kind === 'aau').length).toBeGreaterThanOrEqual(2);
  });
  it('has vendor entries for the three radio vendors', () => {
    for (const v of ['Huawei', 'Ericsson', 'Nokia'])
      expect(all.some((e) => e.vendor === v)).toBe(true);
    expect(all.filter((e) => e.vendor !== 'Generic').length).toBeGreaterThanOrEqual(9);
  });
});

describe('lookup and search', () => {
  it('finds by id', () => {
    const first = all[0];
    expect(getEntry(all, first?.id ?? '')?.id).toBe(first?.id);
    expect(getEntry(all, 'no-such')).toBeUndefined();
  });
  it('filters by kind', () => {
    const r = searchCatalogue(all, { kind: 'aau' });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((e) => e.kind === 'aau')).toBe(true);
  });
  it('filters by vendor, case-insensitively', () => {
    const r = searchCatalogue(all, { vendor: 'ericsson' });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((e) => e.vendor === 'Ericsson')).toBe(true);
  });
  it('filters by band: n78 hits AAUs and every hit overlaps 3.3 to 3.8 GHz', () => {
    const r = searchCatalogue(all, { band: 'n78' });
    expect(r.some((e) => e.kind === 'aau')).toBe(true);
    expect(r.every((e) => entryBandRanges(e).some(([lo, hi]) => hi >= 3300 && lo <= 3800))).toBe(
      true,
    );
  });
  it('searches text over vendor and model, all words', () => {
    const r = searchCatalogue(all, { text: 'ericsson air' });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((e) => /air/i.test(e.model))).toBe(true);
    expect(searchCatalogue(all, { text: 'zzzzqq' })).toEqual([]);
  });
  it('combines filters', () => {
    const r = searchCatalogue(all, { kind: 'antenna', band: 'b3-n3' });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((e) => e.kind === 'antenna')).toBe(true);
  });
  it('returns nothing for an unknown band id', () => {
    expect(searchCatalogue(all, { band: 'nope' })).toEqual([]);
  });
  it('merges catalogues with later sources winning', () => {
    const a = all[0];
    if (!a) throw new Error('no seed entries');
    const b = { ...a, model: 'Changed' };
    const m = mergeCatalogues([a], [b]);
    expect(m).toHaveLength(1);
    expect(m[0]?.model).toBe('Changed');
  });
});
