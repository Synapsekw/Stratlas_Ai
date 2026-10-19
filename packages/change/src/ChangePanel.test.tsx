// @vitest-environment jsdom
import { ChangeSet, type AioBridge } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangePanel, type ChangePanelProps } from './ChangePanel';
import { changeStore } from './store';
import { SITE } from './testing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  delete (globalThis as { aio?: AioBridge }).aio;
  workspace.getState().closeProject();
  changeStore.setState({
    projectId: null,
    sets: {},
    summaries: [],
    misaligned: null,
    pair: null,
    area: null,
  });
});

const set = (lineUp?: object) =>
  ChangeSet.parse({
    schema: 'aio.change/1',
    id: 'd1-d2-issues',
    from: 'd1',
    to: 'd2',
    producer: 'issues',
    createdAt: '2026-10-06T08:00:00Z',
    items: [{ kind: 'issue', id: 'issue:F01', verdict: 'new', at: [1, 2, 3] }],
    ...(lineUp ? { lineUp } : {}),
  });

async function render(props: Partial<ChangePanelProps> = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ChangePanel
        captures={SITE.captures.map((c) => ({ id: c.id, label: c.label }))}
        defaultPair={{ from: 'd1', to: 'd2' }}
        context={() => null}
        actions={{
          confirm: () => Promise.resolve(null),
          closeResolved: () => Promise.resolve(null),
          makeIssue: () => Promise.resolve(null),
          openIssue: () => undefined,
          canMakeIssue: () => false,
          issueCode: () => null,
          author: () => 'me',
        }}
        {...props}
      />,
    );
    await Promise.resolve();
  });
  return host;
}

function open(lined: boolean) {
  workspace.getState().openProject(
    {
      id: 'p',
      root: 'E:/x',
      manifest: {
        ...SITE,
        captures: SITE.captures.map((c) =>
          c.id === 'd2' && lined
            ? { ...c, lineUp: { eastM: 2, northM: 0, with: 'd1', at: '2026-10-10T00:00:00.000Z' } }
            : c,
        ),
      },
    },
    [],
  );
}

const q = (id: string) => host?.querySelector(`[data-testid="${id}"]`) ?? null;

describe('the Changes panel and a line-up', () => {
  it('shows the gap and Line up dates when a run was refused', async () => {
    open(false);
    changeStore.setState({
      misaligned: { from: 'd1', to: 'd2', shiftM: 2.014, producer: 'imagery' },
    });
    const onLineUp = vi.fn();
    await render({ onLineUp });
    expect(q('chg-misaligned')?.textContent).toContain('These dates are 2.01 m apart.');
    await act(async () => {
      (q('chg-lineup') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(onLineUp).toHaveBeenCalledWith('d1', 'd2');
  });

  it('shows no refusal for another pair', async () => {
    open(false);
    changeStore.setState({
      misaligned: { from: 'd2', to: 'd3', shiftM: 2, producer: 'imagery' },
    });
    await render({ onLineUp: vi.fn() });
    expect(q('chg-misaligned')).toBeNull();
  });

  it('offers Run again on a stale set', async () => {
    open(true);
    changeStore.setState({ projectId: 'p', sets: { 'd1-d2-issues': set() } });
    const onRerun = vi.fn();
    await render({ onRerun });
    expect(q('chg-stale')?.textContent).toContain('Out of date');
    await act(async () => {
      (q('chg-rerun') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(onRerun).toHaveBeenCalledWith('issues', expect.objectContaining({ id: 'd1-d2-issues' }));
  });

  it('shows the error of a Run again that fails', async () => {
    open(true);
    changeStore.setState({ projectId: 'p', sets: { 'd1-d2-issues': set() } });
    await render({ onRerun: () => Promise.resolve('No pack.') });
    await act(async () => {
      (q('chg-rerun') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(q('change-notice')?.textContent).toBe('No pack.');
  });

  it('shows nothing stale for a set computed after the line-up', async () => {
    open(true);
    changeStore.setState({
      projectId: 'p',
      sets: { 'd1-d2-issues': set({ to: { eastM: 2, northM: 0 } }) },
    });
    await render({ onRerun: vi.fn() });
    expect(q('chg-stale')).toBeNull();
    expect(q('chg-rerun')).toBeNull();
  });

  const areaSet = (volumesMissing?: object) =>
    ChangeSet.parse({
      ...set(),
      id: 'd1-d2-raster-area-a',
      producer: 'change.raster',
      scope: { id: 'a', name: 'Area A' },
      items: [{ kind: 'region', id: 'region:1', verdict: 'added', label: 'Area item' }],
      ...(volumesMissing ? { volumesMissing } : {}),
    });

  it("shows the area picker and only the chosen area's rows", async () => {
    open(false);
    changeStore.setState({
      projectId: 'p',
      sets: { 'd1-d2-issues': set(), 'd1-d2-raster-area-a': areaSet() },
    });
    await render();
    const rows = () => host?.querySelectorAll('[data-testid="change-row"]') ?? [];
    expect(rows().length).toBe(1);
    const pick = q('change-area') as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Whole map', 'Area A']);
    await act(async () => {
      pick.value = 'a';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(rows().length).toBe(1);
    expect(rows()[0]?.textContent).toContain('Area item');
  });

  it('offers no area picker without areas', async () => {
    open(false);
    changeStore.setState({ projectId: 'p', sets: { 'd1-d2-issues': set() } });
    await render();
    expect(q('change-area')).toBeNull();
  });

  it('shows why volumes are missing for an area', async () => {
    open(false);
    const why = { reason: 'No elevation model.', at: '2026-10-19T08:00:00Z' };
    changeStore.setState({
      projectId: 'p',
      sets: { 'd1-d2-raster-area-a': areaSet(why) },
      pair: { from: 'd1', to: 'd2' },
      area: 'a',
    });
    await render();
    expect(q('change-area-volumes-missing')?.textContent).toBe(
      'No volumes for this area: No elevation model.',
    );
  });

  it('keeps a fresh area that has no sets yet', async () => {
    open(false);
    changeStore.setState({
      projectId: 'p',
      sets: { 'd1-d2-issues': set() },
      pair: { from: 'd1', to: 'd2' },
      area: 'fresh',
    });
    await render();
    expect(changeStore.getState().area).toBe('fresh');
  });

  it('falls back to the whole map when a seen area loses its sets', async () => {
    open(false);
    changeStore.setState({
      projectId: 'p',
      sets: { 'd1-d2-issues': set(), 'd1-d2-raster-area-a': areaSet() },
      pair: { from: 'd1', to: 'd2' },
      area: 'a',
    });
    await render();
    expect(changeStore.getState().area).toBe('a');
    await act(async () => {
      changeStore.setState({ sets: { 'd1-d2-issues': set() } });
      await Promise.resolve();
    });
    expect(changeStore.getState().area).toBeNull();
    expect(host?.querySelectorAll('[data-testid="change-row"]').length).toBe(1);
  });

  it('shows no volumes note on the whole map', async () => {
    open(false);
    const why = { reason: 'No elevation model.', at: '2026-10-19T08:00:00Z' };
    changeStore.setState({
      projectId: 'p',
      sets: { 'd1-d2-raster': { ...areaSet(why), id: 'd1-d2-raster', scope: undefined } },
      pair: { from: 'd1', to: 'd2' },
    });
    await render();
    expect(q('change-area-volumes-missing')).toBeNull();
  });
});
