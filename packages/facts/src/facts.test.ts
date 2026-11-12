import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractFacts, inside, subjectOfTarget } from './extract';
import { readProjectSources } from './sources';
import { ftsQuery, openFactIndex } from './store';
import { measurement, result, writeFixtureProject } from './testing';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'facts-'));
  writeFixtureProject(root, { journal: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const build = async (file = ':memory:') => {
  const ix = openFactIndex(file);
  ix.sync(extractFacts(await readProjectSources(root)), '2026-11-11T00:00:00.000Z');
  return ix;
};

describe('reading a project', () => {
  it('reads every kind of the fixture', async () => {
    const s = await readProjectSources(root);
    expect(s.manifest?.captures).toHaveLength(2);
    expect(s.measurements).toHaveLength(1);
    expect(s.qa).toHaveLength(1);
    expect(s.detections[0]?.detections).toHaveLength(2); // the bad box is left out
    expect(s.issues).toHaveLength(1);
    expect(s.changeSets).toHaveLength(1);
    expect(s.thermal?.hotspots).toHaveLength(1);
    expect(s.walks).toHaveLength(1);
    expect(s.antennas).toHaveLength(2);
    expect(s.events.length).toBeGreaterThan(0);
  });

  it('leaves out an unreadable file and reads the rest', async () => {
    writeFileSync(join(root, 'issues.json'), '{ not json');
    const s = await readProjectSources(root);
    expect(s.issues).toEqual([]);
    expect(s.measurements).toHaveLength(1);
  });
});

describe('extracting facts', () => {
  it('makes one fact per record, volumes per date, and positions in the project CRS', async () => {
    const { facts } = extractFacts(await readProjectSources(root));
    const kinds = new Set(facts.map((f) => f.kind));
    for (const k of [
      'survey',
      'layer',
      'photo',
      'measurement',
      'volume',
      'detection',
      'issue',
      'qa',
      'change-set',
      'change',
      'hotspot',
      'walk',
      'antenna',
      'event',
    ]) {
      expect(kinds, k).toContain(k);
    }
    const vols = facts.filter((f) => f.kind === 'volume');
    expect(vols.map((v) => [v.date, v.value])).toEqual([
      ['2026-07-01', 1200],
      ['2026-08-01', 950],
    ]);
    const d1 = facts.find((f) => f.id === 'detection:d1');
    expect(d1).toMatchObject({
      label: 'Crack',
      capture: 'c2',
      date: '2026-08-01',
      e: 1010,
      n: 1990,
      status: 'draft',
      source: 'ai',
    });
    expect(facts.find((f) => f.id === 'issue:i1')).toMatchObject({
      label: 'D012 Crack in the ramp wall',
      status: 'reviewed',
    });
    expect(facts.find((f) => f.id === 'qa:c2')).toMatchObject({
      status: 'hold',
      value: 0.12,
      unit: 'm',
    });
  });

  it('links kinds: detection to photo, date and issue; volume to QA; things on a pile', async () => {
    const { links } = extractFacts(await readProjectSources(root));
    const has = (from: string, to: string, rel: string) =>
      links.some((l) => l.from === from && l.to === to && l.rel === rel);
    expect(has('detection:d1', 'photo:ph1/p1', 'on-photo')).toBe(true);
    expect(has('detection:d1', 'survey:c2', 'on-survey')).toBe(true);
    expect(has('detection:d1', 'issue:i1', 'issue')).toBe(true);
    expect(has('measurement:pile-north', 'qa:c2', 'qa')).toBe(true);
    expect(has('change-item:c1-c2-issues/it1', 'issue:i1', 'about')).toBe(true);
    expect(has('hotspot:h1', 'photo:ph1/p1', 'on-photo')).toBe(true);
    // p1 sits inside the pile outline, p2 does not
    expect(has('issue:i1', 'measurement:pile-north', 'inside')).toBe(true);
    expect(has('detection:d1', 'measurement:pile-north', 'inside')).toBe(true);
    expect(has('detection:d2', 'measurement:pile-north', 'inside')).toBe(false);
  });

  it('is deterministic', async () => {
    const a = extractFacts(await readProjectSources(root));
    const b = extractFacts(await readProjectSources(root));
    expect(b).toEqual(a);
  });

  it('maps journal targets to subjects', () => {
    expect(subjectOfTarget({ rec: 'issue', id: 'i1' })).toBe('issue:i1');
    expect(subjectOfTarget({ rec: 'change-item', id: 'it1', in: 'cs' })).toBe('change-item:cs/it1');
    expect(subjectOfTarget({ rec: 'detection', id: 'd1', in: 'detections/run-1.json' })).toBe(
      'detection:d1',
    );
  });

  it('tests points in polygons', () => {
    const sq = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(inside(5, 5, sq)).toBe(true);
    expect(inside(15, 5, sq)).toBe(false);
  });
});

describe('the index', () => {
  it('gives an antenna its history across survey dates', async () => {
    const ix = await build();
    const h = ix.historyOf('antenna:ant-a1');
    expect(h.facts.map((f) => [f.date, f.status, f.source])).toEqual([
      ['2026-07-01', 'accepted', 'human'],
      ['2026-08-01', 'draft', 'pipeline'],
    ]);
    expect(h.linked.map((l) => l.fact.subject)).toContain('survey:c2');
    expect(ix.query({ text: 'downtilt 5' }).facts[0]?.id).toBe('antenna:ant-a1@c2');
  });

  it('deleting it and building again gives the same index', async () => {
    const file = join(root, 'ix.sqlite');
    const a = await build(file);
    const first = a.dump();
    a.close();
    rmSync(file);
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
    const b = await build(file);
    expect(b.dump()).toEqual(first);
    expect(b.dump()).toEqual(extractFacts(await readProjectSources(root)));
    b.close();
  });

  it('updates incrementally: only the rows that differ change', async () => {
    const ix = await build();
    writeFileSync(
      join(root, 'survey', 'measurements.json'),
      JSON.stringify({
        schema: 'aio.measurements/1',
        measurements: [measurement([result('c1', 1200), result('c2', 800)])],
      }),
    );
    const r = ix.sync(extractFacts(await readProjectSources(root)));
    expect(r).toMatchObject({ added: 0, changed: 1, removed: 0, linksAdded: 0, linksRemoved: 0 });
    expect(ix.query({ kinds: ['volume'], capture: 'c2' }).facts[0]?.value).toBe(800);
    // and an update equals a fresh build
    const fresh = openFactIndex(':memory:');
    fresh.sync(extractFacts(await readProjectSources(root)));
    expect(ix.dump()).toEqual(fresh.dump());
    const again = ix.sync(extractFacts(await readProjectSources(root)));
    expect(again).toEqual({ added: 0, changed: 0, removed: 0, linksAdded: 0, linksRemoved: 0 });
  });

  it('searches words as prefixes and stems, best match first', async () => {
    const ix = await build();
    const r = ix.query({ text: 'stockpil' });
    expect(r.facts[0]?.subject).toBe('measurement:pile-north');
    expect(ix.query({ text: 'cracks ramp' }).facts.map((f) => f.id)).toContain('issue:i1');
    expect(ix.query({ text: 'gravel' }).total).toBeGreaterThan(0);
    expect(ix.query({ text: 'zzz-nothing' }).total).toBe(0);
  });

  it('filters by kind, date range, status and place', async () => {
    const ix = await build();
    expect(ix.query({ kinds: ['detection'], status: 'rejected' }).facts.map((f) => f.id)).toEqual([
      'detection:d2',
    ]);
    expect(ix.query({ kinds: ['volume'], from: '2026-08-01' }).facts).toHaveLength(1);
    const near = ix.query({
      near: { e: 1010, n: 1990, radiusM: 1 },
      kinds: ['detection', 'issue'],
    });
    expect(near.facts.map((f) => f.id).sort()).toEqual(['detection:d1', 'issue:i1']);
    // no text: newest first
    const all = ix.query({ kinds: ['volume'] });
    expect(all.facts.map((f) => f.date)).toEqual(['2026-08-01', '2026-07-01']);
  });

  it('gives a subject history: own facts, linked facts and events in date order', async () => {
    const ix = await build();
    const h = ix.historyOf('measurement:pile-north');
    expect(h.facts.map((f) => f.kind)).toEqual(['measurement', 'volume', 'volume']);
    expect(h.facts.filter((f) => f.kind === 'volume').map((f) => f.value)).toEqual([1200, 950]);
    const rels = new Set(h.linked.map((l) => `${l.rel} ${l.fact.subject}`));
    expect(rels).toContain('qa qa:c2');
    expect(rels).toContain('inside issue:i1');
    const issue = ix.historyOf('issue:i1');
    expect(issue.linked.map((l) => l.fact.subject)).toContain('detection:d1');
  });

  it('gives journal ops as events of their subject', async () => {
    const ix = await build();
    const events = ix.query({ kinds: ['event'], limit: 500 }).facts;
    expect(events.length).toBeGreaterThan(0);
    const subject = events[0]?.subject ?? '';
    const h = ix.historyOf(subject);
    expect(h.events.length).toBeGreaterThan(0);
    expect(h.events.every((e) => e.op)).toBe(true);
    const ats = h.events.map((e) => e.at ?? '');
    expect([...ats].sort()).toEqual(ats);
  });

  it('reports its status', async () => {
    const ix = await build();
    const s = ix.status();
    expect(s.state).toBe('ready');
    expect(s.builtAt).toBe('2026-11-11T00:00:00.000Z');
    expect(s.counts.volume).toBe(2);
    expect(s.links).toBeGreaterThan(5);
    expect(openFactIndex(':memory:').status().state).toBe('none');
  });

  it('makes an index of another version again, and refuses a file that is not one', async () => {
    const file = join(root, 'old.sqlite');
    const a = await build(file);
    a.close();
    const raw = new DatabaseSync(file);
    raw.exec(`UPDATE meta SET value = '0' WHERE key = 'version'`);
    raw.close();
    const b = openFactIndex(file);
    expect(b.status()).toMatchObject({ state: 'none', links: 0, counts: {} });
    b.close();
    const junk = join(root, 'junk.sqlite');
    writeFileSync(junk, 'not a database '.repeat(400));
    expect(() => openFactIndex(junk)).toThrow();
    rmSync(junk); // the handle was closed, so the file can go
  });

  it('turns free words into a safe FTS query', () => {
    expect(ftsQuery('North "stock" pile!')).toBe('"north"* "stock"* "pile"*');
    expect(ftsQuery('  -- ')).toBeNull();
  });
});
