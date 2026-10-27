// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineStage } from '@aio/engine';
import { AntennasFile } from '@aio/schema';
import { PerspectiveCamera } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameOf } from '../survey/measureScene';
import { attachAntennaHandles } from './antennaHandles';
import type * as storeModule from './antennaStore';
import { antennaStore, commitBoxDrag } from './antennaStore';

vi.mock('../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    jobs: createStore<{ jobs: unknown[] }>()(() => ({ jobs: [] })),
    bridge: { call: vi.fn(() => Promise.resolve({ ok: false, error: 'unexpected' })) },
  };
});

vi.mock('./antennaStore', async (importOriginal) => {
  const real = await importOriginal<typeof storeModule>();
  return { ...real, commitBoxDrag: vi.fn(() => Promise.resolve()) };
});

const contract = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '../../../../../packages/schema/src/__fixtures__/antennas-contract.json',
    ),
    'utf8',
  ),
) as { example: unknown };

const frame = frameOf({ crs: {}, origin: [0, 0, 0] } as never);

/** A stage with a real camera looking at the first unit from the front, drawn on demand. */
function fakeStage() {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 1000);
  const frames = new Set<() => void>();
  const stage = {
    renderer: { domElement: canvas },
    camera,
    controls: { enabled: true },
    requestRender: () => {
      frames.forEach((f) => {
        f();
      });
    },
    onFrame: (f: () => void) => {
      frames.add(f);
      return () => frames.delete(f);
    },
  };
  return { stage: stage as unknown as EngineStage, host, camera, controls: stage.controls };
}

let detach: () => void = () => undefined;
let env: ReturnType<typeof fakeStage>;

beforeEach(() => {
  const file = AntennasFile.parse(structuredClone(contract.example));
  const unit = file.units[0];
  if (!unit) throw new Error('no unit');
  antennaStore.setState({
    file,
    readOnly: false,
    running: false,
    flagging: null,
    flagJob: null,
    flagStarting: false,
    hidden: {},
    boxEdit: null,
    selected: unit.id,
    projectId: 'p1',
    root: '/p',
  });
  env = fakeStage();
  // the unit's centre in local is (E, Z, -N); look at it from 4 m in front (its normal is +N)
  const [e, nn, z] = unit.box.centre;
  env.camera.position.set(e + 0.5, z + 0.5, -nn - 4);
  env.camera.lookAt(e, z, -nn);
  env.camera.updateMatrixWorld();
  detach = attachAntennaHandles(env.stage, frame, {
    getShift: () => null,
    getLayer: () => 'cloud-1',
  });
});

afterEach(() => {
  detach();
  env.host.remove();
  vi.mocked(commitBoxDrag).mockClear();
});

const layer = () => env.host.querySelector<HTMLElement>('[data-testid="antenna-handles"]');
const handle = (key: string) => {
  const h = env.host.querySelector<SVGGElement>(`[data-face="${key}"]`);
  if (!h) throw new Error(`no handle ${key}`);
  return h;
};
const pointer = (type: string, target: EventTarget, x: number, y: number) => {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }),
  );
};

describe('antenna box handles', () => {
  it('shows an arrow on each of the six faces of the selected box', () => {
    expect(layer()?.style.display).toBe('');
    expect(env.host.querySelectorAll('[data-face]')).toHaveLength(6);
    expect(handle('1:+').querySelector('.antenna-handle-cone')?.getAttribute('d')).toMatch(/^M /);
  });

  it('shows none with nothing selected, read only, while a job runs and on a dish', () => {
    for (const patch of [
      { selected: null },
      { readOnly: true },
      { running: true },
      { flagJob: { id: 'j', unit: 'x' } },
    ]) {
      const before = antennaStore.getState();
      antennaStore.setState(patch);
      expect(layer()?.style.display).toBe('none');
      antennaStore.setState(before, true);
    }
    const file = antennaStore.getState().file;
    if (!file) throw new Error('no file');
    antennaStore.setState({
      file: {
        ...file,
        units: file.units.map((u, i) => (i === 0 ? { ...u, kind: 'dish' as const } : u)),
      },
    });
    expect(layer()?.style.display).toBe('none');
  });

  it('a drag moves the face, shows the chip, and a release measures the box', () => {
    pointer('pointerdown', handle('1:+'), 400, 300);
    expect(env.controls.enabled).toBe(false);
    expect(antennaStore.getState().boxEdit?.face).toEqual({ axis: 1, sign: 1 });
    expect(handle('1:+').dataset.active).toBe('1');
    const start = antennaStore.getState().boxEdit?.box.extents[1] ?? 0;
    pointer('pointermove', window, 400, 120);
    const after = antennaStore.getState().boxEdit?.box.extents[1] ?? 0;
    expect(after).toBeGreaterThan(start);
    const chip = env.host.querySelector<HTMLElement>('[data-testid="antenna-handle-readout"]');
    expect(chip?.style.display).toBe('block');
    expect(chip?.textContent).toMatch(/^HHeight \d+\.\d\d m$/);
    pointer('pointerup', window, 400, 120);
    expect(env.controls.enabled).toBe(true);
    expect(commitBoxDrag).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(commitBoxDrag).mock.calls[0]?.[0];
    expect(arg?.layer).toBe('cloud-1');
    expect(arg?.selection.polygon).toHaveLength(4);
  });

  it('Escape while dragging puts the box back and keeps the selection', () => {
    pointer('pointerdown', handle('1:+'), 400, 300);
    pointer('pointermove', window, 400, 120);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const heard = vi.fn();
    window.addEventListener('keydown', heard);
    window.dispatchEvent(esc);
    window.removeEventListener('keydown', heard);
    expect(heard).not.toHaveBeenCalled();
    expect(antennaStore.getState().boxEdit).toBeNull();
    expect(antennaStore.getState().selected).not.toBeNull();
    expect(env.controls.enabled).toBe(true);
    pointer('pointerup', window, 400, 120);
    expect(commitBoxDrag).not.toHaveBeenCalled();
  });
});
