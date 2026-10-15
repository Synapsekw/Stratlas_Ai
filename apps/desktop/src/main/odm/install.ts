import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import {
  compareVersions,
  OdmInstallRecord,
  type OdmGpuSetting,
  type OdmInstallProgress,
  type OdmInstallResult,
  type OdmStatus,
} from '@aio/schema';
import { downloadVerified, type FetchLike } from '../update/download';
import { findOtherOdm, nvcudaPresent, nvidiaName } from './detect';
import { downloadDir, isOurOdmFolder, odmInstallDir, odmRecordPath, odmWorkRoot } from './paths';
import { pinFrom, REQUIRED_FILES, SETUP_ARGS, SETUP_MAY_ASK_ADMIN, UNINSTALL_ARGS } from './pin';
import type { OdmSystem } from './system';

export interface OdmDeps {
  dataRoot(): string;
  env: Record<string, string | undefined>;
  platform: string;
  arch: string;
  fetch: FetchLike;
  system: OdmSystem;
  gpus(): Promise<readonly { name: string; vendor?: string }[]>;
  gpuSetting(): OdmGpuSetting;
  offlineOnly(): boolean;
  now(): Date;
  /** A warning for the app log (a placeholder that could not be renamed); optional. */
  log?(line: string): void;
}

type Env = Record<string, string | undefined>;
type Failure = Extract<OdmInstallResult, { ok: false }>;

const UNSUPPORTED = 'ODM installs on Windows x64 only.';
const BROKEN = 'Files of the processing engine are missing. Reinstall it.';
const OFFLINE =
  'This computer is set to offline only. Switch that off in Settings, Privacy to download the processing engine.';
const DEV = 'ODM comes from QUADRION_ODM_DIR here; install and remove are off.';
const STUB_NOT_PARKED =
  "Dense matching may run on the CPU: ODM's placeholder nvcuda.dll could not be set aside. It is tried again before the next ODM run.";
const STUB_NOT_BACK =
  "ODM's placeholder nvcuda.dll could not be put back. It is tried again before the next ODM run.";

/** ODM's placeholder `nvcuda.dll` is 19 KB; NVIDIA's driver is far larger. */
const STUB_MAX_BYTES = 100_000;
/** Inno's uninstaller returns before it has finished (C14): wait up to 300 s for run.bat to go. */
const UNINSTALL_POLLS = 300;

const supported = (d: Pick<OdmDeps, 'platform' | 'arch'>) =>
  d.platform === 'win32' && d.arch === 'x64';

const fail = (error: string, code?: Failure['code']): Failure =>
  code ? { ok: false, error, code } : { ok: false, error };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;

const sameDir = (a: string, b: string) =>
  a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

