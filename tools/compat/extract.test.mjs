// The committed `schema-0.8/` is exactly what extract-schema.mjs makes from the 0.8.0 commit (when
// the clone has that history; CI's shallow checkout skips the comparison), and the downgrade keeps
// to its rule: only unknown keys and refused array elements go.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { downgrade } from './downgrade.mjs';
import { extractSchema, hasCommit, scratchDir, toModule } from './extract-schema.mjs';
import { milestone } from './milestones.mjs';

const committed = fileURLToPath(new URL('./schema-0.8', import.meta.url));

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

  it.skipIf(!hasCommit(milestone('0.8').commit))(
    'matches a fresh extraction of the 0.8 commit',
    async () => {
      const fresh = scratchDir('schema-0.8-check');
      const names = await extractSchema('0.8', fresh);
      expect(names).toEqual(readdirSync(committed).sort());
      for (const n of names) {
        expect(readFileSync(join(fresh, n), 'utf8'), n).toBe(
          readFileSync(join(committed, n), 'utf8'),
        );
      }
    },
    60_000,
  );
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
