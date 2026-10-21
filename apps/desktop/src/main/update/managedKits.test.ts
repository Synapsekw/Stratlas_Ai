import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  managedKitDirectory,
  readManagedSelection,
  selectManagedKit,
  rollbackManagedKit,
} from './managedKits';
const ref = { version: '0.20.0', sha256: 'a'.repeat(64), appRange: '>=0.25.0 <2.0.0' };
describe('managed kit selections', () => {
  it('isolates future-app selection from old executable and keeps kit-only recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kits-'));
    try {
      await selectManagedKit(root, '0.25.0', ref);
      expect(await readManagedSelection(root, '0.24.0')).toBeNull();
      expect(await readManagedSelection(root, '0.25.0')).toEqual(ref);
      expect(managedKitDirectory(root, ref)).toContain('.website-kits');
      await rollbackManagedKit(root, '0.25.0');
      expect(await readManagedSelection(root, '0.25.0')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('ignores corrupted or traversing persistent records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kits-'));
    try {
      const dir = join(root, 'runtime', '.website-kits');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'selection-v1.json'),
        JSON.stringify({
          schema: 'quadrion.kit-selection/1',
          apps: { '0.25.0': { current: { ...ref, sha256: '../../evil' }, previous: null } },
        }),
      );
      expect(await readManagedSelection(root, '0.25.0')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
