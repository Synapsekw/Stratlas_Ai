import type { PanoScan, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../shell', () => ({ bridge: { call } }));

import { timeline } from '../workspace/timeline';
import {
  canUseHigh,
  defaultKeys,
  defaultLayerName,
  closePanoImport,
  importPanos,
  panoImport,
  revealPanoLayer,
  pickAndScanPanos,
  scanPanoPaths,
  summaryText,
} from './panos';

const sphere = (key: string, frames: number, over: Partial<PanoScan['spheres'][number]> = {}) => ({
  key,
  shape: 'sphere' as const,
  files: [`D:/card/${key}.JPG`],
  frames,
  bytes: frames * 20_000_000,
  startedAt: '2026-09-10T10:00:00',
  lat: 46.5,
  lon: 7.5,
  relAlt: 70,
  incomplete: false,
  ...over,
});
const scan: PanoScan = {
  scanId: 'scan-1',
  spheres: [sphere('s1', 26), sphere('s2', 26), sphere('s3', 27, { alreadyIn: 'Panoramas 4 Sep' })],
  ready: [],
  skipped: [
    { file: 'D:/card/SYN_0100.JPG', reason: 'few-frames' },
    { file: 'D:/card/SYN_0101.JPG', reason: 'few-frames' },
  ],
  files: 81,
  day: '2026-09-10',
};

const currentManifest = (): ProjectManifest =>
  (workspace.getState().project as { manifest: ProjectManifest }).manifest;

beforeEach(() => {
  call.mockReset();
  panoImport.setState({ open: false, scan: null, busy: null, error: null, notStarted: null });
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

describe('preview text', () => {
  it('names the layer after the survey day', () => {
    expect(defaultLayerName('2026-09-10')).toBe('Panoramas 10 Sep');
    expect(defaultLayerName(null)).toBe('Panoramas');
  });

  it('checks every sphere not imported already', () => {
    expect(defaultKeys(scan)).toEqual(['s1', 's2']);
  });

  it('sums up what is found, what is not and what is copied', () => {
    expect(summaryText(scan, ['s1', 's2'])).toBe(
      '2 panoramas found (26 + 26 frames) · 2 files are not panorama frames · about 992 MB copied',
    );
  });

  it('offers High only on GPUs that take 16384 px textures', () => {
    expect(canUseHigh(16384)).toBe(true);
    expect(canUseHigh(8192)).toBe(false);
  });
});

describe('pickAndScanPanos', () => {
  it('scans the chosen folder and opens the preview', async () => {
    call.mockImplementation((channel: string) => {
      if (channel === 'dialog:openFolder')
        return Promise.resolve({ ok: true, value: { path: 'D:/card' } });
      if (channel === 'panos:scan') return Promise.resolve({ ok: true, value: { ok: true, scan } });
      throw new Error(channel);
    });
    await pickAndScanPanos();
    expect(call).toHaveBeenCalledWith('panos:scan', { projectId: 'p1', paths: ['D:/card'] });
    expect(panoImport.getState()).toMatchObject({ open: true, scan, busy: null, error: null });
  });

  it('does nothing when the picker is cancelled', async () => {
    call.mockResolvedValue({ ok: true, value: { path: null } });
    await pickAndScanPanos();
    expect(panoImport.getState().open).toBe(false);
  });
});

describe('importPanos', () => {
  it('imports, takes the saved manifest and closes', async () => {
    panoImport.setState({ open: true, scan });
    const manifest = {
      ...currentManifest(),
      layers: [
        {
          kind: 'panoramas',
          id: 'panos-2026-09-10',
          name: 'Panoramas 10 Sep',
          visible: true,
          items: [],
        },
      ],
    };
    call.mockResolvedValue({
      ok: true,
      value: { ok: true, manifest, layerId: 'panos-2026-09-10', started: 2 },
    });
    expect(
      await importPanos({
        keys: ['s1', 's2'],
        layerName: 'Panoramas 10 Sep',
        date: '2026-09-10',
        quality: 'standard',
      }),
    ).toBeNull();
    expect(call).toHaveBeenCalledWith('panos:import', {
      projectId: 'p1',
      scanId: 'scan-1',
      keys: ['s1', 's2'],
      layerName: 'Panoramas 10 Sep',
      date: '2026-09-10',
      quality: 'standard',
    });
    expect(workspace.getState().project?.manifest.layers.map((l) => l.id)).toEqual([
      'panos-2026-09-10',
    ]);
    expect(panoImport.getState().open).toBe(false);
  });

  it('stays open to say why the stitches did not start', async () => {
    panoImport.setState({ open: true, scan });
    const manifest = currentManifest();
    call.mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        manifest,
        layerId: 'l',
        started: 0,
        notStarted: 'Install the processing tools.',
      },
    });
    await importPanos({ keys: ['s1'], layerName: 'P', quality: 'standard' });
    expect(panoImport.getState()).toMatchObject({
      open: true,
      notStarted: 'Install the processing tools.',
    });
  });

  it('keeps the dialog open with main’s reason on a refusal', async () => {
    panoImport.setState({ open: true, scan });
    call.mockResolvedValue({
      ok: true,
      value: {
        ok: false,
        error: 'Importing these panoramas needs 3.1 GB free, and 1.0 GB is free.',
        code: 'space',
      },
    });
    expect(await importPanos({ keys: ['s1'], layerName: 'P', quality: 'standard' })).toMatch(
      /needs 3.1 GB/,
    );
    expect(panoImport.getState()).toMatchObject({
      open: true,
      busy: null,
      error: expect.stringMatching(/needs 3.1 GB/) as string,
    });
  });
});

