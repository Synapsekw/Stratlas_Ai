import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectedFuses, fuseProblems } from './check-fuses.mjs';

const OPTIONS = {
  RunAsNode: 0,
  EnableCookieEncryption: 1,
  EnableNodeOptionsEnvironmentVariable: 2,
  EnableNodeCliInspectArguments: 3,
  EnableEmbeddedAsarIntegrityValidation: 4,
  OnlyLoadAppFromAsar: 5,
};
const ON = 49;
const OFF = 48;

describe('check-fuses', () => {
  const yml = readFileSync(
    join(import.meta.dirname, '../../apps/desktop/electron-builder.yml'),
    'utf8',
  );
  const expected = expectedFuses(yml);

  it('reads the fuses electron-builder.yml asks for', () => {
    expect(expected).toEqual({
      RunAsNode: false,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      OnlyLoadAppFromAsar: true,
      EnableEmbeddedAsarIntegrityValidation: true,
      EnableCookieEncryption: true,
    });
  });

  it('passes a binary flipped as configured and names every fuse that is not', () => {
    const good = { 0: OFF, 1: ON, 2: OFF, 3: OFF, 4: ON, 5: ON };
    expect(fuseProblems(good, expected, OPTIONS)).toEqual([]);
    // an unflipped Electron: RunAsNode and the inspector still on, no asar checks
    const stock = { 0: ON, 1: OFF, 2: ON, 3: ON, 4: OFF, 5: OFF };
    expect(fuseProblems(stock, expected, OPTIONS)).toHaveLength(6);
    expect(fuseProblems({ ...good, 0: 114 }, expected, OPTIONS)).toEqual([
      'RunAsNode: state 114, expected off',
    ]);
  });

  it('fails when no fuse is configured', () => {
    expect(fuseProblems({}, {}, OPTIONS)).toEqual(['electron-builder.yml names no fuses']);
  });
});
