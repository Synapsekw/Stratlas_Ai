/**
 * The survey files main writes are journaled exactly once (M11 integration): the settings, the
 * calibration and a QA release append their own ops first (`appendEdits`) and the disk scan does
 * not follow those files; the terrain edits go through their wrapped writer. A later scan (open,
 * sync catch-up, a job ending) records none of them again as `record.external`.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signerFromKey } from '@aio/journal';
import {
  defaultSurveySettings,
  type JobRecord,
  type SiteCalibration,
  type SurveyQa,
  type TerrainEditsFile,
} from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { applyCalibration, writeSurveySettings } from './geodesy';
import { createJournalService, type JournalIdentity, type JournalService } from './journal';
import { releaseHold, writeTerrainEdits } from './surveyQa';

const signer = signerFromKey(generateKeyPairSync('ed25519').privateKey);
const identity: JournalIdentity = {
  actor: `a_${'s'.repeat(26)}`,
  name: 'Sami Example',
  initials: 'SE',
  device: { id: signer.device, publicKey: signer.publicKey },
  signer,
  app: { name: 'test-app', version: '0.9.0' },
};
const NOW = new Date('2026-10-09T08:00:00.000Z');

const dirs: string[] = [];
const journals: JournalService[] = [];
afterEach(async () => {
  await Promise.all(journals.splice(0).map((j) => j.closeAll()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(name: string) {
  const d = mkdtempSync(join(tmpdir(), `aio-survey-journal-${name}-`));
  dirs.push(d);
  return d;
}

const held: SurveyQa = {
  schema: 'aio.survey-qa/1',
  capture: 'c1',
  level: 'strict',
  status: 'hold',
  checkpoints: {
    count: 2,
    rmseM: 0.08,
    meanM: -0.07,
    maxAbsM: 0.15,
    points: [
      { name: 'CHK1', dz: 0.01 },
      { name: 'CHK6', dz: -0.15 },
    ],
  },
  hold: { at: NOW.toISOString(), reason: 'Checkpoint RMSE 8.0 cm is above the Strict limit.' },
  checkedAt: NOW.toISOString(),
};

const edits: TerrainEditsFile = {
  schema: 'aio.terrain-edits/1',
  edits: [
    {
      id: 'exc',
      kind: 'cleanup',
      surface: 's-d2',
      ring: [
        [0, 0],
        [8, 0],
        [8, 5],
      ],
      method: 'thin-plate',
      enabled: true,
      createdAt: NOW.toISOString(),
    },
  ],
};

const calibration: SiteCalibration = {
  schema: 'aio.site-calibration/1',
  id: 'cal-1',
  name: 'Site calibration',
  source: { format: 'pairs' },
  projection: { epsg: 32639 },
  horizontal: {
    originE: 500000,
    originN: 3000000,
    shiftE: -499000,
    shiftN: -2999000,
    rotationRad: 0.001,
    scale: 1.00001,
  },
  pairs: [
    { name: 'CP1', local: [1000, 1000, 10], grid: [3000000, 500000, 40], useH: true, useV: true },
  ],
  computedAt: NOW.toISOString(),
};

function setup() {
  const root = tmp('project');
  const userData = tmp('userdata');
  writeFileSync(join(root, 'issues.json'), JSON.stringify({ schema: 'aio.issues/1', issues: [] }));
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({ schema: 'aio.project/1', layers: [] }),
  );
  // a QA job's output: the survey is on hold
  mkdirSync(join(root, 'survey', 'qa'), { recursive: true });
  writeFileSync(join(root, 'survey', 'qa', 'c1.json'), JSON.stringify(held));
  const journal = createJournalService({
    userData,
    projects: { root: (id) => (id === 'p' ? root : undefined), package: () => false },
    identity: () => Promise.resolve(identity),
    now: () => Date.UTC(2026, 9, 9, 8, 0, 0),
  });
  journals.push(journal);
  const appendEdits = (r: string, drafts: Parameters<JournalService['appendEdits']>[1]) =>
    journal.appendEdits(r, drafts);
  const open = journal.wrap('project:open', () =>
    Promise.resolve({ ok: true as const, id: 'p', root, manifest: {} as never, issues: [] }),
  );
  const writeEdits = journal.wrap('survey:writeTerrainEdits', ({ file }) =>
    writeTerrainEdits(root, file),
  );
  const kinds = async () => {
    const h = await journal.history({ projectId: 'p' });
    if (!h.ok) throw new Error(h.error);
    return h.entries.map((e) => e.kind).reverse();
  };
  return { root, journal, appendEdits, open, writeEdits, kinds };
}

describe('survey writes in the journal', () => {
  it('records a settings write, a calibration, a QA release and terrain edits once each', async () => {
    const s = setup();
    await s.open({ path: s.root });
    await s.journal.flush(s.root);
    expect(await s.kinds()).toEqual([]);

    const settings = {
      ...defaultSurveySettings(),
      units: { ...defaultSurveySettings().units, distance: 'us-ft' as const },
    };
    expect(await writeSurveySettings(s.root, settings, s.appendEdits)).toEqual({ ok: true });
    expect(await s.kinds()).toEqual(['survey.settings']);

    const applied = await applyCalibration(
      s.root,
      { projectId: 'p', calibration, apply: true },
      { journal: s.appendEdits, user: 'Sami', now: NOW },
    );
    expect(applied).toEqual({ ok: true });
    expect(await s.kinds()).toEqual(['survey.settings', 'survey.calibration', 'survey.settings']);

    const released = await releaseHold(
      s.root,
      { capture: 'c1', note: 'Checked on site with the rover.' },
      { journal: s.appendEdits, user: 'Sami', now: NOW },
    );
    expect(released.ok).toBe(true);
    expect((await s.kinds()).slice(3)).toEqual(['survey.hold']);

    expect(await s.writeEdits({ projectId: 'p', file: edits })).toEqual({ ok: true });
    const written = await s.kinds();
    expect(written.slice(4)).toEqual(['record.external']);

    // the scans after: on open, before a sync, when a job ends
    await s.open({ path: s.root });
    await s.journal.flush(s.root);
    await s.journal.catchUp(s.root);
    const job = {
      id: 'job-qa',
      pipeline: 'survey.qa',
      project: s.root,
      params: {},
      status: 'running',
      progress: 0,
      steps: [],
      artifacts: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    } as unknown as JobRecord;
    await s.journal.jobEvent({ type: 'update', job });
    await s.journal.jobEvent({ type: 'update', job: { ...job, status: 'done' } });
    expect(await s.kinds()).toEqual(written);
    expect(written.filter((k) => k === 'record.external')).toHaveLength(1);
  });

  it('appends no survey ops while the history is switched off', async () => {
    const s = setup();
    await s.open({ path: s.root });
    await s.journal.flush(s.root);
    expect(await s.journal.setJournal('p', false)).toEqual({ ok: true });
    expect(await writeSurveySettings(s.root, defaultSurveySettings(), s.appendEdits)).toEqual({
      ok: true,
    });
    expect(await s.kinds()).toEqual(['journal.off']);
  });
});