describe('stale results', () => {
  const later = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('ignores a scan that was cancelled or replaced', async () => {
    const a = later<unknown>();
    const b = later<unknown>();
    call.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = scanPanoPaths(['D:/a']);
    await closePanoImport();
    const second = scanPanoPaths(['D:/b']);
    const scanB = { ...scan, scanId: 'b' };
    b.resolve({ ok: true, value: { ok: true, scan: scanB } });
    await second;
    a.resolve({ ok: true, value: { ok: true, scan } });
    await first;
    expect(panoImport.getState().scan?.scanId).toBe('b');
  });

  it('keeps the manifest of an import that finished after Cancel', async () => {
    panoImport.setState({ open: true, scan });
    const imp = later<unknown>();
    call.mockImplementation((channel: string) =>
      channel === 'panos:import' ? imp.promise : Promise.resolve({ ok: true, value: {} }),
    );
    const pending = importPanos({ keys: ['s1'], layerName: 'P', quality: 'standard' });
    await closePanoImport();
    panoImport.setState({ open: true, scan: null, error: null });
    const manifest = {
      ...currentManifest(),
      layers: [{ kind: 'panoramas', id: 'late', name: 'L', visible: true, items: [] }],
    };
    imp.resolve({ ok: true, value: { ok: true, manifest, layerId: 'late', started: 1 } });
    await pending;
    expect(currentManifest().layers.map((l) => l.id)).toEqual(['late']);
    expect(panoImport.getState()).toMatchObject({ open: true, busy: null, error: null });
  });

  it('clears busy and shows the error when the call throws', async () => {
    call.mockRejectedValue(new Error('boom'));
    await scanPanoPaths(['D:/a']);
    expect(panoImport.getState()).toMatchObject({ busy: null, error: 'boom' });
  });

  it('reads sensibly with nothing selected', () => {
    expect(summaryText(scan, [])).toBe('No panoramas selected');
  });
});

describe('revealPanoLayer', () => {
  const place = (capture?: string) => {
    const item = (id: string, pos: [number, number, number]) => ({
      id,
      src: { path: `panoramas/${id}.jpg` },
      pos,
      headingDeg: 0,
    });
    const manifest = {
      ...currentManifest(),
      layers: [
        {
          kind: 'panoramas' as const,
          id: 'panos-1',
          name: 'Panoramas',
          visible: true,
          ...(capture ? { capture } : {}),
          items: [item('a', [0, 40, 0]), item('b', [300, 40, 0])],
        },
      ],
    };
    workspace.getState().replaceManifest(manifest);
  };
  const index = { captures: [{ id: 'c1' }], layers: {}, of: {}, epochs: {}, slot: {} };

  it('flies to the spheres of an undated layer', () => {
    place();
    revealPanoLayer('panos-1');
    const target = workspace.getState().lastCamera?.target;
    expect(target).toMatchObject({ kind: 'point', p: [150, 40, 0] });
    expect((target as { distance: number }).distance).toBeGreaterThanOrEqual(375);
  });

  it('focuses the layer date once the timeline knows it, then flies', () => {
    const focusSurvey = vi.fn((c: string) => {
      timeline.setState({ focus: c });
    });
    timeline.setState({ index: null, focus: null, focusSurvey } as never);
    place('c1');
    const before = workspace.getState().lastCamera;
    revealPanoLayer('panos-1');
    expect(focusSurvey).not.toHaveBeenCalled();
    expect(workspace.getState().lastCamera).toBe(before);
    timeline.setState({ index } as never);
    expect(focusSurvey).toHaveBeenCalledWith('c1');
    expect(workspace.getState().lastCamera?.target).toMatchObject({ kind: 'point' });
    // done: a later timeline change does not focus again
    timeline.setState({ index: { ...index } } as never);
    expect(focusSurvey).toHaveBeenCalledTimes(1);
  });

  it('drops the wait when another project opens, and does not fly', () => {
    const focusSurvey = vi.fn();
    timeline.setState({ index: null, focusSurvey } as never);
    place('c1');
    const before = workspace.getState().lastCamera;
    revealPanoLayer('panos-1');
    workspace
      .getState()
      .openProject({ ...(workspace.getState().project as object), id: 'p2' } as never);
    timeline.setState({ index } as never);
    expect(focusSurvey).not.toHaveBeenCalled();
    expect(workspace.getState().lastCamera).toBe(before);
  });

  it('does not fly when the timeline refuses the focus', () => {
    const focusSurvey = vi.fn();
    timeline.setState({ index, focus: null, focusSurvey } as never);
    place('c1');
    const before = workspace.getState().lastCamera;
    revealPanoLayer('panos-1');
    expect(focusSurvey).toHaveBeenCalledWith('c1');
    expect(workspace.getState().lastCamera).toBe(before);
  });

  it('does nothing for a layer that is not panoramas', () => {
    place();
    const before = workspace.getState().lastCamera;
    revealPanoLayer('missing');
    expect(workspace.getState().lastCamera).toBe(before);
  });

  it('reveals the layer an import made', async () => {
    place();
    panoImport.setState({ open: true, scan });
    call.mockResolvedValue({
      ok: true,
      value: { ok: true, manifest: currentManifest(), layerId: 'panos-1', started: 1 },
    });
    await importPanos({ keys: ['s1'], layerName: 'P', quality: 'standard' });
    expect(workspace.getState().lastCamera?.target).toMatchObject({ kind: 'point' });
  });
});
