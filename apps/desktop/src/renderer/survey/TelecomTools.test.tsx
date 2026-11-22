// @vitest-environment jsdom
import { TOOL_LABELS } from '@aio/survey';
import { messagesEn as en, setLocale, t } from '@aio/ui';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { spaceIsPlayPause } from '../keys';
import { TelecomTools } from './TelecomTools';
import { cardModel } from './card/cardModel';
import { measureStore, startTool } from './measureStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./DetectAntennas', () => ({ DetectAntennas: () => null }));
// the card's registry controls have their own tests (card/CardActions.test.tsx)
vi.mock('./card/CardActions', () => ({
  CardActions: () => null,
  CardMenu: () => null,
  NOTES_MAX: 4000,
}));

vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false }) },
  jobs: {},
  useShell: <T,>(selector: (state: { stageMode: '3d'; pkg: null }) => T) =>
    selector({ stageMode: '3d', pkg: null }),
  shell: { getState: () => ({ setAnnotating: () => undefined }) },
}));

it('reserves Space for telecom control activation instead of global playback', () => {
  measureStore.setState({
    readOnly: false,
    status: 'ready',
    focus: null,
    tool: null,
    draw: null,
    editing: null,
  });
  startTool('azimuth');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let plays = 0;
  // App's global Space policy deliberately includes ordinary focused buttons.
  const globalKey = (event: KeyboardEvent) => {
    if (event.key === ' ' && spaceIsPlayPause(event.target)) {
      event.preventDefault();
      plays++;
    }
  };
  window.addEventListener('keydown', globalKey);
  try {
    act(() => {
      root.render(<TelecomTools />);
    });
    const cancel = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel',
    );
    expect(cancel).toBeDefined();
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => {
      cancel?.focus();
      cancel?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(plays).toBe(0);
    // Outside telecom controls, the existing global playback shortcut still applies.
    const outside = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    document.body.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(true);
    expect(plays).toBe(1);
  } finally {
    window.removeEventListener('keydown', globalKey);
    act(() => {
      root.unmount();
    });
    host.remove();
    measureStore.setState({ tool: null, draw: null });
  }
});

it('Measurements reveals the picked measurement in the tree', () => {
  measureStore.setState({
    readOnly: false,
    status: 'ready',
    focus: 'az1',
    tool: null,
    draw: null,
    editing: null,
    reveal: null,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => {
      root.render(<TelecomTools />);
    });
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Measurements',
    );
    act(() => {
      button?.click();
    });
    expect(measureStore.getState().reveal).toMatchObject({ id: 'az1', openSidebar: true });
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
  }
});

it('telecom card is the shared card with angles in the site angle unit', () => {
  const settings = measureStore.getState().settings;
  measureStore.setState({
    readOnly: false,
    status: 'ready',
    focus: 'tilt1',
    tool: null,
    draw: null,
    editing: null,
    settings: { ...settings, angles: { angle: 'dms', bearing: 'dms', precision: 0 } },
    file: {
      schema: 'aio.measurements/1',
      measurements: [
        {
          id: 'tilt1',
          family: 'line',
          tool: 'antenna-tilt',
          label: 'Tilt A',
          scope: { kind: 'site' },
          // 1 m across for 4 m up: 14.036 degrees from vertical
          points: [
            [0, 0, 0],
            [1, 0, 4],
          ],
          items: [],
          results: [],
          createdAt: '2026-10-20T00:00:00Z',
        },
      ],
    },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => {
      root.render(<TelecomTools />);
    });
    const card = host.querySelector('[data-testid="telecom-card"]');
    expect(card?.classList.contains('mc')).toBe(true);
    expect(card?.getAttribute('data-variant')).toBe('detail');
    expect(card?.getAttribute('data-measure-id')).toBe('tilt1');
    // the angle in degrees, minutes and seconds, as the site's settings say
    expect(card?.querySelector('[data-testid="card-primary"]')?.textContent).toContain(`14°02'10"`);
    // the guidance and the picks are in the card's detail
    expect(card?.querySelector('.mc-detail #telecom-guidance')).not.toBeNull();
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
    measureStore.setState({ settings, focus: null });
  }
});

