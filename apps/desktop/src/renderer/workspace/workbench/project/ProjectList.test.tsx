// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sectionStore } from '../sectionState';
import { PROJECT_GROUPS, type ProjectGroupDef } from './groupRegistry';
import { ProjectList } from './ProjectList';
import { projectListStore, revealInList } from './projectListStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;

const issues: ProjectGroupDef = {
  id: 'issues',
  title: 'project.group.issues',
  useCount: () => 0,
  useApplies: () => true,
  Body: () => <p data-testid="issues-body">none yet</p>,
  Actions: () => (
    <button type="button" data-testid="issues-act">
      eye
    </button>
  ),
};
const sectors: ProjectGroupDef = {
  id: 'sectors',
  title: 'project.group.sectors',
  useCount: () => 2,
  useApplies: () => false,
  Body: () => null,
};

const render = (groups?: readonly ProjectGroupDef[]) => {
  root ??= createRoot(host);
  act(() => {
    root?.render(groups ? <ProjectList groups={groups} /> : <ProjectList />);
  });
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  localStorage.clear();
  sectionStore.setState({ byBench: {} });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
});

describe('ProjectList', () => {
  it('shows the caption and the TOOLS caption', () => {
    render();
    expect(PROJECT_GROUPS).toEqual([]);
    expect(q('project-caption')?.textContent).toBe('In this project');
    expect(q('project-caption')?.tagName).toBe('BUTTON');
    expect(q('project-tools-caption')?.tagName).toBe('H3');
    expect(q('project-tools-caption')?.textContent).toBe('Tools');
  });

  it('folds the whole list from the caption and remembers it', () => {
    render([issues]);
    const caption = q('project-caption');
    expect(caption?.getAttribute('aria-expanded')).toBe('true');
    expect(caption?.getAttribute('title')).toBe('Fold the project list');
    act(() => caption?.click());
    expect(caption?.getAttribute('aria-expanded')).toBe('false');
    expect(caption?.getAttribute('title')).toBe('Show the project list');
    expect(sectionStore.getState().byBench.measure?.ids['project-contents']).toBe(false);
    expect(q('issues-body')?.closest('[inert]')).not.toBeNull();
    // the TOOLS caption is not folded with it
    expect(q('project-tools-caption')?.closest('[inert]')).toBeNull();
    act(() => caption?.click());
    expect(caption?.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows a registered group with count 0', () => {
    render([sectors, issues]);
    const section = q('wb-section-project-issues');
    expect(section).not.toBeNull();
    const head = section?.querySelector<HTMLButtonElement>(':scope > .wb-section-head');
    expect(head?.textContent).toContain('Issues');
    expect(head?.querySelector('.wb-section-count')?.textContent).toBe('0');
    expect(head?.getAttribute('aria-expanded')).toBe('true');
    // its actions sit beside the toggle, not in it
    expect(head?.contains(q('issues-act'))).toBe(false);
    act(() => q('issues-act')?.click());
    expect(head?.getAttribute('aria-expanded')).toBe('true');
    // a group that does not apply to the project is left out
    expect(q('wb-section-project-sectors')).toBeNull();
  });

  it('a reveal holds a folded list open until its caption is clicked', () => {
    render([issues]);
    const caption = q('project-caption');
    act(() => caption?.click());
    expect(caption?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      revealInList('issues', null);
    });
    expect(caption?.getAttribute('aria-expanded')).toBe('true');
    expect(sectionStore.getState().byBench.measure?.ids['project-contents']).toBe(false);
    act(() => caption?.click());
    expect(caption?.getAttribute('aria-expanded')).toBe('false');
    expect(sectionStore.getState().byBench.measure?.ids['project-contents']).toBe(false);
    projectListStore.setState({ reveal: null });
  });
});
