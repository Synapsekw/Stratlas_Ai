import { describe, expect, it } from 'vitest';
import { buildSource, findLatestBuild, latestBuildFrom } from './pmtiles';

describe('latestBuildFrom', () => {
  it('picks the newest dated planet build', () => {
    expect(
      latestBuildFrom([
        { key: '20261001.pmtiles' },
        { key: '20261003.pmtiles' },
        { key: 'notes.txt' },
        { key: '20261002.pmtiles' },
      ]),
    ).toBe('20261003');
  });

  it('fails on an unexpected answer', () => {
    expect(() => latestBuildFrom({ builds: [] })).toThrow(/planet build/);
    expect(() => latestBuildFrom([])).toThrow(/planet build/);
  });
});

describe('findLatestBuild', () => {
  it('takes the newest build that is actually published', async () => {
    const asked: string[] = [];
    const fetchFn = (url: string, init?: { method?: string }) => {
      asked.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('builds.json'))
        return Promise.resolve(
          new Response(JSON.stringify([{ key: '20261002.pmtiles' }, { key: '20261003.pmtiles' }])),
        );
      return Promise.resolve(new Response(null, { status: url.includes('20261003') ? 404 : 200 }));
    };
    expect(await findLatestBuild(fetchFn, new AbortController().signal)).toBe('20261002');
    expect(asked).toEqual([
      'GET https://build-metadata.protomaps.dev/builds.json',
      'HEAD https://build.protomaps.com/20261003.pmtiles',
      'HEAD https://build.protomaps.com/20261002.pmtiles',
    ]);
  });

  it('asks a mirror when one is given', async () => {
    const asked: string[] = [];
    const fetchFn = (url: string) => {
      asked.push(url);
      return Promise.resolve(
        new Response(url.endsWith('.json') ? JSON.stringify([{ key: '20261003.pmtiles' }]) : null),
      );
    };
    const where = buildSource({ STRATLAS_PACK_SOURCE: 'http://127.0.0.1:4100/' });
    expect(await findLatestBuild(fetchFn, new AbortController().signal, where)).toBe('20261003');
    expect(asked).toEqual([
      'http://127.0.0.1:4100/builds.json',
      'http://127.0.0.1:4100/20261003.pmtiles',
    ]);
  });

  it('explains an unreachable build list', async () => {
    const fetchFn = () => Promise.resolve(new Response('busy', { status: 503 }));
    await expect(findLatestBuild(fetchFn, new AbortController().signal)).rejects.toThrow(/503/);
  });
});

describe('buildSource', () => {
  it('uses Protomaps unless a mirror is configured', () => {
    expect(buildSource({})).toEqual({
      index: 'https://build-metadata.protomaps.dev/builds.json',
      base: 'https://build.protomaps.com/',
    });
    expect(buildSource({ STRATLAS_PACK_SOURCE: 'http://127.0.0.1:4100/builds' })).toEqual({
      index: 'http://127.0.0.1:4100/builds/builds.json',
      base: 'http://127.0.0.1:4100/builds/',
    });
    expect(buildSource({ STRATLAS_PACK_SOURCE: 'file:///etc' }).base).toBe(
      'https://build.protomaps.com/',
    );
  });
});
