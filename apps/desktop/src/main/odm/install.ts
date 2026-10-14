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
import { downloadDir, odmInstallDir, odmRecordPath, odmWorkRoot } from './paths';
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
}

type Env = Record<string, string | undefined>;
type Failure = Extract<OdmInstallResult, { ok: false }>;

const UNSUPPORTED = 'ODM installs on Windows x64 only.';
const BROKEN = 'Files of the processing engine are missing. Reinstall it.';
const OFFLINE =
  'This computer is set to offline only. Switch that off in Settings, Privacy to download the processing engine.';
const DEV = 'ODM comes from QUADRION_ODM_DIR here; install and remove are off.';

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

export async function odmStatus(d: OdmDeps, installing: boolean): Promise<OdmStatus> {
  const pin = await pinFrom(d.env);
  const base = {
    pinned: { version: pin.version, downloadBytes: pin.size, installedBytes: pin.installedBytes },
    gpu: {
      setting: d.gpuSetting(),
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
  const rec = devDir ? null : await readRecord(d.dataRoot());
  const ours = devDir ?? rec?.dir ?? null;
  const other = await findOtherOdm({
    regQuery: (k) => d.system.regQuery(k),
    exists: (p) => d.system.exists(p),
    ours,
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
  if (compareVersions(rec.version, pin.version) < 0)
    return { ...s, ...found, state: 'update-available' };
  return { ...s, ...found, state: 'installed' };
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
  const bin = win32.join(dir, 'SuperBuild', 'install', 'bin');
  const dll = win32.join(bin, 'nvcuda.dll');
  const stub = win32.join(bin, 'nvcuda.dll.odm-stub');
  if (gpu === 'auto' && (await nvcudaPresent(env, (p) => system.exists(p)))) {
    const size = await system.fileBytes(dll);
    if (size !== null && size < STUB_MAX_BYTES) await system.rename(dll, stub);
  } else if ((await system.exists(stub)) && !(await system.exists(dll))) {
    await system.rename(stub, dll);
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
    regQuery: (k) => system.regQuery(k),
    exists: (p) => system.exists(p),
    ours: old?.dir ?? target,
    env,
  });
  if (other && !o.replaceOther)
    return fail(
      `Another ODM is installed in ${other.dir}. Installing replaces it.`,
      'other-install',
    );

  const drive = win32.parse(target).root;
  const need = pin.size + pin.installedBytes;
  const free = await system.freeBytes(drive);
  if (free < need)
    return fail(
      `Not enough free space on ${drive}: the processing engine needs about ${gb(need)}, ${gb(free)} is free.`,
      'disk',
    );

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

  const setup = join(downloadDir(dataRoot), pin.file);
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
    if (o.signal.aborted) {
      // the partial file stays, so the next try continues it
      progress('cancelled');
      return fail('The download was cancelled.', 'cancelled');
    }
    return failed(message(e));
  }

  try {
    progress('install');
    const code = await system.runSetup(setup, [...SETUP_ARGS, `/DIR=${target}`]);
    if (code === 2 || code === 5)
      return failed(
        'The installation was cancelled (a Windows permission prompt may have been declined).',
      );
    if (code !== 0) return failed(`ODM's setup stopped with exit code ${String(code)}.`);

    progress('check');
    const missing = await filesPresent(system, target);
    if (missing !== null) return failed(`ODM's setup finished but ${missing} is missing.`);
    // run.bat exits 0 even when it fails to start ODM: its usage text is the proof
    const smoke = await system.runSmoke(target);
    if (smoke.code !== 0 || !/usage: run/i.test(smoke.out))
      return failed(
        `ODM installed but does not start: ${lastLine(smoke.out) ?? `exit code ${String(smoke.code)}`}`,
      );

    await parkOdmStub(target, d.gpuSetting(), env, system);
    await writeRecord(dataRoot, {
      schema: 'aio.odm-install/1',
      version: pin.version,
      dir: target,
      installedAt: d.now().toISOString(),
    });
    if (old && old.dir.toLowerCase() !== target.toLowerCase() && (await system.exists(old.dir)))
      await system.rm(old.dir);
    await system.rm(setup);
    progress('done');
    return { ok: true, status: await odmStatus(d, false) };
  } catch (e) {
    return failed(message(e));
  }
}

/** Uninstall the ODM this app installed and forget it. */
export async function removeOdm(d: OdmDeps): Promise<OdmInstallResult> {
  if (d.env.QUADRION_ODM_DIR) return fail(DEV, 'dev');
  const { system } = d;
  const rec = await readRecord(d.dataRoot());
  if (rec) {
    try {
      // the uninstaller only knows nvcuda.dll: put the placeholder back first
      await parkOdmStub(rec.dir, 'off', d.env, system);
      const uninstaller = win32.join(rec.dir, 'unins000.exe');
      if (await system.exists(uninstaller)) {
        await system.runUninstaller(uninstaller, [...UNINSTALL_ARGS]);
        for (let i = 0; i < UNINSTALL_POLLS; i++) {
          if (!(await system.exists(win32.join(rec.dir, 'run.bat')))) break;
          await system.sleep(1000);
        }
      }
      if (await system.exists(rec.dir)) await system.rm(rec.dir);
      await system.rm(odmRecordPath(d.dataRoot()));
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
