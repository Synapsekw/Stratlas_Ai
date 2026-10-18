// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
import { PerspectiveCamera } from 'three';
import { expect, it } from 'vitest';
import type { Frame } from '../survey/measureScene';
import { attachAntennaLabels } from './antennaLabels';
import type { AntennaLabelSpot } from './antennaVisibility';

it('places visible labels, hides the one behind the camera, and detaches', () => {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.append(canvas);
  document.body.append(host);
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
  host.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  let frame: () => void = () => undefined;
  const stage = {
    camera,
    renderer: { domElement: canvas },
    onFrame: (fn: () => void) => {
      frame = fn;
      return () => undefined;
    },
  };
  const spots: AntennaLabelSpot[] = [
    { key: 'a', text: 'A1', at: [0, 0, 0], kind: 'name', selected: true },
    { key: 'b', text: 'B1', at: [0, 0, 20], kind: 'dim', selected: false },
  ];
  const detach = attachAntennaLabels(stage as unknown as EngineStage, {} as Frame, () => spots);
  frame();
  const box = host.querySelector('.antenna-labels');
  expect(box?.getAttribute('aria-hidden')).toBe('true');
  const spans = box?.querySelectorAll<HTMLElement>('span.sv-label') ?? [];
  expect(spans).toHaveLength(2);
  const [a, b] = [spans[0], spans[1]];
  expect(a?.dataset.key).toBe('a');
  expect(a?.classList.contains('sel')).toBe(true);
  expect(a?.classList.contains('antenna-label--name')).toBe(true);
  expect(a?.style.display).toBe('');
  expect(a?.style.transform).toMatch(/^translate\(/);
  expect(a?.style.fontSize).toBe('12px');
  expect(b?.style.display).toBe('none');
  detach();
  expect(host.querySelector('.antenna-labels')).toBeNull();
});
