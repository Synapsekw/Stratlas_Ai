import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createExtract,
  extractArgs,
  findLatestBuild,
  latestBuildFrom,
  parseProgress,
  resolvePmtiles,
  type SpawnLike,
} from './pmtiles';

describe('extractArgs', () => {
  it('passes the area, zoom and a few download threads', () => {
    expect(
      extractArgs({
        source: 'https://build.protomaps.com/20261003.pmtiles',
        out: 'C:/p/.downloads/qatar.pmtiles.part',
        bbox: [50.74, 24.47, 51.65, 26.2],
        maxZoom: 12,
      }),
    ).toEqual([
      'extract',
      'https://build.protomaps.com/20261003.pmtiles',
      'C:/p/.downloads/qatar.pmtiles.part',
      '--maxzoom=12',
      '--bbox=50.74,24.47,51.65,26.2',
      '--download-threads=4',
    ]);
  });

  it('leaves out the box for the whole world', () => {
    const args = extractArgs({
      source: 's',
      out: 'o',
      bbox: [-180, -85.05, 180, 85.05],
      maxZoom: 6,
    });
    expect(args.some((a) => a.startsWith('--bbox'))).toBe(false);
  });
});

describe('parseProgress', () => {
  it('reads the last percentage of a progress bar line', () => {
    expect(parseProgress(' 12% |███        | (1.2/9.8 MB, 3.1 MB/s)\r 45% |█████')).toBe(0.45);
    expect(parseProgress('fetching directories')).toBeNull();
    expect(parseProgress('100% done')).toBe(1);
  });
});

function fakeSpawn(script: (child: FakeChild) => void, calls: { cmd: string; args: string[] }[]) {
  const spawn: SpawnLike = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new FakeChild();
    setTimeout(() => {
      script(child);
    }, 1);
    return child;
  };
  return spawn;
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
}

describe('createExtract', () => {
  it('runs the binary and reports progress', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const progress: number[] = [];
    const extract = createExtract(
      'C:/app/bin/pmtiles.exe',
      fakeSpawn((c) => {
        c.stderr.write(' 30% |███   |\r');
        c.stderr.write(' 80% |██████|\r');
        c.emit('exit', 0, null);
      }, calls),
    );
    await extract({
      source: 's',
      out: 'o',
      bbox: [1, 2, 3, 4],
      maxZoom: 5,
      signal: new AbortController().signal,
      onProgress: (p) => progress.push(p),
    });
    expect(calls[0]?.cmd).toBe('C:/app/bin/pmtiles.exe');
    expect(calls[0]?.args[0]).toBe('extract');
    expect(progress).toEqual([0.3, 0.8]);
  });

  it('fails with the tool output when it exits with an error', async () => {
    const extract = createExtract(
      'pmtiles',
      fakeSpawn((c) => {
        c.stderr.write('Failed to fetch header: 404 Not Found\n');
        c.emit('exit', 1, null);
      }, []),
    );
    await expect(
      extract({
        source: 's',
        out: 'o',
        bbox: [1, 2, 3, 4],
        maxZoom: 5,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(/404 Not Found/);
  });

  it('kills the tool when the download is cancelled', async () => {
    let child: FakeChild | undefined;
    const extract = createExtract('pmtiles', () => {
      child = new FakeChild();
      return child;
    });
    const ac = new AbortController();
    const done = extract({
      source: 's',
      out: 'o',
      bbox: [1, 2, 3, 4],
      maxZoom: 5,
      signal: ac.signal,
      onProgress: () => undefined,
    });
    ac.abort();
    await expect(done).rejects.toThrow(/cancelled/i);
    expect(child?.killed).toBe(true);
  });
});

describe('resolvePmtiles', () => {
  const exists = (set: string[]) => (p: string) => set.includes(p);

  it('prefers STRATLAS_PMTILES', () => {
    expect(
      resolvePmtiles({
        env: { STRATLAS_PMTILES: 'D:/tools/pmtiles.exe' },
        platform: 'win32',
        packaged: true,
        resourcesPath: 'C:/app/resources',
        appPath: 'C:/app',
        exists: exists(['D:/tools/pmtiles.exe']),
      }),
    ).toBe('D:/tools/pmtiles.exe');
  });

  it('uses the copy bundled in resources/bin when packaged', () => {
    const bundled = join('C:/app/resources', 'bin', 'pmtiles.exe');
    expect(
      resolvePmtiles({
        env: {},
        platform: 'win32',
        packaged: true,
        resourcesPath: 'C:/app/resources',
        appPath: 'C:/app',
        exists: exists([bundled]),
      }),
    ).toBe(bundled);
  });

  it('uses tools/maps/bin of the repository in development', () => {
    const dev = join('E:/repo', 'tools', 'maps', 'bin', 'pmtiles');
    expect(
      resolvePmtiles({
        env: {},
        platform: 'linux',
        packaged: false,
        resourcesPath: '/x',
        appPath: join('E:/repo', 'apps', 'desktop'),
        exists: exists([dev]),
      }),
    ).toBe(dev);
  });

  it('returns null when there is no binary', () => {
    expect(
      resolvePmtiles({
        env: {},
        platform: 'win32',
        packaged: false,
        resourcesPath: 'C:/r',
        appPath: 'C:/a',
        exists: () => false,
      }),
    ).toBeNull();
  });
});

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

  it('explains an unreachable build list', async () => {
    const fetchFn = () => Promise.resolve(new Response('busy', { status: 503 }));
    await expect(findLatestBuild(fetchFn, new AbortController().signal)).rejects.toThrow(/503/);
  });
});