/** `<dataRoot>/runtime/odm.json`, or null when it is missing or not a record. */
export async function readRecord(dataRoot: string): Promise<OdmInstallRecord | null> {
  try {
    const parsed = OdmInstallRecord.safeParse(
      JSON.parse(await readFile(odmRecordPath(dataRoot), 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function filesPresent(system: OdmSystem, dir: string): Promise<string | null> {
  for (const f of REQUIRED_FILES) if (!(await system.exists(win32.join(dir, f)))) return f;
  return null;
}

/** Our folders: the recorded one and where this build installs. Neither is "another ODM". */
const ourDirs = (rec: OdmInstallRecord | null, target: string) => [rec?.dir, target];

/** The ODM jobs use: `QUADRION_ODM_DIR` first (never ours to touch), else the one we installed. */
export async function currentOdm(
  d: Pick<OdmDeps, 'dataRoot' | 'env' | 'system'>,
): Promise<{ dir: string; version: string; owned: boolean } | null> {
  const devDir = d.env.QUADRION_ODM_DIR;
  if (devDir) return { dir: devDir, version: d.env.QUADRION_ODM_VERSION ?? 'dev', owned: false };
  const rec = await readRecord(d.dataRoot());
  if (!rec || (await filesPresent(d.system, rec.dir)) !== null) return null;
  return { dir: rec.dir, version: rec.version, owned: true };
}

const stubPaths = (dir: string) => {
  const bin = win32.join(dir, 'SuperBuild', 'install', 'bin');
  return { dll: win32.join(bin, 'nvcuda.dll'), stub: win32.join(bin, 'nvcuda.dll.odm-stub') };
};

/** Why the placeholder is not where the GPU setting wants it, or null when it is. */
async function stubProblem(
  dir: string,
  gpu: OdmGpuSetting,
  env: Env,
  system: OdmSystem,
): Promise<string | null> {
  const { dll, stub } = stubPaths(dir);
  if (gpu === 'auto' && (await nvcudaPresent(env, (p) => system.exists(p)))) {
    const size = await system.fileBytes(dll);
    return size !== null && size < STUB_MAX_BYTES ? STUB_NOT_PARKED : null;
  }
  return (await system.exists(stub)) && !(await system.exists(dll)) ? STUB_NOT_BACK : null;
}

export async function odmStatus(d: OdmDeps, installing: boolean): Promise<OdmStatus> {
  const pin = await pinFrom(d.env);
  const setting = d.gpuSetting();
  const base = {
    pinned: { version: pin.version, downloadBytes: pin.size, installedBytes: pin.installedBytes },
    gpu: {
      setting,
      nvidia: nvidiaName(await d.gpus()),
      cuda: await nvcudaPresent(d.env, (p) => d.system.exists(p)),
    },
    mayAskAdmin: SETUP_MAY_ASK_ADMIN,
    installing,
    dev: false,
    other: null,
  };
  if (!supported(d)) return { ...base, state: 'unsupported', problem: UNSUPPORTED };
  const devDir = d.env.QUADRION_ODM_DIR;
  const dataRoot = d.dataRoot();
  const rec = devDir ? null : await readRecord(dataRoot);
  const other = await findOtherOdm({
    regQuery: (k, s) => d.system.regQuery(k, s),
    exists: (p) => d.system.exists(p),
    ours: devDir ? [devDir] : ourDirs(rec, odmInstallDir(dataRoot, d.env, pin.version)),
    env: d.env,
  });
  const s = { ...base, other };
  if (devDir)
    return {
      ...s,
      state: 'installed',
      dev: true,
      dir: devDir,
      version: d.env.QUADRION_ODM_VERSION ?? 'dev',
    };
  const found = rec ? { version: rec.version, dir: rec.dir, installedAt: rec.installedAt } : {};
  if (installing) return { ...s, ...found, state: 'installing' };
  if (!rec) return { ...s, state: 'not-installed' };
  if ((await filesPresent(d.system, rec.dir)) !== null)
    return { ...s, ...found, state: 'broken', problem: BROKEN };
  const problem = await stubProblem(rec.dir, setting, d.env, d.system);
  const state = compareVersions(rec.version, pin.version) < 0 ? 'update-available' : 'installed';
  return { ...s, ...found, state, ...(problem ? { problem } : {}) };
}

/**
 * Deviation 17: ODM 3.6.2 ships a placeholder `SuperBuild\install\bin\nvcuda.dll` that Windows
 * loads before NVIDIA's driver, so OpenMVS densifies on the CPU. With `auto` and the driver present
 * it is renamed to `nvcuda.dll.odm-stub`; otherwise it is renamed back. Never deleted.
 */
export async function parkOdmStub(
  dir: string,
  gpu: OdmGpuSetting,
  env: Env,
  system: OdmSystem,
): Promise<void> {
  const { dll, stub } = stubPaths(dir);
  if (gpu === 'auto' && (await nvcudaPresent(env, (p) => system.exists(p)))) {
    const size = await system.fileBytes(dll);
    if (size !== null && size < STUB_MAX_BYTES) await system.rename(dll, stub);
  } else if ((await system.exists(stub)) && !(await system.exists(dll))) {
    await system.rename(stub, dll);
  }
}

/** `parkOdmStub` whose failure is a warning: the runner checks again before every ODM run. */
async function parkOrWarn(d: OdmDeps, dir: string, gpu: OdmGpuSetting): Promise<void> {
  try {
    await parkOdmStub(dir, gpu, d.env, d.system);
  } catch (e) {
    d.log?.(`ODM: the placeholder nvcuda.dll in ${dir} could not be renamed: ${message(e)}`);
  }
}

async function writeRecord(dataRoot: string, rec: OdmInstallRecord): Promise<void> {
  const path = odmRecordPath(dataRoot);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

const lastLine = (out: string) =>
  out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);

/** `downloadVerified` speaks of the app's update feed; say what is being downloaded here. */
export function odmDownloadError(raw: string): string {
  const http = /HTTP (\d+)/.exec(raw);
  if (http) return `The server answered HTTP ${http[1] ?? ''} for the ODM download.`;
  if (/wrong part/i.test(raw))
    return 'The server sent the wrong part of the ODM download. Try again.';
  if (/larger than/i.test(raw)) return 'The ODM download is larger than expected. Try again.';
  const stopped = /stopped at (\d+) of (\d+) bytes/.exec(raw);
  if (stopped)
    return `The ODM download stopped at ${stopped[1] ?? ''} of ${stopped[2] ?? ''} bytes. Install again to continue.`;
  if (/SHA-256|does not match/i.test(raw))
    return 'The ODM download does not match its checksum (SHA-256). It was deleted; try again.';
  if (/no data/i.test(raw)) return 'The server sent no data for the ODM download.';
  return `The ODM download failed: ${raw}`;
}

/**
 * Run an ODM folder's uninstaller silently and wait for run.bat to go, then delete what is left.
 * `mayDelete` guards the delete: only a folder that looked like our install before uninstalling.
 */
async function uninstallFolder(d: OdmDeps, dir: string, mayDelete: boolean): Promise<void> {
  const { system } = d;
  const uninstaller = win32.join(dir, 'unins000.exe');
  if (await system.exists(uninstaller)) {
    await system.runUninstaller(uninstaller, [...UNINSTALL_ARGS]);
    for (let i = 0; i < UNINSTALL_POLLS; i++) {
      if (!(await system.exists(win32.join(dir, 'run.bat')))) break;
      await system.sleep(1000);
    }
  }
  if (mayDelete && (await system.exists(dir))) await system.rm(dir);
}

/** Download, verify and install the pinned ODM per user, then check that it starts. */
export async function installOdm(
  d: OdmDeps,
  o: { replaceOther: boolean; signal: AbortSignal; onProgress(p: OdmInstallProgress): void },
): Promise<OdmInstallResult> {
  if (!supported(d)) return fail(UNSUPPORTED, 'unsupported');
  if (d.env.QUADRION_ODM_DIR) return fail(DEV, 'dev');
  if (d.offlineOnly()) return fail(OFFLINE, 'offline-only');

  const { system, env } = d;
  const dataRoot = d.dataRoot();
  const old = await readRecord(dataRoot);
  const pin = await pinFrom(env);
  const target = odmInstallDir(dataRoot, env, pin.version);
  const other = await findOtherOdm({
    regQuery: (k, s) => system.regQuery(k, s),
    exists: (p) => system.exists(p),
    ours: ourDirs(old, target),
    env,
  });
  if (other && !o.replaceOther)
    return fail(
      `Another ODM is installed in ${other.dir}. Installing replaces it.`,
      'other-install',
    );

  // the setup lands in the data root, ODM in the install folder: each drive needs its share
  const setup = join(downloadDir(dataRoot), pin.file);
  const needs = new Map<string, number>();
  for (const [path, bytes] of [
    [setup, pin.size],
    [target, pin.installedBytes],
  ] as const) {
    const drive = win32.parse(path).root.toUpperCase();
    needs.set(drive, (needs.get(drive) ?? 0) + bytes);
  }
  for (const [drive, need] of needs) {
    const free = await system.freeBytes(drive);
    if (free < need)
      return fail(
        `Not enough free space on ${drive}: the processing engine needs about ${gb(need)} there, ${gb(free)} is free.`,
        'disk',
      );
  }

  let done = 0;
  const progress = (phase: OdmInstallProgress['phase'], error?: string) => {
    o.onProgress({
      phase,
      bytesDone: done,
      bytesTotal: pin.size,
      ...(error ? { error } : {}),
    });
  };
  const failed = (error: string): Failure => {
    progress('failed', error);
    return fail(error, 'failed');
  };
  const cancelled = (): Failure => {
    // the partial or verified file stays, so the next try continues it
    progress('cancelled');
    return fail('The download was cancelled.', 'cancelled');
  };

  progress('download');
  try {
    await downloadVerified({
      url: pin.url,
      sha256: pin.sha256,
      size: pin.size,
      dest: setup,
      fetch: d.fetch,
      signal: o.signal,
      onProgress: (n, t) => {
        done = n;
        o.onProgress({ phase: n === t ? 'verify' : 'download', bytesDone: n, bytesTotal: t });
      },
    });
  } catch (e) {
    return o.signal.aborted ? cancelled() : failed(odmDownloadError(message(e)));
  }
  // a cancel during the hash check: stop before the setup runs
  if (o.signal.aborted) return cancelled();

  // Past this point a failure removes what the setup left (folder and uninstall entry), unless
  // it was installed over our recorded ODM: that one is then reported broken until reinstalled.
  const rollback = async (error: string): Promise<Failure> => {
    if (!old || !sameDir(old.dir, target)) {
      try {
        await uninstallFolder(d, target, isOurOdmFolder(target, dataRoot, env));
      } catch (e) {
        d.log?.(`ODM: could not remove the failed install in ${target}: ${message(e)}`);
      }
    }
    return failed(error);
  };

  try {
    progress('install');
    const code = await system.runSetup(setup, [...SETUP_ARGS, `/DIR=${target}`]);
    if (code === 2 || code === 5)
      return await rollback(
        'The installation was cancelled (a Windows permission prompt may have been declined).',
      );
    if (code !== 0) return await rollback(`ODM's setup stopped with exit code ${String(code)}.`);

    progress('check');
    const missing = await filesPresent(system, target);
    if (missing !== null) return await rollback(`ODM's setup finished but ${missing} is missing.`);
    // run.bat exits 0 even when it fails to start ODM: its usage text is the proof
    const smoke = await system.runSmoke(target);
    if (smoke.code !== 0 || !/usage: run/i.test(smoke.out))
      return await rollback(
        `ODM installed but does not start: ${lastLine(smoke.out) ?? `exit code ${String(smoke.code)}`}`,
      );
  } catch (e) {
    return await rollback(message(e));
  }

  try {
    await parkOrWarn(d, target, d.gpuSetting());
    await writeRecord(dataRoot, {
      schema: 'aio.odm-install/1',
      version: pin.version,
      dir: target,
      installedAt: d.now().toISOString(),
    });
    if (
      old &&
      !sameDir(old.dir, target) &&
      isOurOdmFolder(old.dir, dataRoot, env) &&
      (await system.exists(win32.join(old.dir, 'run.bat')))
    )
      await system.rm(old.dir);
    await system.rm(setup);
  } catch (e) {
    return failed(message(e));
  }
  progress('done');
  return { ok: true, status: await odmStatus(d, false) };
}

/** Uninstall the ODM this app installed and forget it. */
export async function removeOdm(d: OdmDeps): Promise<OdmInstallResult> {
  if (d.env.QUADRION_ODM_DIR) return fail(DEV, 'dev');
  const { system } = d;
  const dataRoot = d.dataRoot();
  const rec = await readRecord(dataRoot);
  if (rec) {
    try {
      // only delete leftovers of a folder that looks like our install before uninstalling
      const mayDelete =
        isOurOdmFolder(rec.dir, dataRoot, d.env) &&
        ((await system.exists(win32.join(rec.dir, 'run.bat'))) ||
          (await system.exists(win32.join(rec.dir, 'unins000.exe'))));
      // the uninstaller only knows nvcuda.dll: put the placeholder back first
      await parkOrWarn(d, rec.dir, 'off');
      await uninstallFolder(d, rec.dir, mayDelete);
      await system.rm(odmRecordPath(dataRoot));
    } catch (e) {
      return fail(`ODM could not be removed: ${message(e)}`, 'failed');
    }
  }
  return { ok: true, status: await odmStatus(d, false) };
}

const ODM_PIPELINES = new Set(['photo.align', 'photo.georef', 'photo.products']);

/** What a photo job is told about ODM; `AIO_ODM_OWNED` lets the runner park the stub (dev. 17). */
export function odmJobEnv(
  pipeline: string,
  odm: { dir: string; version: string; owned: boolean } | null,
  gpu: OdmGpuSetting,
): Record<string, string> {
  if (!odm || !ODM_PIPELINES.has(pipeline)) return {};
  return {
    AIO_ODM: odm.dir,
    AIO_ODM_VERSION: odm.version,
    AIO_ODM_GPU: gpu,
    AIO_ODM_WORK: odmWorkRoot(odm.dir),
    ...(odm.owned ? { AIO_ODM_OWNED: '1' } : {}),
  };
}
