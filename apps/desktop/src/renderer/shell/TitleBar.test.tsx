// @vitest-environment jsdom
import { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shell } from '../shell';
import { help } from '../help/store';
import { processing } from '../processing/store';
import { Rail } from './Rail';
import { customerOf, TitleBar } from './TitleBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NAME = 'North quarry stockpile survey with a very long project name, phase two';
const CUSTOMER = 'Example Aggregates Holdings Limited';

const manifest = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'p',
  name: NAME,
  customer: CUSTOMER,
  crs: { epsg: 32633 },
  origin: [500000, 4500000, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
});

let host: HTMLDivElement;
let root: Root | undefined;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: Element | null) => {
  if (!el) throw new Error('nothing to click');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};
const render = (node: React.ReactNode) => {
  act(() => {
    root = createRoot(host);
    root.render(node);
  });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  shell.setState({
    screen: 'scene',
    pkg: null,
    origin: null,
    rightCollapsed: false,
    library: [],
    settings: { ...shell.getState().settings, sidebarCollapsed: false },
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  workspace.getState().closeProject();
  host.remove();
  help.getState().closeHelp();
  processing.getState().closeDrawer();
});

describe('TitleBar', () => {
  it('breadcrumb shows the full project name and customer', () => {
    workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
    render(<TitleBar />);
    expect(q('crumb-customer')?.textContent).toBe(CUSTOMER);
    // the full name, never cut in the DOM (only drawn with an ellipsis when it must)
    expect(q('crumb-project')?.querySelector('b')?.textContent).toBe(NAME);
    expect(q('crumb-project')?.getAttribute('aria-label')).toContain(NAME);
  });

  it('falls back to the site for the customer, and says when no project is open', () => {
    expect(customerOf({ site: 'Quarry road, North county' })).toBe('North county');
    expect(customerOf({ customer: 'C', site: 'S' })).toBe('C');
    expect(customerOf(undefined)).toBeNull();
    shell.setState({ screen: 'projects' });
    render(<TitleBar />);
    expect(q('crumb-customer')).toBeNull();
    expect(q('crumb-project')?.textContent).toBe('No project open');
  });

  it('the project menu holds Project settings and the Audit trail', () => {
    workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
    render(<TitleBar />);
    click(q('crumb-project'));
    expect(q('menu-audit-trail')).not.toBeNull();
    click(q('menu-project-settings'));
    expect(shell.getState().screen).toBe('settings');
    expect(shell.getState().settingsPage).toBe('project');
  });

  it('carries the connection and the AI status chip on every screen', () => {
    shell.setState({ screen: 'issues' });
    render(<TitleBar />);
    expect(q('ai-status-chip')?.closest('.titlebar')).not.toBeNull();
    expect(q('connection-chip')?.closest('.titlebar')).not.toBeNull();
  });

  it('on the Scene, toggles Layers and the right panel', () => {
    workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
    render(<TitleBar />);
    const layers = q('layers-toggle');
    expect(layers?.getAttribute('aria-pressed')).toBe('true');
    expect(layers?.getAttribute('aria-keyshortcuts')).toContain('Control+B');
    click(q('right-toggle'));
    expect(shell.getState().rightCollapsed).toBe(true);
    act(() => {
      shell.setState({ screen: 'issues' });
    });
    expect(q('layers-toggle')).toBeNull();
    expect(q('right-toggle')).toBeNull();
  });
});

describe('Rail', () => {
  it('lists the screens once, then Processing, the guide and Settings', () => {
    render(<Rail />);
    const names = [...document.body.querySelectorAll('.rail .nav-item .lbl')].map(
      (b) => b.textContent,
    );
    expect(names).toEqual([
      'Projects',
      'Globe',
      'Scene',
      'Issues',
      'Inspect',
      'Reports',
      'Processing',
      'User guide',
      'Settings',
    ]);
  });

  it('goes to a screen and marks it current', () => {
    shell.setState({ screen: 'projects' });
    render(<Rail />);
    click(q('rail-issues'));
    expect(shell.getState().screen).toBe('issues');
    expect(q('rail-issues')?.getAttribute('aria-current')).toBe('page');
  });

  it('opens the processing drawer and the guide', () => {
    render(<Rail />);
    click(q('rail-processing'));
    expect(processing.getState().open).toBe(true);
    expect(q('rail-processing')?.getAttribute('aria-pressed')).toBe('true');
    click(q('help-open'));
    expect(help.getState().open).toBe(true);
  });

  it('holds the Layers tab on the Scene, open or folded', () => {
    render(<Rail />);
    expect(q('panel-handle-left')?.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      shell.setState({ settings: { ...shell.getState().settings, sidebarCollapsed: true } });
    });
    expect(q('panel-handle-left')?.getAttribute('aria-expanded')).toBe('false');
  });
});
