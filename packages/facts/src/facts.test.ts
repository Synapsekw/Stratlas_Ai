import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChangeItem, Detection } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractFacts, inside, subjectOfTarget } from './extract';
import { readProjectSources } from './sources';
import { ftsQuery, openFactIndex } from './store';
import {
  measurement,
  result,
  writeAntennaDeletion,
  writeAntennaInventory,
  writeFixtureProject,
} from './testing';

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
    expect(s.notes.map((n) => n.id)).toEqual(['n-pile1', 'n-units']);
  });

  it('reads the notes tolerantly: a bad note is left out, a bad file is no notes', async () => {
    const file = join(root, 'ai', 'memory.json');
    writeFileSync(
      file,
      JSON.stringify({
        schema: 'aio.agent-memory/1',
        notes: [
          { id: 'bad id', text: 'x', by: 'agent', createdAt: '2026-08-03T09:00:00.000Z' },
          { id: 'n-good', text: 'kept', by: 'person', createdAt: '2026-08-03T09:00:00.000Z' },
        ],
      }),
    );
    expect((await readProjectSources(root)).notes.map((n) => n.id)).toEqual(['n-good']);
    writeFileSync(file, '{ not json');
    expect((await readProjectSources(root)).notes).toEqual([]);
    rmSync(file);
    expect((await readProjectSources(root)).notes).toEqual([]);
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
      'note',
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

  it('reads a walk track draft (V4) at its point and an AI label of a change region', async () => {
    const src = await readProjectSources(root);
    const d = Detection.parse({
      id: 'wt1',
      frame: { layer: 'walk-1', t: 12 },
      space: 'normalized',
      class: 'crack',
      bbox: [0.1, 0.1, 0.2, 0.2],
      track: { frames: 4, firstT: 10, lastT: 14, point: [3, 1, -4], placedOn: 'ground' },
    });
    src.detections.push({ file: 'detections/walk-1.json', source: 'model', detections: [d] });
    const set = src.changeSets[0]?.set;
    if (!set) throw new Error('fixture has a change set');
    set.items.push(
      ChangeItem.parse({
        kind: 'region',
        id: 'r1',
        verdict: 'added',
        aiLabel: { kind: 'material-added', what: 'gravel heap', at: '2026-08-05T00:00:00.000Z' },
      }),
    );
    const { facts, links } = extractFacts(src);
    expect(facts.find((f) => f.id === 'detection:wt1')).toMatchObject({ e: 1003, n: 2004 });
    expect(facts.find((f) => f.id === 'detection:wt1')?.text).toContain('walk track 4 frames');
    expect(links).toContainEqual({ from: 'detection:wt1', to: 'layer:walk-1', rel: 'in-layer' });
    expect(facts.find((f) => f.id === 'change-item:c1-c2-issues/r1')?.text).toContain(
      'material added gravel heap',
    );
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
  it('leaves a deleted antenna out of search and history', async () => {
    writeAntennaDeletion(root);
    const ix = await build();
    expect(ix.historyOf('antenna:ant-a1').facts).toEqual([]);
    expect(ix.query({ kinds: ['antenna'] }).total).toBe(0);
    expect(ix.query({ text: 'downtilt' }).facts.some((f) => f.kind === 'antenna')).toBe(false);
  });

  it("shows an antenna's current name and review state on its inventory's date", async () => {
    writeAntennaInventory(root, { name: 'A1 north', status: 'rejected' }, 'c2');
    const ix = await build();
    const h = ix.historyOf('antenna:ant-a1');
    expect(h.facts.map((f) => [f.date, f.label, f.status, f.source, f.evidence])).toEqual([
      ['2026-07-01', 'A1', 'accepted', 'human', 'telecom/history/c1.json'],
      ['2026-08-01', 'A1 north', 'rejected', 'human', 'telecom/antennas.json'],
    ]);
    expect(ix.query({ text: 'north', kinds: ['antenna'] }).facts[0]?.id).toBe('antenna:ant-a1@c2');
  });

  it('lays an inventory without a date over the latest date measured', async () => {
    writeAntennaInventory(root, { name: 'A1', status: 'accepted' });
    const ix = await build();
    const latest = ix.historyOf('antenna:ant-a1').facts.at(-1);
    expect([latest?.date, latest?.status]).toEqual(['2026-08-01', 'accepted']);
  });

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

  it('finds a project note by its words and in the history of the subject it is about', async () => {
    const ix = await build();
    const hit = ix.query({ text: 'granite' }).facts[0];
    expect(hit).toMatchObject({
      id: 'note:n-pile1',
      kind: 'note',
      subject: 'note:n-pile1',
      source: 'agent',
      evidence: 'ai/memory.json',
      date: '2026-08-03',
    });
    expect(ix.query({ kinds: ['note'] }).total).toBe(2);
    const h = ix.historyOf('measurement:pile-north');
    expect(h.linked.some((l) => l.rel === 'about' && l.fact.id === 'note:n-pile1')).toBe(true);
    expect(ix.historyOf('note:n-units').linked).toEqual([]);
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
