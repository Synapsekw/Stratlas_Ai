import { describe, expect, it } from 'vitest';
import {
  HardwareProbe,
  ipc,
  ipcEvents,
  OdmInstallRecord,
  OdmStatus,
  PhotoProductsParams,
  PhotoRun,
  Settings,
} from './index';

const status = {
  state: 'installed',
  pinned: { version: '3.6.2', downloadBytes: 244_864_104, installedBytes: 1_100_000_000 },
  version: '3.6.2',
  dir: 'E:\\Data\\runtime\\odm-3.6.2',
  other: null,
  gpu: { setting: 'auto', nvidia: 'NVIDIA GeForce RTX 5070 Ti', cuda: true },
  dev: false,
  mayAskAdmin: true,
  installing: false,
};

describe('ODM contract', () => {
  it('declares the channels and the event', () => {
    for (const c of ['odm:status', 'odm:install', 'odm:cancel', 'odm:remove', 'odm:setGpu'])
      expect(Object.keys(ipc)).toContain(c);
    expect(Object.keys(ipcEvents)).toContain('odm:progress');
  });

  it('reads a status and the install record', () => {
    expect(OdmStatus.parse(status).gpu.cuda).toBe(true);
    expect(
      OdmInstallRecord.safeParse({
        schema: 'aio.odm-install/1',
        version: '3.6.2',
        dir: 'C:\\x',
        installedAt: '2026-10-14T10:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('keeps the GPU setting in Settings, and nothing else there', () => {
    const base = Settings.parse({
      cloudAi: false,
      theme: 'dark',
      sidebarCollapsed: false,
      dataRoot: 'E:\\Data',
      routes: [],
    });
    expect(
      Settings.parse({ ...base, processing: { odm: { gpu: 'off' } } }).processing?.odm?.gpu,
    ).toBe('off');
    expect(Settings.safeParse({ ...base, processing: { odm: { gpu: 'on' } } }).success).toBe(false);
  });

  it('refuses dense in products parameters', () => {
    expect(
      PhotoProductsParams.safeParse({ run: 'r1', products: ['ortho'], dense: 'cpu' }).success,
    ).toBe(false);
  });

  it('a probe can say the engine is missing, and a run names its engine', () => {
    const probe = HardwareProbe.shape.processing.parse('no-engine');
    expect(probe).toBe('no-engine');
    const run = PhotoRun.shape.engine.parse({
      name: 'odm',
      version: '3.6.2',
      gpu: { features: true },
    });
    expect(run?.gpu?.features).toBe(true);
  });
});
