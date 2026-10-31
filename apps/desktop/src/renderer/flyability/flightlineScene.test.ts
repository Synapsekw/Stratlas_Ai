// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
import { Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { attachFlightlines, FLIGHTLINE_GROUP } from './flightlineScene';

const stage = () => {
  const s = { scene: new Scene(), requestRender: vi.fn() };
  return { s, stage: s as unknown as EngineStage };
};
const pts = (...v: number[]) => Float32Array.from(v);

describe('flightline scene', () => {
  it('set draws one line per visible flight line and tags its layer', () => {
    const { s, stage: st } = stage();
    const view = attachFlightlines(st);
    view.set([
      { id: 'a', points: pts(0, 0, 0, 1, 0, 0), colour: '#ff0000', visible: true },
      { id: 'b', points: pts(0, 0, 0, 0, 1, 0), colour: '#00ff00', visible: false },
    ]);
    const group = s.scene.getObjectByName(FLIGHTLINE_GROUP);
    expect(group?.children).toHaveLength(1);
    expect(group?.children[0]?.userData).toEqual({ layerId: 'a' });
  });

  it('dispose removes the group', () => {
    const { s, stage: st } = stage();
    const view = attachFlightlines(st);
    view.set([{ id: 'a', points: pts(0, 0, 0, 1, 0, 0), colour: '#ff0000', visible: true }]);
    view.dispose();
    expect(s.scene.getObjectByName(FLIGHTLINE_GROUP)).toBeUndefined();
  });
});
