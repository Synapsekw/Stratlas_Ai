import { describe, expect, it } from 'vitest';
import {
  exportAllowed,
  exportKindForFile,
  ipc,
  LibraryEntry,
  PACKAGE_HEADER_FILE,
  parsePackageHeader,
} from './index';

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
