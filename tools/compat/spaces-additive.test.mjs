// Spaces and the Flyability import (data-conventions section 40) are additive, pinned against the
// 0.21 schema (tools/compat/schema-0.21), as the contract-changes row of 31 Oct 2026 says:
// - a `flightline` layer is a kind 0.21 does not know: it keeps it as an opaque layer and saves it
//   back unchanged;
// - `layer.space`, `manifest.spaces` and `Issue.external` are dropped when 0.21 saves (its objects
//   are not strict), so the layers fall back into the project's own space;
// - a manifest whose own `crs` is `local` is refused by 0.21 (its `Crs` is strict).
// The project is the committed output of the Python import of the synthetic export
// (packages/project/src/builder/flyability/__fixtures__/python-output).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v021 from './schema-0.21/index.mjs';

const DIR = join(
  import.meta.dirname,
  '..',
  '..',
  'packages',
  'project',
  'src',
  'builder',
  'flyability',
  '__fixtures__',
  'python-output',
);
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const issues = JSON.parse(readFileSync(join(DIR, 'issues.json'), 'utf8')).issues;
const flightlines = manifest.layers.filter((l) => l.kind === 'flightline');
const without = (o, key) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

describe('spaces and the flyability import are additive', () => {
  it('the project has spaces, flight lines and external findings', () => {
    expect(manifest.spaces).toHaveLength(1);
    expect(manifest.spaces[0].crs).toEqual({ local: 'flyability' });
    expect(flightlines).toHaveLength(2);
    expect(manifest.layers.every((l) => typeof l.space === 'string')).toBe(true);
    expect(issues.every((i) => i.external?.source === 'flyability')).toBe(true);
  });

  it('0.21 keeps a flight line as an opaque layer and saves it back unchanged', () => {
    const r = v021.parseManifestTolerant(manifest);
    expect(r.ok).toBe(true);
    expect(r.value.unknownLayers).toEqual(flightlines);
    expect(r.value.manifest.layers.map((l) => l.kind)).not.toContain('flightline');
    const saved = v021.keepUnknownLayers(manifest, r.value.manifest);
    expect(saved.ok).toBe(true);
    expect(saved.value.layers.filter((l) => l.kind === 'flightline')).toEqual(flightlines);
  });

  it('0.21 drops layer.space and manifest.spaces when it saves', () => {
    const r = v021.parseManifestTolerant(manifest);
    expect(r.ok).toBe(true);
    expect(r.value.manifest).not.toHaveProperty('spaces');
    for (const layer of r.value.manifest.layers) {
      expect(layer).not.toHaveProperty('space');
      const raw = manifest.layers.find((l) => l.id === layer.id);
      expect(layer).toEqual(without(raw, 'space'));
    }
  });

  it('0.21 drops Issue.external and keeps the rest of the finding', () => {
    for (const issue of issues) {
      const r = v021.Issue.safeParse(issue);
      expect(r.success).toBe(true);
      expect(r.data).not.toHaveProperty('external');
      expect(r.data).toEqual(without(issue, 'external'));
    }
  });

  it('0.21 refuses a manifest whose own crs is local; this build reads it', () => {
    const local = { ...manifest, crs: { local: 'flyability' } };
    expect(v021.parseManifestTolerant(local).ok).toBe(false);
    expect(current.parseManifest(local).ok).toBe(true);
  });

  it('this build reads the project and its findings unchanged', () => {
    const r = current.parseManifest(manifest);
    expect(r.ok).toBe(true);
    expect(JSON.parse(JSON.stringify(r.value))).toEqual(manifest);
    for (const issue of issues) {
      expect(JSON.parse(JSON.stringify(current.Issue.parse(issue)))).toEqual(issue);
    }
  });
});
