import type { DraftOp } from '@aio/journal';
import { defaultSurveySettings, type SiteCalibration } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalogueFile, registerGeodesyIpc, settingsPatch } from './geodesy';
import { collectHandlers } from './notYet';
import { registerSurveyIpc } from './survey';

const CATALOGUE = fileURLToPath(
  new URL('../../../../packages/geo/src/catalogue/epsg.json.gz', import.meta.url),
);

const NOW = new Date('2026-10-09T08:00:00.000Z');

function calibration(): SiteCalibration {
  return {
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
}

describe('geodesy IPC', () => {
  let root = '';
  const ops: DraftOp[] = [];
  let ipc: ReturnType<typeof collectHandlers>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'geodesy-'));
    const deps = {
      projects: {
        root: (id: string) => (id === 'p' ? root : undefined),
        package: (id: string) => (id === 'pkg' ? {} : undefined),
      },
      journal: (_root: string, drafts: readonly DraftOp[]) => {
        ops.push(...drafts);
        return Promise.resolve();
      },
      catalogue: () => loadCatalogueFile(CATALOGUE),
      user: () => 'Surveyor',
      now: () => NOW,
    };
    ipc = collectHandlers((handle) => {
      registerGeodesyIpc({ handle, ...deps });
      registerSurveyIpc({ handle, ...deps });
    });
  });

  const readSettingsFile = async () =>
    JSON.parse(await readFile(join(root, 'survey', 'settings.json'), 'utf8')) as {
      calibration?: string;
      crs?: unknown;
    };

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('searches the EPSG catalogue by name, near a site', async () => {
    const r = await ipc.call('geodesy:searchCrs', {
      query: 'UTM 39N',
      near: [51.5, 25.3],
      limit: 20,
    });
    expect(r.ok && r.results[0]?.code).toBe(32639);
    const code = await ipc.call('geodesy:searchCrs', { query: 'EPSG:2240', kinds: ['projected'] });
    expect(code.ok && code.results.map((e) => e.unit)).toEqual(['US survey foot']);
  });

  it('reads the default site settings, writes them journaled and reads them back', async () => {
    const first = await ipc.call('survey:readSettings', { projectId: 'p' });
    expect(first).toMatchObject({ ok: true, exists: false });
    const settings = {
      ...defaultSurveySettings(),
      units: { ...defaultSurveySettings().units, distance: 'us-ft' as const },
      crs: { epsg: 2240 },
    };
    expect(await ipc.call('survey:writeSettings', { projectId: 'p', settings })).toEqual({
      ok: true,
    });
    const op = ops.at(-1);
    expect(op?.kind).toBe('survey.settings');
    expect(op?.payload).toMatchObject({ set: { 'units.distance': 'us-ft', 'crs.epsg': 2240 } });
    const back = await ipc.call('survey:readSettings', { projectId: 'p' });
    expect(back).toMatchObject({ ok: true, exists: true, settings: { crs: { epsg: 2240 } } });
  });

  // A project from before M11 has no readout tables: the renderer must not ask for them (each
  // aio:// 404 is a console error; every real project failed its @realdata check).
  it('says whether the site readout tables exist', async () => {
    const before = await ipc.call('survey:readSettings', { projectId: 'p' });
    expect(before).toMatchObject({ ok: true, tables: false });
    await mkdir(join(root, 'survey', 'geodesy'), { recursive: true });
    await writeFile(join(root, 'survey', 'geodesy', 'site-transform.json'), '{}');
    const after = await ipc.call('survey:readSettings', { projectId: 'p' });
    expect(after).toMatchObject({ ok: true, tables: true });
    await rm(join(root, 'survey', 'geodesy'), { recursive: true, force: true });
  });

  it('applies a confirmed calibration: journaled, then the files', async () => {
    expect(await ipc.call('geodesy:readCalibration', { projectId: 'p' })).toEqual({
      ok: true,
      calibration: null,
    });
    const n = ops.length;
    expect(
      await ipc.call('geodesy:applyCalibration', {
        projectId: 'p',
        calibration: calibration(),
        apply: true,
      }),
    ).toEqual({ ok: true });
    expect(ops.slice(n).map((o) => o.kind)).toEqual(['survey.calibration', 'survey.settings']);
    const cal = await ipc.call('geodesy:readCalibration', { projectId: 'p' });
    expect(cal).toMatchObject({
      ok: true,
      calibration: { id: 'cal-1', appliedAt: NOW.toISOString(), appliedBy: 'Surveyor' },
    });
    const settings = await readSettingsFile();
    expect(settings.calibration).toBe('cal-1');
    expect(settings.crs).toEqual({ epsg: 2240 });

    // removing it keeps the draft and clears the setting
    expect(
      await ipc.call('geodesy:applyCalibration', {
        projectId: 'p',
        calibration: calibration(),
        apply: false,
      }),
    ).toEqual({ ok: true });
    const draft = await ipc.call('geodesy:readCalibration', { projectId: 'p' });
    expect(draft.ok && draft.calibration?.appliedAt).toBeUndefined();
    const after = await readSettingsFile();
    expect(after.calibration).toBeUndefined();
  });

  it('refuses packages and empty calibrations', async () => {
    expect(
      await ipc.call('geodesy:applyCalibration', {
        projectId: 'pkg',
        calibration: calibration(),
        apply: true,
      }),
    ).toMatchObject({ ok: false, code: 'read-only' });
    expect(
      await ipc.call('survey:writeSettings', {
        projectId: 'pkg',
        settings: defaultSurveySettings(),
      }),
    ).toMatchObject({ ok: false, code: 'read-only' });
    const bare = calibration();
    delete bare.horizontal;
    expect(
      await ipc.call('geodesy:applyCalibration', {
        projectId: 'p',
        calibration: bare,
        apply: true,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('settingsPatch', () => {
  it('lists set, unset and the values before as dotted paths', () => {
    expect(settingsPatch({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: [1] })).toEqual({
      set: { 'b.c': 3, d: [1] },
      was: { 'b.c': 2 },
    });
    expect(settingsPatch({ a: 1, x: 2 }, { a: 1 })).toEqual({ unset: ['x'], was: { x: 2 } });
    expect(settingsPatch({ a: 1 }, { a: 1 })).toBeNull();
  });
});
