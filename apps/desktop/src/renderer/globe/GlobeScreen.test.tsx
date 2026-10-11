// @vitest-environment jsdom
import type { GlobeController, GlobeViewProps } from '@aio/globe/view';
import type { GlobeSite } from '@aio/schema';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What the screen reads from the app: the library's sites, or why they could not be read. */
const app = { sites: [] as GlobeSite[], error: null as string | null };
/** What the screen gave the Globe at its last render, and the flights it asked of it. */
const globe = { props: null as GlobeViewProps | null, flyToSite: vi.fn(() => Promise.resolve()) };

function answer(channel: string): unknown {
  if (channel === 'globe:sites')
    return app.error === null
      ? { ok: true, value: { ok: true, sites: app.sites } }
      : { ok: true, value: { ok: false, error: app.error } };
  // no packs, no saved settings: the screen falls back to its defaults
  return { ok: false, error: 'none' };
}

// the Globe itself is CesiumJS: stand in a view that keeps its props and shows the card it is given
vi.mock('@aio/globe/view', () => ({
  GlobeView: (props: GlobeViewProps) => {
    globe.props = props;
    const { onReady } = props;
    useEffect(() => {
      onReady?.({ flyToSite: globe.flyToSite } as unknown as GlobeController);
    }, [onReady]);
    return <div data-testid="globe-canvas">{props.card}</div>;
  },
}));
vi.mock('@aio/engine', () => ({ reducedMotion: () => true }));
vi.mock('@aio/workspace', () => {
  const state = () => ({ project: null, issues: [] });
  return {
    useWorkspace: (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
    workspace: { getState: state },
  };
});
vi.mock('../shell', () => ({
  bridge: { call: (channel: string) => Promise.resolve(answer(channel)) },
  shell: { getState: () => ({}) },
  useShell: (selector: (s: { library: object[]; settings: object }) => unknown) =>
    selector({ library: [], settings: {} }),
}));
vi.mock('../shell/BrandMotion', () => ({ BrandLoader: () => null }));
vi.mock('../graphics', () => ({
  useGraphics: (selector: (s: { tier: string }) => unknown) => selector({ tier: 'high' }),
}));
vi.mock('../workspace/siteTiles', () => ({
  rasterPacks: { getState: () => ({ refresh: () => undefined }) },
  useRasterPacks: (selector: (s: { prefs: { onlineSatellite: boolean } }) => unknown) =>
    selector({ prefs: { onlineSatellite: false } }),
}));
vi.mock('./street', () => ({ GLOBE_PALETTE: {}, useStreetTiles: () => null }));

import GlobeScreen from './GlobeScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const site = (projectId: string, name: string, open = 0): GlobeSite => ({
  projectId,
  name,
  lonLat: [10, 50],
  captures: [],
  issues: { open, bySeverity: {} },
  tilesets: [],
});
const QUARRY = site('quarry', 'Hill quarry', 2);
const YARD = site('yard', 'Harbour yard');

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  // jsdom has no layout, so no scrolling
  Element.prototype.scrollIntoView = () => undefined;
  app.sites = [QUARRY, YARD];
  app.error = null;
  globe.props = null;
  globe.flyToSite.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const field = () => host.querySelector<HTMLInputElement>('input[role="combobox"]');
const option = (name: string) =>
  [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (o) => o.querySelector('.name')?.textContent === name,
  );

