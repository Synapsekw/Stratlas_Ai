// @vitest-environment jsdom
import type { Capture, Layer, ProjectManifest } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { mockManifest } from '../__fixtures__/project';
import { DatasetTree, type DatasetTreeProps, type TreeRowBadge } from './DatasetTree';
import { EVERY_DATE, buildDateTree } from './dateModel';
import { NO_MARKS, nextMarks } from './marks';
import { buildDatasetTree, type TreeGroup, type TreeItem } from './model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const walk = (id: string, capture?: string): Layer => ({
  kind: 'walk',
  id: `walk-${id}`,
  name: `Walk ${id}`,
  visible: true,
  record: { path: `walks/${id}/walk.json` },
  src: { path: `walks/${id}/playback.mp4` },
  durationS: 81.9,
  ...(capture ? { capture } : {}),
});

const captures: Capture[] = [{ id: 'a', label: 'Survey A', date: '2026-09-04' }];
const manifest: ProjectManifest = {
  ...mockManifest(),
  captures,
  layers: [walk('dated', 'a'), walk('loose')],
};

describe('walks in the tree', () => {
  it('puts a walk under 360 walks with its length as m:ss', () => {
    const groups = buildDatasetTree(manifest, []);
    const g = groups.find((x) => x.kind === 'walks');
    expect(g?.label).toBe('360 walks');
    expect(g?.items[0]).toMatchObject({ layerId: 'walk-dated', layerKind: 'walk', meta: '1:22' });
  });

  it('puts a dated walk under 360 walks in its date folder, an undated one in Every date', () => {
    const folders = buildDateTree(
      manifest,
      [],
      {},
      { captures, of: { 'walk-dated': 'a' } },
      { every: 'Every date', dateLabel: (c) => c.date },
    );
    const inFolder = (id: string) =>
      folders
        .find((f) => f.id === id)
        ?.groups.find((g) => g.kind === 'walks')
        ?.items.map((i) => i.layerId);
    expect(inFolder('a')).toEqual(['walk-dated']);
    expect(inFolder(EVERY_DATE)).toEqual(['walk-loose']);
  });
});

