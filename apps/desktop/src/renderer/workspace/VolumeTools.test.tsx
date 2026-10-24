// @vitest-environment jsdom
import type { HeightTiles } from '@aio/schema';
// @ts-expect-error the kit's own base computation is retired: the package no longer exports it
import { pileVolume } from '@aio/volumetric';
import { volumetric } from '@aio/volumetric';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteReply } from '../survey/engineClient';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectVolumeChange, VolumeDateSwipe, VolumeSurfaces } from './VolumeTools';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
const render = () => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<VolumeSurfaces />);
  });
};
const button = (name: string, within: ParentNode = host) =>
  [...within.querySelectorAll('button')].find((b) => b.textContent === name);
const click = (el: Element | undefined) => {
  if (!el) throw new Error('not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const side = (id: 'from' | 'to') => {
  const el = host.querySelector(`[data-testid="vol-change-${id}"]`);
  if (!el) throw new Error(`no ${id} pick`);
  return el;
};
const pressed = (id: 'from' | 'to') =>
  [...side(id).querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent);

/** A prepared surface of a capture (the engine's survey side). */
const surface = (id: string, capture: string) =>
  ({
    id,
    capture,
    cellM: 0.5,
    bounds: [0, 0, 0, 100, 100, 10],
    source: { kind: 'dsm' },
  }) as unknown as HeightTiles;

beforeEach(() => {
  volumetric.setState({
    status: 'ready',
    epoch: 'e3',
    surface: 'photo',
    swipe: false,
    change: null,
    changeGrid: null,
    file: {
      captures: [
        { epoch: 'e1', captureId: 'c1', date: '2026-01-12', label: '12 Jan 2026' },
        { epoch: 'e2', captureId: 'c2', date: '2026-02-09', label: '9 Feb 2026' },
        { epoch: 'e3', captureId: 'c3', date: '2026-03-09', label: '9 Mar 2026' },
      ],
    } as never,
  });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  volumetric.setState({ status: 'idle', file: null, surface: 'photo', change: null });
});

describe('Volume tools: Cut / fill', () => {
  it('default pick is previous to current', () => {
    render();
    expect(host.querySelector('[data-testid="vol-change-from"]')).toBeNull();
    click(button('Cut / fill'));
    expect(volumetric.getState().change).toEqual({ from: 'e2', to: 'e3' });
    expect(pressed('from')).toEqual(['9 Feb']);
    expect(pressed('to')).toEqual(['9 Mar']);
    // a date cannot be compared with itself
    expect(button('9 Feb', side('to'))?.disabled).toBe(true);
    expect(button('9 Mar', side('from'))?.disabled).toBe(true);
  });

  it('cut/fill compares the picked surveys, not first and last', async () => {
    const site = vi.fn((): Promise<SiteReply> =>
      Promise.resolve({
        result: {} as never,
        grid: { dz: new Float32Array(4), nx: 2, ny: 2, x0: 0, y0: 0, cellM: 50 },
      }),
    );
    const off = connectVolumeChange(volumetric, {
      site,
      surfaces: () => [surface('h1', 'c1'), surface('h2', 'c2'), surface('h3', 'c3')],
    });
    try {
      render();
      click(button('Cut / fill'));
      click(button('12 Jan', side('from')));
      expect(volumetric.getState().change).toEqual({ from: 'e1', to: 'e3' });
      click(button('9 Feb', side('to')));
      expect(volumetric.getState().change).toEqual({ from: 'e1', to: 'e2' });
      expect(pressed('from')).toEqual(['12 Jan']);
      expect(pressed('to')).toEqual(['9 Feb']);
      // the engine's whole-site comparison of the two picked surveys, never first to last
      const last = site.mock.calls.at(-1) as unknown as [{ from: unknown; to: unknown }, string];
      expect(last[0]).toMatchObject({
        from: { kind: 'survey', surface: 'h1' },
        to: { kind: 'survey', surface: 'h2' },
      });
      // and it opened on previous to current, not on the first and the last survey
      const first = site.mock.calls[0] as unknown as [{ from: unknown; to: unknown }, string];
      expect(first[0]).toMatchObject({
        from: { kind: 'survey', surface: 'h2' },
        to: { kind: 'survey', surface: 'h3' },
      });
      await vi.waitFor(() => {
        expect(volumetric.getState().changeGrid).toMatchObject({ from: 'e1', to: 'e2' });
      });
      // the line under the picks says the dates and that the engine coloured them
      act(() => undefined);
      expect(host.querySelector('[data-testid="vol-change-source"]')?.textContent).toBe(
        '12 Jan to 9 Feb, from the prepared surfaces',
      );
    } finally {
      off();
    }
  });

  it('leaves the colours to the survey heights when a date has no prepared surface', async () => {
    const site = vi.fn();
    const off = connectVolumeChange(volumetric, { site, surfaces: () => [surface('h3', 'c3')] });
    try {
      render();
      click(button('Cut / fill'));
      await Promise.resolve();
      expect(site).not.toHaveBeenCalled();
      expect(volumetric.getState().changeGrid).toBeNull();
      expect(host.querySelector('[data-testid="vol-change-source"]')?.textContent).toBe(
        '9 Feb to 9 Mar, from the survey heights (no prepared surface yet)',
      );
    } finally {
      off();
    }
  });

  it('asks the engine once the prepared surfaces arrive', () => {
    const site = vi.fn(() => new Promise<SiteReply>(() => undefined));
    let surfaces: HeightTiles[] = [];
    const listeners = new Set<() => void>();
    const off = connectVolumeChange(volumetric, {
      site,
      surfaces: () => surfaces,
      onSurfaces: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    });
    try {
      render();
      click(button('Cut / fill'));
      expect(site).not.toHaveBeenCalled();
      surfaces = [surface('h2', 'c2'), surface('h3', 'c3')];
      for (const l of listeners) l();
      expect(site).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('a To picked before From swaps them: the earlier survey is From', () => {
    render();
    click(button('Cut / fill'));
    click(button('12 Jan', side('to')));
    expect(volumetric.getState().change).toEqual({ from: 'e1', to: 'e2' });
  });
});

describe('the volumetric package', () => {
  it('exports no base computation', async () => {
    expect(pileVolume).toBeUndefined();
    const names = Object.keys(await import('@aio/volumetric'));
    for (const gone of [
      'pileVolume',
      'pileVolumes',
      'pileChange',
      'gridBase',
      'BASE_IDS',
      'registerRows',
      'registerCsv',
      'VolumesPanel',
      'BaseSelect',
      'ProfileChart',
    ])
      expect(names).not.toContain(gone);
  });
});

describe('the volume tools strings', () => {
  it('come from the catalogue: no Swipe or section line literal', () => {
    for (const file of ['VolumeTools.tsx', 'island/groups.tsx']) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      expect(src).not.toMatch(/>\s*Swipe\s*</);
      expect(src).not.toContain("'Swipe'");
      expect(src).not.toContain('Section line between');
    }
  });

  it('names the Swipe button from vol.swipe', () => {
    root ??= createRoot(host);
    act(() => {
      root?.render(<VolumeDateSwipe />);
    });
    expect(button('Swipe')).toBeDefined();
  });
});
