// The 1.x upgrade policy, proved on the compatibility corpus (tools/compat/corpus, built by
// build-corpus.mjs from each milestone's own schema):
// - every file written by 0.4 to 0.11 opens in this build with nothing lost;
// - every file this build writes parses with the 0.10, 0.9 and 0.8 schemas with nothing lost (an
//   0.10, 0.9 or 0.8 build on the same machine still opens it);
// - every reader refuses a `/2` file with the "newer version" message and changes nothing.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v08 from './schema-0.8/index.mjs';
import * as v09 from './schema-0.9/index.mjs';
import * as v010 from './schema-0.10/index.mjs';
import { familyOf } from './families.mjs';
import { MILESTONES } from './milestones.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const corpus = join(here, 'corpus');
const index = JSON.parse(readFileSync(join(corpus, 'index.json'), 'utf8'));
const versions = readdirSync(corpus).filter((n) => /^\d+\.\d+$/.test(n));
/** This build (build-corpus.mjs `CURRENT`): corpus/<CURRENT> is what it writes. */
const CURRENT = '0.11';

const load = (version, p) => JSON.parse(readFileSync(join(corpus, version, p), 'utf8'));
const rel = (p) => p.slice(p.indexOf('/') + 1);

/** Paths where `before` has a value that `after` lacks or changed (nothing lost: empty). */
function lost(before, after, path = '') {
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || after.length !== before.length) return [path || '(root)'];
    return before.flatMap((v, i) => lost(v, after[i], `${path}[${String(i)}]`));
  }
  if (typeof before === 'object' && before !== null) {
    if (typeof after !== 'object' || after === null) return [path || '(root)'];
    return Object.entries(before).flatMap(([k, v]) =>
      v === undefined ? [] : lost(v, after[k], path ? `${path}.${k}` : k),
    );
  }
  return Object.is(before, after) ? [] : [path || '(root)'];
}

describe('compatibility corpus', () => {
  it('has a build for every milestone from 0.4 and the current 0.11', () => {
    expect(versions.sort()).toEqual([...MILESTONES.map((m) => m.version), CURRENT].sort());
    for (const v of versions) {
      for (const p of index.builds[v].files) expect(existsSync(join(corpus, v, p))).toBe(true);
    }
  });

  for (const version of versions) {
    describe(`files written by ${version}`, () => {
      for (const p of index.builds[version].files) {
        it(`${p} opens in this build with nothing lost`, () => {
          const raw = load(version, p);
          const fam = familyOf(rel(p));
          const schema = fam?.pick(current);
          expect(schema, `no current schema for ${p}`).toBeTruthy();
          const r = schema.safeParse(raw);
          expect(r.success, r.success ? '' : r.error.message).toBe(true);
          expect(lost(raw, r.data)).toEqual([]);
          if (fam.family.startsWith('aio.')) {
            const read = current.readVersioned(raw, { family: fam.family, schema, what: p });
            expect(read).toMatchObject({ ok: true, migratedFrom: null });
          }
        });
      }
    });
  }
});

for (const [older, schemas] of [
  ['0.10', v010],
  ['0.9', v09],
  ['0.8', v08],
]) {
  describe(`this build writes files an ${older} build reads`, () => {
    for (const p of index.builds[CURRENT].files) {
      it(`${p} parses with the ${older} schema with nothing lost`, () => {
        const raw = load(CURRENT, p);
        const schema = familyOf(rel(p))?.pick(schemas);
        expect(schema, `${older} has no schema for ${p}`).toBeTruthy();
        const r = schema.safeParse(raw);
        expect(r.success, r.success ? '' : r.error.message).toBe(true);
        expect(lost(raw, r.data)).toEqual([]);
      });
    }
  });
}

describe('a file saved by a newer build', () => {
  const versioned = index.builds[CURRENT].files.filter((p) =>
    familyOf(rel(p))?.family.startsWith('aio.'),
  );

  for (const p of versioned) {
    it(`${p} as /2 is refused with the update message and left unchanged`, () => {
      const fam = familyOf(rel(p));
      const raw = { ...load(CURRENT, p), schema: `${fam.family}/2` };
      const before = JSON.stringify(raw);
      const r = current.readVersioned(raw, {
        family: fam.family,
        schema: fam.pick(current),
        appName: 'Quadrion AI',
        what: rel(p),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('newer');
        expect(r.error).toBe(
          `${rel(p)} was saved by a newer version of Quadrion AI (${fam.family}/2). Update the app to open it. The file was not changed.`,
        );
      }
      expect(current.newerRefusal(raw, 'Quadrion AI')).toMatch(/newer version of Quadrion AI/);
      expect(JSON.stringify(raw)).toBe(before);
    });
  }

  it('is refused by the readers that already check (manifest, package header, road)', () => {
    const manifest = { ...load(CURRENT, 'tank-farm/manifest.json'), schema: 'aio.project/2' };
    const header = { ...load(CURRENT, 'tank-farm/aio-package.json'), schema: 'aio.package/2' };
    const road = { ...load(CURRENT, 'access-road/road.json'), schema: 'aio.road/2' };
    for (const r of [
      current.parseManifest(manifest),
      current.parsePackageHeader(header),
      current.parseRoadModel(road),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/newer version of Quadrion AI/);
    }
  });
});
