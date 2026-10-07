import { cameraQuatFromGimbal } from '@aio/geo';
import type { DirectionKey, Layer, PoseSample, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { createAlignStore } from './alignStore';
import { drapeMesh } from './directionDrape';
import { withClipKeys } from './orientationEdit';
import {
  keyAt,
  moveKey,
  pitchForFarEdge,
  previewKeys,
  segmentKey,
  setFill,
  withKey,
} from './directionModel';

const START = 1_767_596_400_000;

const clip: Extract<Layer, { kind: 'video' }> = {
  kind: 'video',
  id: 'clip-1',
  name: 'Clip',
  visible: true,
  src: { path: 'video/clip-1.mp4' },
  flight: { src: { path: 'flights/clip-1.json' }, startUtcMs: START },
  lens: { model: 'pinhole', hfovDeg: 70, aspect: 16 / 9 },
  offsetMs: 0,
};

/** 20 s east at 5 m/s, 40 m up, camera estimated looking east 30 degrees down. */
const samples: PoseSample[] = Array.from({ length: 1001 }, (_, i) => ({
  t: i * 20,
  pos: [i * 0.1, 40, 0],
  q: cameraQuatFromGimbal(90, -30, 0),
}));

const key = (t: number, yaw: number, extra: Partial<DirectionKey> = {}): DirectionKey => ({
  t,
  yaw,
  pitch: -30,
  roll: 0,
  fill: 'smooth',
  ...extra,
});

function setup(keys?: DirectionKey[]) {
  const ws = createWorkspace();
  ws.getState().openProject({
    id: 'p',
    root: 'x',
    manifest: { layers: [clip] } as unknown as ProjectManifest,
  });
  // the saved keyframes live in orientation.json, held by the workspace
  if (keys) ws.getState().setOrientation(withClipKeys(null, 'clip-1', keys));
  const saved: (DirectionKey[] | null)[] = [];
  const save = vi.fn((id: string, k: DirectionKey[] | null) => {
    saved.push(k);
    ws.getState().setOrientation(withClipKeys(ws.getState().orientation, id, k));
    return Promise.resolve(null);
  });
  const showBoth = vi.fn();
  const store = createAlignStore({
    workspace: ws,
    save,
    flight: () => samples,
    loadFlight: () => undefined,
    duration: () => 20_000,
    showBoth,
  });
  const at = (ms: number) => {
    ws.getState().setTime(START + ms);
  };
  return { ws, store, saved, save, showBoth, at };
}

describe('direction keyframe editing rules', () => {
  const keys = [key(0, 10), key(1000, 20), key(5000, 30)];

  it('finds the keyframe at the playhead and the one whose fill rules', () => {
    expect(keyAt(keys, 1010)).toBe(1);
    expect(keyAt(keys, 1100)).toBe(-1);
    expect(segmentKey(keys, 3000)).toBe(1);
    expect(segmentKey(keys, -100)).toBe(0);
    expect(segmentKey(keys, 9000)).toBe(2);
    expect(segmentKey([], 0)).toBe(-1);
  });

  it('adds a keyframe in order and replaces one at the same time', () => {
    expect(withKey(keys, key(3000, 99)).map((k) => k.t)).toEqual([0, 1000, 3000, 5000]);
    expect(withKey(keys, key(1005, 99))[1]).toMatchObject({ t: 1005, yaw: 99 });
  });

  it('shows a turn not set yet with the fill of its segment', () => {
    const p = previewKeys([key(0, 10, { fill: 'track' })], {
      t: 800,
      dir: { yaw: 50, pitch: -20, roll: 0 },
    });
    expect(p).toHaveLength(2);
    expect(p[1]).toMatchObject({ t: 800, yaw: 50, fill: 'track' });
  });

  it('moves a keyframe in time between its neighbours', () => {
    expect(moveKey(keys, 1, 9000, 20_000)[1]?.t).toBe(4960);
    expect(moveKey(keys, 1, -50, 20_000)[1]?.t).toBe(40);
    expect(moveKey(keys, 2, 30_000, 20_000)[2]?.t).toBe(20_000);
  });

  it('sets a fill; a look-at keeps its target, other fills drop it', () => {
    expect(setFill(keys, 0, 'lookAt')[0]?.fill).toBe('smooth');
    const look = setFill(keys, 0, 'lookAt', [1, 0, 2]);
    expect(look[0]).toMatchObject({ fill: 'lookAt', target: [1, 0, 2] });
    expect(setFill(look, 0, 'track')[0]).toEqual({ ...key(0, 10), fill: 'track' });
  });

  it('puts the far edge where the tilt handle is dragged', () => {
    const lens = { model: 'pinhole' as const, hfovDeg: 90, aspect: 1 };
    // 45 degree vertical half angle: the top edge 40 m out at 40 m up is 45 degrees down
    expect(pitchForFarEdge(40, 40, lens)).toBeCloseTo(-90, 6);
    expect(pitchForFarEdge(40, 400, lens)).toBeCloseTo(-45 - (Math.atan(0.1) * 180) / Math.PI, 6);
  });
});

describe('the frame drape on the map', () => {
  const toLonLat = (p: readonly number[]): [number, number] => [
    (p[0] ?? 0) / 1e5,
    -(p[2] ?? 0) / 1e5,
  ];
  const lens = { model: 'pinhole' as const, hfovDeg: 90, aspect: 1 };

  it('lays a straight-down frame square under the drone', () => {
    const m = drapeMesh(
      { pos: [0, 100, 0], q: cameraQuatFromGimbal(0, -90 + 1e-9, 0) },
      lens,
      toLonLat,
    );
    expect(m).not.toBeNull();
    const [tl, tr, br] = m?.corners ?? [];
    expect(tl?.[0]).toBeCloseTo(-100 / 1e5, 6);
    expect(tr?.[0]).toBeCloseTo(100 / 1e5, 6);
    expect(tl?.[1]).toBeCloseTo(100 / 1e5, 6);
    expect(br?.[1]).toBeCloseTo(-100 / 1e5, 6);
    expect(m?.triangles).toHaveLength(200);
    expect(m?.width).toBe(m?.height);
  });

  it('follows the heading and leaves the sky out', () => {
    const east = drapeMesh(
      { pos: [0, 40, 0], q: cameraQuatFromGimbal(90, -30, 0) },
      lens,
      toLonLat,
    );
    expect(east?.corners[0][0]).toBeGreaterThan(0);
    expect(east?.triangles.length).toBeLessThan(200);
    expect(
      drapeMesh({ pos: [0, 40, 0], q: cameraQuatFromGimbal(0, 60, 0) }, lens, toLonLat),
    ).toBeNull();
  });
});

describe('align camera to map', () => {
  it('starts on the clip at the playhead and shows the map beside the 3D view', () => {
    const { store, ws, showBoth } = setup();
    store.getState().start('clip-1');
    expect(store.getState().session?.layerId).toBe('clip-1');
    expect(ws.getState().activeClip).toBe('clip-1');
    expect(showBoth).toHaveBeenCalled();
    expect(ws.getState().directionDraft).toEqual({ layerId: 'clip-1', keys: [] });
    expect(store.getState().current()?.yaw).toBeCloseTo(90, 3);
  });

  it('turns, sets keyframes, edits the one under the playhead, undoes, and saves with undo', async () => {
    const { store, ws, saved, at } = setup();
    const a = () => store.getState();
    a().start('clip-1');
    at(2000);
    a().turn({ yaw: 120 });
    // a turn that is not a keyframe yet shows everywhere
    expect(ws.getState().directionDraft?.keys).toMatchObject([{ t: 2000, yaw: 120 }]);
    a().setKey();
    at(8000);
    a().turn({ yaw: 160 });
    a().setKey();
    expect(a().session?.keys.map((k) => [k.t, k.yaw])).toEqual([
      [2000, 120],
      [8000, 160],
    ]);
    // between them: the turn is interpolated
    at(5000);
    expect(a().current()?.yaw).toBeCloseTo(140, 3);
    // on a keyframe a turn edits it
    at(8000);
    a().turn({ yaw: 170 });
    expect(a().session?.keys[1]?.yaw).toBe(170);
    a().undo();
    expect(a().session?.keys[1]?.yaw).toBe(160);
    await a().done();
    expect(saved).toEqual([[key(2000, 120), key(8000, 160)]]);
    expect(a().session).toBeNull();
    expect(ws.getState().directionDraft).toBeNull();
    expect(a().notice?.action).toEqual({ kind: 'undo', layerId: 'clip-1', keys: null });
    // undo takes the keyframes away, redo puts them back
    await a().applyNotice();
    expect(saved.at(-1)).toBeNull();
    expect(a().notice?.action?.kind).toBe('redo');
    await a().applyNotice();
    expect(saved.at(-1)).toHaveLength(2);
  });

  it('drops a turn that was not set when the playhead moves on', () => {
    const { store, at } = setup();
    store.getState().start('clip-1');
    at(1000);
    store.getState().turn({ yaw: 10 });
    expect(store.getState().session?.trial).not.toBeNull();
    at(3000);
    expect(store.getState().session?.trial).toBeNull();
    expect(store.getState().say?.tone).toBe('bad');
  });

  it('sets the first and last frame from what is shown, and a look-at by a pick', () => {
    const { store, ws } = setup();
    const a = () => store.getState();
    a().start('clip-1');
    a().firstLast();
    expect(a().session?.keys.map((k) => k.t)).toEqual([0, 19_960]);
    expect(a().session?.keys[0]?.yaw).toBeCloseTo(90, 2);
    expect(ws.getState().nowMs).toBe(START);
    a().fill('lookAt');
    expect(a().session?.picking).toBe(true);
    a().pick([50, 0, -50]);
    expect(a().session?.keys[0]).toMatchObject({ fill: 'lookAt', target: [50, 0, -50] });
    expect(a().session?.picking).toBe(false);
  });

  it('cancels without saving and clears saved keyframes with undo', async () => {
    const { store, saved, ws } = setup([key(0, 10), key(4000, 50)]);
    const a = () => store.getState();
    a().start('clip-1');
    a().deleteKey();
    a().cancel();
    expect(saved).toEqual([]);
    expect(ws.getState().directionDraft).toBeNull();
    await a().clear('clip-1');
    expect(saved).toEqual([null]);
    await a().applyNotice();
    expect(saved.at(-1)).toEqual([key(0, 10), key(4000, 50)]);
  });

  it('moves a saved keyframe from the timeline in a session', () => {
    const { store } = setup([key(0, 10), key(4000, 50)]);
    store.getState().moveKey('clip-1', 1, 6000);
    expect(store.getState().session?.keys[1]?.t).toBe(6000);
  });
});
