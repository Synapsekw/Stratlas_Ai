import { defaultSurveySettings, emptySurveyTemplates } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import { registerSurveyIpc } from './survey';

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
    // the site settings are G1's (geodesy.test.ts); with no project registry they refuse
    expect(await ipc.call('survey:readSettings', { projectId: 'p' })).toMatchObject({ ok: false });
    expect(
      await ipc.call('survey:writeSettings', { projectId: 'p', settings: defaultSurveySettings() }),
    ).toMatchObject({ ok: false });
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
