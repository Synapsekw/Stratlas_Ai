// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { threeDates } from '../../__fixtures__/threeDates';
import { sectionStore } from '../sectionState';
import { PROJECT_GROUPS, type ProjectGroupDef } from './groupRegistry';
import type { GroupId } from './projectGroups';
import { ProjectList } from './ProjectList';

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

const group = (id: GroupId, count = 0): ProjectGroupDef => ({
  id,
  title: `project.group.${id}` as ProjectGroupDef['title'],
  useCount: () => count,
  useApplies: () => true,
  Body: () => <p data-testid={`${id}-body`}>{id}</p>,
});
const order = (): string[] =>
  [...host.querySelectorAll<HTMLElement>('[data-testid^="wb-section-project-"]')].map((e) =>
    (e.dataset.testid ?? '').replace('wb-section-project-', ''),
  );
const open = (id: string): string | null | undefined =>
  q(`wb-section-project-${id}`)
    ?.querySelector(':scope > .wb-section-head')
    ?.getAttribute('aria-expanded');
const openWith = (purpose: 'telecom' | 'survey' | undefined) => {
  workspace.getState().openProject({
    id: 'p',
    root: '/p',
    manifest: { ...threeDates, ...(purpose ? { purpose } : {}) },
  });
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
  workspace.getState().closeProject();
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
});

describe('ProjectList', () => {
  it('is the groups alone: Project > In this project is its header, no TOOLS caption', () => {
    render([issues]);
    expect(PROJECT_GROUPS.map((g) => g.id)).toContain('antennas');
    expect(q('project-list')).not.toBeNull();
    expect(q('wb-section-project-issues')).not.toBeNull();
    expect(q('project-caption')).toBeNull();
    expect(q('project-tools-caption')).toBeNull();
    expect(host.textContent).not.toContain('In this project');
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

  describe('order and default open', () => {
    const all = [
      group('issues'),
      group('measurements', 1),
      group('coverage'),
      group('sectors'),
      group('antennas', 3),
    ];

    it('orders the groups for a telecom project', () => {
      openWith('telecom');
      render(all);
      expect(order()).toEqual(['antennas', 'sectors', 'coverage', 'measurements', 'issues']);
    });

    it('orders the groups for a survey project, leaving out what is not built and the antennas', () => {
      openWith('survey');
      render(all);
      expect(order()).toEqual(['measurements', 'issues']);
    });

    it('opens only the first group by default; the rest start folded', () => {
      openWith('telecom');
      render(all);
      expect(open('antennas')).toBe('true');
      for (const id of ['sectors', 'coverage', 'measurements', 'issues'])
        expect(open(id)).toBe('false');
    });

    it('remembers a fold the person changed', () => {
      openWith('telecom');
      render(all);
      act(() =>
        q('wb-section-project-sectors')
          ?.querySelector<HTMLElement>(':scope > .wb-section-head')
          ?.click(),
      );
      act(() =>
        q('wb-section-project-antennas')
          ?.querySelector<HTMLElement>(':scope > .wb-section-head')
          ?.click(),
      );
      expect(open('sectors')).toBe('true');
      expect(open('antennas')).toBe('false');
      expect(sectionStore.getState().byBench.measure?.ids['project-antennas']).toBe(false);
    });
  });
});
