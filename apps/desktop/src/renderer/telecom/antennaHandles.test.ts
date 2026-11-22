// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineStage } from '@aio/engine';
import { AntennasFile, type DateShift, type Vec3 } from '@aio/schema';
import { PerspectiveCamera } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameOf } from '../survey/measureScene';
import { attachAntennaHandles, chipPlace } from './antennaHandles';
import { boxCropSelection, draggedUnit } from './antennaBoxEdit';
import { antennaCentre, antennaMeasure, axisToLocal } from './antennaMeasure';
import type * as storeModule from './antennaStore';
import { antennaStore, commitBoxDrag } from './antennaStore';
import { projectToHost } from './screenProjection';

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
/** The screen box of a face's arrow as drawn: its stem ends and its cone's three points. */
const arrowBounds = (g: SVGGElement) => {
  const stem = g.querySelector('.antenna-handle-stem');
  const xs = [Number(stem?.getAttribute('x1')), Number(stem?.getAttribute('x2'))];
  const ys = [Number(stem?.getAttribute('y1')), Number(stem?.getAttribute('y2'))];
  const d = g.querySelector('.antenna-handle-cone')?.getAttribute('d') ?? '';
  const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  nums.forEach((v, i) => (i % 2 === 0 ? xs : ys).push(v));
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
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

  it('keeps the drag chip clear of the basemap control in the top-right corner', () => {
    // the stage around the canvas, with the basemap chip in its top-right slot
    const stageEl = document.createElement('div');
    stageEl.className = 'stage';
    const slot = document.createElement('div');
    slot.className = 'stage-slot';
    slot.dataset.slot = 'tr';
    const basemap = document.createElement('div');
    basemap.className = 'stage-basemap';
    slot.append(basemap);
    env.host.replaceWith(stageEl);
    stageEl.append(env.host, slot);
    const control = new DOMRect(700, 8, 92, 28);
    const chipSize = new DOMRect(0, 0, 130, 22);
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    spy.mockImplementation(function (this: HTMLElement) {
      if (this === basemap) return control;
      if (this.classList.contains('antenna-handle-chip')) return chipSize;
      return new DOMRect(0, 0, 0, 0);
    });
    try {
      pointer('pointerdown', handle('1:+'), 400, 300);
      // up toward the top-right corner, under the control
      pointer('pointermove', window, 620, 10);
      const chip = env.host.querySelector<HTMLElement>('[data-testid="antenna-handle-readout"]');
      const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(chip?.style.transform ?? '');
      const x = Number(m?.[1]);
      const y = Number(m?.[2]);
      const meets =
        x < control.right &&
        x + chipSize.width > control.left &&
        y < control.bottom &&
        y + chipSize.height > control.top;
      expect(meets).toBe(false);
      // and inside the canvas
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + chipSize.width).toBeLessThanOrEqual(800);
      expect(y).toBeGreaterThanOrEqual(0);
      pointer('pointerup', window, 620, 10);
    } finally {
      spy.mockRestore();
    }
  });

  it('on a narrow panel the width label stays clear of the top arrow', () => {
    // a slim panel, 0.25 m wide: the width label used to hang under the top edge's middle
    const file = antennaStore.getState().file;
    const first = file?.units[0];
    if (!file || !first) throw new Error('no unit');
    const narrow = { ...first, box: { ...first.box, extents: [0.25, 1.4, 0.15] as Vec3 } };
    antennaStore.setState({
      file: { ...file, units: file.units.map((u, i) => (i === 0 ? narrow : u)) },
    });
    const [e, nn, z] = narrow.box.centre;
    const canvasRect = new DOMRect(0, 0, 800, 600);
    // from a little above and to the side, from level, and from well above
    for (const [dx, dy] of [
      [0.5, 0.5],
      [0, 0],
      [-0.6, 1.5],
    ] as const) {
      env.camera.position.set(e + dx, z + dy, -nn - 4);
      env.camera.lookAt(e, z, -nn);
      env.camera.updateMatrixWorld();
      env.stage.requestRender();
      const width = antennaMeasure(narrow, frame, null).spots.find((s) => s.key.endsWith(':dim:w'));
      if (!width) throw new Error('no width label');
      const at = projectToHost(width.at, env.camera, canvasRect, canvasRect);
      // `.sv-label` at 12px mono: about 7.3px a character plus 6px padding a side, 20px tall;
      // placed as antennaLabels does (beside: margin -24px 0 0 6px; below: centred, 4px under)
      const w = width.text.length * 7.3 + 12;
      const label =
        width.align === 'below'
          ? { left: at.x - w / 2, top: at.y + 4, right: at.x + w / 2, bottom: at.y + 24 }
          : { left: at.x + 6, top: at.y - 24, right: at.x + 6 + w, bottom: at.y - 4 };
      const arrow = arrowBounds(handle('1:+'));
      const meets =
        label.left < arrow.right &&
        label.right > arrow.left &&
        label.top < arrow.bottom &&
        label.bottom > arrow.top;
      expect(meets, `camera offset ${String(dx)}, ${String(dy)}`).toBe(false);
    }
  });

  describe('the box sent for re-measure on a lined-up date', () => {
    /** Drag the top arrow up with `shift` as the date's line-up; the selection sent and the box. */
    const dragWith = (shift: DateShift | null) => {
      detach();
      detach = attachAntennaHandles(env.stage, frame, {
        getShift: () => shift,
        getLayer: () => 'cloud-1',
      });
      pointer('pointerdown', handle('1:+'), 400, 300);
      pointer('pointermove', window, 400, 120);
      const edit = antennaStore.getState().boxEdit;
      const held = antennaStore.getState().file?.units.find((u) => u.id === edit?.unitId);
      if (!edit || !held) throw new Error('no drag');
      const dragged = draggedUnit(held, edit.face, edit.box);
      pointer('pointerup', window, 400, 120);
      const sel = vi.mocked(commitBoxDrag).mock.calls.at(-1)?.[0].selection;
      if (!sel) throw new Error('nothing sent');
      return { sel, dragged };
    };
    /** The direction of row r of the selection's viewProj (an axis over its half extent). */
    const row = (vp: number[], r: 0 | 1): Vec3 => {
      const v: Vec3 = [vp[r] ?? 0, vp[4 + r] ?? 0, vp[8 + r] ?? 0];
      const n = Math.hypot(...v);
      return [v[0] / n, v[1] / n, v[2] / n];
    };
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    /** A local direction turned counter-clockwise (east towards north) by `deg`. */
    const turnLocal = (v: Vec3, deg: number): Vec3 => {
      const a = Math.cos((deg * Math.PI) / 180);
      const b = Math.sin((deg * Math.PI) / 180);
      return [a * v[0] + b * v[2], v[1], -b * v[0] + a * v[2]];
    };

    it('on an unturned date sends the box as stored, axes unturned', () => {
      const { sel, dragged } = dragWith({ eastM: 0.4, northM: -0.2 });
      const expected = boxCropSelection(
        antennaCentre(dragged, frame, { eastM: 0.4, northM: -0.2 }),
        dragged.box.axes.map(axisToLocal) as [Vec3, Vec3, Vec3],
        dragged.box.extents,
      );
      expect(sel.viewProj.map((v) => Number(v.toFixed(9)))).toEqual(
        expected.viewProj.map((v) => Number(v.toFixed(9))),
      );
      expect(sel.anchor).toEqual(expected.anchor);
    });

    it('on a date with a 5 degree turn sends the box as drawn, its axes not turned', () => {
      const unit = antennaStore.getState().file?.units[0];
      if (!unit) throw new Error('no unit');
      const [pe, pn] = unit.box.centre;
      const turned: DateShift = {
        eastM: 0,
        northM: 0,
        turn: { rotationDeg: 5, scale: 1, pivotE: pe, pivotN: pn, pivotX: pe, pivotZ: -pn },
      };
      const { sel, dragged } = dragWith(turned);
      const drawn = boxCropSelection(
        antennaCentre(dragged, frame, turned),
        dragged.box.axes.map(axisToLocal) as [Vec3, Vec3, Vec3],
        dragged.box.extents,
      );
      // the view does not turn a point cloud with its date, so neither is the box: its rows are
      // the stored axes, not the stored axes turned by 5 degrees
      for (const r of [0, 1] as const) {
        expect(dot(row(sel.viewProj, r), row(drawn.viewProj, r))).toBeCloseTo(1, 9);
        expect(dot(row(sel.viewProj, r), turnLocal(row(drawn.viewProj, r), 5))).toBeLessThan(
          0.9999,
        );
      }
      expect(sel.anchor).toEqual(drawn.anchor);
    });
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

describe('the drag chip placement', () => {
  const size = { w: 120, h: 22 };
  const canvas = { w: 500, h: 600 };
  it('keeps a clear gap from the stage top bar instead of touching it', () => {
    // the pointer drags the top arrow up under the top bar (its bottom edge at y 71)
    const bar = { left: 150, top: 4, right: 400, bottom: 71 };
    const at = chipPlace({ x: 260, y: 57 }, size, canvas, [bar]);
    const meets = (gap: number) =>
      at.x < bar.right + gap &&
      at.x + size.w > bar.left - gap &&
      at.y < bar.bottom + gap &&
      at.y + size.h > bar.top - gap;
    expect(meets(3)).toBe(false);
    expect(at.y + size.h).toBeLessThanOrEqual(canvas.h);
  });

  it('stays below-right of the pointer when nothing is near', () => {
    expect(chipPlace({ x: 100, y: 300 }, size, canvas, [])).toEqual({ x: 116, y: 314 });
  });
});
