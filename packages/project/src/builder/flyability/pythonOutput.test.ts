// The files the Python flyability.import job writes, parsed with this package's schemas. The
// fixture is made by python/tests/test_flyability_import.py (test_output_matches_committed_fixture,
// synthetic export only), which fails when it no longer matches what the job writes; regenerate it
// with AIO_REGEN_FIXTURES=1. Nothing a schema strips may be in it: the app would drop it on save.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Issue, PoseSample, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AioFlight } from '../../import/flight';

const DIR = join(import.meta.dirname, '__fixtures__', 'python-output');
const read = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), 'utf8'));
/** The issues file as the app reads it (apps/desktop/src/main/project.ts). */
const IssuesFile = z.object({ schema: z.literal('aio.issues/1'), issues: z.array(Issue) });
/** A parse result as it would be saved: undefined fields gone, as JSON.stringify drops them. */
const saved = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('the Python flyability import output', () => {
  it('the manifest parses with every layer, space and field kept', () => {
    const raw = read('manifest.json') as { layers: unknown[]; spaces: unknown[] };
    const parsed = ProjectManifest.parse(raw);
    expect(raw.spaces).toHaveLength(1);
    expect(raw.layers.map((l) => (l as { kind: string }).kind).sort()).toEqual([
      'flightline',
      'flightline',
      'photos',
      'pointcloud',
      'pointcloud',
      'pointcloud',
    ]);
    expect(saved(parsed.spaces)).toEqual(raw.spaces);
    expect(saved(parsed.layers)).toEqual(raw.layers);
    expect(saved(parsed)).toEqual(raw);
  });

  it('the issues parse with every finding and its external record kept', () => {
    const raw = read('issues.json') as { issues: { external?: unknown }[] };
    const parsed = IssuesFile.parse(raw);
    expect(raw.issues.length).toBeGreaterThan(0);
    expect(raw.issues.every((i) => i.external !== undefined)).toBe(true);
    expect(saved(parsed.issues)).toEqual(raw.issues);
    expect(saved(parsed)).toEqual(raw);
  });

  it('the pose file parses as aio.flight/1 with its samples kept', () => {
    const raw = read('flight.json') as { samples: unknown[] };
    expect(saved(z.array(PoseSample).parse(raw.samples))).toEqual(raw.samples);
    expect(saved(AioFlight.parse(raw))).toEqual(raw);
  });
});
