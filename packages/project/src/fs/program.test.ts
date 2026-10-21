import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { programPath, system32, systemProgram } from './program';

let base: string;
let bin: string;
let project: string;
const cwd = process.cwd();

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-program-'));
  bin = join(base, 'bin');
  project = join(base, 'project');
  await mkdir(bin);
  await mkdir(project);
  await writeFile(join(bin, 'tool.exe'), 'x');
  // a program of the same name planted in the folder a job runs in
  await writeFile(join(project, 'planted.exe'), 'x');
  await writeFile(join(project, 'tool.exe'), 'x');
  process.chdir(project);
});

afterAll(async () => {
  process.chdir(cwd);
  await rm(base, { recursive: true, force: true });
});

describe('programPath', () => {
  const env = () => ({
    PATH: ['.', 'relative', bin].join(';'),
    PATHEXT: '.EXE',
    SystemRoot: 'C:\\Windows',
  });

  it('finds a program in an absolute PATH folder', () => {
    expect(programPath('tool', env(), 'win32').toLowerCase()).toBe(
      win32.join(bin, 'tool.exe').toLowerCase(),
    );
  });

  it('never takes a program from the current folder or a relative PATH entry', () => {
    const p = programPath('planted', env(), 'win32');
    expect(p).not.toContain(project);
    expect(win32.isAbsolute(p)).toBe(true);
    expect(p.toLowerCase().startsWith('c:\\windows\\system32')).toBe(true);
  });

  it('keeps an absolute path as given', () => {
    expect(programPath('D:\\tools\\ffmpeg.exe', env(), 'win32')).toBe('D:\\tools\\ffmpeg.exe');
  });
});

describe('systemProgram', () => {
  it('names Windows programs by their System32 path', () => {
    const env = { SystemRoot: 'D:\\Win' };
    expect(system32(env)).toBe('D:\\Win\\System32');
    expect(systemProgram('taskkill', env)).toBe('D:\\Win\\System32\\taskkill.exe');
    expect(systemProgram('cmd.exe', env)).toBe('D:\\Win\\System32\\cmd.exe');
    expect(systemProgram('powershell', env)).toBe(
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
  });

  it('ignores a relative SystemRoot', () => {
    expect(system32({ SystemRoot: 'evil' })).toBe('C:\\Windows\\System32');
  });
});
