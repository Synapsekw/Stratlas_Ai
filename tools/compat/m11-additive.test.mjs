// M11's contracts are additive (plan "Global constraints", G0), pinned here against the 0.10.0
// schema (tools/compat/schema-0.10):
// - a project as 0.10 wrote it (corpus/0.10) round-trips unchanged through the 0.11 schemas;
// - every existing file 0.11 writes still parses with the 0.10 schema (corpus.test.mjs runs the
//   whole corpus; here the manifest, settings and the survey defaults that stay out of Settings);
// - survey data lives in new files (`<project>/survey/`, new userData files) whose families 0.10
//   does not know, so it never reads them;
// - survey ops in the journal (`measurement.*`, `design.*`, `survey.*`) are op kinds 0.10 does not
//   know: its reader accepts the op lines (the kind is a dotted name), Verify never checks kinds,
//   and its audit view shows them as `unknown-kind` ("From a newer version").
// The one known exception, as in M10: the job index (userData jobs.json) lists jobs of the new
// pipelines, which 0.10's index reader skips one by one instead of refusing the file.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v010 from './schema-0.10/index.mjs';
import { familyOf } from './families.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const corpus = join(here, 'corpus');
const index = JSON.parse(readFileSync(join(corpus, 'index.json'), 'utf8'));
const load = (version, p) => JSON.parse(readFileSync(join(corpus, version, p), 'utf8'));
const rel = (p) => p.slice(p.indexOf('/') + 1);

/** The first op line of the M9 golden journal (a signed `issue.sighting.add`). */
function sampleOp() {
  const ops = join(
    here,
    '..',
    '..',
    'packages',
    'schema',
    'src',
    '__fixtures__',
    'journal',
    'valid',
    'journal',
    'ops',
  );
  const chain = readdirSync(ops).find((n) => statSync(join(ops, n)).isDirectory());
  const line = readFileSync(join(ops, chain, '000001.jsonl'), 'utf8').split('\n')[0];
  return JSON.parse(line);
}

describe('a project written by 0.10', () => {
  for (const p of index.builds['0.10'].files) {
    it(`${p} round-trips unchanged through the 0.11 schemas`, () => {
      const raw = load('0.10', p);
      const schema = familyOf(rel(p))?.pick(current);
      expect(schema, `no 0.11 schema for ${p}`).toBeTruthy();
      const r = schema.safeParse(raw);
      expect(r.success, r.success ? '' : r.error.message).toBe(true);
      expect(r.data).toEqual(raw);
      expect(JSON.stringify(r.data)).toBe(JSON.stringify(raw));
      if (rel(p) === 'manifest.json')
        expect(current.parseManifest(raw)).toEqual({ ok: true, value: raw });
    });
  }
});

describe('existing files 0.11 writes stay readable by 0.10', () => {
  it('a manifest 0.11 saves parses with the 0.10 schema, nothing lost', () => {
    const base = load('0.11', 'tank-farm/manifest.json');
    const written = current.keepUnknownLayers(base, current.ProjectManifest.parse(base));
    expect(written.ok).toBe(true);
    const disk = JSON.parse(JSON.stringify(written.value));
    const r = v010.ProjectManifest.safeParse(disk);
    expect(r.success, r.success ? '' : r.error.message).toBe(true);
    expect(r.data).toEqual(disk);
  });

  it('settings written by 0.11 parse with the 0.10 schema (survey defaults have their own file)', () => {
    const settings = current.Settings.parse(load('0.11', 'userData/settings.json'));
    expect(Object.keys(current.Settings.shape).sort()).toEqual(
      Object.keys(v010.Settings.shape).sort(),
    );
    expect(v010.Settings.safeParse(settings).success).toBe(true);
    expect(v010.Settings.safeParse({ ...settings, survey: { units: 'm' } }).success).toBe(true);
  });

  it('keeps the 0.10 layer kinds, project types and report sections', () => {
    expect([...current.LAYER_KINDS].sort()).toEqual([...v010.LAYER_KINDS].sort());
    expect(current.ProjectType.options).toEqual(v010.ProjectType.options);
    expect([...current.REPORT_SECTIONS]).toEqual([...v010.REPORT_SECTIONS]);
  });

  it('new M11 files are families 0.10 does not know, so it never reads them', () => {
    const known010 = new Set(v010.SCHEMA_REGISTRY.map((e) => e.family));
    const m11 = current.SCHEMA_REGISTRY.filter((e) => e.since === '0.11');
    expect(m11.length).toBe(16);
    for (const e of m11) expect(known010.has(e.family), e.family).toBe(false);
    for (const e of m11.filter((x) => x.home === 'project'))
      expect(e.where.startsWith('survey/'), `${e.family} lives in ${e.where}`).toBe(true);
  });

  it('the job index lists M11 jobs that 0.10 skips one by one (the known exception)', () => {
    const job = {
      id: '20261008-090000-survey-prepare-a1b2',
      pipeline: 'survey.prepare',
      project: 'D:/data/projects/demo',
      params: { surfaces: [{ id: 'dsm-1', name: 'DSM', source: { kind: 'dsm', layer: 'dsm' } }] },
      status: 'failed',
      progress: 0,
      steps: [],
      artifacts: [],
      createdAt: '2026-10-08T09:00:00Z',
      updatedAt: '2026-10-08T09:00:00Z',
    };
    expect(current.JobRecord.safeParse(job).success).toBe(true);
    expect(v010.JobRecord.safeParse(job).success).toBe(false);
    expect(v010.JobRecord.safeParse({ ...job, pipeline: 'photo.align' }).success).toBe(true);
  });
});

describe('survey ops in the journal', () => {
  const M11_OPS = [
    ['measurement.create', 'measurement', { record: { id: 'm-1', label: 'Stockpile A' } }],
    ['measurement.patch', 'measurement', { set: { label: 'Stockpile B' } }],
    ['measurement.delete', 'measurement', {}],
    ['design.add', 'design', { record: { id: 'd1' } }],
    ['design.patch', 'design', { set: { name: 'Bulk earthworks' } }],
    ['design.archive', 'design', { set: { archived: true } }],
    ['survey.settings', 'survey', { set: { 'units.distance': 'us-ft' } }],
    ['survey.calibration', 'survey', { record: { id: 'cal-1' } }],
    ['survey.hold', 'survey', { capture: 'c1', action: 'hold' }],
  ];

  for (const [kind, rec, payload] of M11_OPS) {
    it(`${kind} is read by 0.10 as unknown-kind and known now`, () => {
      const op = { ...sampleOp(), kind, target: { rec, id: 'x1' }, payload };
      delete op.label;
      // 0.10 reads the line: the op schema takes any dotted kind and any record kind.
      expect(v010.Op.safeParse(op).success).toBe(true);
      // ... and its audit view marks it `unknown-kind` (journal/src/query.ts: !isKnownOpKind).
      expect(v010.isKnownOpKind(kind)).toBe(false);
      expect(v010.AuditEntry.shape.state.options).toContain('unknown-kind');
      // This build knows it, with a payload schema.
      expect(current.Op.safeParse(op).success).toBe(true);
      expect(current.isKnownOpKind(kind)).toBe(true);
      expect(current.OP_PAYLOADS[kind].safeParse(payload).success).toBe(true);
    });
  }

  it('the op kinds 0.10 knows are all still known', () => {
    for (const k of v010.OP_KINDS) expect(current.isKnownOpKind(k), k).toBe(true);
  });
});
