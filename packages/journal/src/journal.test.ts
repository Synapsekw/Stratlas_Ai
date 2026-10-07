import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  checkOp,
  compareHlc,
  createClock,
  readSegment,
  sealOp,
  signerFromSeed,
} from './index';

const fixtures = fileURLToPath(new URL('../../schema/src/__fixtures__/journal/', import.meta.url));

interface Person {
  device: string;
  publicKey: string;
  seed: string;
}
const keys = JSON.parse(readFileSync(join(fixtures, 'TEST-ONLY-KEYS.json'), 'utf8')) as {
  people: Person[];
};
const keyOf = (device: unknown) => keys.people.find((p) => p.device === device)?.publicKey;

function opsOf(root: string) {
  const dir = join(root, 'journal', 'ops');
  return readdirSync(dir).flatMap((chain) =>
    readdirSync(join(dir, chain))
      .filter((f) => statSync(join(dir, chain, f)).isFile())
      .flatMap((f) =>
        readSegment(readFileSync(join(dir, chain, f), 'utf8')).map((l) => ({
          file: `${chain}/${f}`,
          ...l,
        })),
      ),
  );
}

describe('@aio/journal (T0)', () => {
  it('canonicalises JSON as RFC 8785 does', () => {
    // RFC 8785 section 3.2.2 (numbers, string escapes, key order)
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    ) as unknown;
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }], u: undefined })).toBe(
      '{"a":[{"c":3,"d":2}],"b":1}',
    );
  });

  it('agrees with the golden fixtures: every valid op hashes, chains and verifies', () => {
    const lines = opsOf(join(fixtures, 'valid'));
    expect(lines.length).toBeGreaterThan(15);
    for (const l of lines) {
      if (!l.ok) throw new Error(`${l.file}:${l.line} ${l.error}`);
      expect(checkOp(l.raw, keyOf(l.raw.dev))).toEqual({
        id: true,
        payload: true,
        signature: true,
      });
    }
  });

  it('seals an op byte for byte as the fixture generator did', () => {
    const lines = opsOf(join(fixtures, 'valid'));
    const first = lines.find((l) => l.ok && l.raw.seq === 1 && l.raw.kind === 'project.share');
    if (!first?.ok) throw new Error('No first op in the fixtures');
    const person = keys.people.find((p) => p.device === first.raw.dev);
    if (!person) throw new Error('No key for the first op');
    const unsealed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(first.raw)) {
      if (!['id', 'ph', 'sig', 'payload'].includes(k)) unsealed[k] = v;
    }
    const sealed = sealOp(unsealed, first.raw.payload, signerFromSeed(person.seed));
    expect(canonicalJson(sealed)).toBe(canonicalJson(first.raw));
  });

  it('notices an edited payload and a foreign signature in the tampered fixtures', () => {
    const edited = opsOf(join(fixtures, 'tampered', 'edited-payload'));
    expect(edited.some((l) => l.ok && checkOp(l.raw).payload === false)).toBe(true);
    const forged = opsOf(join(fixtures, 'tampered', 'bad-signature'));
    expect(forged.some((l) => l.ok && checkOp(l.raw, keyOf(l.raw.dev)).signature === false)).toBe(
      true,
    );
  });

  it('keeps the clock monotonic when the wall clock goes back, and after a remote reading', () => {
    const dev = `d_${'a'.repeat(52)}`;
    let wall = 1_790_000_000_000;
    const clock = createClock(dev, () => wall);
    const a = clock.tick();
    wall -= 60_000;
    const b = clock.tick();
    expect(compareHlc(a, b)).toBe(-1);
    const remote = `1790000500000.0007.d_${'b'.repeat(52)}`;
    const c = clock.receive(remote);
    expect(c.startsWith('1790000500000.0008.')).toBe(true);
  });
});