/** The screen, once the library has answered. */
async function mount() {
  root = createRoot(host);
  await act(async () => {
    root?.render(<GlobeScreen />);
    await new Promise((done) => setTimeout(done, 0));
  });
}
/** Pick a site in the field, as a person does: focus lists the sites, a click picks one. */
function pickInField(name: string) {
  act(() => field()?.focus());
  act(() => option(name)?.click());
}
const comesBefore = (a: Element | null, b: Element | null) =>
  a !== null &&
  b !== null &&
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('the Globe screen', () => {
  it('has the field, the Map button and Measure, and no side panel', async () => {
    await mount();
    expect(field()?.getAttribute('aria-label')).toBe('Find a site');
    expect(q('globe-map-button')?.textContent).toBe('Map');
    expect(q('globe-notice')).toBeNull();
    expect(host.querySelector('aside')).toBeNull();

    const controls = [...host.querySelectorAll('.globe-controls button')];
    expect(controls.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Measure on the ellipsoid',
      'Zoom in',
      'Zoom out',
      'Show all sites',
    ]);
    const measure = q('globe-measure');
    expect(measure).toBe(controls[0]);
    expect(measure?.getAttribute('title')).toBe('Measure on the ellipsoid');
    expect(measure?.getAttribute('aria-pressed')).toBe('false');
    expect(measure?.textContent).toBe('');
  });

  it('opens a site picked in the field as a card at its pin, and flies there', async () => {
    await mount();
    expect(q('globe-card')).toBeNull();
    expect(globe.props?.cardPick).toBeNull();

    pickInField('Hill quarry');
    expect(globe.flyToSite).toHaveBeenCalledWith(QUARRY.lonLat);
    expect(globe.props?.cardPick).toEqual({ kind: 'site', projectId: 'quarry' });
    expect(globe.props?.selected).toBe('quarry');
    // the Globe is given the card and shows it in its own slot
    const card = q('globe-card');
    expect(q('globe-canvas')?.contains(card)).toBe(true);
    expect(card?.getAttribute('role')).toBe('dialog');
    expect(card?.getAttribute('aria-label')).toBe('Hill quarry');
    expect(card?.textContent).toContain('2 open issues');
    expect(
      [...(card?.querySelectorAll('.actions button') ?? [])].map((b) => b.textContent),
    ).toEqual(['Fly to', 'Open site here']);
  });

  it('keeps the tab order: the field, Map, the card, then the view buttons', async () => {
    await mount();
    pickInField('Harbour yard');
    expect(comesBefore(field(), q('globe-map-button'))).toBe(true);
    expect(comesBefore(q('globe-map-button'), q('globe-card'))).toBe(true);
    expect(comesBefore(q('globe-card'), q('globe-measure'))).toBe(true);
  });

  it('lights on the map the site the keyboard is on in the field', async () => {
    await mount();
    act(() => field()?.focus());
    expect(globe.props?.highlighted).toBeNull();
    act(() => {
      field()?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    });
    const lit = host.querySelector('[role="option"][data-active="true"] .name')?.textContent;
    expect(lit).toBeTruthy();
    expect(globe.props?.highlighted).toBe(app.sites.find((s) => s.name === lit)?.projectId);
  });

  it('closes the card on Esc pressed inside it, and with its Close button', async () => {
    await mount();
    pickInField('Hill quarry');
    act(() => {
      q('globe-card')
        ?.querySelector('.actions button')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
    });
    expect(q('globe-card')).toBeNull();
    expect(globe.props?.cardPick).toBeNull();
    expect(globe.props?.selected).toBeNull();

    pickInField('Hill quarry');
    act(() => q('globe-card')?.querySelector<HTMLElement>('[aria-label="Close"]')?.click());
    expect(q('globe-card')).toBeNull();
  });

  it('puts the read-out in the place of the field while measuring', async () => {
    await mount();
    pickInField('Hill quarry');
    expect(q('globe-readout')).toBeNull();

    act(() => q('globe-measure')?.click());
    expect(q('globe-measure')?.getAttribute('aria-pressed')).toBe('true');
    expect(globe.props?.measuring).toBe(true);
    expect(q('globe-readout')?.textContent).toContain('Click points on the ground');
    expect(field()).toBeNull();
    // measuring starts with no card open
    expect(q('globe-card')).toBeNull();
    // the Map button stays
    expect(q('globe-map-button')).not.toBeNull();

    act(() => q('globe-measure')?.click());
    expect(q('globe-readout')).toBeNull();
    expect(field()).not.toBeNull();
  });

  it('says so in a notice, in the place of the field, when no site can be placed', async () => {
    app.sites = [];
    await mount();
    const notice = q('globe-notice');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('No project can be placed on the globe yet');
    expect(notice?.hasAttribute('data-tone')).toBe(false);
    expect(field()).toBeNull();
    // the settings and the view buttons are still there
    expect(q('globe-map-button')).not.toBeNull();
    expect(q('globe-measure')).not.toBeNull();
  });

  it('says why in the notice when the library could not be read', async () => {
    app.error = 'The library could not be read.';
    await mount();
    const notice = q('globe-notice');
    expect(notice?.textContent).toBe('The library could not be read.');
    expect(notice?.getAttribute('data-tone')).toBe('danger');
  });

  it('tells the Globe how to word a cluster, and has no label for one', async () => {
    await mount();
    expect(globe.props?.clusterLabel?.(1)).toBe('1 site');
    expect(globe.props?.clusterLabel?.(4)).toBe('4 sites');
    expect(globe.props?.describe?.({ kind: 'cluster', count: 4 })).toBeNull();
    expect(globe.props?.describe?.({ kind: 'site', projectId: 'quarry' })).toEqual({
      title: 'Hill quarry',
      note: '2 open issues',
    });
  });

  it('keeps the card clear of its own pieces, with the same insets at every render', async () => {
    await mount();
    const insets = globe.props?.cardInsets;
    expect(insets).toEqual({ top: 56, right: 12, bottom: 44, left: 12 });
    pickInField('Hill quarry');
    expect(globe.props?.cardInsets).toBe(insets);
  });
});
