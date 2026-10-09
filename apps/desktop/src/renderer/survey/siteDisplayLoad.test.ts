// @vitest-environment jsdom
import { defaultSurveySettings, type ProjectManifest } from '@aio/schema';
import type { OpenProject } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';

const answers = { tables: false };
vi.mock('../shell', () => ({
  bridge: {
    call: (channel: string) =>
      Promise.resolve(
        channel === 'survey:readSettings'
          ? {
              ok: true,
              value: {
                ok: true,
                settings: defaultSurveySettings(),
                exists: false,
                tables: answers.tables,
              },
            }
          : { ok: false, error: `no ${channel}` },
      ),
  },
  useShell: () => undefined,
}));

const { loadSiteDisplay } = await import('./SiteSettings');

const project: OpenProject = {
  id: 'hcl',
  root: 'E:\\data\\projects\\hcl',
  manifest: {
    name: 'HCl',
    crs: { epsg: 32639 },
    origin: [316542, 2589075, 0],
  } as unknown as ProjectManifest,
};

const urlOf = (u: RequestInfo | URL): string =>
  typeof u === 'string' ? u : u instanceof URL ? u.href : u.url;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('site display on opening a project', () => {
  // @realdata HCl and Masafi failed on a console 404 for the tables every project before M11 lacks.
  it('asks for no readout tables a project does not have', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    );
    vi.stubGlobal('fetch', fetch);
    answers.tables = false;
    await loadSiteDisplay(project);
    expect(fetch.mock.calls.map(([url]) => urlOf(url))).not.toContainEqual(
      expect.stringContaining('site-transform.json'),
    );
  });

  it('reads the readout tables when the project has them', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    );
    vi.stubGlobal('fetch', fetch);
    answers.tables = true;
    await loadSiteDisplay(project);
    expect(fetch.mock.calls.map(([url]) => urlOf(url))).toContainEqual(
      expect.stringContaining('site-transform.json'),
    );
  });
});
