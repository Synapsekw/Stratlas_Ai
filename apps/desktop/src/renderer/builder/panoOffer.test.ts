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
import { QUEUED_NOTE } from './importSummary';
import { builder, panoOfferCopy, panoOfferExcluded, panoOfferFrom } from './state';

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
/** A drop of already-stitched 360s: no raw sphere frames, one ready-made panorama. */
const readyFile = 'D:/Pano/sphere.jpg';
const readyOnly: PanoScan = {
  ...none,
  ready: [
    {
      key: 'r1',
      file: readyFile,
      bytes: 20_000_000,
      lat: 25.2,
      lon: 55.3,
      takenAt: '2026-09-10T10:00:00',
    },
  ],
  files: 1,
  skipped: [],
};
/** What main answers for a drop without a JPEG (a model, a cloud, a video). */
const empty: PanoScan = {
  scanId: 'scan-2',
  spheres: [],
  ready: [],
  skipped: [],
  files: 0,
  day: null,
};

function main(found: PanoScan, plan?: unknown, nothingLeft = false) {
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
          // main answers no files when every file was left out
          ...(nothingLeft ? { files: [] } : {}),
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

  it('offers a drop that holds only ready-made panoramas', () => {
    const offer = panoOfferFrom(['D:/Pano'], readyOnly);
    expect(offer).toMatchObject({
      frames: [],
      spheres: 0,
      paths: ['D:/Pano'],
      scan: readyOnly,
    });
    expect(offer && panoOfferCopy(offer)).toEqual({
      body: '1 of these files is a ready-made 360 panorama. Import it as a panorama?',
      extra: null,
      skip: 'Skip these panoramas',
      unplaced: null,
      fisheye: null,
    });
  });

  it('keeps the sphere sentence and mentions a ready-made panorama in the same drop', () => {
    const offer = panoOfferFrom(['D:/card'], { ...scan, ready: readyOnly.ready });
    expect(offer && panoOfferCopy(offer)).toEqual({
      body: '25 of these frames are 1 drone panorama. Import it as a panorama?',
      extra: '1 ready-made panorama in this drop is included.',
      skip: 'Skip these frames',
      unplaced: null,
      fisheye: null,
    });
  });

  it('says which 360s have no GPS and import unplaced, and names a dual-fisheye skip', () => {
    const noGps = { key: 'r2', file: 'D:/Pano/ground.jpg', bytes: 1 };
    const fisheye = { file: 'D:\\Pano\\IMG_0001.insp', reason: 'dual-fisheye' as const };
    const offer = panoOfferFrom(['D:/Pano'], {
      ...readyOnly,
      ready: [...readyOnly.ready, noGps],
      skipped: [fisheye, { file: 'D:/Pano/x.JPG', reason: 'few-frames' }],
    });
    const copy = offer && panoOfferCopy(offer);
    // an accepted unplaced 360 stays out of the photo import: it is never brought in twice
    expect(offer && panoOfferExcluded(offer)).toContain('D:/Pano/ground.jpg');
    expect(copy?.unplaced).toBe(
      '1 360 has no GPS: it imports as not placed, ready to pin on the site.',
    );
    expect(copy?.fisheye).toBe(
      'IMG_0001.insp: Two fisheye circles, not a 360 yet: export it as a 360 photo from Insta360 Studio first.',
    );
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

  it('skips the sphere frames on no: imports only the other files, without asking again', async () => {
    main(scan);
    await builder.getState().importFiles(['D:/card']);
    await builder.getState().declinePanoOffer();
    expect(openPanoScan).not.toHaveBeenCalled();
    expect(imports()).toEqual([expect.objectContaining({ paths: ['D:/card'], exclude: frames })]);
    expect(call.mock.calls.filter(([c]) => c === 'panos:scan')).toHaveLength(1);
  });

  it('asks no camera heights for the sphere frames it leaves out', async () => {
    main(scan);
    await builder.getState().importFiles(['D:/card']);
    await builder.getState().declinePanoOffer();
    const plans = call.mock.calls.filter(([c]) => c === 'builder:altitudePlan');
    expect(plans).toEqual([
      ['builder:altitudePlan', expect.objectContaining({ paths: ['D:/card'], exclude: frames })],
    ]);
  });

  it('shows no import card when every file was a sphere frame left out', async () => {
    main(scan, undefined, true);
    await builder.getState().importFiles(['D:/card'], undefined, { exclude: frames });
    expect(imports()).toHaveLength(1);
    expect(builder.getState().importResult).toBeNull();
    expect(builder.getState().importing).toBeNull();
  });

  it('imports a drop without JPEGs straight away: no panorama card', async () => {
    main(empty);
    await builder.getState().importFiles(['D:/site/model.glb', 'D:/site/cloud.las', 'D:/walk.mp4']);
    expect(builder.getState().panoOffer).toBeNull();
    expect(builder.getState().panoFailed).toBeNull();
    expect(imports()).toEqual([
      expect.objectContaining({ paths: ['D:/site/model.glb', 'D:/site/cloud.las', 'D:/walk.mp4'] }),
    ]);
    expect(imports()[0]?.exclude).toBeUndefined();
  });

  it('says why a drop of only a dual-fisheye .insp brings in no 360', async () => {
    const note =
      'IMG_7.insp: Two fisheye circles, not a 360 yet: export it as a 360 photo from Insta360 Studio first.';
    main({
      ...empty,
      files: 1,
      skipped: [{ file: 'D:\\Pano\\IMG_7.insp', reason: 'dual-fisheye' }],
    });
    const answer = call.getMockImplementation();
    if (!answer) throw new Error('expected a main stand-in');
    call.mockImplementation((channel: string, req: unknown): Promise<unknown> =>
      channel === 'builder:cloudDates'
        ? Promise.resolve({ ok: true, value: { ok: true, clouds: [] } })
        : (answer(channel, req) as Promise<unknown>),
    );
    builder.setState({ importNotice: null });
    await builder.getState().importFiles(['D:/Pano/IMG_7.insp']);
    expect(builder.getState().panoOffer).toBeNull();
    expect(builder.getState().importNotice).toBe(note);
    builder.getState().dismissImport();
    expect(builder.getState().importNotice).toBeNull();
    // a cloud dates check that fails as well keeps the sentence beside its own
    call.mockImplementation(answer);
    await builder.getState().importFiles(['D:/Pano/IMG_7.insp']);
    expect(builder.getState().importNotice).toContain(note);
    expect(builder.getState().importNotice).toContain('Could not read the dates');
    builder.getState().dismissImport();
  });

  it('stops at the offer when the drop is only ready-made panoramas', async () => {
    main(readyOnly);
    await builder.getState().importFiles(['D:/Pano']);
    expect(builder.getState().panoOffer).toMatchObject({ spheres: 0, paths: ['D:/Pano'] });
    expect(imports()).toEqual([]);
  });

  it('opens the preview for ready-made panoramas and leaves them out of the photos', async () => {
    main(readyOnly);
    await builder.getState().importFiles(['D:/Pano']);
    const accepting = builder.getState().acceptPanoOffer();
    expect(openPanoScan).toHaveBeenCalledWith(readyOnly);
    await Promise.resolve();
    expect(imports()).toEqual([]);
    panoImport.setState({ open: false });
    await accepting;
    expect(imports()).toEqual([
      expect.objectContaining({ paths: ['D:/Pano'], exclude: [readyFile] }),
    ]);
  });

  it('leaves ready-made panoramas out of the photos when the offer is declined', async () => {
    main(readyOnly);
    await builder.getState().importFiles(['D:/Pano']);
    await builder.getState().declinePanoOffer();
    expect(openPanoScan).not.toHaveBeenCalled();
    expect(imports()).toEqual([
      expect.objectContaining({ paths: ['D:/Pano'], exclude: [readyFile] }),
    ]);
  });

  it('leaves a ready-made panorama out of the photos when spheres are in the same drop', async () => {
    const mixed: PanoScan = { ...scan, ready: readyOnly.ready };
    main(mixed);
    await builder.getState().importFiles(['D:/card']);
    await builder.getState().declinePanoOffer();
    expect(imports()).toEqual([
      expect.objectContaining({ paths: ['D:/card'], exclude: [...frames, readyFile] }),
    ]);
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

  it('queues a drop while the offer shows, then scans it for spheres on its turn', async () => {
    main(scan);
    await builder.getState().importFiles(['D:/card']);
    call.mockClear();
    await builder.getState().importFiles(['D:/other']);
    expect(call).not.toHaveBeenCalled();
    expect(builder.getState().panoOffer?.paths).toEqual(['D:/card']);
    expect(builder.getState().queued).toBe(1);
    expect(builder.getState().importNotice).toBe(QUEUED_NOTE);
    // answering the offer runs the first import, then the waiting drop is checked, not imported
    await builder.getState().declinePanoOffer();
    expect(imports()).toEqual([expect.objectContaining({ paths: ['D:/card'], exclude: frames })]);
    expect(builder.getState().panoOffer?.paths).toEqual(['D:/other']);
    expect(builder.getState().queued).toBe(0);
    builder.getState().dismissPanoOffer();
    expect(imports()).toHaveLength(1);
  });

  it('queues a drop while the scan runs, and shows the checking state', async () => {
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
    expect(builder.getState().queued).toBe(1);
    release({ ok: true, value: { ok: true, scan } });
    await first;
    expect(builder.getState().panoScanning).toBe(false);
    expect(builder.getState().panoOffer?.paths).toEqual(['D:/card']);
    // cancelling the offer lets the waiting drop go: scanned, no sphere, imported as photos
    main(none);
    builder.getState().dismissPanoOffer();
    await vi.waitFor(() => {
      expect(imports()).toEqual([expect.objectContaining({ paths: ['D:/other'] })]);
    });
    expect(call.mock.calls.filter(([c]) => c === 'panos:scan')).toHaveLength(2);
    expect(imports()[0]?.exclude).toBeUndefined();
  });

  it('cancel on the offer imports nothing', async () => {
    main(scan);
    await builder.getState().importFiles(['D:/card']);
    builder.getState().dismissPanoOffer();
    expect(builder.getState().panoOffer).toBeNull();
    expect(imports()).toEqual([]);
  });
});
