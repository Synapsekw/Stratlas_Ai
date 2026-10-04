import type { ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { Bridge, Res } from './bridge';
import { answerShimSave, landingScreen, legacyLayers, readShimSave } from './legacy';

const base: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'masafi',
  name: 'Masafi',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

const review = {
  kind: 'legacy' as const,
  id: 'review',
  name: 'Masafi review',
  viewer: 'volumetric' as const,
  entry: { path: 'legacy/Masafi Stockpile Review.html' },
  visible: true,
};

const mesh = {
  kind: 'mesh' as const,
  id: 'm',
  name: 'Model',
  src: { path: 'models/m.glb' },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  visible: true,
};

describe('legacyLayers', () => {
  it('lists the legacy viewer layers of a project', () => {
    expect(legacyLayers({ ...base, layers: [mesh, review] })).toEqual([review]);
    expect(legacyLayers(undefined)).toEqual([]);
  });
});

describe('landingScreen', () => {
  it('lands on the review when the original viewer is all the project has', () => {
    expect(landingScreen({ ...base, layers: [review] })).toBe('review');
  });
  it('lands on the scene when there is native content', () => {
    expect(landingScreen({ ...base, layers: [mesh, review] })).toBe('scene');
    expect(landingScreen(base)).toBe('scene');
  });
});

describe('readShimSave', () => {
  it('accepts a save message from the shim', () => {
    expect(
      readShimSave({ source: 'stratlas-legacy', type: 'save', filename: 'a.csv', data: 'x' }),
    ).toEqual({ filename: 'a.csv', data: 'x' });
    const bytes = new Uint8Array([1]);
    expect(
      readShimSave({ source: 'stratlas-legacy', type: 'save', filename: 'a.bin', data: bytes }),
    ).toEqual({ filename: 'a.bin', data: bytes });
  });
  it('ignores anything else', () => {
    for (const m of [
      null,
      'save',
      { source: 'other', type: 'save', filename: 'a', data: 'x' },
      { source: 'stratlas-legacy', type: 'delete', filename: 'a', data: 'x' },
      { source: 'stratlas-legacy', type: 'save', filename: 3, data: 'x' },
      { source: 'stratlas-legacy', type: 'save', filename: 'a', data: 3 },
    ]) {
      expect(readShimSave(m)).toBeNull();
    }
  });
});

describe('answerShimSave', () => {
  function bridgeAnswering(res: Res<unknown>) {
    const calls: unknown[] = [];
    const bridge: Bridge = {
      call: (channel, req) => {
        calls.push({ channel, req });
        return Promise.resolve(res as never);
      },
    };
    return { bridge, calls };
  }

  it('saves through dialog:saveFile and confirms', async () => {
    const { bridge, calls } = bridgeAnswering({ ok: true, value: { path: 'C:/x/a.csv' } });
    const r = await answerShimSave({ filename: 'a.csv', data: 'x' }, bridge);
    expect(r).toEqual({ ok: true });
    expect(calls).toEqual([
      { channel: 'dialog:saveFile', req: { defaultName: 'a.csv', data: 'x' } },
    ]);
  });

  it('reports a cancelled dialog as declined', async () => {
    const { bridge } = bridgeAnswering({ ok: true, value: { path: null } });
    expect(await answerShimSave({ filename: 'a.csv', data: 'x' }, bridge)).toEqual({
      ok: false,
      code: 'declined',
    });
  });

  it('passes on write and bridge errors', async () => {
    const write = bridgeAnswering({ ok: true, value: { path: null, error: 'Disk full' } });
    expect(await answerShimSave({ filename: 'a', data: 'x' }, write.bridge)).toEqual({
      ok: false,
      error: 'Disk full',
    });
    const down = bridgeAnswering({ ok: false, error: 'No bridge' });
    expect(await answerShimSave({ filename: 'a', data: 'x' }, down.bridge)).toEqual({
      ok: false,
      error: 'No bridge',
    });
  });
});
