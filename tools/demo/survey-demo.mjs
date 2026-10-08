#!/usr/bin/env node
/* eslint-disable no-console -- build script output */
// The M11 surveying demos (stream G13): synthetic projects generated on demand, never bundled.
// Each is made from a set folder that python/tests/survey_synth.py writes (analytic surfaces with
// exact truths), turned into an ordinary project the current app opens: a manifest with one
// survey date per capture, a DSM per date (raster role dsm, a shaded relief pyramid, with its
// measured heights as aio.grid/1 in sources/), an ortho per date, and the M11 side files under
// survey/ (settings.json with the materials, designs.json with the original design files and
// their normalised layers, measurements.json, the calibration), plus truth.json.
//
//   Earthworks demo  demo-survey-earthworks  3 surveys, pad and road design (LandXML), alignment,
//                                             site calibration (JobXML, .dc), checkpoints
//   Quarry demo      demo-survey-quarry      3 monthly surveys, stockpiles with materials, a benched
//                                             pit, a haul road with planted violations
//   Landfill demo    demo-survey-landfill    cell design, 3 lifts, weighbridge tonnages
//   Survey analytic  demo-survey-analytic    5 analytic shapes on flat ground, 2 surveys
//
//   node tools/demo/survey-demo.mjs [--out <folder>] [--site earthworks,quarry,landfill,analytic]
//                                   [--quick] [--python <python>]
//
// --out defaults to <tmp>/quadrion-survey-demo (the demos are generated, not bundled: they are not
// listed in any demo.json). --quick uses coarser grids (CI); the truths are the same. Each demo
// stays under BUDGET_MB and passes the client-data check. Byte for byte reproducible for a given
// generator (no clock, no temp path in any file).
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { treeSize } from './build-change-demo.mjs';
import { pipelinePython } from './photo-demo.mjs';
import { writePyramid } from './writers.mjs';

/** The demos: site key of survey_synth.py, project id, the name the project is created with. */
export const SURVEY_DEMOS = Object.freeze({
  earthworks: Object.freeze({ id: 'demo-survey-earthworks', name: 'Earthworks demo' }),
  quarry: Object.freeze({ id: 'demo-survey-quarry', name: 'Quarry demo' }),
  landfill: Object.freeze({ id: 'demo-survey-landfill', name: 'Landfill demo' }),
  analytic: Object.freeze({ id: 'demo-survey-analytic', name: 'Survey analytic demo' }),
});
/** Size budget of each demo on disk. */
export const BUDGET_MB = 60;
export const DEFAULT_OUT = join(tmpdir(), 'quadrion-survey-demo');

const repo = fileURLToPath(new URL('../..', import.meta.url));
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

let libsCache = null;
async function libs() {
  if (libsCache) return libsCache;
  const projectRequire = createRequire(join(repo, 'packages', 'project', 'package.json'));
  const { createJiti } = projectRequire('jiti');
  const jiti = createJiti(import.meta.url);
  libsCache = {
    schema: await jiti.import(join(repo, 'packages', 'schema', 'src', 'index.ts')),
    builder: await jiti.import(join(repo, 'packages', 'project', 'src', 'builder', 'index.ts')),
  };
  return libsCache;
}

/** Run survey_synth.py for one site into `dir` (the set folder). */
export function generateSurveySet(dir, site, { quick = false, python } = {}) {
  const args = [
    join(repo, 'python', 'tests', 'survey_synth.py'),
    'demo',
    '--site',
    site,
    '--out',
    dir,
    ...(quick ? ['--quick'] : []),
  ];
  const r = spawnSync(pipelinePython(python), args, {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (r.status !== 0)
    throw new Error(`survey_synth.py ${site} failed: ${r.stderr || r.error?.message || ''}`);
  return dir;
}

async function rgbOf(png) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), ...info };
}

