import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from './en';

const dir = fileURLToPath(new URL('./en/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

/** Every area module under `./en/`, as file name to its catalogue object. */
async function modules(): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  for (const f of files) {
    const mod = (await import(`./en/${f.replace(/\.ts$/, '')}.ts`)) as Record<
      string,
      Record<string, string>
    >;
    const values = Object.values(mod);
    expect(values, f).toHaveLength(1);
    out.set(f, values[0] ?? {});
  }
  return out;
}

const prefix = (key: string) => key.split('.')[0] ?? key;

/** The custom analytics modules are split by UI task, not by prefix, so they share prefixes. */
const byTask = (file: string) => /^askAi[A-Z]/.test(file);

describe('en catalogue split into area modules', () => {
  it('every prefix lives in exactly one area module', async () => {
    const owner = new Map<string, string>();
    for (const [file, cat] of await modules()) {
      if (byTask(file)) continue;
      for (const key of Object.keys(cat)) {
        const p = prefix(key);
        const had = owner.get(p);
        expect(had === undefined || had === file, `${p} in ${had ?? ''} and ${file}`).toBe(true);
        owner.set(p, file);
      }
    }
    expect(owner.size).toBeGreaterThan(0);
  });

  it('no module redefines a key', async () => {
    let total = 0;
    for (const cat of (await modules()).values()) total += Object.keys(cat).length;
    expect(total).toBe(Object.keys(en).length);
  });
});
