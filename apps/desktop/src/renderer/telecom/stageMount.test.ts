/**
 * The stage mounts the antenna runner once, inside its marked block: the inventory's boxes and
 * the AI send preview then outlive whatever the workbench shows (the runner's behaviour is in
 * `AntennaBench.test.tsx`; mounting the whole stage takes the 3D engine).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const stage = readFileSync(join(import.meta.dirname, '../workspace/Stage.tsx'), 'utf8');

it('Stage mounts AntennaRunner exactly once, in the marked block', () => {
  expect(stage.match(/<AntennaRunner \/>/g)).toHaveLength(1);
  const start = stage.lastIndexOf('--- telecom antenna runner (telecom-ui) ---');
  const end = stage.lastIndexOf('--- end telecom antenna runner ---');
  const mount = stage.indexOf('<AntennaRunner />');
  expect(start).toBeGreaterThan(-1);
  expect(mount).toBeGreaterThan(start);
  expect(mount).toBeLessThan(end);
});
