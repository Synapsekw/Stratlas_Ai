import { defaultSurveySettings, emptySurveyTemplates } from '@aio/schema';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import { listSurfaces, registerSurveyIpc } from './survey';

describe('survey IPC (G0 stubs)', () => {
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

describe('survey:surfaces (G2)', () => {
  const tiles = (id: string) => ({
    schema: 'aio.height-tiles/1',
    id,
    name: `DSM ${id}`,
    source: { kind: 'dsm', layer: 'dsm' },
    crs: { epsg: 32631 },
    cellM: 0.1,
    tileSize: 256,
    originE: 302000,
    originN: 2574000,
    cols: 1,
    rows: 1,
    levels: 1,
    bounds: [302000, 2574000, 100, 302025.6, 2574025.6, 104],
    tiles: ['0_0'],
    fingerprint: `fp-${id}`,
    preparedAt: '2026-10-09T00:00:00Z',
  });

  it('lists the prepared surfaces of an open project, sorted, leaving out unfinished ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quadrion-surfaces-'));
    for (const id of ['b', 'a']) {
      await mkdir(join(root, 'survey', 'surfaces', id), { recursive: true });
      await writeFile(
        join(root, 'survey', 'surfaces', id, 'tiles.json'),
        JSON.stringify(tiles(id)),
      );
    }
    await mkdir(join(root, 'survey', 'surfaces', 'busy'), { recursive: true });
    await mkdir(join(root, 'survey', 'surfaces', 'bad'), { recursive: true });
    await writeFile(
      join(root, 'survey', 'surfaces', 'bad', 'tiles.json'),
      '{"schema":"aio.height-tiles/9"}',
    );
    const ipc = collectHandlers((handle) => {
      registerSurveyIpc({
        handle,
        registry: { root: (id) => (id === 'p' ? root : undefined), package: () => undefined },
      });
    });
    const r = await ipc.call('survey:surfaces', { projectId: 'p' });
    expect(r.ok && r.surfaces.map((s) => s.id)).toEqual(['a', 'b']);
    expect(await ipc.call('survey:surfaces', { projectId: 'q' })).toMatchObject({ ok: false });
  });

  it('answers an empty list for a project without surfaces, and reads a package in place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quadrion-surfaces-'));
    expect(await listSurfaces({ root })).toEqual({ ok: true, surfaces: [] });
    const files = new Map([
      ['survey/surfaces/s1/tiles.json', JSON.stringify(tiles('s1'))],
      ['survey/surfaces/s1/0/0_0.bin', 'x'],
    ]);
    const archive = {
      entries: files,
      read: (k: string) => Promise.resolve(Buffer.from(files.get(k) ?? '')),
    };
    const r = await listSurfaces({ archive });
    expect(r.ok && r.surfaces.map((s) => s.id)).toEqual(['s1']);
  });
});
