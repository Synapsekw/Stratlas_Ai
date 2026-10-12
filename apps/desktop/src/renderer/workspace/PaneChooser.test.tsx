// @vitest-environment jsdom
import type { Layer, ProjectManifest } from '@aio/schema';
import { captureIndex, dateTags, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import type { PaneKind, SplitDates, SplitPref } from './splitModel';
import { PaneChooser, pickPano, type SplitModel } from './SplitPanes';

const panoLayer = (id: string, capture?: string) =>
  ({
    kind: 'panoramas',
    id,
    name: id,
    visible: true,
    capture,
    items: [{ id: 'a', src: { path: `p/${id}.jpg` }, pos: [0, 0, 0], headingDeg: 0 }],
  }) as unknown as Layer;

const manifest: ProjectManifest = {
  ...threeDates,
  layers: [...threeDates.layers, panoLayer('p-oct', 'oct')],
};
const index = captureIndex(manifest);
const DATES: SplitDates = { captures: ['sep', 'oct', 'nov'] };
const OPTIONS: PaneKind[] = ['3d', 'map', 'video', 'pano'];

function model(
  sides: SplitPref,
  o: { dates?: SplitDates | undefined } = {},
): SplitModel & { saved: ReturnType<typeof vi.fn<(next: SplitPref) => void>> } {
  const dates = 'dates' in o ? o.dates : DATES;
  const saved = vi.fn<(next: SplitPref) => void>();
  return {
    options: OPTIONS,
    sides,
    reports: [],
    set: (next) => {
      saved(next);
    },
    saved,
    index,
    dates,
  };
}

function only<T>(v: T | undefined | null, what = 'element'): T {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p', root: '/p', manifest });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
});

const render = (side: 'left' | 'right', split: SplitModel) => {
  root ??= createRoot(host);
  act(() => root?.render(<PaneChooser side={side} split={split} />));
};
const select = (side: 'left' | 'right') =>
  only(host.querySelector<HTMLSelectElement>(`[data-testid="pane-select-${side}"]`), 'select');
const groupLabels = (side: 'left' | 'right') =>
  [...select(side).querySelectorAll('optgroup')].map((g) => g.label);

describe('PaneChooser', () => {
  it('groups the panes by survey date, newest first, then any date', () => {
    render('left', model({ left: '3d', right: 'map' }));
    expect(groupLabels('left')).toEqual(['6 Nov 2024', '2 Oct 2024', '4 Sep 2024', 'Any date']);
    expect(select('left').getAttribute('aria-label')).toBe('Left side shows');
    expect(host.querySelector('[data-testid^="pane-date-"]')).toBeNull();
  });

  it('lists Panoramas only on the dates that have them', () => {
    render('right', model({ left: '3d', right: 'map' }));
    const panoValues = [...select('right').options]
      .map((o) => o.value)
      .filter((v) => v.startsWith('pano'));
    expect(panoValues).toEqual(['pano@oct']);
  });

  it('choosing Panoramas under a date puts that pane and date on the side', () => {
    const split = model({ left: '3d', right: 'map' });
    render('right', split);
    const s = select('right');
    act(() => {
      s.value = 'pano@oct';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(split.saved).toHaveBeenCalledWith(
      expect.objectContaining({ right: 'pano', rightCapture: 'oct' }),
    );
  });

  it("disables the other side's exact pane and date", () => {
    render('right', model({ left: 'map', right: '3d', leftCapture: 'oct', rightCapture: 'nov' }));
    const opt = (v: string) =>
      only(
        [...select('right').options].find((o) => o.value === v),
        v,
      );
    expect(opt('map@oct').disabled).toBe(true);
    expect(opt('map@nov').disabled).toBe(false);
    expect(opt('video').disabled).toBe(false);
  });

  it('with one date the picker is the flat list of today', () => {
    render('left', model({ left: '3d', right: 'map' }, { dates: undefined }));
    expect(groupLabels('left')).toEqual([]);
    expect([...select('left').options].map((o) => o.value)).toEqual(OPTIONS);
    expect(select('left').value).toBe('3d');
  });

  it("shows the side's date colour for a dated pane, none for an undated one", () => {
    render('left', model({ left: 'map', right: 'map', leftCapture: 'sep', rightCapture: 'nov' }));
    const tag = only(host.querySelector<HTMLElement>('.dtag'), 'swatch');
    const colour = only(dateTags(index.captures).sep?.colour, 'colour');
    const probe = document.createElement('span');
    probe.style.background = colour;
    expect(tag.style.background).toBe(probe.style.background);
    expect(select('left').value).toBe('map@sep');
    render('left', model({ left: 'video', right: 'map', rightCapture: 'nov' }));
    expect(host.querySelector('.dtag')).toBeNull();
    expect(select('left').value).toBe('video');
  });

  it('shows the link button for two Panoramas panes, as for two maps', () => {
    render(
      'right',
      model({ left: 'pano', right: 'pano', leftCapture: 'oct', rightCapture: 'nov' }),
    );
    expect(host.querySelector('[data-testid="compare-link"]')).not.toBeNull();
    render('right', model({ left: 'map', right: 'map', leftCapture: 'oct', rightCapture: 'nov' }));
    expect(host.querySelector('[data-testid="compare-link"]')).not.toBeNull();
    render('right', model({ left: '3d', right: 'pano', rightCapture: 'oct' }));
    expect(host.querySelector('[data-testid="compare-link"]')).toBeNull();
  });

  it("keeps the side's own pane listed on a date without its data", () => {
    render('left', model({ left: 'pano', right: 'map', leftCapture: 'nov', rightCapture: 'oct' }));
    expect(select('left').value).toBe('pano@nov');
    const group = only(
      [...select('left').querySelectorAll('optgroup')].find((g) => g.label === '4 Sep 2024'),
      'sep group',
    );
    expect([...group.querySelectorAll('option')].map((o) => o.value)).not.toContain('pano@sep');
  });
});

describe('pickPano', () => {
  it('remembers the panorama and keeps the date when it is on the left date', () => {
    const split = model({ left: 'pano', right: 'map', leftCapture: 'oct', rightCapture: 'nov' });
    pickPano(split, 'p-oct/a');
    expect(split.saved).toHaveBeenCalledWith(
      expect.objectContaining({ pano: 'p-oct/a', leftCapture: 'oct', rightCapture: 'nov' }),
    );
  });

  it('moves the left date to the survey of a panorama of another date', () => {
    const split = model({ left: 'pano', right: 'map', leftCapture: 'nov', rightCapture: 'oct' });
    pickPano(split, 'p-oct/a');
    expect(split.saved).toHaveBeenCalledWith(
      expect.objectContaining({ pano: 'p-oct/a', leftCapture: 'oct', rightCapture: 'oct' }),
    );
  });

  it('swaps dates with the right when the right shows that date', () => {
    const split = model({ left: 'pano', right: 'pano', leftCapture: 'nov', rightCapture: 'oct' });
    pickPano(split, 'p-oct/a');
    expect(split.saved).toHaveBeenCalledWith(
      expect.objectContaining({ pano: 'p-oct/a', leftCapture: 'oct', rightCapture: 'nov' }),
    );
  });
});
