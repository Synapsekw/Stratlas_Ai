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
import { findOtherOdm, missingVcRuntime, nvcudaPresent, nvidiaName } from './detect';
import {
  downloadDir,
  isOurOdmFolder,
  odmInstallDir,
  odmPreviousRecordPath,
  odmRecordPath,
  odmSetupLogPath,
  odmWorkRoot,
} from './paths';
import { pinFrom, REQUIRED_FILES, SETUP_ARGS, SETUP_MAY_ASK_ADMIN, UNINSTALL_ARGS } from './pin';
import { SMOKE_TIMEOUT_MS, type OdmSystem } from './system';

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
  /** A line for the app log (a placeholder that could not be renamed, the start check); optional. */
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
const VC_RUNTIME_MISSING =
  'ODM needs the Microsoft Visual C++ 2015-2022 Redistributable (x64), which is missing on this computer. Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe, then install ODM again.';
/** Added to UNVERIFIED when System32 lacks part of the C++ runtime. */
const VC_RUNTIME_HINT =
  'The Microsoft Visual C++ 2015-2022 Redistributable (x64) is also missing; installing it from https://aka.ms/vs/17/release/vc_redist.x64.exe may help.';
/** Why an install recorded unverified is not used yet; the card offers Try again. */
/** Neutral: the check may have run out of time, been cancelled or stopped by a quit. */
const UNVERIFIED =
  'ODM is installed, but its start check has not passed yet. The first start on a new computer can take several minutes while Windows checks the new files. Press Try again; the second start is usually much faster. If it keeps happening, send us the app log.';
const CHECK_CANCELLED = 'The start check was cancelled. ODM stays installed until it is checked.';
/** How much of the start check's output goes to the app log. */
const SMOKE_LOG_CHARS = 4096;

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

