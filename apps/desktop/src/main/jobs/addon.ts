import { appRangeAllows, PipelineAddonManifest } from '@aio/schema';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from '../fsutil';
import { compareVersions, type PackInfo } from './pack';

/**
 * The optional GPU add-on beside the pipeline pack: `<data folder>/runtime/pipeline-addon-cuda-
 * <version>/` (`aio.pipeline-addon/1`, built by tools/pipeline-pack/accelerator.mjs). The pack's
 * Python loads it; this module only finds the one that fits the pack in use and asks the pack to
 * test it on this computer's graphics card.
 */
export const ADDON_DIR = /^pipeline-addon-cuda-(.+)$/;

export interface AddonInfo {
  dir: string;
  version: string;
  manifest: PipelineAddonManifest;
}

/** The add-on to use, or none, with the reason when one is there and does not fit. */
export interface AddonFound {
  addon: AddonInfo | null;
  problem?: string;
}

/** Read one add-on folder against the pack and platform: the add-on, why not, or null (not one). */
export async function readAddon(
  dir: string,
  pack: { version: string },
  platform: string,
): Promise<AddonInfo | { refused: string } | null> {
  let raw: unknown;
  try {
    raw = await readJson(join(dir, 'manifest.json'));
  } catch {
    return null;
  }
  const m = PipelineAddonManifest.safeParse(raw);
  if (!m.success) return null;
  if (m.data.platform !== platform)
    return {
      refused: `GPU add-on ${m.data.version} is for ${m.data.platform}, not this computer (${platform}).`,
    };
  // a development interpreter has no pack version to hold the add-on to
  if (pack.version !== 'dev' && !appRangeAllows(m.data.packRange, pack.version))
    return {
      refused: `GPU add-on ${m.data.version} fits processing tools ${m.data.packRange}; these are ${pack.version}. Install the add-on made for this version.`,
    };
  return { dir, version: m.data.version, manifest: m.data };
}

/**
 * The GPU add-on for this pack: `QUADRION_PIPELINE_ADDON` (one folder, for development and
 * tests), else the newest `<data folder>/runtime/pipeline-addon-cuda-<version>/` that fits.
 */
export async function findAddon(o: {
  dataRoot: string;
  env: Record<string, string | undefined>;
  pack: { version: string };
  platform?: string;
}): Promise<AddonFound> {
  const platform = o.platform ?? `${process.platform}-${process.arch}`;
  const single = o.env.QUADRION_PIPELINE_ADDON;
  if (single) {
    const a = await readAddon(single, o.pack, platform);
    if (a && 'refused' in a) return { addon: null, problem: a.refused };
    return a ? { addon: a } : { addon: null, problem: `${single} is not a GPU add-on folder.` };
  }
  const runtimeDir = join(o.dataRoot, 'runtime');
  let names: string[];
  try {
    names = await readdir(runtimeDir);
  } catch {
    names = [];
  }
  const candidates = names
    .map((n) => ({ n, m: ADDON_DIR.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => compareVersions(b.m[1] ?? '', a.m[1] ?? ''));
  let problem: string | undefined;
  for (const c of candidates) {
    const a = await readAddon(join(runtimeDir, c.n), o.pack, platform);
    if (a && 'refused' in a) {
      problem ??= a.refused;
      continue;
    }
    if (a) return { addon: a };
  }
  return problem ? { addon: null, problem } : { addon: null };
}

// ---------------------------------------------------------------- the card's self-test

/** What `python -m aio_pipelines.accel --selftest` answers (data-conventions section 31). */
export interface AcceleratorState {
  state: 'ready' | 'not-installed' | 'failed' | 'driver-too-old' | 'unsupported-gpu' | 'off';
  /** The add-on's version, when one was found. */
  version?: string;
  /** Why the card is not used, in plain words. */
  reason?: string;
  gpu?: string;
  driver?: string;
  vramBytes?: number;
  freeBytes?: number;
}

const STATES: ReadonlySet<string> = new Set([
  'ready',
  'not-installed',
  'failed',
  'driver-too-old',
  'unsupported-gpu',
  'off',
]);

/** The self-test's JSON line as an `AcceleratorState`; anything else is a failed test. */
export function parseSelfTest(stdout: string): AcceleratorState {
  const line = stdout.trim().split(/\r?\n/).pop() ?? '';
  let doc: unknown;
  try {
    doc = JSON.parse(line);
  } catch {
    doc = null;
  }
  const d = doc as Record<string, unknown> | null;
  if (!d || typeof d.state !== 'string' || !STATES.has(d.state))
    return { state: 'failed', reason: 'The graphics card test gave no answer.' };
  const text = (v: unknown, max: number) =>
    typeof v === 'string' && v !== '' ? v.slice(0, max) : undefined;
  const bytes = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
  const out: AcceleratorState = { state: d.state as AcceleratorState['state'] };
  const version = text(d.version, 64);
  const reason = text(d.reason, 500);
  const gpu = text(d.gpu, 200);
  const driver = text(d.driver, 40);
  const vramBytes = bytes(d.vramBytes);
  const freeBytes = bytes(d.freeBytes);
  if (version) out.version = version;
  if (reason) out.reason = reason;
  if (gpu) out.gpu = gpu;
  if (driver) out.driver = driver;
  if (vramBytes !== undefined) out.vramBytes = vramBytes;
  if (freeBytes !== undefined) out.freeBytes = freeBytes;
  return out;
}

/** Runs a program and answers what it printed; rejects when it cannot start or runs too long. */
export type RunProgram = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; cwd: string },
) => Promise<string>;

