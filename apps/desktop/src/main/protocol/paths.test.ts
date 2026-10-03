import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveInside } from './paths';

let base: string;
let root: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-paths-'));
  root = join(base, 'project');
  await mkdir(join(root, 'video'), { recursive: true });
  await writeFile(join(root, 'manifest.json'), '{}');
  await writeFile(join(root, 'video', 'clip 1.mp4'), 'x');
  await mkdir(join(base, 'outside'));
  await writeFile(join(base, 'outside', 'secret.txt'), 'secret');
  await writeFile(join(base, 'sibling.txt'), 'nope');
  // A junction needs no admin rights on Windows and is a plain symlink elsewhere.
  await symlink(join(base, 'outside'), join(root, 'escape'), 'junction');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('resolveInside', () => {
  it('resolves a file inside the root', async () => {
    const r = await resolveInside(root, 'manifest.json');
    expect(r).toEqual({ ok: true, path: await realpath(join(root, 'manifest.json')) });
  });

  it('resolves nested paths with spaces', async () => {
    const r = await resolveInside(root, 'video/clip 1.mp4');
    expect(r.ok).toBe(true);
  });

  it('rejects parent segments', async () => {
    expect(await resolveInside(root, '../sibling.txt')).toEqual({ ok: false, status: 403 });
    expect(await resolveInside(root, 'video/../../sibling.txt')).toEqual({
      ok: false,
      status: 403,
    });
    expect(await resolveInside(root, 'video\\..\\..\\sibling.txt')).toEqual({
      ok: false,
      status: 403,
    });
  });

  it('rejects absolute paths and drive letters', async () => {
    expect((await resolveInside(root, '/etc/passwd')).ok).toBe(false);
    expect((await resolveInside(root, '\\Windows\\win.ini')).ok).toBe(false);
    expect((await resolveInside(root, 'C:/Windows/win.ini')).ok).toBe(false);
    expect((await resolveInside(root, join(base, 'sibling.txt'))).ok).toBe(false);
  });

  it('rejects NUL bytes and empty paths', async () => {
    expect((await resolveInside(root, 'manifest.json\0.png')).ok).toBe(false);
    expect((await resolveInside(root, '')).ok).toBe(false);
  });

  it('rejects a symlink or junction that escapes the root', async () => {
    expect(await resolveInside(root, 'escape/secret.txt')).toEqual({ ok: false, status: 403 });
  });

  it('returns 404 for a missing file and for a directory', async () => {
    expect(await resolveInside(root, 'nope.json')).toEqual({ ok: false, status: 404 });
    expect(await resolveInside(root, 'video')).toEqual({ ok: false, status: 404 });
  });
});
