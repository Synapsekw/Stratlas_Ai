import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntennasFile } from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import type { SurveyArchive } from './survey';
import { readAntennaCrop, readAntennas, registerTelecomIpc, writeAntennas } from './telecom';

const contract = JSON.parse(
  readFileSync(
    new URL('../../../../packages/schema/src/__fixtures__/antennas-contract.json', import.meta.url),
    'utf8',
  ),
) as { example: unknown };
const sample = (): AntennasFile => AntennasFile.parse(contract.example);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(pkgMembers?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'aio-telecom-'));
  dirs.push(root);
  const archive: SurveyArchive = {
    entries: new Map(Object.entries(pkgMembers ?? {})),
    read: (name) => Promise.resolve(Buffer.from(JSON.stringify(pkgMembers?.[name]), 'utf8')),
  };
  const projects = {
    root: (id: string) => (id === 'p' ? root : undefined),
    package: (id: string) => (id === 'pkg' ? { archive } : undefined),
  };
  return { root, projects };
}
const antPath = (root: string) => join(root, 'telecom', 'antennas.json');

describe('antenna inventory files', () => {
  it('reads null when there is no run yet', async () => {
    const { projects } = setup();
    expect(await readAntennas(projects, 'p')).toEqual({ ok: true, file: null, readOnly: false });
  });

  it('writes atomically with a .bak and reads it back', async () => {
    const { root, projects } = setup();
    const first = sample();
    expect(await writeAntennas(projects, 'p', first)).toEqual({ ok: true });
    expect(existsSync(`${antPath(root)}.bak`)).toBe(false);
    const second = { ...first, units: first.units.slice(0, 1) };
    expect(await readAntennas(projects, 'p')).toEqual({ ok: true, file: first, readOnly: false });
    expect(await writeAntennas(projects, 'p', second)).toEqual({ ok: true });
    expect(existsSync(`${antPath(root)}.bak`)).toBe(true);
    expect(
      (JSON.parse(readFileSync(`${antPath(root)}.bak`, 'utf8')) as AntennasFile).units,
    ).toHaveLength(first.units.length);
    expect(await readAntennas(projects, 'p')).toEqual({ ok: true, file: second, readOnly: false });
  });

  it('refuses a write over a newer file on disk', async () => {
    const { root, projects } = setup();
    expect(await writeAntennas(projects, 'p', sample())).toEqual({ ok: true });
    await readAntennas(projects, 'p');
    // a job commits a new version after the read
    const jobs = { ...sample(), units: [] };
    writeFileSync(antPath(root), JSON.stringify(jobs) + ' ');
    const w = await writeAntennas(projects, 'p', sample());
    expect(w.ok).toBe(false);
    expect(readFileSync(antPath(root), 'utf8')).toBe(JSON.stringify(jobs) + ' ');
  });

  it('refuses writes into a package and reads from it read-only', async () => {
    const { projects } = setup({ 'telecom/antennas.json': sample() });
    expect(await writeAntennas(projects, 'pkg', sample())).toMatchObject({
      ok: false,
      code: 'read-only',
    });
    expect(await readAntennas(projects, 'pkg')).toEqual({
      ok: true,
      file: sample(),
      readOnly: true,
    });
    const empty = setup();
    expect(
      await readAntennas(
        {
          ...empty.projects,
          root: () => undefined,
          package: () => ({
            archive: { entries: new Map(), read: () => Promise.reject(new Error('none')) },
          }),
        },
        'x',
      ),
    ).toEqual({ ok: true, file: null, readOnly: true });
  });

  it('refuses a file saved by a newer version, and never writes over it', async () => {
    const { root, projects } = setup();
    mkdirSync(join(root, 'telecom'));
    const newer = JSON.stringify({ schema: 'aio.antennas/2', units: [] });
    writeFileSync(antPath(root), newer);
    const r = await readAntennas(projects, 'p');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/newer version/i);
    const w = await writeAntennas(projects, 'p', sample());
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.error).toMatch(/newer version/i);
    expect(readFileSync(antPath(root), 'utf8')).toBe(newer);
  });

  it('answers an unknown project and an invalid file', async () => {
    const { root, projects } = setup();
    expect(await readAntennas(projects, 'nope')).toMatchObject({ ok: false });
    expect(await writeAntennas(projects, 'nope', sample())).toMatchObject({ ok: false });
    mkdirSync(join(root, 'telecom'));
    writeFileSync(antPath(root), JSON.stringify({ schema: 'aio.antennas/1', units: [{}] }));
    const r = await readAntennas(projects, 'p');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/antennas\.json is invalid/);
  });

  it('reads a crop only from telecom/crops and only for a safe unit id', async () => {
    const { root } = setup();
    mkdirSync(join(root, 'telecom', 'crops'), { recursive: true });
    writeFileSync(join(root, 'telecom', 'crops', 'ant-a3.jpg'), Buffer.from([1, 2, 3]));
    writeFileSync(join(root, 'telecom', 'manifest.jpg'), Buffer.from([9]));
    const ok = await readAntennaCrop(root, 'ant-a3');
    expect(ok?.bytes).toEqual(Buffer.from([1, 2, 3]));
    expect(ok?.path).toBe(join(root, 'telecom', 'crops', 'ant-a3.jpg'));
    expect(await readAntennaCrop(root, '../manifest')).toBeNull();
    expect(await readAntennaCrop(root, 'ant-a3/../../x')).toBeNull();
    expect(await readAntennaCrop(root, 'ant-missing')).toBeNull();
  });

  it('registers both channels', async () => {
    const { projects } = setup();
    const ipc = collectHandlers((handle) => {
      registerTelecomIpc({ handle, projects });
    });
    expect(await ipc.call('telecom:readAntennas', { projectId: 'p' })).toMatchObject({
      ok: true,
      file: null,
    });
    expect(await ipc.call('telecom:writeAntennas', { projectId: 'p', file: sample() })).toEqual({
      ok: true,
    });
  });
});
