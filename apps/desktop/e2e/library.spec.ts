import { parseManifest } from '@aio/schema';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test('the synthetic data root holds a valid native project', async ({ dataRoot }) => {
  const manifest = JSON.parse(
    await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8'),
  ) as unknown;
  const parsed = parseManifest(manifest);
  expect(parsed.ok ? parsed.value.id : parsed.error).toBe(dataRoot.projectId);

  const glb = await readFile(join(dataRoot.projectDir, 'models', 'quad.glb'));
  expect(glb.toString('ascii', 0, 4)).toBe('glTF');
  expect(glb.readUInt32LE(8)).toBe(glb.length);

  const issues = JSON.parse(
    await readFile(join(dataRoot.projectDir, 'issues.json'), 'utf8'),
  ) as unknown;
  expect(issues).toEqual({ schema: 'aio.issues/1', issues: [] });
});

test('the library lists the synthetic project from QUADRION_DATA', async ({ win, dataRoot }) => {
  const entries = await win.evaluate(() => window.aio.invoke('library:list', {}));
  const entry = entries.find((e) => e.id === dataRoot.projectId);
  expect(entry).toMatchObject({ id: dataRoot.projectId, name: 'E2E tiny project', kind: 'native' });
});
