import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Copy an installer into a fresh private folder under `dir` (`<userData>/updates/verified/...`)
 * before it is checked, so the file that passed the check is the file that runs: the original
 * (in Downloads, or where the person picked it) could be swapped between the check and the start.
 */
export async function stageInstaller(src: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const folder = await mkdtemp(join(dir, 'v-'));
  const dest = join(folder, basename(src));
  await copyFile(src, dest, constants.COPYFILE_EXCL);
  return dest;
}

/** What a command printed and how it ended (macOS `codesign`, `spctl`). */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Run = (file: string, args: string[]) => Promise<RunResult>;

/**
 * Check a macOS disk image before it is opened: a valid code signature (`codesign --verify
 * --strict`), made by the Apple Developer team pinned in brand.json (`signing.macTeamId`), and
 * accepted by Gatekeeper (`spctl --assess --type open`). Without a pinned team the app refuses:
 * opening an unchecked image would run whatever it holds.
 */
export async function verifyMacImage(
  path: string,
  teamId: string | undefined,
  run: Run,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const team = teamId?.trim();
  if (!team)
    return {
      ok: false,
      error:
        'Updates cannot be installed by the app on macOS yet: this build has no Apple team configured (signing.macTeamId in brand.json). Open the new .dmg yourself.',
    };
  const v = await run('codesign', ['--verify', '--strict', '--verbose=2', path]);
  if (v.code !== 0)
    return { ok: false, error: `The disk image's signature is not valid: ${firstLine(v.stderr)}` };
  const d = await run('codesign', ['-dvv', path]);
  const found = /^TeamIdentifier=(.+)$/m.exec(`${d.stdout}\n${d.stderr}`)?.[1]?.trim();
  if (d.code !== 0 || found !== team)
    return {
      ok: false,
      error: `The disk image is signed by team ${found ?? 'unknown'}, not by ${team}.`,
    };
  const g = await run('spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    '-v',
    path,
  ]);
  if (g.code !== 0)
    return { ok: false, error: `Gatekeeper refuses the disk image: ${firstLine(g.stderr)}` };
  return { ok: true };
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? 'no detail').trim().slice(0, 300);
}

/** Run a command without a shell and collect its output (never rejects). */
export const runCommand: Run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout, stderr: stderr || (err?.message ?? '') });
    });
  });
