import { win32 } from 'node:path';

/** One program in Windows' uninstall list (`reg query` output). */
export interface UninstallEntry {
  key: string;
  displayName: string;
  installLocation?: string;
  displayVersion?: string;
  publisher?: string;
  /** Inno Setup's own record of the folder (`Inno Setup: App Path`). */
  appPath?: string;
  uninstallString?: string;
}

/** ODM's setup registers as `ODM version 3.6.2` (C14), published by OpenDroneMap. */
export const UNINSTALL_MATCH = /^ODM\b/i;
const PUBLISHER_MATCH = /opendronemap/i;

/** Where Windows lists installed programs, per user first. */
const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

/** The folder ODM's setup offers by default. */
const DEFAULT_ODM_DIR = 'C:\\ODM';

/** Parse `reg query <key> /s ...` output; entries without a DisplayName are left out. */
export function parseUninstallEntries(text: string): UninstallEntry[] {
  const out: UninstallEntry[] = [];
  let key: string | null = null;
  let values: Record<string, string> = {};
  const flush = () => {
    const displayName = values.DisplayName;
    if (key && displayName) {
      const e: UninstallEntry = { key, displayName };
      if (values.InstallLocation) e.installLocation = values.InstallLocation;
      if (values.DisplayVersion) e.displayVersion = values.DisplayVersion;
      if (values.Publisher) e.publisher = values.Publisher;
      if (values['Inno Setup: App Path']) e.appPath = values['Inno Setup: App Path'];
      if (values.UninstallString) e.uninstallString = values.UninstallString;
      out.push(e);
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      flush();
      key = line.trim();
      values = {};
      continue;
    }
    // value names may hold spaces (`Inno Setup: App Path`); the data may be empty
    const m = /^\s+(.+?)\s+REG_[A-Z0-9_]+(?:\s+(.*))?$/.exec(line);
    if (m && key) values[m[1] ?? ''] = (m[2] ?? '').trim();
  }
  flush();
  return out;
}

const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();

/** The folder of an uninstall entry: its InstallLocation, Inno's App Path, or the uninstaller's folder. */
function entryDir(e: UninstallEntry): string | null {
  const uninstaller = /^"?([^"]+\\)[^"\\]+\.exe"?/i.exec(e.uninstallString ?? '')?.[1];
  const dir = e.installLocation ?? e.appPath ?? uninstaller; // the parser leaves empty values out
  return dir ? dir.replace(/[\\/]+$/, '') : null;
}

/**
 * Another ODM on this computer, which ODM's setup would replace: an uninstall entry named
 * `ODM ...` (published by OpenDroneMap when it names a publisher) whose folder is not ours
 * (`ours`: one folder or several), else `C:\ODM\run.bat`. The entries are found by searching the
 * values for "ODM" (`regQuery(key, 'ODM')`, which prints only the matching values), then each one
 * is read in full (`regQuery(entryKey)`), so a folder without "ODM" in its path is seen too; one
 * whose folder cannot be read is named by its entry, and still asked about. In end to end tests
 * `QUADRION_ODM_OTHER` stands for one.
 */
export async function findOtherOdm(d: {
  regQuery(key: string, search?: string): Promise<string>;
  exists(p: string): Promise<boolean>;
  ours: string | readonly (string | null | undefined)[] | null;
  env: Record<string, string | undefined>;
}): Promise<{ dir: string; version?: string } | null> {
  if (d.env.QUADRION_E2E === '1' && d.env.QUADRION_ODM_OTHER)
    return { dir: d.env.QUADRION_ODM_OTHER };
  const ours = new Set(
    (typeof d.ours === 'string' ? [d.ours] : (d.ours ?? []))
      .filter((p) => !!p)
      .map((p) => norm(p ?? '')),
  );
  for (const key of UNINSTALL_KEYS) {
    for (const found of parseUninstallEntries(await d.regQuery(key, 'ODM'))) {
      if (!UNINSTALL_MATCH.test(found.displayName)) continue;
      const full = parseUninstallEntries(await d.regQuery(found.key)).find(
        (e) => e.key.toLowerCase() === found.key.toLowerCase(),
      );
      const e = { ...found, ...full };
      if (e.publisher && !PUBLISHER_MATCH.test(e.publisher)) continue;
      const dir = entryDir(e) ?? e.displayName;
      if (ours.has(norm(dir))) continue;
      const version = e.displayVersion ?? /\bversion\s+(\S+)/i.exec(e.displayName)?.[1];
      return version ? { dir, version } : { dir };
    }
  }
  if (!ours.has(norm(DEFAULT_ODM_DIR)) && (await d.exists(win32.join(DEFAULT_ODM_DIR, 'run.bat'))))
    return { dir: DEFAULT_ODM_DIR };
  return null;
}

const system32 = (env: Record<string, string | undefined>) =>
  win32.join(env.SYSTEMROOT ?? env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32');

/** NVIDIA's CUDA driver is installed: `%SYSTEMROOT%\System32\nvcuda.dll` exists. */
export async function nvcudaPresent(
  env: Record<string, string | undefined>,
  exists: (p: string) => Promise<boolean>,
): Promise<boolean> {
  return exists(win32.join(system32(env), 'nvcuda.dll'));
}

/** Microsoft's Visual C++ 2015-2022 x64 runtime, which ODM's Python and programs load. */
export const VC_RUNTIME_FILES: readonly string[] = [
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'msvcp140.dll',
];

/**
 * The files of the C++ runtime missing from `%SYSTEMROOT%\System32`. ODM's per-user setup may not
 * install it without administrator rights, and still exits 0.
 */
export async function missingVcRuntime(
  env: Record<string, string | undefined>,
  exists: (p: string) => Promise<boolean>,
): Promise<string[]> {
  const out: string[] = [];
  for (const f of VC_RUNTIME_FILES) if (!(await exists(win32.join(system32(env), f)))) out.push(f);
  return out;
}

/** The NVIDIA card's name, or null when there is none. */
export function nvidiaName(gpus: readonly { name: string; vendor?: string }[]): string | null {
  const card = gpus.find(
    (g) => /nvidia/i.test(g.vendor ?? '') || /nvidia|geforce|quadro/i.test(g.name),
  );
  return card?.name ?? null;
}
