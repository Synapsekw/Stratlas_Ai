import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntennasFile } from '@aio/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

const policy = vi.hoisted(() => ({
  value: { ai: 'allow', photos: true, scans: false },
}));
vi.mock('./evidencePolicy', () => ({
  evidencePolicy: () => Promise.resolve(policy.value),
}));

import { telecomLabelHost } from './telecomAi';

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

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aio-telecom-ai-'));
  dirs.push(root);
  mkdirSync(join(root, 'telecom', 'crops'), { recursive: true });
  writeFileSync(join(root, 'telecom', 'antennas.json'), JSON.stringify(sample()));
  const projects = {
    root: (id: string) => (id === 'p' ? root : undefined),
    package: (id: string) =>
      id === 'pkg'
        ? { archive: { entries: new Map(), read: () => Promise.reject(new Error('x')) } }
        : undefined,
  };
  const host = telecomLabelHost({
    projects,
    packagePolicy: () => 'forbid',
  });
  return { root, host };
}

describe('telecomLabelHost', () => {
  it('reads the photo flag and policy from the manifest reader', async () => {
    const { host } = setup();
    policy.value = { ai: 'allow', photos: true, scans: true };
    expect(await host.policy('p')).toEqual({ ai: 'allow', photos: true });
    policy.value = { ai: 'forbid', photos: false, scans: false };
    expect(await host.policy('p')).toEqual({ ai: 'forbid', photos: false });
    policy.value = { error: 'unreadable' };
    expect(await host.policy('p')).toEqual({ error: 'unreadable' });
  });

  it('answers null for a project that is not open and never allows photos of a package', async () => {
    const { host } = setup();
    expect(await host.policy('nope')).toBeNull();
    expect(await host.policy('pkg')).toEqual({ ai: 'forbid', photos: false });
    expect(await host.crops('pkg', ['ant-a3'])).toEqual([]);
  });

  it('returns the crop of each unit that has one, with a data URL, a relative path and a SHA-256', async () => {
    const { root, host } = setup();
    const bytes = Buffer.from([0xff, 0xd8, 1, 2, 3]);
    writeFileSync(join(root, 'telecom', 'crops', 'ant-a3.jpg'), bytes);
    const out = await host.crops('p', ['ant-a3', 'ant-d1']);
    expect(out).toEqual([
      {
        unitId: 'ant-a3',
        path: 'telecom/crops/ant-a3.jpg',
        dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ]);
  });

  it('ignores ids that are not in the inventory, even when a file exists', async () => {
    const { root, host } = setup();
    writeFileSync(join(root, 'telecom', 'crops', 'ant-stray.jpg'), Buffer.from([1]));
    expect(await host.crops('p', ['ant-stray', '../antennas'])).toEqual([]);
  });
});
