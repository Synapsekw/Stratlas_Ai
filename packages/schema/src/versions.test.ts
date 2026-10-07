import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NOT_FILE_SCHEMAS,
  SCHEMA_REGISTRY,
  appRangeAllows,
  compareVersions,
  migrationPath,
  newerRefusal,
  packRangeRefusal,
  parseAppRange,
  readVersioned,
  readerFor,
  schemaIdOf,
  type Migration,
} from './versions';

const repo = fileURLToPath(new URL('../../..', import.meta.url));

const Thing = z.object({ schema: z.literal('aio.issues/1'), issues: z.array(z.string()) });

describe('version registry', () => {
  it('has one row per family, each at version 1 in 1.x', () => {
    const families = SCHEMA_REGISTRY.map((e) => e.family);
    expect(new Set(families).size).toBe(families.length);
    for (const e of SCHEMA_REGISTRY) {
      expect(e.family).toMatch(/^aio\.[a-z][a-z0-9-]*$/);
      expect(e.version).toBe(1);
      expect(e.since).toMatch(/^0\.[4-9]$/);
    }
  });

  // Every `aio.<name>/<n>` literal in the code is a registered file schema or a known non-file id
  // (protocols, signing domains, tool-only and test formats). A stream that adds a file schema
  // without a registry row fails here.
  it('lists every aio.* schema id found in the source tree', () => {
    const roots = ['apps', 'packages', 'python/src', 'tools'].map((d) => join(repo, d));
    const skip = /node_modules|[\\/]out[\\/]|[\\/]dist[\\/]|__fixtures__|[\\/]compat[\\/]/;
    const found = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (skip.test(p)) continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (
          /\.(ts|tsx|mjs|py)$/.test(name) &&
          !/\.test\.|[\\/]e2e[\\/]|[\\/]tests[\\/]/.test(p)
        )
          for (const m of readFileSync(p, 'utf8').matchAll(/aio\.[a-z][a-z0-9-]*\/[1-9]/g))
            found.set(m[0], relative(repo, p));
      }
    };
    roots.forEach(walk);
    const known = new Set([
      ...SCHEMA_REGISTRY.map((e) => `${e.family}/${String(e.version)}`),
      ...NOT_FILE_SCHEMAS,
    ]);
    const missing = [...found].filter(([id]) => !known.has(id));
    expect(missing).toEqual([]);
  });
});

describe('readerFor', () => {
  it('classifies current, older, newer and unknown ids', () => {
    expect(readerFor('aio.issues/1').kind).toBe('current');
    expect(readerFor('aio.nothing/1').kind).toBe('unknown');
    expect(readerFor('not a schema').kind).toBe('unknown');
    const newer = readerFor('aio.change/2', 'Quadrion AI');
    expect(newer.kind).toBe('newer');
    if (newer.kind === 'newer') {
      expect(newer.found).toBe(2);
      expect(newer.message).toBe(
        'change/*.json was saved by a newer version of Quadrion AI (aio.change/2). Update the app to open it. The file was not changed.',
      );
    }
  });
});

describe('schemaIdOf', () => {
  it('reads `schema`, or the numeric `v` of ops and checkpoints for a known family', () => {
    expect(schemaIdOf({ schema: 'aio.issues/1' })).toBe('aio.issues/1');
    expect(schemaIdOf({ v: 1, id: 'x' }, 'aio.op')).toBe('aio.op/1');
    expect(schemaIdOf({ v: 1 })).toBeNull();
    expect(schemaIdOf([])).toBeNull();
    expect(schemaIdOf(null)).toBeNull();
    expect(schemaIdOf({ schema: 3 })).toBeNull();
  });
});

describe('newerRefusal', () => {
  it('answers a message only for a newer version of a known family', () => {
    expect(newerRefusal({ schema: 'aio.issues/1' })).toBeNull();
    expect(newerRefusal({ schema: 'aio.unknown/9' })).toBeNull();
    expect(newerRefusal('text')).toBeNull();
    expect(newerRefusal({ schema: 'aio.issues/2' }, 'Quadrion AI')).toMatch(
      /^issues\.json was saved by a newer version of Quadrion AI \(aio\.issues\/2\)/,
    );
    expect(newerRefusal({ v: 7 }, 'Quadrion AI', 'aio.op')).toMatch(/newer version of Quadrion AI/);
  });
});

