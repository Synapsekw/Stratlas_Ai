import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ChangeSet,
  DetectionsFile,
  Issue,
  ProcModel,
  type BoundaryEditsFile,
  type NarrativeFile,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  applyBoundaries,
  applyChangeSet,
  applyDetections,
  applyIssues,
  applyNarrative,
  applyProcModel,
  mergeStateFiles,
  project,
  stateFiles,
  stateFileText,
} from './index';
import { TeamSim } from './testing/generator';

const fixture = (rel: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../schema/src/__fixtures__/${rel}`, import.meta.url)),
    'utf8',
  );

/** What today's `project:writeIssues` writes for a list: IPC parse, then `writeJsonAtomic`. */
const todayIssues = (issues: unknown[]) =>
  stateFileText({ schema: 'aio.issues/1', issues: issues.map((i) => Issue.parse(i)) });

const compat = JSON.parse(fixture('compat-0.8/issues.json')) as {
  issues: Record<string, unknown>[];
};
const f01 = compat.issues[0] ?? {};
const f01id = f01.id as string;

/** The journal turned on over an existing project: one `issue.create` per issue, in file order. */
function baseline(sim: TeamSim) {
  for (const issue of compat.issues) {
    sim.write(0, 'issue.create', { rec: 'issue', id: issue.id as string }, { record: issue });
  }
  sim.syncAll();
}

describe('applyIssues', () => {
  it('leaves an 0.8 file byte for byte when the journal holds no change', () => {
    const text = fixture('compat-0.8/issues.json');
    const today = todayIssues(compat.issues);
    expect(stateFileText(applyIssues(JSON.parse(text), project([])).value)).toBe(today);
    const sim = new TeamSim();
    baseline(sim);
    expect(stateFileText(applyIssues(JSON.parse(text), project(sim.all())).value)).toBe(today);
  });

  it('writes a merged edit exactly as today’s writer would', () => {
    const sim = new TeamSim({ people: 2 });
    baseline(sim);
    sim.write(0, 'issue.patch', { rec: 'issue', id: f01id }, { set: { severity: 4 } });
    sim.write(1, 'issue.patch', { rec: 'issue', id: f01id }, { set: { note: 'Merged note' } });
    const out = applyIssues(compat, project(sim.all()));
    expect(out.problems).toEqual([]);
    const expected = compat.issues.map((i) =>
      i.id === f01id ? { ...i, severity: 4, note: 'Merged note' } : i,
    );
    expect(stateFileText(out.value)).toBe(todayIssues(expected));
  });

  it('overlays issues made before the journal, drops deleted ones, keeps unknown ones', () => {
    const sim = new TeamSim();
    sim.write(0, 'issue.patch', { rec: 'issue', id: f01id }, { set: { title: 'Patched' } });
    const out = applyIssues(compat, project(sim.all()));
    expect(out.value.issues.map((i) => [i.id, i.title])).toEqual(
      compat.issues.map((i) => [i.id, i.id === f01id ? 'Patched' : i.title]),
    );
    sim.write(0, 'issue.delete', { rec: 'issue', id: f01id }, {});
    const gone = applyIssues(compat, project(sim.all()));
    expect(gone.value.issues.map((i) => i.id)).toEqual(
      compat.issues.filter((i) => i.id !== f01id).map((i) => i.id),
    );
  });

  it('adds no field: unknown keys are stripped as today, so an 0.8 build reads the file', () => {
    const sim = new TeamSim();
    sim.write(
      0,
      'issue.create',
      { rec: 'issue', id: 'i_new' },
      {
        record: { ...f01, id: 'i_new', code: 'F99', assignee: 'a_x', approvals: [] },
      },
    );
    const out = applyIssues(null, project(sim.all()));
    const keys = Object.keys(out.value.issues[0] ?? {});
    expect(keys.every((k) => k in Issue.shape)).toBe(true);
  });

  it('keeps the file version of an issue the merge could not make valid', () => {
    const sim = new TeamSim();
    baseline(sim);
    sim.write(0, 'issue.patch', { rec: 'issue', id: f01id }, { set: { code: 'not a code' } });
    const out = applyIssues(compat, project(sim.all()));
    expect(out.problems[0]).toMatch(/^Issue not a code:/);
    expect(out.value.issues.find((i) => i.id === f01id)?.code).toBe(f01.code);
  });
});

describe('applyChangeSet', () => {
  const set = ChangeSet.parse(JSON.parse(fixture('change/issues.json')));

  it('merges reviews into items, leaving the rest as today', () => {
    const sim = new TeamSim({ people: 2 });
    const item = (id: string) => ({ rec: 'change-item', id, in: set.id });
    const at = '2026-10-07T08:00:00Z';
    sim.write(0, 'change.review', item('issue:F03'), {
      set: { status: 'confirmed', by: 'Rana Example', at },
    });
    sim.write(1, 'change.review', item('issue:F01'), { set: { note: 'Seen again' } });
    const p = project(sim.all());
    expect(stateFiles(p)).toEqual(['change/c1-c2-issues.json']);
    const out = applyChangeSet(set, p);
    const expected = ChangeSet.parse({
      ...set,
      items: set.items.map((i) =>
        i.id === 'issue:F03'
          ? { ...i, review: { status: 'confirmed', by: 'Rana Example', at } }
          : i.id === 'issue:F01'
            ? { ...i, review: { ...i.review, note: 'Seen again' } }
            : i,
      ),
    });
    expect(stateFileText(out.value)).toBe(stateFileText(expected));
  });
});

describe('applyDetections', () => {
  const file = DetectionsFile.parse({
    schema: 'aio.detections/1',
    source: 'ai',
    detections: [
      { id: 'a1', photo: 'p001', class: 'corrosion', severity: 2, bbox: [10, 20, 60, 80] },
      { photo: 'p002', class: 'crack', status: 'draft', bbox: [1, 1, 5, 5] },
    ],
  });

  it('merges per detection by id, leaves detections without id, adds drawn ones', () => {
    const sim = new TeamSim({ people: 2 });
    const det = (id: string) => ({ rec: 'detection', id, in: 'ai-run1.json' });
    sim.write(0, 'detection.review', det('a1'), { set: { status: 'accepted', severity: 3 } });
    sim.write(1, 'detection.review', det('d9'), {
      set: { photo: 'p003', class: 'leak', bbox: [5, 5, 9, 9], status: 'accepted' },
    });
    const out = applyDetections('ai-run1.json', file, project(sim.all()));
    expect(out.problems).toEqual([]);
    expect(out.value.detections).toEqual([
      {
        id: 'a1',
        photo: 'p001',
        class: 'corrosion',
        severity: 3,
        status: 'accepted',
        bbox: [10, 20, 60, 80],
      },
      file.detections[1],
      { id: 'd9', photo: 'p003', class: 'leak', status: 'accepted', bbox: [5, 5, 9, 9] },
    ]);
    // other passes are left alone
    expect(applyDetections('review.json', file, project(sim.all())).value).toEqual(file);
  });
});

describe('applyProcModel, applyBoundaries, applyNarrative', () => {
  it('merges part fields', () => {
    const model = ProcModel.parse({
      schema: 'aio.procmodel/2',
      id: 'm1',
      name: 'Site',
      createdAt: '2026-10-06T08:00:00Z',
      updatedAt: '2026-10-06T08:00:00Z',
      sources: [],
      parts: [
        {
          kind: 'box',
          id: 's1',
          status: 'draft',
          origin: { by: 'manual' },
          base: [5, 0, 5],
          size: [4, 2.5, 6],
        },
      ],
      materials: [],
      assemblies: [],
    });
    const sim = new TeamSim();
    sim.write(
      0,
      'procmodel.part',
      { rec: 'part', id: 's1', in: 'm1' },
      { set: { status: 'accepted' } },
    );
    const out = applyProcModel(model, project(sim.all()));
    expect(out.value.parts[0]?.status).toBe('accepted');
    expect(stateFiles(project(sim.all()))).toEqual(['models/m1.procmodel.json']);
  });

  it('migrates a /1 model file before merging into it, never dropping it', async () => {
    const v1 = {
      schema: 'aio.procmodel/1',
      id: 'm1',
      name: 'Site',
      createdAt: '2026-10-06T08:00:00Z',
      updatedAt: '2026-10-06T08:00:00Z',
      parts: [
        {
          kind: 'box',
          id: 's1',
          status: 'draft',
          origin: { by: 'manual' },
          base: [5, 0, 5],
          size: [4, 2.5, 6],
        },
      ],
    };
    const sim = new TeamSim();
    sim.write(
      0,
      'procmodel.part',
      { rec: 'part', id: 's1', in: 'm1' },
      { set: { status: 'accepted' } },
    );
    const out = await mergeStateFiles(project(sim.all()), (path) =>
      Promise.resolve(path === 'models/m1.procmodel.json' ? JSON.stringify(v1) : null),
    );
    expect(out.problems).toEqual([]);
    const written = out.files.find((f) => f.path === 'models/m1.procmodel.json');
    const merged = ProcModel.parse(JSON.parse(written?.text ?? '{}'));
    expect(merged.schema).toBe('aio.procmodel/2');
    expect(merged.parts[0]?.status).toBe('accepted');
  });

  const engineering = {
    schema: 'aio.procmodel/2',
    id: 'eng',
    name: 'Shaft',
    createdAt: '2026-10-06T08:00:00Z',
    updatedAt: '2026-10-06T08:00:00Z',
    sources: [],
    parts: [],
    materials: [],
    assemblies: [
      {
        id: 'shaft-1',
        kind: 'shaft',
        name: 'Shaft',
        description: 'Tapered shaft',
        category: 'Shaft',
        status: 'draft',
        origin: { by: 'engineer', runId: 'r1' },
        quality: {},
        sources: [],
        params: {
          base: [0, 0, 0],
          profile: [
            { y: 0, r: 10 },
            { y: 100, r: 7 },
          ],
          wall: 0.4,
          openTop: true,
        },
      },
    ],
  };

  it("lands another device's component edit on an engineering model (last writer wins)", async () => {
    const shaft = engineering.assemblies[0];
    const sim = new TeamSim();
    sim.write(
      0,
      'procmodel.part',
      { rec: 'model', id: 'eng' },
      { set: { assemblies: [{ ...shaft, name: 'First' }] } },
    );
    sim.advance();
    sim.write(
      1,
      'procmodel.part',
      { rec: 'model', id: 'eng' },
      {
        set: { assemblies: [{ ...shaft, name: 'Main shaft' }], updatedAt: '2026-10-07T08:00:00Z' },
      },
    );
    sim.syncAll();
    const p = project(sim.all());
    expect(stateFiles(p)).toEqual(['models/eng.procmodel.json']);
    const out = await mergeStateFiles(p, (path) =>
      Promise.resolve(path === 'models/eng.procmodel.json' ? stateFileText(engineering) : null),
    );
    expect(out.problems).toEqual([]);
    const merged = ProcModel.parse(JSON.parse(out.files[0]?.text ?? '{}'));
    expect(merged.assemblies[0]?.name).toBe('Main shaft');
    expect(merged.updatedAt).toBe('2026-10-07T08:00:00Z');
  });

  it('creates an engineering model made on another device', async () => {
    const rest = Object.fromEntries(Object.entries(engineering).filter(([k]) => k !== 'parts'));
    const sim = new TeamSim();
    sim.write(1, 'procmodel.part', { rec: 'model', id: 'eng' }, { set: rest });
    sim.syncAll();
    const out = await mergeStateFiles(project(sim.all()), () => Promise.resolve(null));
    expect(out.problems).toEqual([]);
    expect(out.files.map((f) => f.path)).toEqual(['models/eng.procmodel.json']);
    const made = ProcModel.parse(JSON.parse(out.files[0]?.text ?? '{}'));
    expect(made).toEqual(ProcModel.parse(engineering));
    expect(out.files[0]?.text).toBe(stateFileText(ProcModel.parse(engineering)));
  });

  it('leaves a model with only part changes as it was outside its parts', async () => {
    const withPart = ProcModel.parse({
      ...engineering,
      parts: [
        {
          kind: 'box',
          id: 's1',
          status: 'draft',
          origin: { by: 'manual' },
          base: [5, 0, 5],
          size: [4, 2.5, 6],
        },
      ],
    });
    const sim = new TeamSim();
    sim.write(
      0,
      'procmodel.part',
      { rec: 'part', id: 's1', in: 'eng' },
      { set: { status: 'accepted' } },
    );
    const out = await mergeStateFiles(project(sim.all()), (path) =>
      Promise.resolve(path === 'models/eng.procmodel.json' ? stateFileText(withPart) : null),
    );
    const merged = ProcModel.parse(JSON.parse(out.files[0]?.text ?? '{}'));
    expect({ ...merged, parts: [] }).toEqual({ ...withPart, parts: [] });
    expect(merged.parts[0]?.status).toBe('accepted');
    // part ops alone never make a model that is not here
    const none = await mergeStateFiles(project(sim.all()), () => Promise.resolve(null));
    expect(none.files).toEqual([]);
  });

  it('takes the last boundary edit per pile and date', () => {
    const edit = (net: number) => ({
      pile: 'P1',
      epoch: 'e1',
      ring: [
        [0, 0],
        [1, 0],
        [1, 1],
      ] as [number, number][],
      volumes: Object.fromEntries(
        ['tin', 'plane', 'avg', 'low'].map((b) => [b, { fill: 1, cut: 0, net: 1 }]),
      ),
      areaM2: 1,
      topM: 2,
      heightM: 1,
      autoNet: net,
      updatedAt: '2026-10-07T08:00:00Z',
    });
    const sim = new TeamSim({ people: 2 });
    sim.write(0, 'boundary.edit', { rec: 'boundary', id: 'P1/e1' }, { record: edit(1) });
    sim.write(1, 'boundary.edit', { rec: 'boundary', id: 'P1/e1' }, { record: edit(2) });
    const file = { schema: 'aio.boundaries/1', edits: [edit(0)] } as BoundaryEditsFile;
    const out = applyBoundaries(file, project(sim.all()));
    expect(out.problems).toEqual([]);
    expect(out.value.edits.map((e) => e.autoNet)).toEqual([2]);
  });

  it('keeps every narrative version, the newest 50 per part', () => {
    const v = (n: number) => ({
      text: `v${n}`,
      source: 'user',
      createdAt: `2026-10-07T08:${String(n).padStart(2, '0')}:00Z`,
    });
    const file = {
      schema: 'aio.narrative/1',
      parts: { summary: { versions: Array.from({ length: 50 }, (_, i) => v(i)) } },
    } as NarrativeFile;
    const sim = new TeamSim({ people: 2 });
    sim.write(
      0,
      'narrative.version',
      { rec: 'narrative', id: 'summary' },
      {
        record: { part: 'summary', ...v(55) },
      },
    );
    sim.write(
      1,
      'narrative.version',
      { rec: 'narrative', id: 'method' },
      {
        record: { part: 'method', ...v(56) },
      },
    );
    const out = applyNarrative(file, project(sim.all()));
    expect(out.problems).toEqual([]);
    const summary = out.value.parts.summary?.versions ?? [];
    expect(summary).toHaveLength(50);
    expect(summary.at(-1)?.text).toBe('v55');
    expect(summary[0]?.text).toBe('v1');
    expect(out.value.parts.method?.versions.map((x) => x.text)).toEqual(['v56']);
  });
});
