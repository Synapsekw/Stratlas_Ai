import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyThreshold,
  forgetDetector,
  readApplied,
  readLearning,
  resetThreshold,
  setLearn,
  THRESHOLDS_FILE,
  withApplied,
} from './thresholds';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'thresholds-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('learning settings', () => {
  it('none before any apply, and none from a broken file', async () => {
    expect(await readApplied(dir)).toEqual({});
    expect(await readLearning(dir)).toEqual({ thresholds: {}, learnOff: [] });
    await writeFile(join(dir, THRESHOLDS_FILE), '{ not json');
    expect(await readApplied(dir)).toEqual({});
  });

  it('two applies at once both land; a later one replaces its own id only', async () => {
    await Promise.all([applyThreshold(dir, 'chimney', 0.85), applyThreshold(dir, 'flue', 0.6)]);
    await applyThreshold(dir, 'chimney', 0.7);
    expect(await readApplied(dir)).toEqual({ chimney: 0.7, flue: 0.6 });
  });

  it('reset goes back to the detector own threshold', async () => {
    await applyThreshold(dir, 'chimney', 0.85);
    await applyThreshold(dir, 'flue', 0.6);
    await resetThreshold(dir, 'chimney');
    expect(await readApplied(dir)).toEqual({ flue: 0.6 });
  });

  it('the learn switch is on unless turned off', async () => {
    await setLearn(dir, 'chimney', false);
    await setLearn(dir, 'flue', false);
    await setLearn(dir, 'flue', true);
    expect((await readLearning(dir)).learnOff).toEqual(['chimney']);
  });

  it('forgetting a detector drops its threshold and its switch', async () => {
    await applyThreshold(dir, 'chimney', 0.85);
    await setLearn(dir, 'chimney', false);
    await applyThreshold(dir, 'flue', 0.6);
    await forgetDetector(dir, 'chimney');
    expect(await readLearning(dir)).toEqual({ thresholds: { flue: 0.6 }, learnOff: [] });
  });

  it('a file that cannot be read is moved aside with a warning, never overwritten', async () => {
    await writeFile(join(dir, THRESHOLDS_FILE), '{ not json');
    const warnings: string[] = [];
    await applyThreshold(dir, 'chimney', 0.85, (w) => warnings.push(w));
    expect(await readApplied(dir)).toEqual({ chimney: 0.85 });
    const aside = (await readdir(dir)).filter((f) => f.startsWith(`${THRESHOLDS_FILE}.bak-`));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(dir, aside[0] ?? ''), 'utf8')).toBe('{ not json');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('moved');
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
