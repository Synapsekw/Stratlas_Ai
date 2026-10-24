// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
/**
 * A revealed row in a group of the list, ported from the antenna inventory's section: the group
 * is held open without changing the person's fold, the row scrolls inside the group's own
 * scroller once the fold has opened, a header click ends the hold and folds.
 */
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { threeDates } from '../../__fixtures__/threeDates';
import { sectionStore } from '../sectionState';
import type { ProjectGroupDef } from './groupRegistry';
import { ProjectList } from './ProjectList';
import { revealInList } from './projectListStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sel = createStore<{ id: string | null }>()(() => ({ id: null }));
const select = (id: string | null) => {
  act(() => {
    sel.setState({ id });
  });
};

function Rows() {
  return (
    <ul className="pl-rows">
      {['a1', 'a2', 'a3'].map((id) => (
        <li key={id} data-row-id={id}>
          {id}
        </li>
      ))}
    </ul>
  );
}
const antennas: ProjectGroupDef = {
  id: 'antennas',
  title: 'project.group.antennas',
  useCount: () => 3,
  useApplies: () => true,
  useSelected: () => useStore(sel, (s) => s.id),
  Body: Rows,
};
const issues: ProjectGroupDef = {
  id: 'issues',
  title: 'project.group.issues',
  useCount: () => 0,
  useApplies: () => true,
  Body: () => null,
};

let host: HTMLDivElement;
let root: Root | undefined;
let rows: HTMLElement;

const mount = (shown = true) => {
  root ??= createRoot(host);
  act(() => {
    root?.render(
      shown ? (
        <div className="wb-scroll">
          <ProjectList groups={[antennas, issues]} />
        </div>
      ) : null,
    );
  });
  if (!shown) return;
  // the group's scroller shows 0-100; row a3 sits at 150-176, below it
  rows = host.querySelector<HTMLElement>('.pl-rows')!;
  rows.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
  const a3 = host.querySelector<HTMLElement>('[data-row-id="a3"]')!;
  a3.getBoundingClientRect = () =>
    ({ top: 150 - rows.scrollTop, bottom: 176 - rows.scrollTop }) as DOMRect;
};
const head = (group = 'antennas') =>
  host.querySelector<HTMLButtonElement>(
    `[data-testid="wb-section-project-${group}"] > .wb-section-head`,
  )!;
const expanded = (group = 'antennas') => head(group).getAttribute('aria-expanded');
const click = (el: HTMLElement) => {
  act(() => {
    el.click();
  });
};
const wait = (ms = 400) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  localStorage.clear();
  sectionStore.setState({ byBench: {} });
  sel.setState({ id: null });
  // a telecom project lists Antennas first, which is the group that starts open
  workspace
    .getState()
    .openProject({ id: 'p', root: '/p', manifest: { ...threeDates, purpose: 'telecom' } });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
  vi.useRealTimers();
});

describe('useRevealRow', () => {
  it('reveals a row without changing the person’s fold, and scrolls it in its group', () => {
    mount();
    click(head());
    expect(expanded()).toBe('false');
    const saved = JSON.stringify(sectionStore.getState().byBench);
    select('a3');
    act(() => {
      revealInList('antennas', 'a3');
    });
    expect(expanded()).toBe('true');
    expect(JSON.stringify(sectionStore.getState().byBench)).toBe(saved);
    // the row scrolls once the fold has opened, not in the commit that opens it
    expect(rows.scrollTop).toBe(0);
    wait();
    expect(rows.scrollTop).toBe(76);
    // the same row revealed again scrolls again
    rows.scrollTop = 0;
    act(() => {
      revealInList('antennas', 'a3');
    });
    wait();
    expect(rows.scrollTop).toBe(76);
    // the row no longer selected ends the hold: the saved fold is back
    select(null);
    expect(expanded()).toBe('false');
  });

  it('holds a row selected just after its reveal', () => {
    mount();
    click(head());
    act(() => {
      revealInList('antennas', 'a2');
    });
    select('a2');
    expect(expanded()).toBe('true');
    select('a1');
    expect(expanded()).toBe('false');
  });

  it('a header click ends the hold and folds the group', () => {
    mount();
    // open as the person left it (the default): the reveal holds it, the header folds it
    select('a1');
    act(() => {
      revealInList('antennas', 'a1');
    });
    click(head());
    expect(expanded()).toBe('false');
    expect(sel.getState().id).toBe('a1');
    // folded by the person before the reveal: the click ends the hold, the saved fold stays
    act(() => {
      revealInList('antennas', 'a1');
    });
    expect(expanded()).toBe('true');
    const saved = JSON.stringify(sectionStore.getState().byBench);
    click(head());
    expect(expanded()).toBe('false');
    expect(JSON.stringify(sectionStore.getState().byBench)).toBe(saved);
    // and the next click opens it as usual
    click(head());
    expect(expanded()).toBe('true');
  });

  it('a reveal with no row holds the group until the header folds it', () => {
    mount();
    click(head());
    act(() => {
      revealInList('antennas', null);
    });
    expect(expanded()).toBe('true');
    select('a2');
    select(null);
    expect(expanded()).toBe('true');
    click(head());
    expect(expanded()).toBe('false');
  });

  it('a reveal of another group leaves this one as it is', () => {
    mount();
    click(head());
    act(() => {
      revealInList('issues', null);
    });
    expect(expanded()).toBe('false');
  });

  it('honours a reveal made while the list was not mounted', () => {
    mount();
    click(head());
    mount(false);
    select('a3');
    act(() => {
      revealInList('antennas', 'a3');
    });
    mount();
    expect(expanded()).toBe('true');
    wait();
    expect(rows.scrollTop).toBe(76);
  });
});
