import type { PanoScan } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { call, openPanoScan } = vi.hoisted(() => ({ call: vi.fn(), openPanoScan: vi.fn() }));
vi.mock('../shell', () => ({
  bridge: { call },
  shell: {
    getState: () => ({
      setPalette: vi.fn(),
      openProject: vi.fn(),
      go: vi.fn(),
      loadLibrary: () => Promise.resolve(),
    }),
  },
}));
vi.mock('../panos/panos', async () => {
  const { createStore } = await import('zustand/vanilla');
  const panoImport = createStore(() => ({ open: false }));
  return {
    panoImport,
    openPanoScan: (scan: unknown) => {
      openPanoScan(scan);
      panoImport.setState({ open: true });
    },
  };
});

// the store listens for progress on the preload bridge, which a test does not have
vi.stubGlobal('window', {});

import { panoImport } from '../panos/panos';
import { builder, panoOfferFrom } from './state';

const frames = Array.from(
  { length: 25 },
  (_, i) => `D:/card/SYN_${String(i + 1).padStart(4, '0')}.JPG`,
);
const scan: PanoScan = {
  scanId: 'scan-1',
  spheres: [
    {
      key: 's1',
      shape: 'sphere',
      files: frames,
      frames: 25,
      bytes: 1,
      startedAt: '2026-09-10T10:00:00',
      lat: 0,
      lon: 0,
      incomplete: false,
    },
  ],
  ready: [],
  skipped: [{ file: 'D:/card/SYN_0100.JPG', reason: 'few-frames' }],
  files: 26,
  day: '2026-09-10',
};
const none: PanoScan = { ...scan, spheres: [] };

function main(found: PanoScan, plan?: unknown) {
  call.mockImplementation((channel: string) => {
    if (channel === 'panos:scan')
      return Promise.resolve({ ok: true, value: { ok: true, scan: found } });
    if (channel === 'builder:altitudePlan')
      return Promise.resolve(
        plan ? { ok: true, value: { ok: true, plan } } : { ok: false, error: 'not needed here' },
      );
    if (channel === 'builder:import')
      return Promise.resolve({
        ok: true,
        value: {
          ok: true,
          manifest: (workspace.getState().project as { manifest: unknown }).manifest,
          items: [],
        },
      });
    return Promise.resolve({ ok: false, error: channel });
  });
}

beforeEach(() => {
  call.mockReset();
  openPanoScan.mockReset();
  panoImport.setState({ open: false });
  builder.setState({
    panoFailed: null,
    panoScanning: false,
    panoNote: null,
    panoOffer: null,
    importing: null,
    importResult: null,
    heightsPrompt: null,
  });
  workspace.getState().openProject({
    id: 'p1',
    root: 'D:/projects/p1',
    manifest: {
      schema: 'aio.project/1',
      id: 'p1',
      name: 'P',
      crs: { epsg: 32639 },
      origin: [0, 0, 0],
      captures: [],
      layers: [],
      severityModels: [],
      classCatalogues: [],
    },
  } as never);
});

const imports = () =>
  call.mock.calls
    .filter(([c]) => c === 'builder:import')
    .map(([, req]) => req as Record<string, unknown>);

describe('panoOfferFrom', () => {
  it('offers only when spheres were found', () => {
    expect(panoOfferFrom(['D:/card'], none)).toBeNull();
    expect(panoOfferFrom(['D:/card'], scan)).toMatchObject({
      frames,
      spheres: 1,
      paths: ['D:/card'],
    });
  });
});

