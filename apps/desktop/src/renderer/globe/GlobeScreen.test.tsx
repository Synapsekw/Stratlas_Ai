// @vitest-environment jsdom
import type { GlobeCamera } from '@aio/globe';
import type { GlobeController, GlobeViewProps } from '@aio/globe/view';
import type { GlobeSite } from '@aio/schema';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the screen reads from the app: the library's sites (or why they could not be read), the
 * open project and its issues; and what it sent to main.
 */
const app = {
  sites: [] as GlobeSite[],
  error: null as string | null,
  project: null as { id: string; manifest: object } | null,
  issues: [] as object[],
  sent: [] as { channel: string; payload: unknown }[],
};
/** What the screen gave the Globe at its last render, and the flights it asked of it. */
const globe = {
  props: null as GlobeViewProps | null,
  flyToSite: vi.fn(() => Promise.resolve()),
  flyHome: vi.fn(),
};

/** Each project's tilesets, as `tilesets:list` answers. */
const tilesetsOf = (projectId: string) => [
  {
    id: `${projectId}-mesh`,
    name: 'Mesh',
    kind: 'mesh',
    src: 'tiles/m/tileset.json',
    visible: true,
  },
];

function answer(channel: string, payload: unknown): unknown {
  app.sent.push({ channel, payload });
  if (channel === 'globe:sites')
    return app.error === null
      ? { ok: true, value: { ok: true, sites: app.sites } }
      : { ok: true, value: { ok: false, error: app.error } };
  if (channel === 'tilesets:list') {
    const { projectId } = payload as { projectId: string };
    return { ok: true, value: { ok: true, file: { entries: tilesetsOf(projectId) } } };
  }
  // no packs, no saved settings: the screen falls back to its defaults
  return { ok: false, error: 'none' };
}

