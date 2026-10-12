import { describe, expect, it } from 'vitest';
import {
  EMBEDDED_RASTER_DIRS,
  exportAllowed,
  exportKindForFile,
  ipc,
  LibraryEntry,
  PACKAGE_HEADER_FILE,
  PackageExportOptions,
  packageEditAllowed,
  PackagePlan,
  parsePackageHeader,
} from './index';

describe('edit policy', () => {
  it('lets a package say whether it may be extracted, defaulting to its read-only flag', () => {
    const parse = (extra: object) => {
      const r = parsePackageHeader({ ...header, ...extra });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    expect(packageEditAllowed(parse({}))).toBe(false);
    expect(packageEditAllowed(parse({ readOnly: false }))).toBe(true);
    expect(packageEditAllowed(parse({ editPolicy: 'allow' }))).toBe(true);
    expect(packageEditAllowed(parse({ readOnly: false, editPolicy: 'forbid' }))).toBe(false);
    expect(parsePackageHeader({ ...header, editPolicy: 'maybe' }).ok).toBe(false);
  });
});

const header = {
  schema: 'aio.package/1',
  projectId: 'hcl',
  createdAt: '2026-10-04T09:00:00+03:00',
};

describe('package header', () => {
  it('defaults a customer package to read-only, AI forbidden and CSV, PDF and snapshot exports', () => {
    const r = parsePackageHeader(header);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.readOnly).toBe(true);
    expect(r.value.aiPolicy).toBe('forbid');
    expect(r.value.exports).toEqual(['issues-csv', 'report-pdf', 'snapshot']);
    expect(r.value.excludedLayers).toEqual([]);
  });

  it('keeps an explicit AI allowance and export list', () => {
    const r = parsePackageHeader({ ...header, aiPolicy: 'allow', exports: [], readOnly: false });
    expect(r.ok && r.value.aiPolicy).toBe('allow');
    expect(r.ok && r.value.exports).toEqual([]);
    expect(r.ok && r.value.readOnly).toBe(false);
  });

  it('rejects an unknown AI policy with a message naming the field', () => {
    const r = parsePackageHeader({ ...header, aiPolicy: 'sometimes' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/aiPolicy/);
  });

  it('asks for a newer app when the package schema is newer', () => {
    const r = parsePackageHeader({ ...header, schema: 'aio.package/2' });
    expect(!r.ok && r.error).toMatch(/newer/);
  });

  it('lives in a fixed member name', () => {
    expect(PACKAGE_HEADER_FILE).toBe('aio-package.json');
  });
});

describe('export limits', () => {
  it('maps a saved file to the export kind the package must allow', () => {
    expect(exportKindForFile('issues.csv')).toBe('issues-csv');
    expect(exportKindForFile('Register.PDF')).toBe('report-pdf');
    expect(exportKindForFile('issues.geojson')).toBe('issues-geojson');
    expect(exportKindForFile('view.png')).toBe('snapshot');
    expect(exportKindForFile('view.jpg')).toBe('snapshot');
    expect(exportKindForFile('masks.zip')).toBe('masks');
    expect(exportKindForFile('coco.json')).toBe('kit-json');
    expect(exportKindForFile('model.glb')).toBe('files');
  });

  it('allows an export only when the package lists its kind', () => {
    expect(exportAllowed(['issues-csv'], 'a.csv')).toBe(true);
    expect(exportAllowed(['issues-csv'], 'a.pdf')).toBe(false);
    expect(exportAllowed([], 'a.csv')).toBe(false);
  });
});

describe('package IPC', () => {
  it('accepts a passphrase when opening a project', () => {
    expect(
      ipc['project:open'].request.safeParse({ path: 'x.aio', passphrase: 'secret' }).success,
    ).toBe(true);
  });

  it('tells the renderer when an encrypted package needs its passphrase', () => {
    const r = ipc['project:open'].response.safeParse({
      ok: false,
      error: 'Enter the passphrase',
      needsPassphrase: true,
    });
    expect(r.success).toBe(true);
  });

  it('marks package entries in the library', () => {
    const r = LibraryEntry.safeParse({
      id: 'hcl-aio',
      name: 'HCl',
      path: 'C:/x/hcl.aio',
      kind: 'native',
      package: { encrypted: true, readOnly: true },
    });
    expect(r.success).toBe(true);
  });

  it('declares the export, plan, cancel and open-file channels', () => {
    for (const c of [
      'package:plan',
      'package:export',
      'package:cancel',
      'dialog:openFile',
      'app:takeOpenPath',
    ] as const) {
      expect(ipc[c]).toBeDefined();
    }
  });
});

describe('raster packs in packages', () => {
  const base = { projectId: 'p', exclude: [], readOnly: true, aiPolicy: 'forbid', exports: [] };
  it('accepts ticked imagery and terrain packs and stays compatible without them', () => {
    expect(
      PackageExportOptions.safeParse({
        ...base,
        rasterPacks: [{ kind: 'imagery', id: 'site-imagery' }],
      }).success,
    ).toBe(true);
    expect(PackageExportOptions.safeParse(base).success).toBe(true);
    expect(ipc['package:plan'].request.safeParse({ projectId: 'p', exclude: [] }).success).toBe(
      true,
    );
    expect(
      ipc['package:plan'].request.safeParse({
        projectId: 'p',
        exclude: [],
        rasterPacks: [{ kind: 'terrain', id: 'dem' }],
      }).success,
    ).toBe(true);
  });
  it('rejects a bad kind or an id with a slash', () => {
    expect(
      PackageExportOptions.safeParse({ ...base, rasterPacks: [{ kind: 'street', id: 'x' }] })
        .success,
    ).toBe(false);
    expect(
      PackageExportOptions.safeParse({ ...base, rasterPacks: [{ kind: 'imagery', id: 'a/b' }] })
        .success,
    ).toBe(false);
  });
  it('parses a plan with one ok and one refused raster entry', () => {
    const meta = { label: 'L', licence: 'x', attribution: 'y', customerLicence: false };
    const r = PackagePlan.safeParse({
      layers: [],
      baseBytes: 0,
      totalBytes: 0,
      totalFiles: 0,
      rasterPacks: [
        { kind: 'imagery', id: 'a', ...meta, ok: true, bytes: 10, tiles: 2, maxZoom: 18 },
        { kind: 'terrain', id: 'b', ...meta, ok: false, reason: 'no cover' },
      ],
    });
    expect(r.success).toBe(true);
  });
  it('names the embedded directories', () => {
    expect(EMBEDDED_RASTER_DIRS.imagery).toBe('packs/imagery');
    expect(EMBEDDED_RASTER_DIRS.terrain).toBe('packs/terrain');
  });
});
