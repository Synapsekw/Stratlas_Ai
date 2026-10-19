import { describe, expect, it } from 'vitest';
import type { OdmStatus } from '@aio/schema';
import { phaseLabel, processingEngineView } from './processingEngineView';

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
    // the download starts before the first progress report: Cancel is there from the start
    expect(processingEngineView(base, null, true).actions).toEqual(['cancel']);
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

  it('names each install phase, in words without figures for a screen reader', () => {
    const at = (phase: 'download' | 'verify' | 'install' | 'check') =>
      processingEngineView(base, { phase, bytesDone: 1, bytesTotal: 2 }, true);
    expect(at('verify').progress).toEqual({ label: 'Checking the download', pct: null });
    expect(at('check').progress).toEqual({
      label: 'Starting ODM for the first time; this can take a few minutes',
      pct: null,
    });
    expect(processingEngineView(base, null, true).progress?.label).toBe('Installing');
    expect(phaseLabel(null)).toBe('Installing');
    expect(phaseLabel({ phase: 'download', bytesDone: 1, bytesTotal: 2 })).toBe('Downloading');
    expect(phaseLabel({ phase: 'verify', bytesDone: 0, bytesTotal: 0 })).toBe(
      'Checking the download',
    );
    expect(phaseLabel({ phase: 'check', bytesDone: 0, bytesTotal: 0 })).toBe(
      'Starting ODM for the first time; this can take a few minutes',
    );
  });

  it('says why it is broken or unsupported, and what an update means', () => {
    const broken = processingEngineView(
      { ...base, state: 'broken', problem: 'run.bat is missing.' },
      null,
      false,
    );
    expect(broken.detail).toBe('run.bat is missing.');
    expect(broken.tone).toBe('warn');
    const unsupported = processingEngineView(
      { ...base, state: 'unsupported', problem: 'ODM needs 64-bit Windows.' },
      null,
      false,
    );
    expect(unsupported.state).toBe('unsupported');
    expect(unsupported.detail).toBe('ODM needs 64-bit Windows.');
    expect(unsupported.detail).not.toContain('234 MB');
    expect(unsupported.actions).toEqual([]);
    const update = processingEngineView(
      { ...base, state: 'update-available', version: '3.5.6' },
      null,
      false,
    );
    expect(update.detail).toContain('uses ODM 3.6.2');
    expect(update.detail).toContain('234 MB');
    expect(processingEngineView(null, null, false).state).toBe('loading');
  });

  it('shows a problem as a warning while installed or update-available', () => {
    const problem = 'The GPU stub could not be renamed; dense matching will use the CPU.';
    const ok = processingEngineView({ ...base, state: 'installed', problem }, null, false);
    expect(ok.warning).toBe(problem);
    expect(ok.detail).toBeNull();
    const up = processingEngineView({ ...base, state: 'update-available', problem }, null, false);
    expect(up.warning).toBe(problem);
    expect(processingEngineView({ ...base, state: 'installed' }, null, false).warning).toBeNull();
    expect(
      processingEngineView({ ...base, state: 'broken', problem }, null, false).warning,
    ).toBeNull();
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