// the Globe itself is CesiumJS: stand in a view that keeps its props and shows the card it is given
vi.mock('@aio/globe/view', () => ({
  GlobeView: (props: GlobeViewProps) => {
    globe.props = props;
    const { onReady } = props;
    useEffect(() => {
      onReady?.({
        flyToSite: globe.flyToSite,
        flyHome: globe.flyHome,
      } as unknown as GlobeController);
    }, [onReady]);
    return <div data-testid="globe-canvas">{props.card}</div>;
  },
}));
vi.mock('@aio/engine', () => ({ reducedMotion: () => true }));
vi.mock('@aio/workspace', () => {
  const state = () => ({ project: app.project, issues: app.issues });
  return {
    useWorkspace: (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
    workspace: { getState: state },
  };
});
vi.mock('../shell', () => ({
  bridge: {
    call: (channel: string, payload: unknown) => Promise.resolve(answer(channel, payload)),
  },
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
  useRasterPacks: (selector: (s: object) => unknown) =>
    selector({
      prefs: { onlineSatellite: false },
      online: { source: 'esri-world-imagery', keys: { esri: false, mapbox: false } },
    }),
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
/** The quarry as the open project, and one open issue of it with a place in 3D (so it has a pin). */
const QUARRY_PROJECT = {
  id: 'quarry',
  manifest: { crs: { epsg: 4326 }, origin: [0, 0, 0], severityModels: [] },
};
const LOOSE_ROCK = {
  id: 'i1',
  code: 'Q-1',
  title: 'Loose rock',
  status: 'open',
  severity: 2,
  sightings: [{ on: 'mesh', geom: { type: 'spoint', p: [1, 2, 3] } }],
};

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  // jsdom has no layout, so no scrolling
  Element.prototype.scrollIntoView = () => undefined;
  app.sites = [QUARRY, YARD];
  app.error = null;
  app.project = null;
  app.issues = [];
  app.sent = [];
  globe.props = null;
  globe.flyToSite.mockClear();
  globe.flyHome.mockClear();
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
/**
 * Pick a site in the field, as a person does: a click in the field lists the sites (whether or
 * not the keyboard was there already), a click picks one.
 */
function pickInField(name: string) {
  act(() => {
    field()?.focus();
    field()?.click();
  });
  act(() => option(name)?.click());
}
const pressEscapeOn = (el: Element | null | undefined) => {
  act(() => {
    el?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
};
const comesBefore = (a: Element | null, b: Element | null) =>
  a !== null &&
  b !== null &&
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('the Globe screen', () => {
  it('has the field, the Map button and Measure, and no side panel', async () => {
    await mount();
    // one heading names the screen (nothing on the Globe shows its name)
    expect([...host.querySelectorAll('h1')].map((h) => h.textContent)).toEqual(['Globe']);
    expect(field()?.getAttribute('aria-label')).toBe('Find a site');
    // the chip names the map drawn now
    expect(q('globe-map-button')?.textContent).toBe('Streets');
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
    pressEscapeOn(q('globe-card')?.querySelector('.actions button'));
    expect(q('globe-card')).toBeNull();
    expect(globe.props?.cardPick).toBeNull();
    expect(globe.props?.selected).toBeNull();

    pickInField('Hill quarry');
    expect(q('globe-card')).not.toBeNull();
    act(() => q('globe-card')?.querySelector<HTMLElement>('[aria-label="Close"]')?.click());
    expect(q('globe-card')).toBeNull();
  });

  it('gives the keyboard back to the field when the card closes, its list still shut', async () => {
    await mount();
    const closedFrom = (inCard: (card: HTMLElement) => void) => {
      pickInField('Hill quarry');
      const card = q('globe-card');
      expect(card).not.toBeNull();
      // the keyboard is in the card, on its first action
      const flyTo = card?.querySelector<HTMLElement>('.actions button');
      act(() => flyTo?.focus());
      expect(document.activeElement).toBe(flyTo);
      if (card) inCard(card);
      expect(q('globe-card')).toBeNull();
      // back where the site was picked from, and the list waits to be asked for
      expect(document.activeElement).toBe(field());
      expect(host.querySelector('[role="listbox"]')).toBeNull();
      expect(field()?.getAttribute('aria-expanded')).toBe('false');
    };
    closedFrom((card) => {
      pressEscapeOn(card.querySelector('.actions button'));
    });
    // Close from the keyboard: the button has the focus, and Enter or Space clicks it
    closedFrom((card) => {
      const close = card.querySelector<HTMLElement>('[aria-label="Close"]');
      act(() => {
        close?.focus();
        close?.click();
      });
    });
    // the field still answers the keyboard: Down opens the list
    act(() => {
      field()?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    });
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it('leaves the keyboard where it is when the card is closed with the mouse', async () => {
    await mount();
    /**
     * A click of the mouse on Close, as the browser does it: the press comes first and moves the
     * focus to the button, unless the button refuses it; then the click.
     */
    const mouseClose = () => {
      const close = q('globe-card')?.querySelector<HTMLElement>('[aria-label="Close"]');
      expect(close).toBeTruthy();
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      act(() => {
        close?.dispatchEvent(press);
        if (!press.defaultPrevented) close?.focus();
        close?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
        );
      });
      // the button does not take the focus for a press of the mouse: it is about to go, and the
      // app would hand the focus it took to the nearest control left, the field
      expect(press.defaultPrevented).toBe(true);
      expect(q('globe-card')).toBeNull();
      expect(globe.props?.cardPick).toBeNull();
    };

    // the keyboard in no control (the card opened by a click on the Globe): it stays in none,
    // and no text field shows its ring for a click of the mouse
    act(() => globe.props?.onPick({ kind: 'site', projectId: 'quarry' }));
    expect(q('globe-card')).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
    mouseClose();
    expect(document.activeElement).toBe(document.body);
    expect(host.querySelector('[role="listbox"]')).toBeNull();

    // the keyboard in the field (the site was picked there): it stays there, the list shut
    pickInField('Hill quarry');
    expect(document.activeElement).toBe(field());
    mouseClose();
    expect(document.activeElement).toBe(field());
    expect(host.querySelector('[role="listbox"]')).toBeNull();

    // the keyboard in the card, which goes: back to the field, as with Esc
    pickInField('Hill quarry');
    const flyTo = q('globe-card')?.querySelector<HTMLElement>('.actions button');
    act(() => flyTo?.focus());
    expect(document.activeElement).toBe(flyTo);
    mouseClose();
    expect(document.activeElement).toBe(field());
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('closes the card on Esc in the field once its list is shut, the keyboard staying there', async () => {
    await mount();
    const escapeInField = () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        field()?.dispatchEvent(event);
      });
      return event;
    };
    // as after a pick with the keyboard: the focus in the field, its list shut, the card open
    pickInField('Hill quarry');
    expect(document.activeElement).toBe(field());
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(q('globe-card')).not.toBeNull();
    // with the list open, Esc is the list's: the card stays
    act(() => {
      field()?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    });
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    escapeInField();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(q('globe-card')).not.toBeNull();
    // the next Esc closes the card
    expect(escapeInField().defaultPrevented).toBe(true);
    expect(q('globe-card')).toBeNull();
    expect(globe.props?.cardPick).toBeNull();
    expect(globe.props?.selected).toBeNull();
    expect(document.activeElement).toBe(field());
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    // with no card left, Esc in the field is nobody's
    expect(escapeInField().defaultPrevented).toBe(false);
  });

  it('lists in the field the sites of a gathered chip that cannot part', async () => {
    app.sites = [QUARRY, YARD, site('depot', 'North depot')];
    await mount();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    // the Globe: these two were clicked as one chip and still stand as one after the flight
    act(() => globe.props?.onGroup?.(['yard', 'quarry']));
    expect(document.activeElement).toBe(field());
    expect(field()?.getAttribute('aria-expanded')).toBe('true');
    const listed = [...host.querySelectorAll('[role="option"] .name')].map((n) => n.textContent);
    expect(listed).toEqual(['Harbour yard', 'Hill quarry']);
    // one of them picked there opens its card, as any pick in the field does
    act(() => option('Hill quarry')?.click());
    expect(globe.flyToSite).toHaveBeenCalledWith(QUARRY.lonLat);
    expect(q('globe-card')?.getAttribute('aria-label')).toBe('Hill quarry');
    // and the field lists the whole library again
    act(() => field()?.click());
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(3);
  });

  it('has nothing to list them in while measuring, and says nothing', async () => {
    await mount();
    act(() => q('globe-measure')?.click());
    expect(field()).toBeNull();
    act(() => globe.props?.onGroup?.(['yard', 'quarry']));
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(q('globe-readout')).not.toBeNull();
  });

  it('leaves the keyboard where it is when the card closes from elsewhere', async () => {
    await mount();
    pickInField('Hill quarry');
    // Show all sites closes the card: the keyboard stays on that button
    const all = q('globe-all-sites');
    act(() => {
      all?.focus();
      all?.click();
    });
    expect(globe.flyHome).toHaveBeenCalledTimes(1);
    expect(q('globe-card')).toBeNull();
    expect(document.activeElement).toBe(all);
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

  it('saves a base map chosen in the Map menu, and the screen follows it', async () => {
    await mount();
    expect(q('globe-screen')?.getAttribute('data-look')).toBe('street');
    act(() => q('globe-map-button')?.click());
    expect(q('map-tile-streets')?.getAttribute('aria-checked')).toBe('true');
    act(() => q('map-tile-natural-earth')?.click());
    const saved = app.sent.filter((s) => s.channel === 'globe:setSettings');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.payload).toMatchObject({
      settings: { base: 'natural-earth', style: 'natural-earth' },
    });
    expect(q('globe-screen')?.getAttribute('data-look')).toBe('natural-earth');
    expect(globe.props?.style).toBe('natural-earth');
    expect(q('map-tile-natural-earth')?.getAttribute('aria-checked')).toBe('true');
  });

  it('hands the Globe the same packs on every render while they are off, so it rebuilds nothing', async () => {
    await mount();
    // the street look: the packs are off
    const before = globe.props?.imagery;
    expect(before).toEqual([]);
    // a render that changes nothing about the packs (a site picked in the field)
    pickInField('Hill quarry');
    expect(globe.props?.selected).toBe('quarry');
    expect(globe.props?.imagery).toBe(before);
  });

  it('keeps the note that no street map pack is installed, inside the menu', async () => {
    await mount();
    act(() => q('globe-map-button')?.click());
    expect(q('globe-map-menu')?.textContent).toContain('No street map pack is installed');
  });

  it('closes the card of an issue when its pin is no longer drawn', async () => {
    app.project = QUARRY_PROJECT;
    app.issues = [LOOSE_ROCK];
    await mount();
    expect(globe.props?.issuePins?.pins.map((p) => p.id)).toEqual(['i1']);
    act(() => globe.props?.onPick({ kind: 'issue', projectId: 'quarry', issueId: 'i1' }));
    expect(q('globe-card')?.textContent).toContain('Q-1 Loose rock');
    expect(globe.props?.cardPick).toEqual({ kind: 'issue', projectId: 'quarry', issueId: 'i1' });

    // "Show issues of the open project" switched off in the Map dialog: the pins go, and the card
    act(() => q('globe-map-button')?.click());
    act(() => {
      q('map-ontop-issues')?.querySelector<HTMLElement>('[role="switch"]')?.click();
    });
    expect(globe.props?.issuePins).toBeNull();
    expect(q('globe-card')).toBeNull();
    expect(globe.props?.cardPick).toBeNull();
  });

  it('never shows an issue with no pin as its site', async () => {
    app.project = QUARRY_PROJECT;
    app.issues = [LOOSE_ROCK];
    await mount();
    // an issue this project does not have (the pick of a project that was open before)
    act(() => globe.props?.onPick({ kind: 'issue', projectId: 'quarry', issueId: 'gone' }));
    expect(q('globe-card')).toBeNull();
    expect(globe.props?.cardPick).toBeNull();
  });

  it('hands the Globe one insets object for the card, with the agreed room at each edge', async () => {
    await mount();
    const insets = globe.props?.cardInsets;
    // top: the field's row; right: the view buttons (12 + 36 + 8); bottom: the credits
    expect(insets).toEqual({ top: 56, right: 56, bottom: 44, left: 12 });
    pickInField('Hill quarry');
    expect(globe.props?.cardInsets).toBe(insets);
  });

  it('starts on the whole Earth over the open project site once another project is open, and at the remembered camera for the same one', async () => {
    const camera = { position: [1, 2, 3], direction: [0, 0, -1] } as unknown as GlobeCamera;
    app.project = QUARRY_PROJECT;
    await mount();
    act(() => globe.props?.onClose?.(camera));
    act(() => root?.unmount());
    root = undefined;
    // the same project again: the camera it was left at
    await mount();
    expect(globe.props?.start).toEqual({ camera });
    act(() => root?.unmount());
    root = undefined;
    // another project: the whole Earth centred over its own site
    app.project = { ...QUARRY_PROJECT, id: 'yard' };
    app.sites = [QUARRY, { ...YARD, lonLat: [20, 60] }];
    await mount();
    expect(globe.props?.start).toEqual({ centre: [20, 60] });
  });
});

describe('the sites in focus on the Globe', () => {
  const INDEX = {
    schema: 'aio.tiles/1',
    corners: { tl: [0, 0, 0], tr: [10, 0, 0], bl: [0, 0, 10] },
    levels: [{ z: 0, tileSize: 256, cols: 1, rows: 1, pattern: '{z}/{x}/{y}.png' }],
  };
  /** A site that can be placed, with an ortho per survey date and a heat map. */
  const placed = (projectId: string, name: string): GlobeSite => ({
    ...site(projectId, name),
    captures: [
      { id: 'c1', label: 'First', date: '2026-10-07' },
      { id: 'c2', label: 'Second', date: '2026-10-21' },
    ],
    frame: { crs: { epsg: 32640 }, origin: [500000, 2700000, 10] },
    rasters: [
      {
        layerId: 'heat',
        name: 'Surface change',
        role: 'plan',
        src: 'heat/tiles.json',
        change: true,
      },
      { layerId: 'o2', name: 'Late', role: 'ortho', src: 'o2/tiles.json', capture: 'c2' },
      { layerId: 'o1', name: 'Early', role: 'ortho', src: 'o1/tiles.json', capture: 'c1' },
      { layerId: 'bad', name: 'Broken', role: 'ortho', src: 'bad/tiles.json', capture: 'c1' },
    ],
  });
  const B = placed('yard', 'Harbour yard');
  const C = placed('pit', 'Gravel pit');

  beforeEach(async () => {
    const { useSiteOutputs, clearPyramids } = await import('./siteOutputsStore');
    useSiteOutputs.setState({ shown: {} });
    clearPyramids();
    app.sites = [QUARRY, B, C];
    app.project = QUARRY_PROJECT;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes('/bad/')
            ? { ok: false, json: () => Promise.resolve(null) }
            : { ok: true, json: () => Promise.resolve(INDEX) },
        ),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const settle = () =>
    act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  const outputs = () =>
    (globe.props?.outputs ?? []).map((o) => ({
      projectId: o.projectId,
      georef: o.georef,
      tilesets: o.tilesets.map((t) => t.id),
      rasters: o.rasters.map((r) => r.layerId),
    }));

  it('draws the open project and the picked site, the picked one placed by its frame', async () => {
    await mount();
    await settle();
    expect(outputs()).toEqual([
      {
        projectId: 'quarry',
        georef: { crs: { epsg: 4326 }, origin: [0, 0, 0], heightOffset: 0 },
        tilesets: ['quarry-mesh'],
        rasters: [],
      },
    ]);

    pickInField('Harbour yard');
    await settle();
    expect(app.sent).toContainEqual({ channel: 'tilesets:list', payload: { projectId: 'yard' } });
    expect(outputs()).toEqual([
      {
        projectId: 'quarry',
        georef: { crs: { epsg: 4326 }, origin: [0, 0, 0], heightOffset: 0 },
        tilesets: ['quarry-mesh'],
        rasters: [],
      },
      {
        projectId: 'yard',
        georef: { crs: { epsg: 32640 }, origin: [500000, 2700000, 10], heightOffset: 0 },
        tilesets: ['yard-mesh'],
        rasters: ['o2'],
      },
    ]);
    const shown = globe.props?.outputs[1]?.rasters[0];
    expect(shown?.src).toBe('o2/tiles.json');
    expect(shown?.index.levels).toHaveLength(1);
    // the card has the section
    expect(q('globe-card')?.textContent).toContain('On the Globe');
  });

  it('puts a third site in the place of the second, the open project staying', async () => {
    await mount();
    pickInField('Harbour yard');
    await settle();
    pickInField('Gravel pit');
    await settle();
    expect(outputs().map((o) => o.projectId)).toEqual(['quarry', 'pit']);
  });

  it('passes only the shown rasters with a readable index, bottom first', async () => {
    const { useSiteOutputs } = await import('./siteOutputsStore');
    await mount();
    pickInField('Harbour yard');
    await settle();
    act(() => {
      useSiteOutputs.getState().toggle(B, 'heat');
      useSiteOutputs.getState().toggle(B, 'bad');
      useSiteOutputs.getState().toggle(B, 'o1');
    });
    await settle();
    expect(outputs()[1]?.rasters).toEqual(['o1', 'o2', 'heat']);
  });

  it('leaves out a picked site that cannot be placed', async () => {
    const unplaced: GlobeSite = { ...B };
    delete unplaced.frame;
    app.sites = [QUARRY, unplaced, C];
    await mount();
    pickInField('Harbour yard');
    await settle();
    expect(outputs().map((o) => o.projectId)).toEqual(['quarry']);
  });
});
