import {
  ProjectManifest,
  WALK_SCHEMA,
  type ImportItem,
  type JobRecord,
  type PipelinePackStatus,
  type WalkFile,
  type WalkLayer,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';

const call = vi.hoisted(() => vi.fn());
const start = vi.hoisted(() => vi.fn<(req: unknown) => Promise<string | null>>());
vi.mock('../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    bridge: { call },
    shell: { getState: () => ({ screen: 'scene', stageMode: 'split', go: vi.fn() }) },
    jobs: createStore(() => ({ jobs: [] as unknown[], start })),
  };
});
vi.mock('../builder/state', async () => {
  const { createStore } = await import('zustand/vanilla');
  return { builder: createStore(() => ({ cancellable: false, importResult: null })) };
});
const PACK_OK = {
  state: 'ok',
  runtimeDir: 'R',
  platform: 'win32-x64',
  needs: [],
} as unknown as PipelinePackStatus;
vi.mock('../processingTools', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    processingTools: createStore(() => ({
      status: { state: 'ok', runtimeDir: 'R', platform: 'win32-x64', needs: [] },
      load: () => Promise.resolve(),
    })),
  };
});

import { builder } from '../builder/state';
import { processingTools } from '../processingTools';
import { jobs } from '../shell';
import { locateOriginal, processWalk, walks } from './walks';

const walkLayer = (id: string): WalkLayer => ({
  kind: 'walk',
  id: `walk-${id}`,
  name: id,
  visible: true,
  record: { path: `walks/${id}/walk.json` },
  src: { path: `walks/${id}/playback.mp4` },
  durationS: 12,
});

const manifest = (layers: WalkLayer[]) =>
  ProjectManifest.parse({
    schema: 'aio.project/1',
    id: 'p',
    name: 'P',
    crs: { epsg: 32633 },
    origin: [500000, 4500000, 0],
    captures: [],
    layers,
    severityModels: [],
    classCatalogues: [],
  });

afterEach(() => {
  workspace.getState().closeProject();
  call.mockReset();
  start.mockReset();
  jobs.setState({ jobs: [] });
  builder.setState({ importResult: null });
  processingTools.setState({ status: PACK_OK });
});

const record = (id: string, file: string, layout: WalkFile['source']['layout']): WalkFile => ({
  schema: WALK_SCHEMA,
  id,
  name: id,
  createdAt: '2026-10-11T08:00:00.000Z',
  source: { file, layout, streams: [{ width: 128, height: 128, codec: 'avc1', fps: 30 }] },
  video: {
    src: `walks/${id}/playback.mp4`,
    width: 256,
    height: 128,
    durationS: 1,
    fps: 30,
    audio: false,
  },
});

/** Open a project whose walk `vid-1` came from `VID_1.insv`; main lists its record. */
async function openCameraWalk(): Promise<void> {
  call.mockImplementation((channel: string) =>
    Promise.resolve(
      channel === 'walks:list'
        ? { ok: true, value: { walks: [record('vid-1', 'VID_1.insv', 'insv-dual-stream')] } }
        : { ok: false, error: '?' },
    ),
  );
  workspace
    .getState()
    .openProject({ id: 'p', root: 'C:/p', manifest: manifest([walkLayer('vid-1')]) });
  await walks.getState().sync('p', workspace.getState().project?.manifest.layers ?? []);
}

const imported = (file: string): ImportItem => ({ file, kind: 'video', status: 'imported' });

const listCalls = () => call.mock.calls.filter(([c]) => c === 'walks:list').length;

describe('processWalk', () => {
  it('starts walk.process on the walk folder of the open project', async () => {
    await openCameraWalk();
    start.mockResolvedValue(null);
    expect(await processWalk('walk-vid-1', { walk: 'vid-1', src: ['D:/VID_1.insv'] })).toBeNull();
    expect(start).toHaveBeenCalledWith({
      pipeline: 'walk.process',
      project: 'C:/p',
      params: { walk: 'vid-1', src: ['D:/VID_1.insv'] },
    });
    expect(walks.getState().startErrors).toEqual({});
  });

  it('remembers on the walk layer why it could not start', async () => {
    await openCameraWalk();
    start.mockResolvedValue('No pipeline pack');
    expect(await processWalk('walk-vid-1', { walk: 'vid-1' })).toBe('No pipeline pack');
    expect(walks.getState().startErrors).toEqual({ 'walk-vid-1': 'No pipeline pack' });
  });
});

describe('locateOriginal', () => {
  const walk = record('vid-1', 'VID_1.insv', 'insv-dual-stream');

  it('asks for the original filtered to its extension, and takes it', async () => {
    call.mockResolvedValue({ ok: true, value: { paths: ['D:/cam/vid_1.INSV'] } });
    expect(await locateOriginal(walk)).toEqual({ path: 'D:/cam/vid_1.INSV' });
    expect(call).toHaveBeenCalledWith(
      'dialog:openFiles',
      expect.objectContaining({ filters: [{ name: 'VID_1.insv', extensions: ['insv'] }] }),
    );
  });

  it('says so when another file was picked, and nothing when the dialog was closed', async () => {
    call.mockResolvedValue({ ok: true, value: { paths: ['D:/cam/VID_2.insv'] } });
    const wrong = await locateOriginal(walk);
    expect(wrong && 'error' in wrong ? wrong.error : null).toContain('VID_2.insv');
    call.mockResolvedValue({ ok: true, value: { paths: [] } });
    expect(await locateOriginal(walk)).toBeNull();
  });
});

describe('walk.process after an import', () => {
  it('processes a walk the import added, from the original it was given', async () => {
    await openCameraWalk();
    start.mockResolvedValue(null);
    builder.setState({
      importResult: { items: [imported('VID_1.insv')], error: null, paths: ['D:/cam/VID_1.insv'] },
    });
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledWith({
        pipeline: 'walk.process',
        project: 'C:/p',
        params: { walk: 'vid-1', src: ['D:/cam/VID_1.insv'] },
      });
    });
  });

  it('starts nothing when the pipeline pack has no walk.process', async () => {
    await openCameraWalk();
    processingTools.setState({ status: { ...PACK_OK, state: 'missing' } });
    const before = listCalls();
    builder.setState({
      importResult: { items: [imported('VID_1.insv')], error: null, paths: ['D:/cam/VID_1.insv'] },
    });
    await vi.waitFor(() => {
      expect(listCalls()).toBeGreaterThan(before);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(start).not.toHaveBeenCalled();
  });

  it('reads the walk list again when a walk.process job of the open project is done', async () => {
    await openCameraWalk();
    const job = (status: JobRecord['status']) =>
      ({
        id: 'j1',
        pipeline: 'walk.process',
        project: 'C:\\p\\',
        status,
        params: { walk: 'vid-1' },
      }) as unknown as JobRecord;
    jobs.setState({ jobs: [job('running')] });
    const before = listCalls();
    jobs.setState({ jobs: [job('done')] });
    await vi.waitFor(() => {
      expect(listCalls()).toBe(before + 1);
    });
  });
});
