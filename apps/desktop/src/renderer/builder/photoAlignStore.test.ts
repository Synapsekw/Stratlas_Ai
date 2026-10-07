import { cameraQuatFromGimbal, correctedPhoto, directionFromQuat } from '@aio/geo';
import type { PhotoCorrection, PhotoRef, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { createPhotoAlignStore } from './photoAlignStore';

const at = (min: number) => new Date(Date.UTC(2026, 0, 5, 7, min)).toISOString();
const photo = (id: string, min: number): PhotoRef => ({
  id,
  src: { path: `photos/${id}.jpg` },
  takenAt: at(min),
  pos: [Number(id.slice(1)) * 10, 40, 0],
  q: cameraQuatFromGimbal(90, -45, 0),
});

function setup() {
  const ws = createWorkspace();
  const items = [photo('p1', 0), photo('p2', 3), photo('p3', 6), photo('p4', 90)];
  ws.getState().openProject({
    id: 'p',
    root: 'x',
    manifest: {
      layers: [{ kind: 'photos', id: 'photos', name: 'Photos', visible: true, items }],
    } as unknown as ProjectManifest,
  });
  const saves: Record<string, PhotoCorrection | null>[] = [];
  const save = vi.fn((_l: string, fixes: Record<string, PhotoCorrection | null>) => {
    saves.push(fixes);
    const p = ws.getState().project;
    if (p) {
      const layers = p.manifest.layers.map((l) =>
        l.kind === 'photos'
          ? {
              ...l,
              items: l.items.map((it) => {
                if (!(it.id in fixes)) return it;
                const c = fixes[it.id];
                const n = { ...it };
                if (c) n.correction = c;
                else delete n.correction;
                return n;
              }),
            }
          : l,
      );
      ws.getState().replaceManifest({ ...p.manifest, layers });
    }
    return Promise.resolve(null);
  });
  const store = createPhotoAlignStore({ workspace: ws, save, showBoth: () => undefined });
  const item = (id: string) => {
    const l = ws.getState().project?.manifest.layers[0];
    return l?.kind === 'photos' ? l.items.find((p) => p.id === id) : undefined;
  };
  return { ws, store, saves, item };
}

describe('align photo to map', () => {
  it('turns the photo as a correction of its gimbal pose, saves it, offers the flight', async () => {
    const { store, saves, ws, item } = setup();
    const a = () => store.getState();
    a().start('photos', 'p2');
    expect(ws.getState().selection).toEqual({ kind: 'photo', id: 'p2', layer: 'photos' });
    expect(a().current()?.yaw).toBeCloseTo(90, 4);
    a().turn({ yaw: 80 });
    a().setOffset([0, -2, 0]);
    expect(a().current()?.yaw).toBeCloseTo(80, 4);
    expect(a().pose()?.pos).toEqual([20, 38, 0]);
    await a().done();
    expect(saves).toEqual([{ p2: { yawDeg: -10, pitchDeg: 0, rollDeg: 0, offsetM: [0, -2, 0] } }]);
    expect(a().session).toBeNull();
    // the saved photo draws turned; its pose on disk is the imported one
    const p2 = item('p2');
    expect(p2?.q).toEqual(cameraQuatFromGimbal(90, -45, 0));
    const drawn = p2 ? correctedPhoto(p2) : undefined;
    expect(directionFromQuat(drawn?.q ?? [0, 0, 0, 1]).yaw).toBeCloseTo(80, 4);
    // the other photos of the flight (not p4, an hour later) can take the same correction
    expect(a().notice?.flight?.ids).toEqual(['p1', 'p3']);
    await a().applyToFlight();
    expect(item('p1')?.correction?.yawDeg).toBe(-10);
    expect(item('p3')?.correction?.yawDeg).toBe(-10);
    expect(item('p4')?.correction).toBeUndefined();
    // undo takes it back from those two
    await a().applyNotice();
    expect(item('p1')?.correction).toBeUndefined();
    expect(item('p2')?.correction?.yawDeg).toBe(-10);
  });

  it('undoes turns, cancels without saving, resets a saved correction with undo', async () => {
    const { store, saves, item } = setup();
    const a = () => store.getState();
    a().start('photos', 'p1');
    a().gesture(true);
    a().turn({ yaw: 100 });
    a().turn({ yaw: 110 });
    a().gesture(false);
    a().undo();
    expect(a().current()?.yaw).toBeCloseTo(90, 4);
    a().turn({ pitch: -30 });
    a().cancel();
    expect(saves).toEqual([]);
    a().start('photos', 'p1');
    a().turn({ pitch: -30 });
    await a().done();
    expect(item('p1')?.correction?.pitchDeg).toBeCloseTo(15, 3);
    await a().resetSaved('photos', 'p1');
    expect(item('p1')?.correction).toBeUndefined();
    await a().applyNotice();
    expect(item('p1')?.correction?.pitchDeg).toBeCloseTo(15, 3);
  });
});
