import { describe, expect, it } from 'vitest';
import type { OdmStatus } from '@aio/schema';
import { processingEngineView } from './processingEngineView';

const base: OdmStatus = {
  state: 'not-installed',
  pinned: { version: '3.6.2', downloadBytes: 244_864_104, installedBytes: 1_100_000_000 },
  other: null,
  gpu: { setting: 'auto', nvidia: 'NVIDIA GeForce RTX 5070 Ti', cuda: true },
  dev: false,
  mayAskAdmin: true,
  installing: false,
};

describe('the Processing engine card', () => {
  it('offers the install with the sizes', () => {
    const v = processingEngineView(base, null, false);
    expect(v.state).toBe('not-installed');
    expect(v.actions).toEqual(['install']);
    expect(v.detail).toContain('234 MB');
  });

  it('shows the download and allows cancel only while downloading', () => {
    const d = processingEngineView(
      base,
      { phase: 'download', bytesDone: 122_432_052, bytesTotal: 244_864_104 },
      true,
    );
    expect(d.progress).toEqual({ label: 'Downloading 117 MB of 234 MB', pct: 50 });
    expect(d.actions).toEqual(['cancel']);
    const i = processingEngineView(base, { phase: 'install', bytesDone: 0, bytesTotal: 0 }, true);
    expect(i.progress?.pct).toBeNull();
    expect(i.actions).toEqual([]);
  });

  it('installed: version, folder, GPU line and remove', () => {
    const v = processingEngineView(
      { ...base, state: 'installed', version: '3.6.2', dir: 'E:\\Q\\odm-3.6.2' },
      null,
      false,
    );
    expect(v.tone).toBe('ok');
    expect(v.hardware).toBe('Graphics card: NVIDIA GeForce RTX 5070 Ti, used for processing');
    expect(v.actions).toEqual(['remove']);
    expect(v.gpuOn).toBe(true);
  });

  it('update, broken, no card, switched off, development', () => {
    expect(
      processingEngineView({ ...base, state: 'update-available', version: '3.5.6' }, null, false)
        .actions,
    ).toEqual(['update', 'remove']);
    expect(processingEngineView({ ...base, state: 'broken' }, null, false).actions).toEqual([
      'reinstall',
      'remove',
    ]);
    const none = processingEngineView(
      { ...base, gpu: { setting: 'auto', nvidia: null, cuda: false } },
      null,
      false,
    );
    expect(none.hardware).toBe('No NVIDIA graphics card found; processing uses the CPU');
    expect(none.gpuDisabled).toBe(true);
    const off = processingEngineView(
      { ...base, state: 'installed', gpu: { ...base.gpu, setting: 'off' } },
      null,
      false,
    );
    expect(off.hardware).toContain('switched off');
    expect(off.gpuOn).toBe(false);
    expect(
      processingEngineView({ ...base, state: 'installed', dev: true }, null, false).actions,
    ).toEqual([]);
  });
});
