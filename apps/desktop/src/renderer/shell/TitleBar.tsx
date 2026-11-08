import { Button, Icon, IconButton, Menu, t, useT, type MenuEntry } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useRef, useState } from 'react';
import { openAuditTrail } from '../audit/auditView';
import { shell, useShell } from '../shell';
import { isSidebarFolded } from '../store';
import { SpaceSegment } from '../spaces/SpaceSegment';
import { switcherShown } from '../spaces/spaceModel';
import { DatePicker } from '../workspace/DatePicker';
import { PANEL_ID, panelHandleLabel } from './PanelHandle';
import { SidebarStatus } from './SidebarStatus';

/** The customer a project is for: its own field, else the last part of its site. */
export function customerOf(
  manifest: { customer?: string | undefined; site?: string | undefined } | undefined,
): string | null {
  return manifest?.customer ?? manifest?.site?.split(',').pop()?.trim() ?? null;
}

/**
 * The project crumb and its menu: the library's projects (each with its customer under its full
 * name), All projects, Project settings, the Audit trail and Close project.
 */
function ProjectSwitcher() {
  const manifest = useWorkspace((s) => s.project?.manifest);
  const root = useWorkspace((s) => s.project?.root);
  const library = useShell((s) => s.library);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const name = manifest?.name ?? t('nav.noProject');
  const projects = library ?? [];
  const items: MenuEntry[] = [
    // each project with its customer under its full name, so a long customer never cuts the name
    ...projects.map((e): MenuEntry => ({
      id: `project-${e.id}`,
      label: e.name,
      icon: 'layers',
      radio: true,
      checked: e.path === root,
      ...(e.customer ? { note: e.customer } : {}),
      onSelect: () => void shell.getState().openProject(e.path),
    })),
    ...(projects.length === 0
      ? [
          {
            id: 'library-empty',
            label: t('titlebar.libraryEmpty'),
            disabledReason: t('titlebar.libraryEmpty'),
          },
        ]
      : []),
    'separator',
    {
      id: 'all-projects',
      label: t('titlebar.allProjects'),
      icon: 'projects',
      onSelect: () => {
        shell.getState().go('projects');
      },
    },
    ...(manifest
      ? ([
          {
            id: 'project-settings',
            label: t('titlebar.projectSettings'),
            icon: 'settings',
            testId: 'menu-project-settings',
            onSelect: () => {
              shell.getState().openSettingsPage('project');
            },
          },
          {
            id: 'audit-trail',
            label: t('audit.title'),
            icon: 'history',
            testId: 'menu-audit-trail',
            onSelect: openAuditTrail,
          },
          {
            id: 'close-project',
            label: t('titlebar.closeProject'),
            icon: 'x',
            onSelect: () => {
              shell.getState().closeProject();
            },
          },
        ] satisfies MenuEntry[])
      : []),
  ];

  return (
    <div className="proj-wrap">
      <button
        ref={button}
        type="button"
        className="proj-switch"
        aria-label={t('titlebar.projectMenu', { name })}
        data-testid="crumb-project"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <b dir="auto">{name}</b>
        <Icon name="chevdown" size={12} className="faint" />
      </button>
      <Menu
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        opener={button}
        label={t('titlebar.project')}
        items={items}
        anchor="below"
        testId="project-switcher"
      />
    </div>
  );
}

/**
 * The 40 px title bar over the Layers column and the main area (UI revision W11, D1): on the
 * Scene the Layers toggle, then the breadcrumb "Customer / Project v / Date v" with full names,
 * search (Ctrl+K), the status group (connection, the AI status chip, the Jobs chip), the right
 * panel's toggle on the Scene, and room for the window's own buttons at its end. The bar drags
 * the window; its controls do not.
 */
export function TitleBar() {
  useT();
  const screen = useShell((s) => s.screen);
  const layersOpen = !useShell(isSidebarFolded);
  const rightOff = useShell((s) => s.rightCollapsed);
  const manifest = useWorkspace((s) => s.project?.manifest);
  const dated = useWorkspace((s) => (s.project?.manifest.captures.length ?? 0) > 0);
  const scene = screen === 'scene';
  const showDate = scene && dated;
  const showSpace = manifest !== undefined && switcherShown(manifest);
  const customer = manifest ? (customerOf(manifest) ?? t('titlebar.noCustomer')) : null;
  return (
    <header className="titlebar" aria-label={t('titlebar.bar')} data-testid="titlebar">
      {scene && (
        <IconButton
          icon="sidebar"
          label={t(layersOpen ? 'nav.hideLayers' : 'nav.showLayers')}
          tip={t(layersOpen ? 'nav.hideLayers' : 'nav.showLayers')}
          shortcut="global.sidebar"
          pressed={layersOpen}
          aria-controls={PANEL_ID.left}
          data-testid="layers-toggle"
          onClick={() => {
            void shell.getState().toggleSidebar();
          }}
        />
      )}
      <nav className="tb-crumbs" aria-label={t('titlebar.breadcrumb')}>
        {/* Customer / Project / (a Space goes here) / Date: the last crumb is where you are */}
        <ol>
          {customer !== null && (
            <li className="tb-crumb-customer" dir="auto" data-testid="crumb-customer">
              {customer}
            </li>
          )}
          <li
            className="tb-crumb-project"
            aria-current={showDate || showSpace ? undefined : 'location'}
          >
            <ProjectSwitcher />
          </li>
          {showSpace && (
            <li className="tb-crumb-space" aria-current={showDate ? undefined : 'location'}>
              <SpaceSegment />
            </li>
          )}
          {showDate && (
            <li className="tb-crumb-date" aria-current="location">
              <DatePicker testId="crumb-date" />
            </li>
          )}
        </ol>
      </nav>
      <span className="tb-fill" />
      <IconButton
        icon="search"
        label={t('titlebar.search')}
        shortcut="global.palette"
        className="tb-search"
        onClick={() => {
          shell.getState().setPalette(true);
        }}
      />
      <SidebarStatus />
      {scene && (
        <Button
          variant="icon"
          pressed={!rightOff}
          aria-label={t(panelHandleLabel('right', rightOff))}
          aria-controls={PANEL_ID.right}
          tip={t(panelHandleLabel('right', rightOff))}
          shortcut="global.rightPanel"
          data-testid="right-toggle"
          onClick={shell.getState().toggleRight}
        >
          <Icon name="sidebar" size={16} className="flip" />
        </Button>
      )}
    </header>
  );
}