const tiltRow = {
  id: 'tilt1',
  family: 'line' as const,
  tool: 'antenna-tilt' as const,
  label: 'Tilt A',
  scope: { kind: 'site' as const },
  points: [
    [0, 0, 0],
    [1, 0, 4],
  ] as [number, number, number][],
  items: [],
  results: [],
  createdAt: '2026-10-20T00:00:00Z',
};

it('the tools carry the catalogue names on their saved rows', () => {
  // @aio/survey cannot read the catalogue, so its list is tied to it here
  expect(TOOL_LABELS.azimuth).toBe(t('telecom.tools.name.azimuth'));
  expect(TOOL_LABELS['antenna-tilt']).toBe(t('telecom.tools.name.tilt'));
  expect(TOOL_LABELS.clearance).toBe(t('telecom.tools.name.clearance'));
  expect(TOOL_LABELS.azimuth).toBe(t('measureCat.tool.azimuth'));
  expect(TOOL_LABELS['antenna-tilt']).toBe(t('measureCat.tool.tilt'));
  expect(TOOL_LABELS.clearance).toBe(t('measureCat.tool.clearance'));
});

it('a saved tilt row reads Physical tilt', () => {
  const model = cardModel(tiltRow, {
    settings: measureStore.getState().settings,
    templates: [],
    captures: [],
  });
  expect(model.tool).toBe('Physical tilt');
  // a row saved earlier keeps the name it was given: the label is stored, the tool name derived
  expect(model.name).toBe('Tilt A');
});

it('no English outside the catalogue', () => {
  // every telecom tool key (and the reasons the tools are unavailable) answers with a marker
  const stub: Record<string, string> = {};
  for (const key of Object.keys(en)) {
    if (/^(telecom\.tools\.|palette\.unavailable\.)/.test(key)) stub[key] = `@@${key}@@`;
  }
  const settings = measureStore.getState().settings;
  const base = {
    readOnly: false,
    status: 'ready' as const,
    focus: null,
    tool: null,
    draw: null,
    editing: null,
    reveal: null,
  };
  const stray = (host: HTMLElement): string[] => {
    const out: string[] = [];
    const walk = (node: Node) => {
      if (node instanceof Element) {
        // the card's own words come from its registry and its own tests
        if (node.classList.contains('mc') && !node.closest('.mc-detail')) return;
        for (const attr of ['aria-label', 'title', 'placeholder']) {
          const v = node.getAttribute(attr);
          if (v && !v.includes('@@')) out.push(`${attr}=${v}`);
        }
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const v = (node.textContent ?? '').trim();
        if (v && !v.includes('@@')) out.push(v);
      }
      node.childNodes.forEach(walk);
    };
    walk(host);
    return out;
  };
  const render = (state: Record<string, unknown>) => {
    measureStore.setState({ ...base, settings, ...state });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(<TelecomTools />);
    });
    return {
      host,
      done: () => {
        act(() => {
          root.unmount();
        });
        host.remove();
      },
    };
  };
  setLocale('xx', stub);
  try {
    // picking an azimuth: guidance, north note, points picked, Undo, Cancel
    startTool('azimuth');
    const picking = render({});
    expect(stray(toolsOf(picking.host))).toEqual([]);
    picking.done();
    // a picked, unsaved azimuth: meaning, Flip, Edit, Done editing, endpoint coordinates, Save
    for (const editing of [null, { points: tiltRow.points }]) {
      const picked = render({
        focus: 'tilt1',
        tool: null,
        draw: null,
        editing,
        file: {
          schema: 'aio.measurements/1',
          measurements: [{ ...tiltRow, tool: 'azimuth', label: 'Az' }],
        },
        savedText: 'older',
      });
      expect(stray(toolsOf(picked.host))).toEqual([]);
      picked.done();
    }
  } finally {
    setLocale('en');
    measureStore.setState({ tool: null, draw: null, focus: null });
  }
});

function toolsOf(host: Element): HTMLElement {
  const el = host.querySelector('.telecom-tools');
  if (!(el instanceof HTMLElement)) throw new Error('the telecom tools did not render');
  return el;
}
