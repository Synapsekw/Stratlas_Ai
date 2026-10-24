import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntennaDeletionsFile, AntennasFile } from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import type { SurveyArchive } from './survey';
import {
  deleteAntennas,
  readAntennaCrop,
  readAntennas,
  registerTelecomIpc,
  writeAntennas,
} from './telecom';

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

describe('deleting antennas', () => {
  const sidecarPath = (root: string) => join(root, 'telecom', 'antenna-deletions.json');
  const sidecar = (root: string) =>
    AntennaDeletionsFile.parse(JSON.parse(readFileSync(sidecarPath(root), 'utf8')));
  const crop = (root: string, id: string) => join(root, 'telecom', 'crops', `${id}.jpg`);
  const NOW = '2026-10-24T10:00:00Z';
  const now = () => NOW;

  async function seeded(file: AntennasFile = sample()) {
    const s = setup();
    expect(await writeAntennas(s.projects, 'p', file)).toEqual({ ok: true });
    mkdirSync(join(s.root, 'telecom', 'crops'), { recursive: true });
    for (const u of file.units) writeFileSync(crop(s.root, u.id), Buffer.from([1]));
    await readAntennas(s.projects, 'p');
    return s;
  }
  const flaggedSample = (): AntennasFile => {
    const f = sample();
    const u = f.units[0];
    if (!u) throw new Error('no unit');
    return { ...f, units: [{ ...u, id: 'ant-f1', name: 'F1', origin: 'flagged' }, ...f.units] };
  };

  it('deletes a detected unit, records it and removes its crop', async () => {
    const { root, projects } = await seeded();
    const before = sample();
    const unit = before.units[0];
    if (!unit) throw new Error('no unit');
    const r = await deleteAntennas(projects, 'p', [unit.id], now);
    expect(r).toMatchObject({ ok: true, deleted: [unit.id] });
    const onDisk = AntennasFile.parse(JSON.parse(readFileSync(antPath(root), 'utf8')));
    expect(onDisk.units.map((u) => u.id)).not.toContain(unit.id);
    expect(onDisk.units).toHaveLength(before.units.length - 1);
    if (r.ok) expect(r.file).toEqual(onDisk);
    expect(sidecar(root).deletions).toEqual([
      {
        unitId: unit.id,
        name: unit.name,
        kind: unit.kind,
        box: unit.box,
        ...(before.run.captureId ? { captureId: before.run.captureId } : {}),
        deletedAt: NOW,
      },
    ]);
    expect(existsSync(crop(root, unit.id))).toBe(false);
    expect(existsSync(`${antPath(root)}.bak`)).toBe(true);
  });

  it('deletes a flagged unit without a record', async () => {
    const { root, projects } = await seeded(flaggedSample());
    expect(await deleteAntennas(projects, 'p', ['ant-f1'], now)).toMatchObject({
      ok: true,
      deleted: ['ant-f1'],
    });
    expect(existsSync(sidecarPath(root))).toBe(false);
    expect(existsSync(crop(root, 'ant-f1'))).toBe(false);
  });

  it('appends to an existing sidecar and never duplicates a unit id', async () => {
    const { root, projects } = await seeded();
    const [a, b] = sample().units;
    if (!a || !b) throw new Error('need two units');
    await deleteAntennas(projects, 'p', [a.id], now);
    // the unit comes back (an older build restored the file); deleting it again adds no second record
    await writeAntennas(projects, 'p', sample());
    await readAntennas(projects, 'p');
    await deleteAntennas(projects, 'p', [a.id, b.id], now);
    const ids = sidecar(root).deletions.map((d) => d.unitId);
    expect(ids).toEqual([a.id, b.id]);
  });

  it('ignores unknown ids and writes nothing when none is known', async () => {
    const { root, projects } = await seeded();
    const text = readFileSync(antPath(root), 'utf8');
    const r = await deleteAntennas(projects, 'p', ['ant-nope'], now);
    expect(r).toMatchObject({ ok: true, deleted: [] });
    expect(readFileSync(antPath(root), 'utf8')).toBe(text);
    expect(existsSync(sidecarPath(root))).toBe(false);
    expect(existsSync(`${antPath(root)}.bak`)).toBe(false);
  });

  it('refuses a package, an unknown project and a missing file', async () => {
    const { projects } = setup({ 'telecom/antennas.json': sample() });
    expect(await deleteAntennas(projects, 'pkg', ['ant-a3'])).toMatchObject({
      ok: false,
      code: 'read-only',
    });
    expect(await deleteAntennas(projects, 'nope', ['ant-a3'])).toMatchObject({ ok: false });
    expect(await deleteAntennas(projects, 'p', ['ant-a3'])).toMatchObject({ ok: false });
  });

  it('refuses when the sidecar is newer or unreadable, changing nothing', async () => {
    const { root, projects } = await seeded();
    const text = readFileSync(antPath(root), 'utf8');
    const newer = JSON.stringify({ schema: 'aio.antenna-deletions/2', deletions: [] });
    writeFileSync(sidecarPath(root), newer);
    const r = await deleteAntennas(projects, 'p', ['ant-a3'], now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/newer version/i);
    expect(readFileSync(sidecarPath(root), 'utf8')).toBe(newer);
    writeFileSync(sidecarPath(root), '{ not json');
    expect((await deleteAntennas(projects, 'p', ['ant-a3'], now)).ok).toBe(false);
    expect(readFileSync(sidecarPath(root), 'utf8')).toBe('{ not json');
    expect(readFileSync(antPath(root), 'utf8')).toBe(text);
    expect(existsSync(crop(root, 'ant-a3'))).toBe(true);
  });

  it('refuses when the inventory is newer or changed since it was read', async () => {
    const { root, projects } = await seeded();
    writeFileSync(antPath(root), readFileSync(antPath(root), 'utf8') + ' ');
    const changed = readFileSync(antPath(root), 'utf8');
    expect((await deleteAntennas(projects, 'p', ['ant-a3'], now)).ok).toBe(false);
    expect(readFileSync(antPath(root), 'utf8')).toBe(changed);
    const newer = JSON.stringify({ schema: 'aio.antennas/2', units: [] });
    writeFileSync(antPath(root), newer);
    const r = await deleteAntennas(projects, 'p', ['ant-a3'], now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/newer version/i);
  });

  it('writes the sidecar before the inventory', async () => {
    const { root, projects } = await seeded();
    // the file changes after the read: the inventory write is refused, the sidecar is already there
    const changed = readFileSync(antPath(root), 'utf8') + ' ';
    writeFileSync(antPath(root), changed);
    const r = await deleteAntennas(projects, 'p', ['ant-a3'], now);
    expect(r.ok).toBe(false);
    expect(sidecar(root).deletions.map((d) => d.unitId)).toEqual(['ant-a3']);
    expect(readFileSync(antPath(root), 'utf8')).toBe(changed);
    expect(existsSync(crop(root, 'ant-a3'))).toBe(true);
  });

  it('registers the channel', async () => {
    const { projects } = await seeded();
    const ipc = collectHandlers((handle) => {
      registerTelecomIpc({ handle, projects });
    });
    expect(
      await ipc.call('telecom:deleteAntennas', { projectId: 'p', ids: ['ant-a3'] }),
    ).toMatchObject({ ok: true, deleted: ['ant-a3'] });
  });
});