const groups: TreeGroup[] = [
  {
    kind: 'walks',
    label: '360 walks',
    icon: 'pano',
    count: 1,
    items: [
      { id: 'walk-a', layerId: 'walk-a', layerKind: 'walk', name: 'Ground floor', meta: '1:22' },
    ],
  },
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(props: Partial<DatasetTreeProps>) {
  host = document.createElement('div');
  document.body.append(host);
  const r = createRoot(host);
  root = r;
  act(() => {
    r.render(
      <DatasetTree
        groups={groups}
        hidden={{}}
        selectedId={null}
        activeClip={null}
        collapsed={false}
        defaultOpen={['walks']}
        onToggleVisible={() => undefined}
        onSelect={() => undefined}
        {...props}
      />,
    );
  });
  const el = host;
  return {
    q: (sel: string) => el.querySelector<HTMLElement>(sel),
    click: (sel: string) => {
      const b = el.querySelector<HTMLElement>(sel);
      if (!b) throw new Error(`no ${sel}`);
      act(() => {
        b.click();
      });
    },
  };
}

describe('walk rows', () => {
  const badge = (it: TreeItem): TreeRowBadge | null =>
    it.layerId === 'walk-a' ? { text: 'Needs placing', tone: 'info' } : null;

  it('shows the name, the length and the one badge', () => {
    const { q } = mount({ rowBadge: badge });
    const row = q('[data-testid="tree-row-walk-a"]');
    expect(row?.querySelector('.tn')?.textContent).toBe('Ground floor');
    expect(row?.querySelector('.tm')?.textContent).toBe('1:22');
    const b = row?.querySelector('[data-testid="tree-badge-walk-a"]');
    expect(b?.textContent).toBe('Needs placing');
    expect(b?.className).toContain('info');
  });

  it('opens the 360 walks group by default, so a Needs placing badge is seen', () => {
    const { q } = mount({ rowBadge: badge, defaultOpen: undefined });
    expect(q('[data-testid="tree-badge-walk-a"]')?.textContent).toBe('Needs placing');
  });

  it('keeps the length and badge in the row name, for when the actions cover them', () => {
    const { q } = mount({ rowBadge: badge, walkActions: { onOpen: () => undefined } });
    expect(q('[data-testid="tree-row-walk-a"]')?.getAttribute('aria-label')).toBe(
      'Ground floor, 1:22, Needs placing',
    );
  });

  it('opens and places from the row actions', () => {
    const log: string[] = [];
    const { click } = mount({
      walkActions: {
        onOpen: (it) => log.push(`open ${it.id}`),
        onPlace: (it) => log.push(`place ${it.id}`),
        onRemove: (it) => log.push(`remove ${it.id}`),
      },
    });
    click('[data-testid="walk-open-walk-a"]');
    click('[data-testid="walk-place-walk-a"]');
    expect(log).toEqual(['open walk-a', 'place walk-a']);
  });

  it('Remove on a walk row calls onRemove at once (the shared dialog asks)', () => {
    const removed: string[] = [];
    const { click, q } = mount({
      walkActions: { onOpen: () => undefined, onRemove: (it) => removed.push(it.id) },
    });
    click('[data-testid="walk-remove-walk-a"]');
    expect(removed).toEqual(['walk-a']);
    expect(q('[data-testid="walk-remove-confirm"]')).toBeNull();
  });

  it('Ctrl+click and Shift+click mark rows; a plain click selects', () => {
    const marks: [string, boolean, boolean][] = [];
    const selected: string[] = [];
    const { q } = mount({
      marked: new Set(['walk-a']),
      onMark: (it, m) => marks.push([it.id, m.ctrl, m.shift]),
      onSelect: (it) => selected.push(it.id),
    });
    const row = q('[data-testid="tree-row-walk-a"]');
    if (!row) throw new Error('no row');
    expect(row.className).toContain('marked');
    expect(row.getAttribute('aria-selected')).toBe('true');
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(marks).toEqual([
      ['walk-a', true, false],
      ['walk-a', false, true],
    ]);
    expect(selected).toEqual(['walk-a']);
  });

  it('offers no Place or Remove without their callbacks (a package)', () => {
    const { q } = mount({ walkActions: { onOpen: () => undefined } });
    expect(q('[data-testid="walk-open-walk-a"]')).not.toBeNull();
    expect(q('[data-testid="walk-place-walk-a"]')).toBeNull();
    expect(q('[data-testid="walk-remove-walk-a"]')).toBeNull();
  });

  it('shows the group action label on the 360 walks header', () => {
    const { q } = mount({
      groupAction: (g) =>
        g.kind === 'walks' ? { label: 'Add 360 video', onClick: () => undefined } : undefined,
    });
    expect(q('[data-testid="tree-group-add-walks"]')?.getAttribute('aria-label')).toBe(
      'Add 360 video',
    );
  });
});

describe('marking rows in the order they are drawn', () => {
  const rows = (kind: TreeGroup['kind'], ids: string[]): TreeGroup => ({
    kind,
    label: kind,
    icon: 'scene',
    count: ids.length,
    items: ids.map((id) => ({ id, layerId: id, layerKind: 'mesh', name: id })),
  });
  const flight: TreeGroup = {
    kind: 'video',
    label: 'Video',
    icon: 'video',
    count: 2,
    items: [
      {
        id: 'flight:f1',
        flightId: 'f1',
        name: 'Flight 1',
        children: [
          { id: 'c1', layerId: 'c1', layerKind: 'video', name: 'clip 1' },
          { id: 'c2', layerId: 'c2', layerKind: 'video', name: 'clip 2' },
        ],
      },
    ],
  };
  const shiftClick = (el: HTMLElement | null) => {
    if (!el) throw new Error('no row');
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
  };

  it('a Shift range skips the rows of a closed group, a closed flight and behind "more"', () => {
    const orders: (readonly string[])[] = [];
    const many = Array.from({ length: 10 }, (_, i) => `p${String(i)}`);
    const { q } = mount({
      groups: [rows('walks', ['a', 'b']), rows('models', ['m1', 'm2']), flight, rows('maps', many)],
      defaultOpen: ['walks', 'video', 'maps'],
      onMark: (_it, _m, order) => orders.push(order),
    });
    shiftClick(q('[data-testid="tree-row-p0"]'));
    // models is closed, the flight is closed, and maps draws 8 of its 10 rows
    const order = orders[0] ?? [];
    expect(orders).toEqual([['a', 'b', ...many.slice(0, 8)]]);
    const from = nextMarks(NO_MARKS, order, 'a', { ctrl: true, shift: false });
    const range = nextMarks(from, order, 'p0', { ctrl: false, shift: true });
    expect([...range.marked]).toEqual(['a', 'b', 'p0']);
  });

  it('says the tree takes many marks only when rows can be marked', () => {
    const { q } = mount({ onMark: () => undefined });
    expect(q('[role="tree"]')?.getAttribute('aria-multiselectable')).toBe('true');
    act(() => root?.unmount());
    root = null;
    const plain = mount({});
    expect(plain.q('[role="tree"]')?.getAttribute('aria-multiselectable')).toBeNull();
  });
});