async function readRecordAt(path: string): Promise<OdmInstallRecord | null> {
  try {
    const parsed = OdmInstallRecord.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** `<dataRoot>/runtime/odm.json`, or null when it is missing or not a record. */
export function readRecord(dataRoot: string): Promise<OdmInstallRecord | null> {
  return readRecordAt(odmRecordPath(dataRoot));
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
  // an install whose start check has not passed is not given to jobs
  if (!rec || rec.verified === false || (await filesPresent(d.system, rec.dir)) !== null)
    return null;
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
  const outdated = compareVersions(rec.version, pin.version) < 0;
  // an older version is offered its update (a full install) rather than another start check
  if (rec.verified === false && !outdated) {
    const noRuntime = await missingVcRuntime(d.env, (p) => d.system.exists(p));
    const problem = noRuntime.length > 0 ? `${UNVERIFIED} ${VC_RUNTIME_HINT}` : UNVERIFIED;
    return { ...s, ...found, state: 'unverified', problem };
  }
  const problem = await stubProblem(rec.dir, setting, d.env, d.system);
  const state = outdated ? 'update-available' : 'installed';
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

async function writeRecord(
  dataRoot: string,
  rec: OdmInstallRecord,
  path = odmRecordPath(dataRoot),
): Promise<void> {
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

/** Another ODM that would be replaced without asking, or too little free space: the refusal. */
async function preflight(
  d: OdmDeps,
  replaceOther: boolean,
  old: OdmInstallRecord | null,
  target: string,
  setup: string,
  pin: { size: number; installedBytes: number },
): Promise<Failure | null> {
  const { system, env } = d;
  const other = await findOtherOdm({
    regQuery: (k, s) => system.regQuery(k, s),
    exists: (p) => system.exists(p),
    ours: ourDirs(old, target),
    env,
  });
  if (other && !replaceOther)
    return fail(
      `Another ODM is installed in ${other.dir}. Installing replaces it.`,
      'other-install',
    );

  // the setup lands in the data root, ODM in the install folder: each drive needs its share
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
  return null;
}

/**
 * Download, verify and install the pinned ODM per user, then check that it starts. A start check
 * that runs out of time keeps the install, recorded unverified; installing again then reruns only
 * the start check (Try again), with no download and no setup.
 */
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
  const setup = join(downloadDir(dataRoot), pin.file);
  const retry =
    old?.verified === false &&
    old.version === pin.version &&
    sameDir(old.dir, target) &&
    (await filesPresent(system, target)) === null;
  if (!retry) {
    const refused = await preflight(d, o.replaceOther, old, target, setup, pin);
    if (refused) return refused;
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

  if (!retry) {
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
  }

  // Past this point a failure removes what the setup left (folder and uninstall entry), unless
  // it was installed over our recorded ODM: that one is then reported broken until reinstalled.
  // An unverified install that fails its start check for real goes, record and all, as a failed
  // install does; the working ODM an update replaced (odm-previous.json) is recorded again. The
  // setup's own log stays, outside that folder.
  const setupLog = odmSetupLogPath(dataRoot, pin.version);
  const previousPath = odmPreviousRecordPath(dataRoot);
  /** The record now names `target` (written before the start check). */
  let recorded = retry;
  const rollback = async (error: string): Promise<Failure> => {
    d.log?.(`ODM: the install failed: ${error} The setup's log: ${setupLog}`);
    if (retry || !old || !sameDir(old.dir, target)) {
      try {
        await uninstallFolder(d, target, isOurOdmFolder(target, dataRoot, env));
      } catch (e) {
        d.log?.(`ODM: could not remove the failed install in ${target}: ${message(e)}`);
      }
      // apart from the uninstall: a failed one must not keep the older record from coming back
      if (recorded) {
        try {
          const previous = await readRecordAt(previousPath);
          if (previous) await writeRecord(dataRoot, previous);
          else await system.rm(odmRecordPath(dataRoot));
          await system.rm(previousPath);
        } catch (e) {
          d.log?.(`ODM: the earlier install could not be recorded again: ${message(e)}`);
        }
      }
    }
    return failed(error);
  };

  /**
   * An older version's folder of ours. ODM's setup may have uninstalled it already; the parked
   * placeholder (unknown to its uninstaller) keeps the folder. One that cannot go is a warning.
   */
  const removeEarlier = async (dir: string) => {
    try {
      await system.rm(dir);
    } catch (e) {
      d.log?.(`ODM: the earlier version in ${dir} could not be removed: ${message(e)}`);
    }
  };

  const installedAt = retry ? old.installedAt : d.now().toISOString();
  const record = (verified: boolean): OdmInstallRecord => ({
    schema: 'aio.odm-install/1',
    version: pin.version,
    dir: target,
    installedAt,
    ...(verified ? {} : { verified: false }),
  });
  let verified = true;
  try {
    if (!retry) {
      progress('install');
      await mkdir(dirname(setupLog), { recursive: true });
      // unquoted: Node quotes an argument with a space (the data root may have one), Inno takes it whole
      const code = await system.runSetup(setup, [
        ...SETUP_ARGS,
        `/DIR=${target}`,
        `/LOG=${setupLog}`,
      ]);
      if (code === 2 || code === 5)
        return await rollback(
          'The installation was cancelled (a Windows permission prompt may have been declined).',
        );
      if (code !== 0) return await rollback(`ODM's setup stopped with exit code ${String(code)}.`);
    }

    progress('check');
    const missing = await filesPresent(system, target);
    if (missing !== null) return await rollback(`ODM's setup finished but ${missing} is missing.`);
    // Only reached on Windows x64 (`supported`); the per-user setup may leave the runtime out.
    // ODM brings some of it along, so a gap is only the likely cause when ODM does not start.
    const noRuntime = await missingVcRuntime(env, (p) => system.exists(p));
    if (noRuntime.length > 0)
      d.log?.(`ODM: the C++ runtime is missing from System32: ${noRuntime.join(', ')}`);
    // Recorded unverified before the check: a quit or a cancel during it leaves an install that
    // Try again picks up, never a folder nobody knows of. The ODM an update replaces stays (folder
    // and record, verified or not) until the check passes. Only one is kept: a working one already
    // kept from an earlier slow update wins, and an unverified one in between goes now.
    if (!recorded) {
      if (old && !sameDir(old.dir, target)) {
        const kept = await readRecordAt(previousPath);
        if (!kept || old.verified !== false) await writeRecord(dataRoot, old, previousPath);
        else if (isOurOdmFolder(old.dir, dataRoot, env)) await removeEarlier(old.dir);
      }
      await writeRecord(dataRoot, record(false));
      recorded = true;
    }
    // run.bat exits 0 even when it fails to start ODM: its usage text is the proof
    const started = d.now().getTime();
    const smoke = await system.runSmoke(target, o.signal);
    const secs = Math.round((d.now().getTime() - started) / 1000);
    d.log?.(
      `ODM: start check: ${String(secs)} s, exit code ${String(smoke.code)}, ${o.signal.aborted || smoke.stopped === true ? 'cancelled' : smoke.timedOut ? 'timed out' : 'finished'}; output: ${smoke.out.slice(-SMOKE_LOG_CHARS).trim() || '(none)'}`,
    );
    // a cancel, or the app quitting: the check was stopped, ODM stays installed and unverified
    if (o.signal.aborted || smoke.stopped === true) {
      progress('cancelled');
      return fail(CHECK_CANCELLED, 'cancelled');
    }
    // the usage text printed counts, even when the timer stopped it just after
    const passed = /usage: run/i.test(smoke.out) && (smoke.code === 0 || smoke.timedOut === true);
    // a slow first start is no proof of a broken install: kept, it waits for Try again
    if (!passed && smoke.timedOut) {
      verified = false;
      d.log?.(
        `ODM: did not finish starting within ${String(SMOKE_TIMEOUT_MS / 60_000)} minutes; kept, unverified, for Try again.`,
      );
    } else if (!passed)
      return await rollback(
        noRuntime.length > 0
          ? VC_RUNTIME_MISSING
          : `ODM installed but does not start: ${lastLine(smoke.out) ?? `exit code ${String(smoke.code)}`}`,
      );
  } catch (e) {
    return await rollback(message(e));
  }

  try {
    await parkOrWarn(d, target, d.gpuSetting());
    await writeRecord(dataRoot, record(verified));
    if (verified) {
      // the older versions go once this one starts: the one an update replaced, and its record
      const previous = await readRecordAt(previousPath);
      for (const earlier of [previous, old]) {
        if (!earlier || sameDir(earlier.dir, target) || !isOurOdmFolder(earlier.dir, dataRoot, env))
          continue;
        await removeEarlier(earlier.dir);
      }
      await system.rm(previousPath);
    } else if (old && !sameDir(old.dir, target))
      d.log?.(`ODM: the earlier version in ${old.dir} is kept until this one starts.`);
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
  // only delete leftovers of a folder that looks like our install before uninstalling
  const mayDelete = async (dir: string) =>
    isOurOdmFolder(dir, dataRoot, d.env) &&
    ((await system.exists(win32.join(dir, 'run.bat'))) ||
      (await system.exists(win32.join(dir, 'unins000.exe'))));
  if (rec) {
    try {
      const ours = await mayDelete(rec.dir);
      // the uninstaller only knows nvcuda.dll: put the placeholder back first
      await parkOrWarn(d, rec.dir, 'off');
      await uninstallFolder(d, rec.dir, ours);
      // an update still waiting for its start check kept the older version: it goes too
      const previous = await readRecordAt(odmPreviousRecordPath(dataRoot));
      if (previous) {
        const oursToo = await mayDelete(previous.dir);
        await parkOrWarn(d, previous.dir, 'off');
        await uninstallFolder(d, previous.dir, oursToo);
      }
      await system.rm(odmPreviousRecordPath(dataRoot));
      // a cancelled or stopped start check left the setup behind
      await system.rm(join(downloadDir(dataRoot), (await pinFrom(d.env)).file));
      await system.rm(odmRecordPath(dataRoot));
    } catch (e) {
      return fail(`ODM could not be removed: ${message(e)}`, 'failed');
    }
  }
  return { ok: true, status: await odmStatus(d, false) };
}

const ODM_PIPELINES = new Set(['photo.align', 'photo.georef', 'photo.products']);

/**
 * What a photo job is told about ODM; `AIO_ODM_OWNED` lets the runner park the stub (dev. 17).
 * The junctions go beside our own install; a dev ODM (`QUADRION_ODM_DIR`, such as the fake in the
 * repository) keeps an `AIO_ODM_WORK` the app itself was given, so they never land in its folder.
 */
export function odmJobEnv(
  pipeline: string,
  odm: { dir: string; version: string; owned: boolean } | null,
  gpu: OdmGpuSetting,
  appEnv: Record<string, string | undefined> = {},
): Record<string, string> {
  if (!odm || !ODM_PIPELINES.has(pipeline)) return {};
  return {
    AIO_ODM: odm.dir,
    AIO_ODM_VERSION: odm.version,
    AIO_ODM_GPU: gpu,
    AIO_ODM_WORK: (odm.owned ? undefined : appEnv.AIO_ODM_WORK) ?? odmWorkRoot(odm.dir),
    ...(odm.owned ? { AIO_ODM_OWNED: '1' } : {}),
  };
}