describe('readVersioned', () => {
  const opts = { family: 'aio.issues', schema: Thing, appName: 'Quadrion AI', what: 'issues.json' };

  it('reads a current file', () => {
    const r = readVersioned({ schema: 'aio.issues/1', issues: ['a'] }, opts);
    expect(r).toEqual({
      ok: true,
      value: { schema: 'aio.issues/1', issues: ['a'] },
      migratedFrom: null,
    });
  });

  it('refuses a newer file without touching it', () => {
    const raw = { schema: 'aio.issues/3', issues: [{ deep: true }], extra: 1 };
    const copy = structuredClone(raw);
    const r = readVersioned(raw, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('newer');
      expect(r.error).toMatch(/newer version of Quadrion AI \(aio\.issues\/3\)/);
    }
    expect(raw).toEqual(copy);
  });

  it('migrates an older file step by step, never mutating the input', () => {
    const V2 = z.object({ schema: z.literal('aio.issues/3'), items: z.array(z.string()) });
    const migrations: Migration[] = [
      {
        family: 'aio.issues',
        from: 1,
        note: 'issues renamed to list',
        migrate: (raw) => ({ schema: 'aio.issues/2', list: raw.issues }),
      },
      {
        family: 'aio.issues',
        from: 2,
        note: 'list renamed to items',
        migrate: (raw) => ({ schema: 'aio.issues/3', items: raw.list }),
      },
    ];
    const raw = { schema: 'aio.issues/1', issues: ['a', 'b'] };
    const r = readVersioned(raw, { ...opts, schema: V2, version: 3, migrations });
    expect(r).toEqual({
      ok: true,
      value: { schema: 'aio.issues/3', items: ['a', 'b'] },
      migratedFrom: 1,
    });
    expect(raw).toEqual({ schema: 'aio.issues/1', issues: ['a', 'b'] });
  });

  it('says plainly when an older version has no migrator', () => {
    const r = readVersioned({ schema: 'aio.issues/1', issues: [] }, { ...opts, version: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('older');
      expect(r.error).toMatch(/older version/);
    }
  });

  it('names a wrong family, a missing id, a non-object and an invalid file', () => {
    const wrong = readVersioned({ schema: 'aio.road/1' }, opts);
    expect(wrong.ok || wrong.reason).toBe('wrong-family');
    if (!wrong.ok) expect(wrong.error).toBe('issues.json is not an aio.issues file (aio.road/1).');
    const none = readVersioned({ issues: [] }, opts);
    expect(none.ok || none.reason).toBe('invalid');
    expect(readVersioned('[]', opts)).toMatchObject({ ok: false, reason: 'not-object' });
    expect(readVersioned(null, opts)).toMatchObject({ ok: false, reason: 'not-object' });
    const bad = readVersioned({ schema: 'aio.issues/1', issues: [1] }, opts);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason).toBe('invalid');
      expect(bad.error).toMatch(/^issues\.json is invalid at issues\.0: /);
    }
  });

  it('never throws, whatever the input', () => {
    const inputs: unknown[] = [
      undefined,
      0,
      'x',
      [],
      { schema: '' },
      { schema: 'aio.issues/0' },
      { schema: 'aio.issues/99999' },
      { schema: 'aio.issues/1', issues: null },
      Object.create(null),
      { __proto__: { schema: 'aio.issues/2' } },
      { v: Number.NaN },
    ];
    for (const raw of inputs) expect(() => readVersioned(raw, opts)).not.toThrow();
  });
});

describe('migrationPath', () => {
  const m = (from: number): Migration => ({
    family: 'aio.x',
    from,
    note: '',
    migrate: (r) => r,
  });
  it('chains consecutive steps and answers null on a gap', () => {
    expect(migrationPath('aio.x', 1, 3, [m(1), m(2)])?.map((s) => s.from)).toEqual([1, 2]);
    expect(migrationPath('aio.x', 1, 3, [m(2)])).toBeNull();
    expect(migrationPath('aio.x', 2, 2, [])).toEqual([]);
  });
});

describe('app ranges (pipeline pack)', () => {
  it('orders versions with pre-releases before their release', () => {
    expect(compareVersions('1.0.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });

  it('parses ranges and refuses malformed ones', () => {
    expect(parseAppRange('>=0.9.0 <2.0.0')).toEqual([
      { op: '>=', version: '0.9.0' },
      { op: '<', version: '2.0.0' },
    ]);
    expect(parseAppRange('')).toBeNull();
    expect(parseAppRange('~1.0')).toBeNull();
    expect(parseAppRange('>=abc')).toBeNull();
  });

  it('allows versions inside the range, release candidates included', () => {
    const range = '>=0.9.0 <2.0.0';
    expect(appRangeAllows(range, '0.9.0')).toBe(true);
    expect(appRangeAllows(range, '1.0.0-rc.1')).toBe(true);
    expect(appRangeAllows(range, '1.4.2')).toBe(true);
    expect(appRangeAllows(range, '0.8.0')).toBe(false);
    expect(appRangeAllows(range, '2.0.0')).toBe(false);
    expect(appRangeAllows('nonsense', '1.0.0')).toBe(false);
  });

  it('words the refusal for a pack outside the range', () => {
    expect(packRangeRefusal(undefined, '1.0.0', 'Quadrion AI')).toBeNull();
    expect(packRangeRefusal('>=0.9.0 <2.0.0', '1.0.0', 'Quadrion AI')).toBeNull();
    expect(packRangeRefusal('>=0.9.0 <2.0.0', '0.8.0', 'Quadrion AI')).toBe(
      'This pipeline pack works with Quadrion AI >=0.9.0 <2.0.0, and this is 0.8.0. Install the pipeline pack made for this version.',
    );
    expect(packRangeRefusal('~1', '1.0.0', 'Quadrion AI')).toBe(
      'This pipeline pack declares an app range that cannot be read (~1). Install the pipeline pack made for this version.',
    );
  });
});
