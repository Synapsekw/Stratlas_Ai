import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Op } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  createMemoryTransport,
  defaultFetchPolicy,
  exchangeMembers,
  isSafeMemberName,
  routePath,
} from './index';

const valid = fileURLToPath(
  new URL('../../schema/src/__fixtures__/journal/valid/journal/ops/', import.meta.url),
);
const fixtureOps = readdirSync(valid).flatMap((chain) =>
  readdirSync(join(valid, chain)).flatMap((f) =>
    readFileSync(join(valid, chain, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => Op.parse(JSON.parse(l))),
  ),
);

describe('@aio/sync (T0)', () => {
  it('a transport stores and forwards: pushes are idempotent, heads and pulls per chain', async () => {
    const t = createMemoryTransport();
    const first = await t.pushOps(fixtureOps);
    expect(first.accepted).toHaveLength(fixtureOps.length);
    const again = await t.pushOps(fixtureOps.slice(0, 3));
    expect(again.duplicates).toHaveLength(3);
    const heads = await t.heads();
    expect(Object.keys(heads)).toHaveLength(3);
    const page = await t.pullOps({});
    expect(page.ops).toHaveLength(fixtureOps.length);
    expect(await t.pullOps(heads)).toMatchObject({ ops: [], more: false });
  });

  it('accepts only the known member names of an exchange file', () => {
    const chain = fixtureOps[0]?.chain ?? '';
    expect(isSafeMemberName(exchangeMembers.ops(chain, 1, 9))).toBe(true);
    expect(isSafeMemberName(exchangeMembers.header)).toBe(true);
    expect(isSafeMemberName(exchangeMembers.blob('c'.repeat(64)))).toBe(true);
    for (const bad of ['../x', '/etc/passwd', 'C:/x', 'journal/../x', 'a\\b', 'other.txt']) {
      expect(isSafeMemberName(bad)).toBe(false);
    }
  });

  it('defaults large files to on-demand and builds server routes', () => {
    expect(defaultFetchPolicy('pointcloud', 3e9)).toBe('on-demand');
    expect(defaultFetchPolicy('raster', 1e6)).toBe('always');
    expect(defaultFetchPolicy('photos', 1e6)).toBe('on-open');
    expect(routePath('heads', { id: 't_x' })).toBe('/v1/projects/t_x/heads');
    expect(() => routePath('blob')).toThrow(/sha256/);
  });
});
