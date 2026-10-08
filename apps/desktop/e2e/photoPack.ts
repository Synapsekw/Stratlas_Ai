/**
 * The photo processing harness of the Process photos specs (M10 G4):
 *
 * - `buildPhotoPack(dir)`: a throwaway pipeline pack (`QUADRION_PIPELINE_PACK`) whose Python is a
 *   venv over the development one, with `photo-fake/aio_photo_fake.py` swapped in for the photo
 *   pipelines: the app's side of processing (wizard, run panel, marking, reports, refined poses)
 *   end to end in seconds. The real pipelines run in `photo-real.spec.ts` on G8's synthetic set,
 *   where this machine has their native tools (`missingRealPhotoTools`).
 * - `writePhotoProject(dataRoot)`: `projects/e2e-photos/`, a fictional site in UTM 39N with a
 *   photos layer of twelve nadir photos (rendered by Pillow: noise ground and checker targets at
 *   the six ground control points), and the GCP CSV (`GCP1`-`GCP4` and `GCP6` control, `GCP5`
 *   check; the fake adjustment treats `GCP6` as the planted 1 m outlier).
 *
 * Synthetic data only: no client file, place or camera.
 */
import { envVar } from '@aio/brand/env';
import { toWgs84 } from '@aio/geo';
import { ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import type { Fixtures, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, VENV_PYTHON, type DataRoot } from './fixtures';

export const PHOTO_PROJECT = { id: 'e2e-photos', name: 'E2E photo site' } as const;
export const PHOTO_SIZE: [number, number] = [800, 600];
export const PHOTO_HFOV = 70;
const ORIGIN: [number, number, number] = [400000, 3250000, 0];
const ALTITUDE = 60;
/** Nadir camera: looking down (-Y), image up to the north (-Z). */
const NADIR: [number, number, number, number] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/** Control and check points in the local frame (x east, y up, z south), on the ground. */
export const GCPS: { id: string; role: 'control' | 'check'; local: [number, number, number] }[] = [
  { id: 'GCP1', role: 'control', local: [-20, 0, -15] },
  { id: 'GCP2', role: 'control', local: [20, 0, -15] },
  { id: 'GCP3', role: 'control', local: [20, 0, 15] },
  { id: 'GCP4', role: 'control', local: [-20, 0, 15] },
  { id: 'GCP5', role: 'check', local: [0, 0, 0] },
  { id: 'GCP6', role: 'control', local: [8, 0, 6] },
];

/** The photos: a 4 x 3 grid 25 m apart at 60 m. */
export const CAMERAS = Array.from({ length: 12 }, (_, i) => {
  const col = i % 4;
  const row = Math.floor(i / 4);
  return {
    id: `img-${String(i + 1).padStart(4, '0')}`,
    file: `IMG_${String(i + 1).padStart(4, '0')}.JPG`,
    pos: [-37.5 + col * 25, ALTITUDE, -25 + row * 25] as [number, number, number],
  };
});

/** Where a ground point appears in a nadir photo (pinhole, pixels, y down), or null outside. */
export function expectedPixel(
  cam: { pos: [number, number, number] },
  p: [number, number, number],
): [number, number] | null {
  const [w, h] = PHOTO_SIZE;
  const f = w / 2 / Math.tan((PHOTO_HFOV * Math.PI) / 360);
  const depth = cam.pos[1] - p[1];
  const x = w / 2 + (f * (p[0] - cam.pos[0])) / depth;
  const y = h / 2 + (f * (p[2] - cam.pos[2])) / depth;
  return x >= 0 && y >= 0 && x <= w && y <= h ? [x, y] : null;
}

const python = (exe: string, code: string, args: string[] = []) =>
  execFileSync(exe, ['-c', code, ...args], { encoding: 'utf8' }).trim();

/**
 * `QUADRION_E2E_PHOTO_REAL=1`: the real photo pipelines must run (`photo-real.spec.ts` fails
 * instead of skipping when a tool is missing). The stand-in specs always use the stand-ins: their
 * Pillow photos are independent noise that no real matcher can align.
 */
export const PHOTO_REAL = envVar(process.env, 'E2E_PHOTO_REAL') === '1';

const imports = (exe: string, module: string): boolean => {
  if (!existsSync(exe)) return false;
  try {
    execFileSync(exe, ['-c', `import ${module}`], { stdio: 'ignore', timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
};

/**
 * The Python whose `pycolmap` runs G2's structure from motion: `AIO_COLMAP_PYTHON` when set,
 * else the development Python, which has COLMAP's PyPI wheel after `uv sync`; null when this
 * machine has none.
 */
export function colmapPython(): string | null {
  const env = process.env.AIO_COLMAP_PYTHON;
  if (env && imports(env, 'pycolmap')) return env;
  return imports(VENV_PYTHON, 'pycolmap') ? VENV_PYTHON : null;
}

/**
 * What the real photo pipelines need that this machine lacks, in words, or null when all is
 * here: the development Python, and the COLMAP engine of `photo.align` (pycolmap). PDAL, OpenCV
 * and MeshLab are optional (photo.products falls back to its own numpy engines).
 */
export function missingRealPhotoTools(): string | null {
  const missing: string[] = [];
  if (!existsSync(VENV_PYTHON)) missing.push(`the pipeline Python (${VENV_PYTHON})`);
  else if (!colmapPython())
    missing.push(
      'the COLMAP engine of photo.align (pycolmap: run uv sync --frozen in python/, or set AIO_COLMAP_PYTHON)',
    );
  return missing.length ? missing.join('; ') : null;
}

/** Build the throwaway pack in `dir`; answers the app environment that selects it. */
export async function buildPhotoPack(dir: string): Promise<Record<string, string>> {
  const venv = join(dir, 'venv');
  execFileSync(VENV_PYTHON, ['-m', 'venv', '--without-pip', venv]);
  const exe =
    process.platform === 'win32'
      ? join(venv, 'Scripts', 'python.exe')
      : join(venv, 'bin', 'python');
  const purelib = 'import sysconfig; print(sysconfig.get_paths()["purelib"])';
  const devSite = python(VENV_PYTHON, purelib);
  const site = python(exe, purelib);
  const fakes = join(import.meta.dirname, 'photo-fake');
  // the development site (aio_pipelines and its wheels), then the fakes over the photo stubs
  await writeFile(
    join(site, 'stratlas_photo_fake.pth'),
    `import site; site.addsitedir(${JSON.stringify(devSite)})\n${fakes}\nimport aio_photo_fake\n`,
  );
  const rel = process.platform === 'win32' ? 'venv/Scripts/python.exe' : 'venv/bin/python';
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schema: 'aio.pipeline-pack/1',
      version: '0.4.0',
      protocol: 'aio.pipelines/1',
      python: { version: '3', build: 'e2e photo fakes', executable: rel },
      platform: `${process.platform}-${process.arch}`,
      createdAt: new Date().toISOString(),
      pipelines: [],
      // no appRange: under Playwright the app reports Electron's own version
      files: {},
    }),
  );
  return { QUADRION_PIPELINE_PACK: dir, AIO_FAKE_PHOTO_STEP_S: '0.5' };
}

const RENDER = `
import json, random, sys
from PIL import Image, ImageDraw
spec = json.loads(open(sys.argv[1], encoding="utf-8").read())
for i, photo in enumerate(spec["photos"]):
    w, h = spec["size"]
    rnd = random.Random(i)
    img = Image.effect_noise((w, h), 40).convert("RGB")
    img = Image.merge("RGB", [b.point(lambda v, k=k: min(255, v + 40 + k * 10)) for k, b in enumerate(img.split())])
    d = ImageDraw.Draw(img)
    for _ in range(80):
        x, y = rnd.randrange(w), rnd.randrange(h)
        d.ellipse([x, y, x + rnd.randrange(4, 18), y + rnd.randrange(4, 18)], fill=(rnd.randrange(60, 200),) * 3)
    for x, y in photo["targets"]:
        s = 9
        d.rectangle([x - s, y - s, x + s, y + s], fill=(255, 255, 255))
        d.rectangle([x - s, y - s, x, y], fill=(0, 0, 0))
        d.rectangle([x, y, x + s, y + s], fill=(0, 0, 0))
    exif = Image.Exif()
    exif[271] = "Stratlas Synthetic"
    exif[272] = "SYN-20"
    lat, lon = photo["lat"], photo["lon"]
    def dms(v):
        v = abs(v); d = int(v); m = int((v - d) * 60); s = (v - d - m / 60) * 3600
        return (d, m, round(s, 4))
    exif[0x8825] = {1: "N" if lat >= 0 else "S", 2: dms(lat), 3: "E" if lon >= 0 else "W", 4: dms(lon)}
    img.save(photo["path"], "JPEG", quality=90, exif=exif)
`;

/** Write the photo project into the data root (before the app starts). */
export async function writePhotoProject(dataRoot: DataRoot): Promise<{ dir: string; csv: string }> {
  const dir = join(dataRoot.root, 'projects', PHOTO_PROJECT.id);
  await mkdir(join(dir, 'photos'), { recursive: true });
  const input: ProjectManifestInput = {
    schema: 'aio.project/1',
    id: PHOTO_PROJECT.id,
    name: PHOTO_PROJECT.name,
    customer: 'E2E',
    site: 'Synthetic photo site',
    crs: { epsg: 32639 },
    origin: ORIGIN,
    captures: [{ id: 'c1', label: 'Photo survey', date: '2026-10-01' }],
    layers: [
      {
        kind: 'photos',
        id: 'photos',
        name: 'Synthetic flight',
        items: CAMERAS.map((c) => ({
          id: c.id,
          src: { path: `photos/${c.file}` },
          pos: c.pos,
          q: NADIR,
          lens: { model: 'pinhole', hfovDeg: PHOTO_HFOV, aspect: PHOTO_SIZE[0] / PHOTO_SIZE[1] },
        })),
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(input), null, 2),
  );
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );
  const toProject = (l: [number, number, number]): [number, number, number] => [
    ORIGIN[0] + l[0],
    ORIGIN[1] - l[2],
    ORIGIN[2] + l[1],
  ];
  const spec = {
    size: PHOTO_SIZE,
    photos: CAMERAS.map((c) => {
      const [lon, lat] = toWgs84(toProject(c.pos), 32639);
      return {
        path: join(dir, 'photos', c.file),
        lat,
        lon,
        targets: GCPS.map((g) => expectedPixel(c, g.local)).filter(
          (p): p is [number, number] => p !== null,
        ),
      };
    }),
  };
  const specFile = join(dataRoot.base, 'photo-render.json');
  await writeFile(specFile, JSON.stringify(spec));
  execFileSync(VENV_PYTHON, ['-c', RENDER, specFile]);
  const csv = join(dataRoot.base, 'site gcp.csv');
  await writeFile(
    csv,
    [
      'Name,Easting,Northing,Height,Type',
      ...GCPS.map((g) => {
        const [e, n, h] = toProject(g.local);
        return `${g.id},${e.toFixed(3)},${n.toFixed(3)},${h.toFixed(3)},${g.role}`;
      }),
    ].join('\n'),
  );
  return { dir, csv };
}

export interface PhotoFixtures {
  photoSite: { dir: string; csv: string };
  appEnv: Record<string, string>;
}
export interface PhotoWorkerFixtures {
  photoPackEnv: Record<string, string>;
}

/**
 * Fixtures for `test.extend`: the photo project written before the app starts and the photo pack
 * selected (built once per worker). In a spec:
 * `const test = base.extend<PhotoFixtures, PhotoWorkerFixtures>(photoFixtures)`.
 */
export const photoFixtures: Fixtures<
  PhotoFixtures,
  PhotoWorkerFixtures,
  { dataRoot: DataRoot; appEnv: Record<string, string> }
> = {
  photoPackEnv: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
    async ({}, use) => {
      const dir = await mkdtemp(join(tmpdir(), 'aio-photo-pack-'));
      try {
        await use(await buildPhotoPack(dir));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    { scope: 'worker' },
  ],
  photoSite: async ({ dataRoot }, use) => {
    await use(await writePhotoProject(dataRoot));
  },
  // the app starts after the project is written, with the photo pack
  appEnv: async ({ photoPackEnv, photoSite }, use) => {
    expect(photoSite.dir).toBeTruthy();
    await use(photoPackEnv);
  },
};

/** Open the photo project from the library. */
export async function openPhotoSite(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: PHOTO_PROJECT.name }).first().click();
  await expect(win.locator('.crumbs')).toContainText(PHOTO_PROJECT.name);
}

