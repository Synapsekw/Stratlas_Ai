// @vitest-environment jsdom
import { setAnnotateReadOnly } from '@aio/annotate';
import type { ProjectManifest, ThermalRasterIndex } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobs, shell } from '../../../shell';
import type * as RasterModule from '../../../thermal/raster';
import type { ThermalRaster } from '../../../thermal/raster';
import { useThermal } from '../../../thermal/thermalStore';
import { ThermalBench } from './ThermalBench';

// thumbnails need an IntersectionObserver and workers: here only that a tile is there
vi.mock('../../../thumbs/Thumb', () => ({ MediaThumb: () => null }));
vi.mock('../../../thermal/raster', async (importOriginal) => ({
  ...(await importOriginal<typeof RasterModule>()),
  loadRasterIndex: vi.fn(() => Promise.resolve(null)),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const photo = (id: string) => ({ id, src: { path: `photos/${id}.jpg` } });
const manifest = {
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'th',
      name: 'Thermal',
      visible: true,
      items: [photo('r1'), photo('w1'), photo('r2'), photo('r3')],
    },
  ],
} as unknown as ProjectManifest;

const settings = { emissivity: 0.95, distanceM: 18, airC: 32, humidityPct: 60, reflectedC: null };
/** 4 x 4 at 30 °C with 85.04 °C at pixel (1, 2). */
function raster(): ThermalRaster {
  const data = new Float32Array(16).fill(30);
  data[2 * 4 + 1] = 85.04;
  return {
    width: 4,
    height: 4,
    data,
    meta: {
      schema: 'aio.thermalRaster/1',
      width: 4,
      height: 4,
      family: 'flir',
      camera: 'XT2',
      settings,
      clamped: [],
      minC: 30,
      maxC: 85.04,
      medianC: 30,
      decoder: 'flir/1',
      settingsKey: 'a'.repeat(64),
    },
  };
}
const index: ThermalRasterIndex = {
  schema: 'aio.thermalRaster/1',
  photos: { r1: { status: 'ok' }, r2: { status: 'unverified' } },
};
const probe = [
  { photoId: 'r1', family: 'flir', make: 'DJI', model: 'XT2' },
  { photoId: 'w1', family: null, make: null, model: null },
  { photoId: 'r2', family: 'flir', make: 'DJI', model: 'XT2' },
];

let host: HTMLDivElement;
let root: Root | undefined;
const render = () => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<ThermalBench />);
  });
};
const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const click = (el: Element | null) => {
  if (!el) throw new Error('not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const saveSettings = vi.fn(() => Promise.resolve());
const decodeMissing = vi.fn(() => Promise.resolve());
const select = vi.fn(() => Promise.resolve());

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  jobs.setState({ jobs: [] } as never);
  workspace.setState({ project: { id: 'p', root: 'C:/p', manifest } } as never);
  shell.setState({ pkg: null } as never);
  setAnnotateReadOnly(false);
  useThermal.setState({
    projectId: 'p',
    layerId: 'th',
    photoId: 'r1',
    file: { schema: 'aio.thermal/1', photos: {}, readings: [], hotspots: [] },
    index,
    probe,
    current: raster(),
    currentOf: 'r1',
    palette: 'iron',
    range: [30, 85.04],
    rangeAuto: true,
    error: null,
    readOnly: false,
    saveSettings,
    select,
    decodeMissing,
  });
  decodeMissing.mockClear();
  saveSettings.mockClear();
  select.mockClear();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  jobs.setState({ jobs: [] } as never);
  vi.restoreAllMocks();
});

