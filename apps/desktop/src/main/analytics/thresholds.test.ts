import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyThreshold, readApplied, THRESHOLDS_FILE, withApplied } from './thresholds';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'thresholds-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('applied thresholds', () => {
  it('none before any apply, and none from a broken file', async () => {
    expect(await readApplied(dir)).toEqual({});
    await writeFile(join(dir, THRESHOLDS_FILE), '{ not json');
    expect(await readApplied(dir)).toEqual({});
  });

  it('two applies at once both land; a later one replaces its own id only', async () => {
    await Promise.all([applyThreshold(dir, 'chimney', 0.85), applyThreshold(dir, 'flue', 0.6)]);
    await applyThreshold(dir, 'chimney', 0.7);
    expect(await readApplied(dir)).toEqual({ chimney: 0.7, flue: 0.6 });
  });

  it('refuses a bad id or a threshold outside 0 to 1', async () => {
    await expect(applyThreshold(dir, '../x', 0.5)).rejects.toThrow();
    await expect(applyThreshold(dir, 'chimney', 1.5)).rejects.toThrow();
    await expect(applyThreshold(dir, 'chimney', Number.NaN)).rejects.toThrow();
  });

  it('withApplied puts the applied threshold in place of the detector own', () => {
    const items = [
      { where: 'shipped', detector: { id: 'chimney', threshold: 0.8 } },
      { where: 'library', detector: { id: 'flue', threshold: 0.8 } },
    ];
    expect(withApplied(items, { chimney: 0.65 }).map((i) => i.detector.threshold)).toEqual([
      0.65, 0.8,
    ]);
    expect(items[0]?.detector.threshold).toBe(0.8);
  });
});
