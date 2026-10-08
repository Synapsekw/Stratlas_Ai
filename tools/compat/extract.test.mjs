// The committed `schema-0.8/`, `schema-0.9/` and `schema-0.10/` are exactly what extract-schema.mjs
// makes from the 0.8.0, 0.9.0 and 0.10.0 commits (when the clone has that history; CI's shallow
// checkout skips the comparison), and the downgrade keeps to its rule: only unknown keys and refused
// array elements go.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { downgrade } from './downgrade.mjs';
import { extractSchema, hasCommit, scratchDir, toModule } from './extract-schema.mjs';
import { milestone } from './milestones.mjs';

describe('extract-schema', () => {
  it('strips types and gives relative imports an .mjs extension', () => {
    const js = toModule(
      "import { z } from 'zod';\nimport { Id, type Vec3 } from './common';\nexport type A = { a: Vec3 };\nexport const B: z.ZodString = z.string();\nexport * from '../x';\n",
    );
    expect(js).toContain("from './common.mjs'");
    expect(js).toContain("from '../x.mjs'");
    expect(js).toContain("from 'zod'");
    expect(js).not.toMatch(/type A|: z\.ZodString/);
  });

  for (const version of ['0.8', '0.9', '0.10']) {
    const committed = fileURLToPath(new URL(`./schema-${version}`, import.meta.url));
    it.skipIf(!hasCommit(milestone(version).commit))(
      `matches a fresh extraction of the ${version} commit`,
      async () => {
        const fresh = scratchDir(`schema-${version}-check`);
        const names = await extractSchema(version, fresh);
        expect(names).toEqual(readdirSync(committed).sort());
        for (const n of names) {
          expect(readFileSync(join(fresh, n), 'utf8'), n).toBe(
            readFileSync(join(committed, n), 'utf8'),
          );
        }
      },
      60_000,
    );
  }
});

describe('downgrade', () => {
  const Old = z.object({
    schema: z.literal('aio.x/1'),
    items: z.array(z.object({ kind: z.enum(['a', 'b']), n: z.number() }).strict()),
    note: z.string().optional(),
  });

  it('drops unknown keys of strict objects and array elements the old schema refuses', () => {
    const input = {
      schema: 'aio.x/1',
      items: [
        { kind: 'a', n: 1, extra: true },
        { kind: 'c', n: 2 },
        { kind: 'b', n: 3 },
      ],
      later: 'stripped by the plain object',
    };
    const { value, removed } = downgrade(Old, input);
    expect(value).toEqual({
      schema: 'aio.x/1',
      items: [
        { kind: 'a', n: 1 },
        { kind: 'b', n: 3 },
      ],
    });
    expect(removed).toHaveLength(2);
    expect(input.items).toHaveLength(3);
  });

  it('refuses to invent data the old schema needs', () => {
    expect(() => downgrade(Old, { schema: 'aio.x/1' })).toThrow(/Cannot downgrade/);
  });
});
