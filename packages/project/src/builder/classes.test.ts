import type { ClassCatalogue, ProjectManifest } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cataloguesProblem, updateClasses } from './classes';

const manifest = (): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [
    {
      id: 'sev',
      name: 'Severity',
      levels: [
        { value: 1, label: 'Minor', color: '#78b3d6', criteria: 'Monitor' },
        { value: 3, label: 'Severe', color: '#f05653', criteria: 'Act' },
      ],
    },
  ],
  classCatalogues: [
    {
      id: 'cat',
      name: 'Classes',
      assetType: 'asset',
      classes: [
        { id: 'crack', label: 'Crack', color: '#e5484d', hotkey: 'c', severityModel: 'sev' },
        { id: 'rust', label: 'Rust', color: '#f08a3e', severityModel: 'sev' },
      ],
    },
  ],
});

const withClasses = (classes: ClassCatalogue['classes']): ClassCatalogue[] => [
  { id: 'cat', name: 'Classes', assetType: 'asset', classes },
];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-classes-'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest()));
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [{ id: 'i1', classId: 'rust' }] }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('cataloguesProblem', () => {
  const m = manifest();
  const none = new Set<string>();
  it('accepts a valid set', () => {
    expect(cataloguesProblem(m, m.classCatalogues, none)).toBeNull();
  });
  it('refuses duplicate ids, unknown models, reserved and shared hotkeys', () => {
    const crack = { id: 'crack', label: 'Crack', color: '#e5484d', severityModel: 'sev' };
    expect(cataloguesProblem(m, withClasses([crack, { ...crack, label: 'Other' }]), none)).toMatch(
      /Two classes have the id "crack"/,
    );
    expect(cataloguesProblem(m, withClasses([{ ...crack, severityModel: 'x' }]), none)).toMatch(
      /severity model "x"/,
    );
    expect(cataloguesProblem(m, withClasses([{ ...crack, hotkey: 'u' }]), none)).toMatch(
      /reserved/,
    );
    expect(
      cataloguesProblem(
        m,
        withClasses([
          { ...crack, hotkey: 'k' },
          { id: 'b', label: 'B', color: '#000000', severityModel: 'sev', hotkey: 'K' },
        ]),
        none,
      ),
    ).toMatch(/share the hotkey "k"/);
    expect(cataloguesProblem(m, [...withClasses([]), ...withClasses([])], none)).toMatch(
      /Two class catalogues/,
    );
  });
  it('refuses to remove a class that issues use; an unknown class in issues does not matter', () => {
    expect(cataloguesProblem(m, withClasses([]), new Set(['rust']))).toMatch(
      /Class "rust" still has issues/,
    );
    expect(cataloguesProblem(m, m.classCatalogues, new Set(['imported-x']))).toBeNull();
  });
});

describe('updateClasses', () => {
  it('writes the catalogues with a backup and leaves the rest of the manifest alone', async () => {
    const next = withClasses([
      ...(manifest().classCatalogues[0]?.classes ?? []),
      { id: 'spalling', label: 'Spalling', color: '#7cc46b', severityModel: 'sev' },
    ]);
    const r = await updateClasses(dir, next);
    expect(r.backup).toMatch(/manifest\.json\.bak$/);
    const onDisk = JSON.parse(
      await readFile(join(dir, 'manifest.json'), 'utf8'),
    ) as ProjectManifest;
    expect(onDisk.classCatalogues).toEqual(next);
    expect(onDisk.severityModels).toEqual(manifest().severityModels);
  });

  it('refuses to remove a class that issues.json still uses', async () => {
    await expect(updateClasses(dir, withClasses([]))).rejects.toThrow(
      /Class "rust" still has issues/,
    );
    const onDisk = JSON.parse(
      await readFile(join(dir, 'manifest.json'), 'utf8'),
    ) as ProjectManifest;
    expect(onDisk.classCatalogues).toEqual(manifest().classCatalogues);
  });
});