async function removeEmptyDirs(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }))
    if (e.isDirectory()) await removeEmptyDirs(join(dir, e.name));
  if ((await readdir(dir)).length === 0) await rmdir(dir);
}

/** Parse with a zod schema or fail with the file's name and the first issue. */
function check(schema, value, what) {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new Error(
      `${what}: ${r.error.issues[0]?.path.join('.') ?? ''} ${r.error.issues[0]?.message ?? ''}`,
    );
  return r.data;
}

/**
 * Build one survey demo into `<out>/<id>/`. Returns { id, root, bytes, truth }.
 * @param {{ out: string, site: keyof typeof SURVEY_DEMOS, quick?: boolean, python?: string, log?: (m: string) => void }} o
 */
export async function buildSurveyDemo({ out, site, quick = false, python, log = () => undefined }) {
  const demo = SURVEY_DEMOS[site];
  if (!demo)
    throw new Error(`Unknown survey demo "${site}" (${Object.keys(SURVEY_DEMOS).join(', ')}).`);
  const { schema, builder } = await libs();
  const work = await mkdtemp(join(tmpdir(), 'quadrion-survey-demo-'));
  try {
    const set = generateSurveySet(join(work, 'set'), site, { quick, python });
    const meta = JSON.parse(await readFile(join(set, 'site.json'), 'utf8'));
    const truth = JSON.parse(await readFile(join(set, 'truth.json'), 'utf8'));
    if (meta.id !== demo.id) throw new Error(`set ${meta.id} is not ${demo.id}`);
    log(`${demo.id}: set generated (${String(meta.captures.length)} surveys)`);

    // the project id is the slug of the name it is created with
    const { root, manifest } = await builder.createProject(
      join(work, 'data'),
      {
        name: demo.id.replace(/-/g, ' '),
        customer: 'Demo customer (fictional)',
        site: meta.description,
        type: 'fusion',
        epsg: meta.crs.epsg,
        origin: meta.origin,
        captureDate: meta.captures[0].date,
        severityTemplate: builder.GENERAL_TEMPLATE.id,
      },
      builder.GENERAL_TEMPLATE,
    );
    if (manifest.id !== demo.id) throw new Error(`project id ${manifest.id}`);

    const h = meta.half;
    const corners = (y) => ({ tl: [-h, y, -h], tr: [h, y, -h], bl: [-h, y, h] });
    const layers = [];
    const last = meta.captures[meta.captures.length - 1].id;
    await mkdir(join(root, 'sources'), { recursive: true });
    for (const c of meta.captures) {
      const from = join(set, 'captures', c.id);
      const dsmId = `dsm-${c.id}`;
      const orthoId = `ortho-${c.id}`;
      // measured heights (aio.grid/1) in sources/, named by the DSM layer
      const grid = JSON.parse(await readFile(join(from, 'dsm.json'), 'utf8'));
      grid.layer = dsmId;
      grid.file = `${dsmId}.png`;
      await cp(join(from, 'dsm.png'), join(root, 'sources', `${dsmId}.png`));
      await writeFile(join(root, 'sources', `${dsmId}.json`), json(grid));
      const relief = await rgbOf(join(from, 'relief.png'));
      await writePyramid(
        root,
        `rasters/${dsmId}`,
        relief.rgb,
        relief.width,
        relief.height,
        corners(0.03),
      );
      layers.push({
        kind: 'raster',
        id: dsmId,
        name: `DSM ${c.label.replace(/^Survey /, '')} (shaded relief)`,
        visible: false,
        capture: c.id,
        src: { path: `rasters/${dsmId}/tiles.json` },
        role: 'dsm',
        format: 'kit-pyramid',
        corners: corners(0.03),
      });
      const ortho = await rgbOf(join(from, 'ortho.png'));
      await writePyramid(
        root,
        `rasters/${orthoId}`,
        ortho.rgb,
        ortho.width,
        ortho.height,
        corners(0.02),
      );
      layers.push({
        kind: 'raster',
        id: orthoId,
        name: `Orthomosaic ${c.label.replace(/^Survey /, '')}`,
        visible: c.id === last,
        capture: c.id,
        src: { path: `rasters/${orthoId}/tiles.json` },
        role: 'ortho',
        format: 'kit-pyramid',
        corners: corners(0.02),
      });
    }

    // the M11 side files, checked against the G0 schemas
    await cp(join(set, 'survey'), join(root, 'survey'), { recursive: true });
    const sv = (f) => join(root, 'survey', f);
    const readSv = async (f) => JSON.parse(await readFile(sv(f), 'utf8'));
    check(schema.SurveySettings, await readSv('settings.json'), 'survey/settings.json');
    const designs = check(schema.DesignsFile, await readSv('designs.json'), 'survey/designs.json');
    check(schema.MeasurementsFile, await readSv('measurements.json'), 'survey/measurements.json');
    for (const d of designs.designs)
      for (const l of d.layers) {
        const file = join(root, 'survey', 'designs', d.id, l.file);
        if (l.kind === 'alignment')
          check(schema.Alignment, JSON.parse(await readFile(file, 'utf8')), l.file);
        else {
          const buf = await readFile(file);
          const n = buf.readUInt32LE(0);
          check(schema.TinHeader, JSON.parse(buf.toString('utf8', 4, 4 + n)), l.file);
        }
      }
    if (meta.calibration)
      check(schema.SiteCalibration, await readSv('calibration.json'), 'survey/calibration.json');
    // the same designs in DXF, 12da and CSV, for import tests (G6)
    await cp(join(set, 'design-files'), join(root, 'survey', 'design-files'), {
      recursive: true,
    }).catch(() => undefined);

    const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    m.name = demo.name;
    m.captures = meta.captures.map(({ id, label, date }) => ({ id, label, date }));
    m.layers = layers;
    const parsed = schema.parseManifest(m);
    if (!parsed.ok) throw new Error(`manifest: ${parsed.error}`);
    await writeFile(join(root, 'manifest.json'), json(m));
    await writeFile(join(root, 'truth.json'), json(truth));
    await writeFile(
      join(root, 'README.txt'),
      [
        `${demo.name}: synthetic survey data (python/tests/survey_synth.py, tools/demo/survey-demo.mjs).`,
        'No client data: a fictional site, procedural surfaces, hand-written design and controller files.',
        'truth.json holds the exact volumes, areas, grades, checkpoints and calibration of every survey.',
        '',
      ].join('\n'),
    );
    for (const f of await readdir(root)) if (f.endsWith('.bak')) await rm(join(root, f));
    await removeEmptyDirs(root);

    const dest = join(out, demo.id);
    await rm(dest, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    await cp(root, dest, { recursive: true });
    const bytes = await treeSize(dest);
    log(`${demo.id}: ${(bytes / 1e6).toFixed(1)} MB`);
    if (bytes > BUDGET_MB * 1e6)
      throw new Error(
        `${demo.id} is ${(bytes / 1e6).toFixed(1)} MB, over its ${BUDGET_MB} MB budget.`,
      );
    return { id: demo.id, root: dest, bytes, truth };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function cli() {
  const argv = process.argv.slice(2);
  const opt = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const out = resolve(opt('out', DEFAULT_OUT));
  const quick = argv.includes('--quick');
  const sites = opt('site', Object.keys(SURVEY_DEMOS).join(',')).split(',');
  const t0 = Date.now();
  const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${m}`);
  for (const site of sites) {
    const { root } = await buildSurveyDemo({ out, site, quick, python: opt('python'), log });
    const r = spawnSync(
      process.execPath,
      [
        join(repo, 'tools', 'demo', 'check-no-client-data.mjs'),
        root,
        '--max-mb',
        String(BUDGET_MB),
      ],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) throw new Error(`${root} failed the client data check.`);
  }
  log(`written to ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cli().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