/** Jobs, Photo processing, Process photos: the wizard. */
export async function openWizard(win: Page) {
  await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
  await win.getByTestId('photo-runs').getByRole('button', { name: 'Process photos' }).click();
  const wizard = win.getByRole('dialog', { name: 'Process photos' });
  await expect(wizard).toBeVisible();
  return wizard;
}

/** Walk the wizard with its defaults (the photos layer, Balanced); answers the run panel. */
export async function startRun(win: Page, o: { groundControl?: boolean } = {}) {
  const wizard = await openWizard(win);
  const next = wizard.getByRole('button', { name: 'Next' });
  await next.click();
  await expect(wizard.getByTestId('photo-groups')).toContainText('Stratlas Synthetic SYN-20');
  await next.click();
  await next.click();
  if (o.groundControl) await wizard.getByText('I have ground control points').click();
  await next.click();
  await expect(wizard.getByTestId('photo-estimate')).toBeVisible({ timeout: 60_000 });
  await wizard.getByTestId('photo-start').click();
  const panel = win.getByTestId('photo-run');
  await expect(panel).toBeVisible();
  return panel;
}

/** The run id the open run panel shows. */
export async function runId(win: Page): Promise<string> {
  const title = await win.getByTestId('photo-run').getByRole('heading', { level: 2 }).innerText();
  return title.replace(/^Photo run /, '').trim();
}