describe('Add data and drone spheres', () => {
  it('stops at the offer when the files hold spheres', async () => {
    main(scan);
    await builder.getState().importFiles(['D:/card']);
    expect(builder.getState().panoOffer).toMatchObject({ spheres: 1, frames });
    expect(imports()).toEqual([]);
  });

  it('opens the panorama preview on yes, and imports the rest as photos once it closes', async () => {
    main(scan);
    await builder.getState().importFiles(['D:/card']);
    const accepting = builder.getState().acceptPanoOffer();
    expect(openPanoScan).toHaveBeenCalledWith(scan);
    expect(builder.getState().panoOffer).toBeNull();
    await Promise.resolve();
    expect(imports()).toEqual([]); // the preview is modal: the photo import waits for it
    panoImport.setState({ open: false });
    await accepting;
    expect(imports()).toHaveLength(1);
    expect(imports()[0]).toEqual(expect.objectContaining({ paths: ['D:/card'], exclude: frames }));
  });

  it('imports everything as photos on no, without asking again', async () => {
    main(scan);
    await builder.getState().importFiles(['D:/card']);
    await builder.getState().declinePanoOffer();
    expect(openPanoScan).not.toHaveBeenCalled();
    expect(imports()).toEqual([expect.objectContaining({ paths: ['D:/card'] })]);
    expect(imports()[0]?.exclude).toBeUndefined();
  });

  it('goes straight on when there is no sphere, and never checks drawings or 360 video', async () => {
    main(none);
    await builder.getState().importFiles(['D:/card']);
    expect(imports()).toHaveLength(1);
    call.mockClear();
    main(scan);
    await builder.getState().importFiles(['D:/plan.pdf'], undefined, { drawings: true });
    await builder.getState().importFiles(['D:/walk.insv'], undefined, { as360: true });
    expect(call.mock.calls.some(([c]) => c === 'panos:scan')).toBe(false);
  });

  it('keeps the sphere frames out through the camera-heights card', async () => {
    const plan = {
      files: 3,
      absolute: 0,
      relative: 3,
      recommended: 'relative',
      takeoff: { x: 0, z: 0, relAltM: 0 },
      takeoffAbsAlt: null,
    };
    main(scan, plan);
    await builder.getState().importFiles(['D:/card'], undefined, { exclude: frames });
    expect(builder.getState().heightsPrompt?.exclude).toEqual(frames);
    expect(imports()).toEqual([]);
    await builder.getState().confirmHeights({ source: 'relative', takeoffH: 5 } as never);
    expect(call.mock.calls.some(([c]) => c === 'panos:scan')).toBe(false);
    expect(imports()).toHaveLength(1);
    expect(imports()[0]).toEqual(expect.objectContaining({ exclude: frames }));
  });

  it.each([
    ['not ok', () => Promise.resolve({ ok: false, error: 'x' })],
    ['refused', () => Promise.resolve({ ok: true, value: { ok: false, error: 'x' } })],
    ['thrown', () => Promise.reject(new Error('gone'))],
  ])('fails closed when the check is %s: asks before importing as photos', async (_n, answer) => {
    call.mockImplementation((channel: string) =>
      channel === 'panos:scan' ? answer() : Promise.resolve({ ok: false, error: channel }),
    );
    await builder.getState().importFiles(['D:/card']);
    expect(builder.getState().panoFailed).toMatchObject({ paths: ['D:/card'] });
    expect(builder.getState().panoScanning).toBe(false);
    expect(imports()).toEqual([]);
    main(none);
    await builder.getState().importAnyway();
    expect(imports()).toHaveLength(1);
    expect(builder.getState().panoFailed).toBeNull();
  });

  it('cancel after a failed check imports nothing', async () => {
    call.mockImplementation(() => Promise.reject(new Error('gone')));
    await builder.getState().importFiles(['D:/card']);
    builder.getState().dismissPanoOffer();
    expect(builder.getState().panoFailed).toBeNull();
    expect(imports()).toEqual([]);
  });

  it('refuses a drop while the offer shows, keeping the first files', async () => {
    main(scan);
    await builder.getState().importFiles(['D:/card']);
    call.mockClear();
    await builder.getState().importFiles(['D:/other']);
    expect(call).not.toHaveBeenCalled();
    expect(builder.getState().panoOffer?.paths).toEqual(['D:/card']);
    expect(builder.getState().panoNote).toBe('Finish the current import first.');
  });

  it('refuses a drop while the scan runs, and shows the checking state', async () => {
    let release: (v: unknown) => void = () => undefined;
    call.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const first = builder.getState().importFiles(['D:/card']);
    expect(builder.getState().panoScanning).toBe(true);
    await builder.getState().importFiles(['D:/other']);
    expect(call).toHaveBeenCalledTimes(1);
    expect(builder.getState().panoNote).toBe('Finish the current import first.');
    release({ ok: true, value: { ok: true, scan } });
    await first;
    expect(builder.getState().panoScanning).toBe(false);
    expect(builder.getState().panoOffer?.paths).toEqual(['D:/card']);
  });

  it('cancel on the offer imports nothing', async () => {
    main(scan);
    await builder.getState().importFiles(['D:/card']);
    builder.getState().dismissPanoOffer();
    expect(builder.getState().panoOffer).toBeNull();
    expect(imports()).toEqual([]);
  });
});