/** Type into a React-controlled input. */
function typeInto(el: Element | null, value: string) {
  if (!(el instanceof HTMLInputElement)) throw new Error('no field');
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  act(() => {
    desc?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function hoverAt(clientX: number, clientY: number) {
  const canvas = byId('thermal-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 40,
    height: 40,
    right: 40,
    bottom: 40,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  act(() => {
    canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX, clientY }));
  });
}

describe('ThermalBench', () => {
  it('never shows the raster of the last photo under the next one', () => {
    // r2 picked, its load still pending: the store still holds a raster, but not r2's
    useThermal.setState({ photoId: 'r1', currentOf: 'r2' });
    render();
    expect(byId('thermal-canvas')).toBeNull();
    expect(byId('thermal-hover')).toBeNull();
    expect(byId('thermal-range-min')?.textContent).toBe('');
    expect(byId('thermal-range-max')?.textContent).toBe('');
  });

  it('a held photo has no Edit', () => {
    useThermal.setState({ photoId: 'r2', current: null, currentOf: null });
    render();
    expect(byId('thermal-settings-line')).not.toBeNull();
    expect(byId('thermal-settings-edit')).toBeNull();
  });

  it('an unsupported photo shows as an ordinary picture with its note', () => {
    useThermal.setState({
      photoId: 'r3',
      current: null,
      currentOf: null,
      index: { ...index, photos: { ...index.photos, r3: { status: 'unsupported' } } },
      probe: [...probe, { photoId: 'r3', family: null, make: 'ACME', model: 'T1' }],
    });
    render();
    expect(byId('thermal-status')?.textContent).toBe(
      'Not a supported thermal camera (ACME T1). Shown as an ordinary photo.',
    );
    const img = byId('thermal-plain');
    expect(img instanceof HTMLImageElement ? img.src : '').toContain('photos/r3.jpg');
    expect(byId('thermal-canvas')).toBeNull();
    expect(byId('thermal-settings-edit')).toBeNull();
  });

  it('a tab restored with nothing open shows the hint, not a blank bench', () => {
    useThermal.setState({ projectId: null, layerId: null, photoId: null });
    render();
    expect(byId('thermal-status')?.textContent).toBe('No thermal photos in this dataset.');
  });

  it('shows the temperature under the pointer with one decimal', () => {
    render();
    hoverAt(15, 25);
    expect(byId('thermal-hover')?.textContent).toBe('85.0 °C');
    hoverAt(35, 5);
    expect(byId('thermal-hover')?.textContent).toBe('30.0 °C');
  });

  it('an unverified photo shows its note and no temperature', () => {
    useThermal.setState({ photoId: 'r2' });
    render();
    expect(byId('thermal-status')?.textContent).toBe(
      'Temperatures held back: the reading did not match the reference tool.',
    );
    expect(byId('thermal-canvas')).toBeNull();
    expect(byId('thermal-hover')).toBeNull();
    expect(byId('thermal-range-min')?.textContent).toBe('');
  });

  it('shows the palette range and the settings line', () => {
    render();
    expect(byId('thermal-range-min')?.textContent).toBe('30.0 °C');
    expect(byId('thermal-range-max')?.textContent).toBe('85.0 °C');
    expect(byId('thermal-settings-line')?.textContent).toBe(
      'Emissivity 0.95 · Distance 18 m · Air 32 °C · Humidity 60%',
    );
  });

  it('saving for the whole dataset writes every thermal photo of the set', () => {
    render();
    click(byId('thermal-settings-edit'));
    typeInto(byId('thermal-setting-emissivity'), '0.8');
    click(byId('thermal-apply-all'));
    expect(saveSettings).toHaveBeenCalledWith(['th/r1', 'th/r2'], { ...settings, emissivity: 0.8 });
    expect(byId('thermal-settings-editor')).toBeNull();
  });

  it('saves one photo, or the photos marked in the filmstrip', () => {
    render();
    click(byId('thermal-settings-edit'));
    click(byId('thermal-apply-photo'));
    expect(saveSettings).toHaveBeenLastCalledWith(['th/r1'], settings);
    // Ctrl and a click marks
    for (const id of ['r1', 'r2'])
      act(() => {
        byId(`thermal-thumb-${id}`)?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, ctrlKey: true }),
        );
      });
    click(byId('thermal-settings-edit'));
    expect(byId('thermal-apply-selected')?.textContent).toBe('2 selected photos');
    click(byId('thermal-apply-selected'));
    expect(saveSettings).toHaveBeenLastCalledWith(['th/r1', 'th/r2'], settings);
  });

  it('the filmstrip lists the thermal photos only, and a click shows one', () => {
    render();
    const thumbs = [...(byId('thermal-filmstrip')?.querySelectorAll('button') ?? [])];
    expect(thumbs.map((b) => b.dataset.testid)).toEqual(['thermal-thumb-r1', 'thermal-thumb-r2']);
    click(byId('thermal-thumb-r2'));
    expect(select).toHaveBeenCalledWith('r2');
  });

  it('picks a palette and goes back to the auto range', () => {
    const setRange = vi.fn();
    useThermal.setState({ setRange, rangeAuto: false });
    render();
    click(byId('thermal-palette-whiteHot'));
    expect(useThermal.getState().palette).toBe('whiteHot');
    expect(byId('thermal-palette-whiteHot')?.getAttribute('aria-pressed')).toBe('true');
    click(byId('thermal-range-auto'));
    expect(setRange).toHaveBeenCalledWith(null);
  });

  it('asks the store to decode what has no raster once the probe is in', () => {
    useThermal.setState({ probe: null });
    render();
    expect(decodeMissing).not.toHaveBeenCalled();
    act(() => {
      useThermal.setState({ probe });
    });
    expect(decodeMissing).toHaveBeenCalled();
  });

  it('shows the settings the raster was decoded with when the photo has none of its own', () => {
    const r = raster();
    useThermal.setState({
      current: { ...r, meta: { ...r.meta, settings: { ...settings, distanceM: 42 } } },
    });
    render();
    expect(byId('thermal-settings-line')?.textContent).toContain('Distance 42 m');
    // the editor opens on them too
    click(byId('thermal-settings-edit'));
    const d = byId('thermal-setting-distanceM');
    expect(d instanceof HTMLInputElement ? d.value : null).toBe('42');
  });

  it("a photo's own settings win over the raster's", () => {
    useThermal.setState({
      file: {
        schema: 'aio.thermal/1',
        photos: { 'th/r1': { settings: { ...settings, distanceM: 7 } } },
        readings: [],
        hotspots: [],
      },
    });
    render();
    expect(byId('thermal-settings-line')?.textContent).toContain('Distance 7 m');
  });

  it('without a raster the line shows the defaults', () => {
    useThermal.setState({ current: null });
    render();
    expect(byId('thermal-settings-line')?.textContent).toBe(
      'Emissivity 0.95 · Distance 10 m · Air 25 °C · Humidity 50%',
    );
  });

  it('a read-only opening in the store is a read-only bench', () => {
    useThermal.setState({ readOnly: true });
    render();
    expect(byId('thermal-readonly')).not.toBeNull();
    expect(byId('thermal-settings-edit')).toBeNull();
    expect(decodeMissing).not.toHaveBeenCalled();
  });

  it('says "Reading temperatures" while the decode job runs', () => {
    jobs.setState({
      jobs: [
        {
          id: 'j',
          pipeline: 'thermal.decode',
          status: 'running',
          params: { layerId: 'th', photos: ['r1', 'r2'] },
        },
      ],
    } as never);
    render();
    expect(byId('thermal-progress')?.textContent).toBe('Reading temperatures of 2 photos');
  });

  it('a package opens read-only: its rasters, the note, no Edit and no decode', () => {
    shell.setState({ pkg: { name: 'x.aio' } } as never);
    // a package has no probe: its thermal photos are the ones its raster index lists
    useThermal.setState({
      probe: null,
      index: { schema: 'aio.thermalRaster/1', photos: { r1: { status: 'ok' } } },
    });
    render();
    expect(byId('thermal-readonly')?.textContent).toBe(
      'Open the project folder to analyse thermal photos.',
    );
    expect(byId('thermal-settings-edit')).toBeNull();
    expect(byId('thermal-settings-line')).not.toBeNull();
    expect(decodeMissing).not.toHaveBeenCalled();
    const thumbs = [...(byId('thermal-filmstrip')?.querySelectorAll('button') ?? [])];
    expect(thumbs.map((b) => b.dataset.testid)).toEqual(['thermal-thumb-r1']);
    hoverAt(15, 25);
    expect(byId('thermal-hover')?.textContent).toBe('85.0 °C');
  });

  it('a reviewer who may only look gets the read-only bench too', () => {
    setAnnotateReadOnly(true);
    useThermal.setState({ index: { schema: 'aio.thermalRaster/1', photos: {} }, current: null });
    render();
    expect(byId('thermal-readonly')).not.toBeNull();
    expect(decodeMissing).not.toHaveBeenCalled();
  });

  it('a set with no thermal photos says so', () => {
    useThermal.setState({
      probe: [{ photoId: 'w1', family: null, make: null, model: null }],
      index: null,
      current: null,
      photoId: null,
    });
    render();
    expect(byId('thermal-status')?.textContent).toBe('No thermal photos in this dataset.');
    expect(byId('thermal-filmstrip')).toBeNull();
  });
});
