import { describe, expect, it } from 'vitest';
import { judge, loadPolicy, parseExpression, terms } from './licence-policy.mjs';

const policy = loadPolicy({
  allowed: {
    spdx: ['MIT', 'Apache-2.0', 'BSD-3-Clause'],
    native: ['libpng-2.0', 'LLVM-exception'],
  },
  mpl: [
    { name: 'eigen', aliases: ['eigen3'], ecosystem: 'native', approved: '2026-10-07' },
    { name: 'certifi', ecosystem: 'python', approved: '2026-10-07' },
  ],
  lgplShared: [
    { name: 'geos', ecosystem: 'native', approved: '2026-10-07' },
    { name: 'libiconv', ecosystem: 'native', approved: 'pending' },
  ],
  runtimes: [
    {
      name: 'gcc-runtime',
      ecosystem: 'native',
      licence: 'GPL-3.0-or-later WITH GCC-exception-3.1',
      approved: 'pending',
    },
  ],
});

describe('SPDX expressions', () => {
  it('parses AND, OR, WITH and parentheses', () => {
    expect(parseExpression('MIT')).toEqual({ id: 'MIT' });
    expect(parseExpression('(MIT OR Apache-2.0) AND Zlib')).toEqual({
      and: [{ or: [{ id: 'MIT' }, { id: 'Apache-2.0' }] }, { id: 'Zlib' }],
    });
    expect(parseExpression('Apache-2.0 WITH LLVM-exception')).toEqual({
      id: 'Apache-2.0',
      with: 'LLVM-exception',
    });
    expect(terms('BSD-3-Clause OR GPL-2.0-only')).toEqual(['BSD-3-Clause', 'GPL-2.0-only']);
  });

  it('refuses what it cannot parse', () => {
    expect(() => parseExpression('MIT AND')).toThrow();
    expect(() => parseExpression('(MIT')).toThrow();
    expect(() => parseExpression('')).toThrow();
  });
});

describe('judge', () => {
  const native = (expr, names = []) => judge(policy, expr, { ecosystem: 'native', names });

  it('allows the allow-list, and native-only ids only for native code', () => {
    expect(native('MIT').status).toBe('ok');
    expect(native('libpng-2.0').status).toBe('ok');
    expect(judge(policy, 'libpng-2.0', { ecosystem: 'npm', names: ['x'] }).status).toBe('denied');
  });

  it('takes the best option of an OR and the worst part of an AND', () => {
    expect(native('BSD-3-Clause OR GPL-2.0-only').status).toBe('ok');
    expect(native('MIT AND GPL-2.0-only').status).toBe('denied');
    expect(native('Apache-2.0 WITH LLVM-exception').status).toBe('ok');
  });

  it('allows MPL and LGPL only by name, and reports pending approvals', () => {
    expect(native('MPL-2.0', ['eigen3']).status).toBe('ok');
    expect(native('MPL-2.0', ['opencv']).status).toBe('denied');
    expect(judge(policy, 'MPL-2.0', { ecosystem: 'python', names: ['eigen'] }).status).toBe(
      'denied',
    );
    expect(native('LGPL-2.1-only', ['geos'])).toMatchObject({ status: 'ok', lgpl: true });
    expect(native('LGPL-2.1-or-later', ['libiconv'])).toEqual({
      status: 'pending',
      pending: ['libiconv'],
      lgpl: true,
      copyleft: false,
    });
  });

  it('allows a named runtime only with its exact licence', () => {
    const gcc = 'GPL-3.0-or-later WITH GCC-exception-3.1';
    expect(native(gcc, ['libgfortran', 'gcc-runtime']).status).toBe('pending');
    expect(native(gcc, ['libgfortran']).status).toBe('denied');
    expect(native('GPL-3.0-or-later', ['gcc-runtime']).status).toBe('denied');
    expect(native(`BSD-3-Clause AND ${gcc}`, ['gcc-runtime']).status).toBe('pending');
  });

  it('never allows GPL, AGPL or unknown ids', () => {
    for (const l of ['GPL-2.0-or-later', 'AGPL-3.0-only', 'SSPL-1.0', 'LicenseRef-NonCommercial'])
      expect(native(l, ['geos', 'eigen', 'gcc-runtime']).status).toBe('denied');
  });
});

describe('the copyleft acceptance (founder decision of 8 Oct 2026)', () => {
  const pack = loadPolicy({
    allowed: { spdx: ['MIT'] },
    copyleft: { ecosystems: ['python', 'native'] },
  });

  it('allows the GPL family in the pipeline pack, marked as copyleft', () => {
    for (const l of ['GPL-3.0-only', 'LGPL-2.1-or-later', 'AGPL-3.0-only', 'MPL-2.0'])
      for (const ecosystem of ['python', 'native'])
        expect(judge(pack, l, { ecosystem })).toMatchObject({ status: 'ok', copyleft: true });
    expect(judge(pack, 'MIT AND GPL-2.0-or-later', { ecosystem: 'native' })).toMatchObject({
      status: 'ok',
      copyleft: true,
      lgpl: false,
    });
    expect(judge(pack, 'MIT', { ecosystem: 'native' }).copyleft).toBe(false);
  });

  it('keeps the app (npm) permissive, and never allows non-commercial or unknown ids', () => {
    expect(judge(pack, 'GPL-3.0-only', { ecosystem: 'npm' }).status).toBe('denied');
    for (const l of ['LicenseRef-NonCommercial', 'SSPL-1.0', 'CC-BY-NC-4.0'])
      expect(judge(pack, l, { ecosystem: 'native' }).status).toBe('denied');
  });

  it('is what the committed policy says', () => {
    const real = loadPolicy();
    expect(judge(real, 'GPL-3.0-only', { ecosystem: 'python' }).status).toBe('ok');
    expect(judge(real, 'GPL-2.0-or-later', { ecosystem: 'native' }).status).toBe('ok');
    expect(judge(real, 'GPL-3.0-only', { ecosystem: 'npm' }).status).toBe('denied');
  });
});
