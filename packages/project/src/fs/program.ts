import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, win32 } from 'node:path';

type Env = Record<string, string | undefined>;

const isWin = (platform: NodeJS.Platform) => platform === 'win32';

/** `%SystemRoot%\System32`, where Windows keeps its own programs. */
export function system32(env: Env = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
  return win32.join(isAbsolute(root) || win32.isAbsolute(root) ? root : 'C:\\Windows', 'System32');
}

/** A Windows program by its full System32 path (`taskkill`, `reg`, `cmd`, `powershell` ...). */
export function systemProgram(name: string, env: Env = process.env): string {
  if (name.toLowerCase() === 'powershell')
    return win32.join(system32(env), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return win32.join(system32(env), /\.exe$/i.test(name) ? name : `${name}.exe`);
}

function runnable(p: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (!isWin(platform)) accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The absolute path of a program found on the PATH, looking only in absolute PATH folders (never
 * the current folder or a relative entry: Windows' process search would otherwise run a program
 * of that name planted in a project folder). A name that is already an absolute path is kept.
 * When nothing is found, an absolute path that does not exist is given, so starting it fails as
 * "not found" (ENOENT) just as a missing program did before, instead of searching the current
 * folder.
 */
export function programPath(
  name: string,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (isAbsolute(name) || (isWin(platform) && win32.isAbsolute(name))) return name;
  const sep = isWin(platform) ? ';' : delimiter;
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(sep)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '' && (isWin(platform) ? win32.isAbsolute(d) : isAbsolute(d)));
  const exts = isWin(platform)
    ? /\.[a-z0-9]+$/i.test(name)
      ? ['']
      : (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '')
    : [''];
  const joinIn = (d: string, f: string) => (isWin(platform) ? win32.join(d, f) : join(d, f));
  for (const d of dirs)
    for (const e of exts) {
      const p = joinIn(d, `${name}${e}`);
      if (runnable(p, platform)) return p;
    }
  return isWin(platform)
    ? win32.join(system32(env), 'missing', `${name}.exe`)
    : `/nonexistent/${name}`;
}

/** A program named by an environment variable (absolute, or looked up as {@link programPath}). */
export function programFromEnv(
  value: string | undefined,
  fallback: string,
  env: Env = process.env,
): string {
  return programPath(value !== undefined && value !== '' ? value : fallback, env);
}
