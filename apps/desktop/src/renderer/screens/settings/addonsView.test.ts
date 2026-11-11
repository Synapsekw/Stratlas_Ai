import { ADDON_SCHEMA, type AddonManifest, type AddonStatus } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { addonFacts, addonName, addonOffer, addonProgressText } from './addonsView';

const SHA = 'b'.repeat(64);
const MB = 1024 * 1024;
const manifest = (version: string): AddonManifest => ({
  schema: ADDON_SCHEMA,
  id: 'segmentation',
  name: 'Segmentation (SAM)',
  version,
  kind: 'segmenter',
  licence: 'Apache-2.0',
  source: 'https://example.org',
  sizeBytes: 90 * MB,
  files: [{ path: 'encoder.onnx', sizeBytes: 90 * MB, sha256: SHA }],
});
const bare: AddonStatus = {
  id: 'segmentation',
  kind: 'segmenter',
  installed: null,
  available: null,
  update: false,
};
const offered: AddonStatus = {
  ...bare,
  available: {
    manifest: manifest('1.1.0'),
    archive: { url: 'x', sizeBytes: 24 * MB, sha256: SHA },
  },
};
const installed: AddonStatus = {
  ...offered,
  installed: { manifest: manifest('1.0.0'), dir: 'D:\\a', sizeBytes: 90 * MB },
};

describe('add-on rows', () => {
  it('names a known add-on before the catalogue is read, else by its manifest', () => {
    expect(addonName(bare)).toBe('Segmentation');
    expect(addonName({ ...bare, id: 'ground-classifier', kind: 'point-classifier' })).toBe(
      'Ground classifier',
    );
    expect(addonName({ ...bare, id: 'road-defects', kind: 'detector' })).toBe('Road defects');
    expect(addonName(offered)).toBe('Segmentation (SAM)');
  });

  it('offers Download with the archive size, Update when newer, nothing otherwise', () => {
    expect(addonOffer(bare)).toBeNull();
    expect(addonOffer(offered)).toEqual({ kind: 'download', label: 'Download (24 MB)' });
    expect(addonOffer(installed)).toBeNull();
    expect(addonOffer({ ...installed, update: true })).toEqual({
      kind: 'update',
      label: 'Update to 1.1.0 (24 MB)',
    });
  });

  it('shows the archive size before a download and the size on disk after', () => {
    expect(addonFacts(offered)).toEqual({ version: '1.1.0', licence: 'Apache-2.0', size: '24 MB' });
    expect(addonFacts(installed)).toEqual({
      version: '1.0.0',
      licence: 'Apache-2.0',
      size: '90 MB',
    });
  });

  it('says how far an install is', () => {
    expect(addonProgressText(null)).toEqual({ text: 'Starting', pct: null });
    expect(
      addonProgressText({
        id: 'segmentation',
        phase: 'download',
        bytesDone: 12 * MB,
        bytesTotal: 24 * MB,
      }),
    ).toEqual({ text: 'Downloading 12 MB of 24 MB', pct: 50 });
    expect(
      addonProgressText({ id: 'segmentation', phase: 'check', bytesDone: 0, bytesTotal: 0 }).text,
    ).toBe('Checking the file');
    expect(
      addonProgressText({ id: 'segmentation', phase: 'unpack', bytesDone: 1, bytesTotal: 4 }),
    ).toEqual({ text: 'Unpacking', pct: 25 });
  });
});
