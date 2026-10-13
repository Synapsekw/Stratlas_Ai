import type { Layer } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_JOBS,
  OUTSIDE,
  RUN_DONE,
  RUN_FAILED,
  RUN_FOLDERS,
  makeRemoveProject,
} from './removeFixture';
import { readManifestFile, writeManifestFile } from './create';
import { namesAny, ownedPaths, planRemoval, valuesUnder } from './removePlan';

let dir: string;
let root: string;
beforeEach(async () => {
  ({ dir, root } = await makeRemoveProject());
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id).sort();
const put = async (rel: string, text = 'x') => {
  const f = join(root, ...rel.split('/'));
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, text);
};
const photos = (id: string, paths: string[]): Layer => ({
  kind: 'photos',
  id,
  name: id,
  visible: true,
  items: paths.map((path, i) => ({ id: `${id}-${String(i)}`, src: { path } })),
});
const addLayers = async (...layers: Layer[]) => {
  const m = await readManifestFile(root);
  await writeManifestFile(root, { ...m, layers: [...m.layers, ...layers] });
};

describe('planRemoval', () => {
  it('a photos layer takes its runs, their layers by outputs and by id, the comparison, tilesets, surfaces, detections and jobs', async () => {
    const p = await planRemoval(root, [{ layer: 'photos-a' }], { jobs: FIXTURE_JOBS });
    expect(p.refused).toBeUndefined();
    expect(ids(p.runs)).toEqual([RUN_DONE, RUN_FAILED].sort());
    expect(ids(p.layers)).toEqual(
      [
        'chg-1-heat',
        'photos-a',
        `${RUN_DONE}-dsm`,
        `${RUN_DONE}-ortho`,
        `${RUN_FAILED}-ortho`,
      ].sort(),
    );
    // the failed run never listed it: found by the <run>-ortho convention
    expect(p.layers.find((l) => l.id === `${RUN_FAILED}-ortho`)?.why).toEqual({
      madeBy: RUN_FAILED,
    });
    expect(p.runs.find((r) => r.id === RUN_DONE)?.why).toEqual({ usedBy: 'photos-a' });
    expect(ids(p.changes)).toEqual(['chg-1']);
    expect(p.changes[0]?.name).toBe('2026-10-12 to 2026-10-26');
    expect([...p.tilesets].sort()).toEqual([`${RUN_DONE}-mesh`, 'dsm-tiles']);
    expect([...p.surfaces].sort()).toEqual(['s-a', 's-a-clean']);
    expect(p.detections).toEqual(['detections/pass-1.json']);
    expect([...p.jobs].sort()).toEqual(['job-done', 'job-failed']);
    expect(p.files).toEqual(
      expect.arrayContaining([
        `photogrammetry/${RUN_DONE}`,
        `photogrammetry/${RUN_FAILED}`,
        `rasters/${RUN_FAILED}-ortho`,
        `rasters/${RUN_DONE}-dsm`,
        `sources/${RUN_DONE}-ortho.json`,
        'photos/p1.jpg',
        'photos/p2.jpg',
        'photos/thumbs/p1.jpg',
        'change/chg-1.json',
        'change/chg-1',
        'tiles/dsm-tiles',
        `tiles/${RUN_DONE}-mesh`,
        'survey/surfaces/s-a',
        'survey/surfaces/s-a-clean',
        'detections/pass-1.json',
        'jobs/job-failed',
        'jobs/job-done',
      ]),
    );
    expect(p.files).not.toContain('rasters/dsm-b');
    expect(p.files).not.toContain('photos/thumbs/p2.jpg'); // never there
    expect(p.touches).toEqual({ issues: 1, walkPins: 0 });
    expect(p.bytes).toBeGreaterThan(0);
  });

  it("a date takes its layers and the comparison into another date, and that date's layers stay", async () => {
    const p = await planRemoval(root, [{ capture: 'c1' }]);
    expect(p.captures).toEqual(['c1']);
    expect(p.layers.find((l) => l.id === 'photos-a')?.why).toEqual({ filedUnder: 'c1' });
    expect(ids(p.changes)).toEqual(['chg-1']);
    expect(ids(p.layers)).toContain('chg-1-heat');
    expect(ids(p.layers)).not.toContain('dsm-b');
    expect(p.surfaces).not.toContain('s-b');
    expect(p.tilesets).not.toContain('b-tiles');
    expect(p.captures).not.toContain('c2');
  });

  it('keeps a date that a volume names, and says so', async () => {
    const p = await planRemoval(root, [{ capture: 'c3' }]);
    expect(ids(p.layers)).toEqual(['dsm-c']);
    expect(p.captures).toEqual([]);
    expect(p.keptCaptures).toEqual([{ id: 'c3', by: 'volume' }]);
  });

  it('never lists the folders a run reads in place', async () => {
    const p = await planRemoval(root, [{ run: RUN_FOLDERS }]);
    expect(p.files).toEqual([`photogrammetry/${RUN_FOLDERS}`]);
    expect(p.keptOutside).toEqual([OUTSIDE]);
  });

  it('does not move a file another remaining layer names', async () => {
    expect((await planRemoval(root, [{ layer: 'mesh-a' }])).files).toEqual([]);
    const clip = await planRemoval(root, [{ layer: 'clip-1' }]);
    expect(clip.files).toEqual(['video/clip-1.mp4']);
  });

  it('removes a layer whose files are already gone', async () => {
    await rm(join(root, 'rasters', 'dsm-c'), { recursive: true });
    const p = await planRemoval(root, [{ layer: 'dsm-c' }]);
    expect(ids(p.layers)).toEqual(['dsm-c']);
    expect(p.files).toEqual([]);
  });

  it('lists a run folder without a readable run.json by its folder name', async () => {
    await writeFile(join(root, 'photogrammetry', RUN_FAILED, 'run.json'), 'not json');
    const p = await planRemoval(root, [{ run: RUN_FAILED }]);
    expect(p.runs).toEqual([{ id: RUN_FAILED, status: null, why: 'asked' }]);
    expect(p.files).toContain(`photogrammetry/${RUN_FAILED}`);
    expect(ids(p.layers)).toEqual([`${RUN_FAILED}-ortho`]);
  });

  it('refuses while a job of a removed run is live, naming it', async () => {
    const jobs = [
      { id: 'j1', pipeline: 'photo.products', status: 'running', params: { run: RUN_DONE } },
    ];
    const p = await planRemoval(root, [{ layer: 'photos-a' }], { jobs });
    expect(p.refused).toBe(`Creating maps for run ${RUN_DONE} is still running. Cancel it first.`);
    expect(p.files).toEqual([]);
  });

  it('refuses while a live job names a removed layer deep in its params', async () => {
    const jobs = [
      {
        id: 'j2',
        pipeline: 'change.raster',
        status: 'cancelling',
        params: { pair: { layerFrom: 'dsm-b' } },
      },
    ];
    const p = await planRemoval(root, [{ layer: 'dsm-b' }], { jobs });
    expect(p.refused).toMatch(/still running\. Cancel it first\./);
  });

  it('refuses while walk.process runs on a removed walk, naming the walk', async () => {
    await addLayers({
      kind: 'walk',
      id: 'walk-w1',
      name: 'Morning walk',
      visible: true,
      record: { path: 'walks/w1/walk.json' },
      src: { path: 'walks/w1/playback.mp4' },
      durationS: 10,
    });
    const job = { id: 'j3', pipeline: 'walk.process', status: 'running', params: { walk: 'w1' } };
    const p = await planRemoval(root, [{ layer: 'walk-w1' }], { jobs: [job] });
    expect(p.refused).toBe(
      'Processing the walk uses "Morning walk" and is still running. Cancel it first.',
    );
    const other = [{ ...job, params: { walk: 'w2' } }];
    expect((await planRemoval(root, [{ layer: 'walk-w1' }], { jobs: other })).refused).toBe(
      undefined,
    );
  });

  it('a finished job never refuses', async () => {
    const p = await planRemoval(root, [{ layer: 'photos-a' }], { jobs: FIXTURE_JOBS });
    expect(p.refused).toBeUndefined();
  });

  it('refuses a package and an unknown target', async () => {
    const pkg = 'This project is a read-only package. Nothing can be added or changed.';
    expect((await planRemoval(root, [{ layer: 'photos-a' }], { readOnly: pkg })).refused).toBe(pkg);
    expect((await planRemoval(root, [{ layer: 'nope' }])).refused).toBe(
      'There is no dataset "nope" in this project.',
    );
    expect((await planRemoval(root, [{ run: 'nope' }])).refused).toMatch(/no run "nope"/);
    expect((await planRemoval(root, [{ capture: 'nope' }])).refused).toMatch(/no survey date/);
  });

  it('refuses a run id that is not a plain folder name, before it reaches the disk', async () => {
    // a run folder one level up, which '../x' would name if it were joined
    await writeFile(join(dir, 'run.json'), JSON.stringify({ id: 'x', status: 'failed' }));
    for (const run of ['../x', 'a/b', '..', `${RUN_FAILED}/../${RUN_DONE}`]) {
      const p = await planRemoval(root, [{ run }]);
      expect(p.refused).toBe(`There is no run "${run}" in this project.`);
      expect(p.runs).toEqual([]);
      expect(p.files).toEqual([]);
    }
  });

  it('refuses a path that leads outside the project through a junction', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'aio-outside-'));
    try {
      await writeFile(join(outside, 'precious.tif'), 'keep');
      await rm(join(root, 'rasters', 'dsm-b'), { recursive: true });
      await symlink(outside, join(root, 'rasters', 'dsm-b'), 'junction');
      const p = await planRemoval(root, [{ layer: 'dsm-b' }]);
      expect(p.refused).toMatch(/rasters\/dsm-b" leads outside the project folder/);
      expect(p.files).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('what a layer owns', () => {
  // an undated raw import names its photos layer `photos`, items at `photos/<file>`
  it('a photos layer named like its top-level folder owns only its items and thumbs', async () => {
    await addLayers(photos('photos', ['photos/a.jpg', 'photos/b.jpg']));
    for (const f of ['photos/a.jpg', 'photos/b.jpg', 'photos/thumbs/a.jpg', 'photos/masks/x.png'])
      await put(f);
    const p = await planRemoval(root, [{ layer: 'photos' }]);
    expect(p.refused).toBeUndefined();
    expect([...p.files].sort()).toEqual(['photos/a.jpg', 'photos/b.jpg', 'photos/thumbs/a.jpg']);
  });

  it('two photos layers in the same folder each take exactly their own items', async () => {
    await addLayers(photos('photos', ['photos/a.jpg']), photos('photos-2', ['photos/c.jpg']));
    for (const f of ['photos/a.jpg', 'photos/c.jpg']) await put(f);
    expect((await planRemoval(root, [{ layer: 'photos' }])).files).toEqual(['photos/a.jpg']);
    expect((await planRemoval(root, [{ layer: 'photos-2' }])).files).toEqual(['photos/c.jpg']);
  });

  it('never owns a top-level folder', () => {
    expect(ownedPaths(photos('photos', ['photos/a.jpg']))).toEqual([
      'photos/a.jpg',
      'photos/thumbs/a.jpg',
    ]);
  });

  // Windows paths are case-insensitive: `Photos/a.jpg` and `photos/a.jpg` are one file
  it.runIf(process.platform === 'win32')(
    'keeps a file a remaining layer names in other letter case',
    async () => {
      await addLayers(photos('gone', ['photos/a.jpg']), photos('stays', ['Photos/a.jpg']));
      await put('photos/a.jpg');
      const p = await planRemoval(root, [{ layer: 'gone' }]);
      expect(ids(p.layers)).toEqual(['gone']);
      expect(p.files).toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'never moves a hash asset named in other letter case',
    async () => {
      await addLayers(photos('hashed', ['Assets/sha256/x']));
      await put('assets/sha256/x');
      const p = await planRemoval(root, [{ layer: 'hashed' }]);
      expect(ids(p.layers)).toEqual(['hashed']);
      expect(p.files).toEqual([]);
    },
  );

  it('refuses a tileset whose src climbs out of the project, before it looks at the disk', async () => {
    const outside = join(root, '..', 'outside', 'tileset.json');
    await mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, 'keep');
    try {
      const doc = JSON.parse(await readFile(join(root, 'tilesets.json'), 'utf8')) as {
        entries: unknown[];
      };
      doc.entries.push({
        id: 'c-tiles',
        name: 'c-tiles',
        kind: 'mesh',
        src: '../outside/tileset.json',
        visible: true,
        from: 'dsm-c',
      });
      await writeFile(join(root, 'tilesets.json'), JSON.stringify(doc));
      const p = await planRemoval(root, [{ layer: 'dsm-c' }]);
      expect(p.refused).toBe(
        '"../outside/tileset.json" leads outside the project folder (a link or junction). Nothing was removed.',
      );
      expect(p.files).toEqual([]);
      expect(p.tilesets).toEqual([]);
      expect(await readFile(outside, 'utf8')).toBe('keep');
    } finally {
      await rm(dirname(outside), { recursive: true, force: true });
    }
  });
});

describe('helpers', () => {
  it('owns a folder named after the layer, else the file, plus thumbs and sources', () => {
    expect(
      ownedPaths({
        kind: 'raster',
        id: 'r-ortho',
        name: 'r',
        visible: true,
        src: { path: 'rasters/r-ortho/tiles.json' },
        role: 'ortho',
        format: 'kit-pyramid',
      }),
    ).toEqual(['rasters/r-ortho', 'sources/r-ortho.json']);
    expect(
      ownedPaths({
        kind: 'photos',
        id: 'ph',
        name: 'p',
        visible: true,
        items: [
          { id: 'a', src: { path: 'photos/a.JPG' } },
          { id: 'h', src: { hash: 'a'.repeat(64) } },
        ],
      }),
    ).toEqual(['photos/a.JPG', 'photos/thumbs/a.jpg']);
  });

  it('finds layer names deep in change items and job params', () => {
    expect([
      ...valuesUnder(
        { items: [{ a: { layer: 'x' } }, { layerTo: 'y' }] },
        new Set(['layer', 'layerTo']),
      ),
    ]).toEqual(['x', 'y']);
    expect(namesAny({ p: [{ q: 'dsm-b' }] }, new Set(['dsm-b']))).toBe('dsm-b');
    expect(namesAny({ p: 3 }, new Set(['dsm-b']))).toBeNull();
  });
});
