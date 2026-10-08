/**
 * M11 e2e fixtures (stream G13): the synthetic survey demos (tools/demo/survey-demo.mjs, made from
 * python/tests/survey_synth.py) as writable projects in a test's data root. The demos are built
 * once per generator version (`--quick`) into a cache in the temp folder and copied from there, so
 * a run builds them at most once. Synthetic only: a fictional desert site, procedural surfaces,
 * hand-written design and controller files, and `truth.json` with every exact value.
 *
 * Used through `fixtures.ts` (`surveyProject`, `earthworksProject`, `quarryProject`,
 * `landfillProject`), which skip the test when the demos cannot be built (no pipeline Python).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');

/** The survey demos: survey_synth.py site key, project id and name. */
export const SURVEY_DEMOS = {
  survey: { site: 'analytic', id: 'demo-survey-analytic', name: 'Survey analytic demo' },
  earthworks: { site: 'earthworks', id: 'demo-survey-earthworks', name: 'Earthworks demo' },
  quarry: { site: 'quarry', id: 'demo-survey-quarry', name: 'Quarry demo' },
  landfill: { site: 'landfill', id: 'demo-survey-landfill', name: 'Landfill demo' },
} as const;
export type SurveyDemoKey = keyof typeof SURVEY_DEMOS;

/** A survey demo copied into the data root as a writable project. */
export interface SurveyDemoProject {
  id: string;
  name: string;
  /** `<dataRoot>/projects/<id>`. */
  dir: string;
  /** The demo's `truth.json` (survey_synth.py: exact volumes, areas, grades, checkpoints...). */
  truth: Record<string, unknown>;
}

/** The files the built demos depend on: a change to any of them rebuilds the cache. */
const SOURCES = [
  'python/tests/survey_synth.py',
  'tools/demo/survey-demo.mjs',
  'tools/demo/writers.mjs',
  'tools/demo/check-m11.mjs',
  'tools/demo/check-no-client-data.mjs',
];

let built: { dir: string | null; reason: string } | null = null;

/**
 * The folder holding the four quick survey demos, built on first use; `dir` is null (with the
 * reason) when they cannot be built here (QUADRION_E2E_SURVEY_DEMO names a prebuilt folder).
 */
export function surveyDemoFolder(): { dir: string | null; reason: string } {
  if (built) return built;
  const given = process.env.QUADRION_E2E_SURVEY_DEMO;
  if (given) {
    built = existsSync(join(given, SURVEY_DEMOS.earthworks.id, 'truth.json'))
      ? { dir: given, reason: '' }
      : { dir: null, reason: `no survey demos in QUADRION_E2E_SURVEY_DEMO (${given})` };
    return built;
  }
  const hash = createHash('sha256');
  for (const f of SOURCES) hash.update(readFileSync(join(REPO, f)));
  const key = hash.digest('hex').slice(0, 16);
  const root = join(tmpdir(), 'quadrion-e2e-survey-demo');
  const dir = join(root, key);
  if (existsSync(join(dir, SURVEY_DEMOS.landfill.id, 'truth.json'))) {
    built = { dir, reason: '' };
    return built;
  }
  const work = join(root, `${key}.${String(process.pid)}.tmp`);
  rmSync(work, { recursive: true, force: true });
  const r = spawnSync(
    process.execPath,
    [join(REPO, 'tools', 'demo', 'survey-demo.mjs'), '--out', work, '--quick'],
    { encoding: 'utf8', timeout: 300_000 },
  );
  if (r.status !== 0) {
    rmSync(work, { recursive: true, force: true });
    built = {
      dir: null,
      reason: `the survey demos could not be built (node tools/demo/survey-demo.mjs --quick): ${[r.stderr, r.error?.message ?? ''].join(' ').slice(-400)}`,
    };
    return built;
  }
  try {
    renameSync(work, dir);
  } catch {
    // another run built the same version first: use that one
    rmSync(work, { recursive: true, force: true });
  }
  built = { dir, reason: '' };
  return built;
}

/** Copy one survey demo from the built folder into `<dataRoot>/projects/<id>`. */
export async function createSurveyProject(
  dataRoot: string,
  folder: string,
  key: SurveyDemoKey,
): Promise<SurveyDemoProject> {
  const demo = SURVEY_DEMOS[key];
  const dir = join(dataRoot, 'projects', demo.id);
  await mkdir(join(dataRoot, 'projects'), { recursive: true });
  await cp(join(folder, demo.id), dir, { recursive: true });
  const truth = JSON.parse(await readFile(join(dir, 'truth.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  return { id: demo.id, name: demo.name, dir, truth };
}