const runProgram: RunProgram = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        env: options.env,
        cwd: options.cwd,
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => {
        // the self-test exits 0 whatever it finds; an error is the program itself failing
        if (error && !stdout.trim()) reject(new Error(error.message));
        else resolve(stdout);
      },
    );
  });

/** Environment names the pack's Python must not inherit (as the job runner drops them). */
const ENV_DROP: ReadonlySet<string> = new Set([
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
]);

/**
 * Ask the pack to test the add-on on this computer's graphics card. A process of its own with a
 * time limit: a driver fault or a hang there never reaches the app.
 */
export async function selfTestAddon(o: {
  pack: PackInfo;
  addon: AddonInfo;
  cacheDir: string;
  off?: boolean;
  env?: NodeJS.ProcessEnv;
  run?: RunProgram;
  timeoutMs?: number;
}): Promise<AcceleratorState> {
  if (o.off)
    return {
      state: 'off',
      version: o.addon.version,
      reason: 'The graphics card is switched off for photo processing.',
    };
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(o.env ?? process.env).filter(([k]) => !ENV_DROP.has(k))),
    AIO_PHOTO_GPU_CACHE: o.cacheDir,
  };
  try {
    const stdout = await (o.run ?? runProgram)(
      o.pack.python,
      ['-I', '-u', '-X', 'utf8', '-m', 'aio_pipelines.accel', '--selftest', '--addon', o.addon.dir],
      { env, timeoutMs: o.timeoutMs ?? 120_000, cwd: o.pack.dir },
    );
    return { version: o.addon.version, ...parseSelfTest(stdout) };
  } catch {
    return {
      state: 'failed',
      version: o.addon.version,
      reason:
        'The graphics card test could not run. The processing tools may be too old for the GPU add-on: update them in Settings, Processing tools.',
    };
  }
}

/**
 * The card's state for the hardware probe, tested once per add-on and pack and kept for ten
 * minutes: the wizard asks for the probe every time it opens.
 */
export class AcceleratorProbe {
  private kept: { key: string; at: number; state: AcceleratorState } | null = null;

  constructor(
    private readonly deps: {
      findPack: () => Promise<{ pack: PackInfo | null }>;
      dataRoot: () => string;
      cacheDir: () => string;
      env: () => Record<string, string | undefined>;
      off: () => boolean;
      run?: RunProgram;
      now?: () => number;
      platform?: string;
    },
  ) {}

  /** The add-on that fits the pack in use (null without a pack or an add-on). */
  async addon(): Promise<{ pack: PackInfo | null; found: AddonFound }> {
    const { pack } = await this.deps.findPack();
    if (!pack) return { pack: null, found: { addon: null } };
    const found = await findAddon({
      dataRoot: this.deps.dataRoot(),
      env: this.deps.env(),
      pack,
      ...(this.deps.platform ? { platform: this.deps.platform } : {}),
    });
    return { pack, found };
  }

  async state(): Promise<AcceleratorState> {
    const { pack, found } = await this.addon();
    if (!pack || !found.addon)
      return found.problem
        ? { state: 'failed', reason: found.problem }
        : { state: 'not-installed' };
    const off = this.deps.off();
    const key = `${pack.dir}|${pack.version}|${found.addon.dir}|${found.addon.version}|${String(off)}`;
    const now = (this.deps.now ?? Date.now)();
    if (this.kept?.key === key && now - this.kept.at < 10 * 60_000) return this.kept.state;
    const state = await selfTestAddon({
      pack,
      addon: found.addon,
      cacheDir: this.deps.cacheDir(),
      off,
      env: this.deps.env(),
      ...(this.deps.run ? { run: this.deps.run } : {}),
    });
    this.kept = { key, at: now, state };
    return state;
  }

  /** Forget the kept answer (after an install or a removal). */
  reset(): void {
    this.kept = null;
  }
}

/**
 * Whether the graphics card is switched off for photo processing. For now only by
 * `QUADRION_PHOTO_GPU=0` (tests and support); the switch in Settings comes with the add-on's row.
 */
export const photoGpuOff = (env: Record<string, string | undefined>): boolean =>
  env.QUADRION_PHOTO_GPU === '0';

/** The photo jobs whose stages can use the graphics card. */
export const PHOTO_GPU_PIPELINES: ReadonlySet<string> = new Set(['photo.align', 'photo.products']);

/**
 * The environment that names the add-on to a photo job: `AIO_PHOTO_ADDON` (the folder),
 * `AIO_PHOTO_GPU_CACHE` (where the card's compiled kernels are kept) and, when the card is
 * switched off, `AIO_PHOTO_GPU=0`. Nothing for other jobs or without an add-on: the job then
 * runs on the CPU exactly as before.
 */
export function photoAddonEnv(
  pipeline: string,
  addon: AddonInfo | null,
  cacheDir: string,
  off: boolean,
): Record<string, string> {
  if (!addon || !PHOTO_GPU_PIPELINES.has(pipeline)) return {};
  return {
    AIO_PHOTO_ADDON: addon.dir,
    AIO_PHOTO_GPU_CACHE: cacheDir,
    ...(off ? { AIO_PHOTO_GPU: '0' } : {}),
  };
}
