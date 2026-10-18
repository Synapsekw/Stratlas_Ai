// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
import { PerspectiveCamera } from 'three';
import { expect, it } from 'vitest';
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
  const detach = attachAntennaLabels(stage as unknown as EngineStage, () => spots);
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

it('draws a pin that picks its unit on click, keeps the click and shows a tooltip', () => {
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
    {
      key: 'u14:pin',
      text: '14',
      at: [0, 0, 0],
      kind: 'pin',
      selected: false,
      unitId: 'u14',
      colour: '#4fb3ff',
      title: 'A14 · panel · Draft',
    },
  ];
  const picks: string[] = [];
  const heard: string[] = [];
  for (const type of ['pointerdown', 'pointerup', 'click'])
    host.addEventListener(type, () => heard.push(type));
  const detach = attachAntennaLabels(
    stage as unknown as EngineStage,
    () => spots,
    (id) => picks.push(id),
  );
  frame();
  const pin = host.querySelector<HTMLElement>('.antenna-label--pin');
  expect(pin?.textContent).toBe('14');
  expect(pin?.title).toBe('A14 · panel · Draft');
  expect(pin?.style.background).toBe('rgb(79, 179, 255)');
  expect(pin?.style.transform).toMatch(/translate\(-50%, -50%\)$/);
  pin?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  pin?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  pin?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(picks).toEqual(['u14']);
  // the stage under the pin never hears it
  expect(heard).toEqual([]);
  // the pin stays the same element from frame to frame: one pick per click
  frame();
  host.querySelector<HTMLElement>('.antenna-label--pin')?.click();
  expect(picks).toEqual(['u14', 'u14']);
  detach();
});

it('puts the name wholly above its anchor and hangs the width under its line', () => {
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
    {
      key: 'u:name',
      text: 'A7 · 1.31 m',
      at: [0, 0, 0],
      kind: 'name',
      selected: true,
      align: 'above',
    },
    { key: 'u:dim:w', text: '1.51 m', at: [0, 0, 0], kind: 'dim', selected: true, align: 'below' },
    { key: 'u:dim:h', text: '1.31 m', at: [0, 0, 0], kind: 'dim', selected: true },
  ];
  let placed = 0;
  const detach = attachAntennaLabels(
    stage as unknown as EngineStage,
    () => spots,
    undefined,
    () => placed++,
  );
  frame();
  expect(placed).toBe(1);
  const el = (key: string) => host.querySelector<HTMLElement>(`[data-key="${key}"]`);
  expect(el('u:name')?.dataset.align).toBe('above');
  expect(el('u:name')?.style.transform).toMatch(/translate\(-50%, calc\(-100% - 4px\)\)$/);
  expect(el('u:dim:w')?.style.transform).toMatch(/translate\(-50%, 4px\)$/);
  expect(el('u:dim:h')?.dataset.align).toBeUndefined();
  expect(el('u:dim:h')?.style.transform).toMatch(/^translate\([^)]*\)$/);
  detach();
});
