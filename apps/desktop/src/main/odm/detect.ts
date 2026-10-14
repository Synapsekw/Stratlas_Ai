import { win32 } from 'node:path';

/** One program in Windows' uninstall list (`reg query` output). */
export interface UninstallEntry {
  key: string;
  displayName: string;
  installLocation?: string;
  displayVersion?: string;
}

/** ODM's setup registers as `ODM version 3.6.2` (C14). */
export const UNINSTALL_MATCH = /^ODM\b/i;

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
    const m = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
    if (m && key) values[m[1] ?? ''] = (m[2] ?? '').trim();
  }
  flush();
  return out;
}

const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();

/**
 * Another ODM on this computer, which ODM's setup would replace: an uninstall entry whose folder
 * is not ours, else `C:\ODM\run.bat`. In end to end tests `QUADRION_ODM_OTHER` stands for one.
 */
export async function findOtherOdm(d: {
  regQuery(key: string): Promise<string>;
  exists(p: string): Promise<boolean>;
  ours: string | null;
  env: Record<string, string | undefined>;
}): Promise<{ dir: string; version?: string } | null> {
  if (d.env.QUADRION_E2E === '1' && d.env.QUADRION_ODM_OTHER)
    return { dir: d.env.QUADRION_ODM_OTHER };
  const ours = d.ours ? norm(d.ours) : null;
  for (const key of UNINSTALL_KEYS) {
    for (const e of parseUninstallEntries(await d.regQuery(key))) {
      if (!UNINSTALL_MATCH.test(e.displayName) || !e.installLocation) continue;
      const dir = e.installLocation.replace(/[\\/]+$/, '');
      if (norm(dir) === ours) continue;
      // `reg query /f ODM /d` prints only values holding "ODM": the version is in the name then
      const version = e.displayVersion ?? /\bversion\s+(\S+)/i.exec(e.displayName)?.[1];
      return version ? { dir, version } : { dir };
    }
  }
  if (norm(DEFAULT_ODM_DIR) !== ours && (await d.exists(win32.join(DEFAULT_ODM_DIR, 'run.bat'))))
    return { dir: DEFAULT_ODM_DIR };
  return null;
}

/** NVIDIA's CUDA driver is installed: `%SYSTEMROOT%\System32\nvcuda.dll` exists. */
export async function nvcudaPresent(
  env: Record<string, string | undefined>,
  exists: (p: string) => Promise<boolean>,
): Promise<boolean> {
  const root = env.SYSTEMROOT ?? env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  return exists(win32.join(root, 'System32', 'nvcuda.dll'));
}

/** The NVIDIA card's name, or null when there is none. */
export function nvidiaName(gpus: readonly { name: string; vendor?: string }[]): string | null {
  const card = gpus.find(
    (g) => /nvidia/i.test(g.vendor ?? '') || /nvidia|geforce|quadro/i.test(g.name),
  );
  return card?.name ?? null;
}
