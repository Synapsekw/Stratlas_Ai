import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOTICES, jsEntries, jsInventory, pythonLicense, render } from './notices.mjs';

describe('licence inventory', () => {
  it('leaves workspace packages out and sorts by name', () => {
    const entries = jsEntries({
      MIT: [
        { name: 'zod', versions: ['4.6.5'], license: 'MIT' },
        { name: '@aio/schema', versions: ['0.1.0'], license: 'MIT' },
      ],
      'Apache-2.0': [{ name: 'alpha', versions: ['1.0.0', '1.1.0'] }],
    });
    expect(entries.map((e) => [e.name, e.version, e.license])).toEqual([
      ['alpha', '1.0.0, 1.1.0', 'Apache-2.0'],
      ['zod', '4.6.5', 'MIT'],
    ]);
  });

  it('names a Python licence by expression, short text or classifier', () => {
    expect(pythonLicense({ expression: 'MIT', license: 'x' })).toBe('MIT');
    expect(pythonLicense({ license: 'The MIT License (MIT)' })).toBe('MIT');
    expect(
      pythonLicense({
        license: 'Files: *\nCopyright: ...',
        classifiers: ['License :: OSI Approved :: BSD License'],
      }),
    ).toBe('BSD (classifier)');
    expect(pythonLicense({ license: '' })).toBe('see package');
  });

  it('renders both sections with counts', () => {
    const md = render(
      [{ name: 'a|b', version: '1', license: 'MIT' }],
      [{ name: 'numpy', version: '2', license: 'BSD-3-Clause' }],
    );
    expect(md).toContain('1 packages: MIT (1).');
    expect(md).toContain('| a\\|b | 1 | MIT |');
    expect(md).toContain('| numpy | 2 | BSD-3-Clause |');
  });

  it('lists every npm package that ships (regenerate with node tools/release/notices.mjs)', () => {
    const committed = readFileSync(NOTICES, 'utf8');
    const missing = jsInventory()
      .map((e) => e.name)
      .filter((n) => !committed.includes(`| ${n} `));
    expect(missing).toEqual([]);
  }, 60_000);
});
