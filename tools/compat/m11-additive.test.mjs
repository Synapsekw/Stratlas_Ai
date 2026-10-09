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
// G9 adds four report sections and the integration two more (`haul`, `hydrology`) to
// `ReportSectionId`, strict in `ReportContentsSettings`: settings keep them in
// `reportSectionsExtra`, which 0.10 folds back only for the sections it knows and carries over
// unread on its own saves (the M9 fix), so only the toggles are new to it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REPORT_SECTIONS_08,
  createSettingsStore,
  defaultSettings,
} from '../../apps/desktop/src/main/settings.ts';
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

  it('keeps the 0.10 layer kinds and project types; report sections gain exactly six survey ids', () => {
    expect([...current.LAYER_KINDS].sort()).toEqual([...v010.LAYER_KINDS].sort());
    expect(current.ProjectType.options).toEqual(v010.ProjectType.options);
    // G9 (plan "Contract changes"): the 0.10 sections in order, then the four survey sections and
    // the haul-road and hydrology runs; settings saved with them toggled stay readable by 0.10
    // (the test below)
    expect([...current.REPORT_SECTIONS]).toEqual([
      ...v010.REPORT_SECTIONS,
      'measurements',
      'earthworks',
      'stockpiles',
      'landfill',
      'haul',
      'hydrology',
    ]);
    expect([...current.EXPORT_FORMATS]).toEqual([
      ...v010.EXPORT_FORMATS,
      'measurements-csv',
      'stockpile-csv',
      'survey-report-pdf',
    ]);
  });

  it('new M11 files are families 0.10 does not know, so it never reads them', () => {
    const known010 = new Set(v010.SCHEMA_REGISTRY.map((e) => e.family));
    const m11 = current.SCHEMA_REGISTRY.filter((e) => e.since === '0.11');
    expect(m11.length).toBe(17);
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

// What apps/desktop/src/main/settings.ts did at 0.10.0 (unchanged since the M9 fix): sections in
// `reportSectionsExtra` that its ReportSectionId knows are folded back into `reportContents`, each
// top-level field its schema accepts is kept, and on save the sections 0.8 does not know go to
// `reportSectionsExtra` together with the extras it read and does not know itself.
const EXTRA = 'reportSectionsExtra';
const known010 = (id) => v010.ReportSectionId.safeParse(id).success;
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
function extras010(raw) {
  if (!isRecord(raw?.[EXTRA])) return {};
  return Object.fromEntries(Object.entries(raw[EXTRA]).filter(([, on]) => typeof on === 'boolean'));
}
function read010(raw) {
  const ours = Object.entries(extras010(raw)).filter(([id]) => known010(id));
  const contents = isRecord(raw.reportContents) ? raw.reportContents : {};
  const sections = isRecord(contents.sections) ? contents.sections : {};
  const stored = ours.length
    ? {
        ...raw,
        reportContents: { ...contents, sections: { ...Object.fromEntries(ours), ...sections } },
      }
    : raw;
  const kept = {};
  for (const [key, field] of Object.entries(v010.Settings.shape)) {
    if (!(key in stored)) continue;
    const r = field.safeParse(stored[key]);
    if (r.success) kept[key] = r.data;
  }
  return kept;
}
function write010(settings, keep) {
  const { reportContents, ...rest } = settings;
  const out = { ...rest };
  const extra = Object.fromEntries(Object.entries(keep).filter(([id]) => !known010(id)));
  if (reportContents) {
    const { sections = {}, ...others } = reportContents;
    const old = Object.entries(sections).filter(([id]) => REPORT_SECTIONS_08.includes(id));
    for (const [id, on] of Object.entries(sections))
      if (!REPORT_SECTIONS_08.includes(id)) extra[id] = on;
    out.reportContents = old.length ? { ...others, sections: Object.fromEntries(old) } : others;
  }
  if (Object.keys(extra).length) out[EXTRA] = extra;
  return out;
}

describe('settings with a G9 report section toggled, read by 0.10', () => {
  it('keeps every 0.10 report choice, and the survey toggles survive an 0.10 save', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-compat-m11-settings-'));
    const file = join(dir, 'settings.json');
    try {
      const store = createSettingsStore(file, defaultSettings('C:/Data'));
      await store.set({
        theme: 'light',
        reportContents: {
          sections: {
            appendices: false,
            processing: false,
            stockpiles: false,
            measurements: true,
            haul: false,
            hydrology: true,
          },
          issuePages: 'none',
        },
      });
      const disk = JSON.parse(await readFile(file, 'utf8'));
      // the strict part holds 0.8's sections only; the rest wait in reportSectionsExtra
      expect(disk.reportContents).toEqual({ sections: { appendices: false }, issuePages: 'none' });
      expect(disk[EXTRA]).toEqual({
        processing: false,
        stockpiles: false,
        measurements: true,
        haul: false,
        hydrology: true,
      });
      expect(v010.Settings.safeParse(disk).success).toBe(true);

      // 0.10 reads its own choices (processing folded back), never refuses the file
      const seen = read010(disk);
      expect(seen.theme).toBe('light');
      expect(seen.reportContents).toEqual({
        sections: { processing: false, appendices: false },
        issuePages: 'none',
      });
      expect(v010.ReportContentsSettings.safeParse(seen.reportContents).success).toBe(true);

      // 0.10 saves a change of its own: the survey toggles ride along in reportSectionsExtra
      const parsed = v010.Settings.parse({ ...defaultSettings('C:/Data'), ...seen, theme: 'dark' });
      await writeFile(file, JSON.stringify(write010(parsed, extras010(disk))));
      const back = await createSettingsStore(file, defaultSettings('C:/Data')).get();
      expect(back.theme).toBe('dark');
      expect(back.reportContents?.sections).toEqual({
        appendices: false,
        processing: false,
        stockpiles: false,
        measurements: true,
        haul: false,
        hydrology: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('would have been refused whole by 0.10 inside the strict reportContents (the M9 risk)', () => {
    const raw = { reportContents: { sections: { appendices: false, landfill: true } } };
    expect(read010(raw).reportContents).toBeUndefined();
    const haul = { reportContents: { sections: { appendices: false, haul: true } } };
    expect(read010(haul).reportContents).toBeUndefined();
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
