// @vitest-environment jsdom
import type { ModelRoute } from '@aio/ai';
import { EngineerSetup, type Layer } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupDialog, type SetupDialogProps } from './SetupDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const layers: Layer[] = [
  {
    kind: 'pointcloud',
    id: 'scan',
    name: 'Site scan',
    visible: true,
    src: { path: 'clouds/scan.copc.laz' },
    format: 'copc',
  },
  {
    kind: 'mesh',
    id: 'mesh',
    name: 'Photo mesh',
    visible: true,
    src: { path: 'models/mesh.glb' },
    transform: I,
  },
  {
    kind: 'photos',
    id: 'shots',
    name: 'Drone photos',
    visible: true,
    items: [
      { id: 'a', src: { path: 'photos/a.jpg' } },
      { id: 'b', src: { path: 'photos/b.jpg' } },
    ],
  },
  {
    kind: 'vector',
    id: 'map',
    name: 'Site plan',
    visible: true,
    src: { path: 'vectors/plan.geojson' },
    format: 'geojson',
  },
];
const route: ModelRoute = { task: 'engineer', provider: 'anthropic', model: 'claude-opus-5-5' };

function show(over: Partial<SetupDialogProps> = {}) {
  const props: SetupDialogProps = {
    layers,
    route,
    online: true,
    familyHint: null,
    run: { start: vi.fn(() => Promise.resolve()) },
    onPickPhotos: vi.fn(() => Promise.resolve(['E:/shots/c.jpg', 'E:/shots/d.jpg'])),
    onPickRegion: vi.fn(() =>
      Promise.resolve({ centre: [12, -30] as [number, number], radiusM: 25 }),
    ),
    onPickAnchor: vi.fn(() => Promise.resolve([4, 0, -6] as [number, number, number])),
    onOpenSettings: vi.fn(),
    onPreview: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  act(() => root?.render(<SetupDialog {...props} />));
  return props;
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const check = (id: string) => {
  act(() => q(id)?.click());
};
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe('SetupDialog', () => {
  it('guides sources, options and a budget summary before starting', () => {
    show({ initial: ['scan'] });
    expect((q('eng-start') as HTMLButtonElement).hidden).toBe(true);
    act(() => q('eng-next')?.click());
    expect((q('eng-start') as HTMLButtonElement).hidden).toBe(true);
    act(() => q('eng-next')?.click());
    expect((q('eng-start') as HTMLButtonElement).hidden).toBe(false);
    expect((q('eng-next') as HTMLButtonElement).hidden).toBe(true);
  });
  it('lists the clouds, models and photo sets as sources, and adds photos from files', async () => {
    const p = show();
    const names = [...host.querySelectorAll('[data-testid^="eng-source-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(names).toEqual(['eng-source-scan', 'eng-source-mesh', 'eng-source-shots']);
    act(() => q('eng-add-photos')?.click());
    await flush();
    expect(p.onPickPhotos).toHaveBeenCalledTimes(1);
    expect(q('eng-photo-files')?.textContent).toContain('2 photos from files');
    expect(host.textContent).not.toMatch(DASHES);
  });

  it('sets a region by its centre and radius, and clears it', async () => {
    show();
    act(() => q('eng-region-pick')?.click());
    await flush();
    expect(q('eng-region')?.textContent).toContain('25 m');
    expect((q('eng-region-radius') as HTMLInputElement).value).toBe('25');
    act(() => q('eng-region-clear')?.click());
    expect(q('eng-region-radius')).toBeNull();
  });

  it('offers a box around the picked centre instead of a circle', async () => {
    const start = vi.fn<(setup: EngineerSetup) => Promise<void>>(() => Promise.resolve());
    show({ run: { start } });
    check('eng-source-scan');
    act(() => q('eng-region-pick')?.click());
    await flush();
    act(() => q('eng-region-box')?.click());
    expect(q('eng-region-radius')).toBeNull();
    const set = (id: string, v: string) => {
      const el = q(id) as HTMLInputElement;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    set('eng-box-width', '20');
    set('eng-box-depth', '10');
    set('eng-box-bottom', '-2');
    set('eng-box-top', '90');
    act(() => q('eng-start')?.click());
    await flush();
    const setup = start.mock.calls[0]?.[0];
    expect(EngineerSetup.safeParse(setup).success).toBe(true);
    expect(setup?.region).toEqual({ min: [2, -2, -35], max: [22, 90, -25] });
  });

  it('suggests the family from the evidence, and the person overrides it', () => {
    show({ familyHint: { suggested: 'chimney', reasons: ['tall, round, hollow'] } });
    expect(q('eng-family-hint')?.textContent).toContain('Chimney');
    const select = q('eng-family') as HTMLSelectElement;
    expect(select.value).toBe('auto');
    act(() => {
      select.value = 'flare';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.value).toBe('flare');
  });

  it('shows the route read-only with a link to Settings; no preview offline', () => {
    const p = show({ online: false });
    expect(q('eng-route')?.textContent).toBe('Anthropic, Claude Opus 5.5');
    expect(q('eng-route')?.querySelector('input,select')).toBeNull();
    act(() => q('eng-open-settings')?.click());
    expect(p.onOpenSettings).toHaveBeenCalled();
    expect(q('eng-preview')).toBeNull();
    expect(q('eng-offline')?.textContent).toContain('offline');
  });

  it('starts with a schema-valid setup: sources, region, scope, detail, reference, anchor', async () => {
    const start = vi.fn<(setup: EngineerSetup) => Promise<void>>(() => Promise.resolve());
    show({ run: { start } });
    // nothing chosen: no start
    expect((q('eng-start') as HTMLButtonElement).disabled).toBe(true);
    check('eng-source-scan');
    check('eng-source-shots');
    act(() => q('eng-add-photos')?.click());
    await flush();
    act(() => q('eng-region-pick')?.click());
    await flush();
    check('eng-scope-asset-and-surroundings');
    // standard is the default detail
    expect((q('eng-detail-standard') as HTMLInputElement).checked).toBe(true);
    check('eng-detail-detailed');
    const value = q('eng-ref-value') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        value,
        '42.5',
      );
      value.dispatchEvent(new Event('input', { bubbles: true }));
    });
    check('eng-placement-anchor');
    act(() => q('eng-anchor-pick')?.click());
    await flush();
    act(() => q('eng-start')?.click());
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    const setup = start.mock.calls[0]?.[0];
    expect(EngineerSetup.safeParse(setup).success).toBe(true);
    expect(setup).toEqual({
      sources: {
        clouds: [{ layer: 'scan' }],
        meshes: [],
        photos: [
          { path: 'photos/a.jpg' },
          { path: 'photos/b.jpg' },
          { path: 'E:/shots/c.jpg' },
          { path: 'E:/shots/d.jpg' },
        ],
      },
      region: { centre: [12, -30], radiusM: 25 },
      family: 'auto',
      scope: 'asset-and-surroundings',
      detail: 'detailed',
      budgetUsd: 5,
      reference: { what: 'height', valueM: 42.5 },
      placement: 'anchor',
      anchor: [4, 0, -6],
    });
  });

  it('says why Start is off when the known dimension is not a number of metres', () => {
    show({ initial: ['scan'] });
    expect((q('eng-source-scan') as HTMLInputElement).checked).toBe(true);
    expect((q('eng-start') as HTMLButtonElement).disabled).toBe(false);
    const value = q('eng-ref-value') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        value,
        'tall',
      );
      value.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect((q('eng-start') as HTMLButtonElement).disabled).toBe(true);
    expect(q('eng-ref-invalid')?.textContent).toContain('metres');
    expect(value.getAttribute('aria-invalid')).toBe('true');
  });

  it('asks for the anchor before an anchored start, and closes on Escape', () => {
    const p = show();
    check('eng-source-mesh');
    check('eng-placement-anchor');
    expect((q('eng-start') as HTMLButtonElement).disabled).toBe(true);
    check('eng-placement-unplaced');
    expect((q('eng-start') as HTMLButtonElement).disabled).toBe(false);
    act(() => {
      q('eng-setup')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(p.onClose).toHaveBeenCalled();
  });
});
