import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signerFromKey } from '@aio/journal';
import {
  defaultSurveySettings,
  emptySurveyTemplates,
  type MeasurementsFile,
  type SurveyMeasurement,
  type SurveyTemplatesFile,
} from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createJournalService, type JournalIdentity, type JournalService } from './journal';
import { collectHandlers } from './notYet';
import { registerSurveyIpc, writeMeasurements, type SurveyArchive } from './survey';

const dirs: string[] = [];
const journals: JournalService[] = [];
afterEach(async () => {
  await Promise.all(journals.splice(0).map((j) => j.closeAll()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(name: string) {
  const d = mkdtempSync(join(tmpdir(), `aio-survey-${name}-`));
  dirs.push(d);
  return d;
}

const measurement = (id: string, label: string): SurveyMeasurement => ({
  id,
  family: 'line',
  tool: 'distance',
  label,
  scope: { kind: 'site' },
  points: [
    [500_000.125, 2_700_000.5, 12.25],
    [500_025.125, 2_700_000.5, 13.25],
  ],
  items: [],
  results: [],
  createdAt: '2026-10-09T06:00:00.000Z',
});
const file = (...ms: SurveyMeasurement[]): MeasurementsFile => ({
  schema: 'aio.measurements/1',
  measurements: ms,
});

const archive = (members: Record<string, unknown>): SurveyArchive => {
  const m = new Map(Object.entries(members));
  return {
    entries: m,
    read: (name) => Promise.resolve(Buffer.from(JSON.stringify(m.get(name)), 'utf8')),
  };
};

function setup(pkgMembers?: Record<string, unknown>) {
  const root = tmp('project');
  const userData = tmp('userdata');
  const projects = {
    root: (id: string) => (id === 'p' ? root : undefined),
    package: (id: string) => (id === 'pkg' ? { archive: archive(pkgMembers ?? {}) } : undefined),
  };
  const ipc = collectHandlers((handle) => {
    registerSurveyIpc({ handle, projects, userData: () => userData });
  });
  return { root, userData, projects, ipc };
}

describe('survey IPC (G0 stubs without deps)', () => {
  const ipc = collectHandlers((handle) => {
    registerSurveyIpc({ handle });
  });

  it('registers every survey channel', () => {
    expect(ipc.channels()).toEqual([
      'survey:readDesigns',
      'survey:readMeasurements',
      'survey:readSettings',
      'survey:readTemplates',
      'survey:surfaces',
      'survey:writeDesigns',
      'survey:writeMeasurements',
      'survey:writeSettings',
      'survey:writeTemplates',
    ]);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    const notImplemented = { ok: false, code: 'not-implemented' };
    expect(await ipc.call('survey:readSettings', { projectId: 'p' })).toMatchObject(notImplemented);
    expect(
      await ipc.call('survey:writeSettings', { projectId: 'p', settings: defaultSurveySettings() }),
    ).toMatchObject(notImplemented);
    expect(
      await ipc.call('survey:writeMeasurements', {
        projectId: 'p',
        file: { schema: 'aio.measurements/1', measurements: [] },
      }),
    ).toMatchObject(notImplemented);
    expect(await ipc.call('survey:readTemplates', {})).toMatchObject(notImplemented);
    expect(
      await ipc.call('survey:writeTemplates', { scope: 'user', file: emptySurveyTemplates() }),
    ).toMatchObject(notImplemented);
    expect(
      await ipc.call('survey:writeDesigns', {
        projectId: 'p',
        file: { schema: 'aio.designs/1', designs: [] },
      }),
    ).toMatchObject(notImplemented);
    expect(await ipc.call('survey:surfaces', { projectId: 'p' })).toMatchObject(notImplemented);
  });
});

describe('survey measurements', () => {
  it('reads an empty list when there is no file, and writes atomically with a .bak', async () => {
    const { root, ipc } = setup();
    expect(await ipc.call('survey:readMeasurements', { projectId: 'p' })).toEqual({
      ok: true,
      file: { schema: 'aio.measurements/1', measurements: [] },
      readOnly: false,
    });
    const one = file(measurement('m1', 'Kerb'));
    expect(await ipc.call('survey:writeMeasurements', { projectId: 'p', file: one })).toEqual({
      ok: true,
    });
    const path = join(root, 'survey', 'measurements.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(one);
    expect(existsSync(`${path}.bak`)).toBe(false);
    const two = file(measurement('m1', 'Kerb'), measurement('m2', 'Pad edge'));
    expect(await ipc.call('survey:writeMeasurements', { projectId: 'p', file: two })).toEqual({
      ok: true,
    });
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8'))).toEqual(one);
    const back = await ipc.call('survey:readMeasurements', { projectId: 'p' });
    expect(back).toEqual({ ok: true, file: two, readOnly: false });
    // float64 coordinates survive the round trip exactly
    if (back.ok)
      expect(back.file.measurements[0]?.points[0]).toEqual([500_000.125, 2_700_000.5, 12.25]);
  });

  it('reads a package in place, read only, and refuses to write it', async () => {
    const stored = file(measurement('m1', 'Kerb'));
    const { ipc, projects } = setup({ 'survey/measurements.json': stored });
    expect(await ipc.call('survey:readMeasurements', { projectId: 'pkg' })).toEqual({
      ok: true,
      file: stored,
      readOnly: true,
    });
    expect(await ipc.call('survey:writeMeasurements', { projectId: 'pkg', file: stored })).toEqual(
      expect.objectContaining({ ok: false, code: 'read-only' }),
    );
    expect(await writeMeasurements(projects, 'pkg', stored)).toMatchObject({ code: 'read-only' });
  });

  it('refuses a file saved by a newer build, and never writes over it', async () => {
    const { root, ipc } = setup();
    mkdirSync(join(root, 'survey'));
    const path = join(root, 'survey', 'measurements.json');
    writeFileSync(path, JSON.stringify({ schema: 'aio.measurements/9', measurements: [] }));
    const r = await ipc.call('survey:readMeasurements', { projectId: 'p' });
    expect(r.ok).toBe(false);
    const w = await ipc.call('survey:writeMeasurements', { projectId: 'p', file: file() });
    expect(w.ok).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      schema: 'aio.measurements/9',
      measurements: [],
    });
  });

  it('answers an invalid file with where it is wrong', async () => {
    const { root, ipc } = setup();
    mkdirSync(join(root, 'survey'));
    writeFileSync(
      join(root, 'survey', 'measurements.json'),
      JSON.stringify({ schema: 'aio.measurements/1', measurements: [{ id: 'm1' }] }),
    );
    const r = await ipc.call('survey:readMeasurements', { projectId: 'p' });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/measurements\.json is invalid at measurements\.0/);
  });

  it('answers an unknown project', async () => {
    const { ipc } = setup();
    expect(await ipc.call('survey:readMeasurements', { projectId: 'nope' })).toMatchObject({
      ok: false,
    });
  });
});

const signer = signerFromKey(generateKeyPairSync('ed25519').privateKey);
const identity: JournalIdentity = {
  actor: `a_${'r'.repeat(26)}`,
  name: 'Rana Example',
  initials: 'RE',
  device: { id: signer.device, publicKey: signer.publicKey },
  signer,
  app: { name: 'test-app', version: '0.11.0' },
};

describe('survey measurements in the journal', () => {
  it('records measurement.create, .patch and .delete per measurement, signed and intact', async () => {
    const { root, userData, projects } = setup();
    writeFileSync(
      join(root, 'manifest.json'),
      JSON.stringify({ schema: 'aio.project/1', layers: [] }),
    );
    const journal = createJournalService({
      userData,
      projects: { root: projects.root, package: (id) => id === 'pkg' },
      identity: () => Promise.resolve(identity),
      emitChanged: () => undefined,
      now: () => Date.UTC(2026, 9, 9, 9, 0, 0),
    });
    journals.push(journal);
    const ipc = collectHandlers((handle) => {
      registerSurveyIpc({
        handle: (channel, handler) => {
          handle(channel, journal.wrap(channel, handler));
        },
        projects,
        userData: () => userData,
      });
    });
    const open = journal.wrap('project:open', () =>
      Promise.resolve({ ok: true as const, id: 'p', root, manifest: {} as never, issues: [] }),
    );
    await open({ path: root });
    await journal.flush(root);

    const a = measurement('m1', 'Kerb');
    const b = measurement('m2', 'Pad edge');
    for (const f of [file(a, b), file({ ...a, label: 'Kerb line' }, b), file(b)]) {
      expect(await ipc.call('survey:writeMeasurements', { projectId: 'p', file: f })).toEqual({
        ok: true,
      });
    }
    const h = await journal.history({
      projectId: 'p',
      filter: { target: { rec: 'measurement', id: 'm1' } },
    });
    if (!h.ok) throw new Error(h.error);
    expect(h.entries.map((e) => e.kind)).toEqual([
      'measurement.delete',
      'measurement.patch',
      'measurement.create',
    ]);
    expect(h.entries[1]?.changes).toEqual([{ field: 'label', before: 'Kerb', after: 'Kerb line' }]);
    const v = await journal.verify('p');
    if (!v.ok) throw new Error(v.error);
    expect(v.report.problems).toEqual([]);
  });
});

describe('survey templates', () => {
  const tpl: SurveyTemplatesFile = {
    schema: 'aio.survey-templates/1',
    templates: [
      {
        id: 'pad-check',
        name: 'Pad check',
        family: 'polygon',
        tool: 'volume',
        items: ['cut', 'fill', 'net'],
        fields: [{ id: 'crew', name: 'Crew', type: 'dropdown', options: ['North', 'South'] }],
        comparisons: [],
        bookmarked: true,
      },
    ],
  };

  it('reads null for the project and an empty user library at first', async () => {
    const { ipc } = setup();
    expect(await ipc.call('survey:readTemplates', { projectId: 'p' })).toEqual({
      ok: true,
      project: null,
      user: emptySurveyTemplates(),
    });
    expect(await ipc.call('survey:readTemplates', {})).toEqual({
      ok: true,
      project: null,
      user: emptySurveyTemplates(),
    });
  });

  it('writes the project file and the user library separately', async () => {
    const { root, userData, ipc } = setup();
    expect(
      await ipc.call('survey:writeTemplates', { scope: 'project', projectId: 'p', file: tpl }),
    ).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(root, 'survey', 'templates.json'), 'utf8'))).toEqual(tpl);
    const user = { ...tpl, templates: [{ ...tpl.templates[0], id: 'mine', name: 'Mine' }] };
    expect(
      await ipc.call('survey:writeTemplates', { scope: 'user', file: user as SurveyTemplatesFile }),
    ).toEqual({ ok: true });
    expect(existsSync(join(userData, 'survey-templates.json'))).toBe(true);
    expect(await ipc.call('survey:readTemplates', { projectId: 'p' })).toEqual({
      ok: true,
      project: tpl,
      user,
    });
  });

  it('refuses project templates for a package and without a project', async () => {
    const { ipc } = setup({ 'survey/templates.json': tpl });
    expect(await ipc.call('survey:readTemplates', { projectId: 'pkg' })).toMatchObject({
      ok: true,
      project: tpl,
    });
    expect(
      await ipc.call('survey:writeTemplates', { scope: 'project', projectId: 'pkg', file: tpl }),
    ).toMatchObject({ ok: false, code: 'read-only' });
    expect(await ipc.call('survey:writeTemplates', { scope: 'project', file: tpl })).toMatchObject({
      ok: false,
    });
  });
});
