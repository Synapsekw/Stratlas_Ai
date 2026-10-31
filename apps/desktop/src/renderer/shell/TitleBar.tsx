import { arrowFocus, Button, Icon, IconButton, t, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { openAuditTrail } from '../audit/auditView';
import { shell, useShell } from '../shell';
import { isSidebarFolded } from '../store';
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
    };
  }, [open]);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // focus into the menu, Esc closes it and focus returns to the switcher
  useFocusTrap(menu, open, {
    onEscape: () => {
      setOpen(false);
    },
    returnTo: () => button.current,
  });
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const name = manifest?.name ?? t('nav.noProject');

  return (
    <div className="proj-wrap" ref={ref}>
      <button
        ref={button}
        type="button"
        className="proj-switch"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('titlebar.projectMenu', { name })}
        data-testid="crumb-project"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <b dir="auto">{name}</b>
        <Icon name="chevdown" size={12} className="faint" />
      </button>
      {open && (
        <div
          ref={menu}
          className="proj-menu"
          role="menu"
          aria-label={t('titlebar.project')}
          onKeyDown={(e) => {
            if (menu.current && arrowFocus(menu.current, e.key)) e.preventDefault();
          }}
        >
          {(library ?? []).map((e) => (
            <button
              key={e.id}
              type="button"
              role="menuitem"
              aria-current={e.path === root ? 'true' : undefined}
              onClick={run(() => void shell.getState().openProject(e.path))}
            >
              <Icon name={e.path === root ? 'check' : 'layers'} size={14} />
              <span className="pm-t">
                <span className="pm-n">{e.name}</span>
                {e.customer && <span className="pm-c mono">{e.customer}</span>}
              </span>
            </button>
          ))}
          {(library ?? []).length === 0 && (
            <div className="pm-empty">{t('titlebar.libraryEmpty')}</div>
          )}
          <div className="pm-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={run(() => {
              shell.getState().go('projects');
            })}
          >
            <Icon name="projects" size={14} />
            <span className="pm-n">{t('titlebar.allProjects')}</span>
          </button>
          {manifest && (
            <button
              type="button"
              role="menuitem"
              data-testid="menu-project-settings"
              onClick={run(() => {
                shell.getState().openSettingsPage('project');
              })}
            >
              <Icon name="settings" size={14} />
              <span className="pm-n">{t('titlebar.projectSettings')}</span>
            </button>
          )}
          {manifest && (
            <button
              type="button"
              role="menuitem"
              data-testid="menu-audit-trail"
              onClick={run(openAuditTrail)}
            >
              <Icon name="history" size={14} />
              <span className="pm-n">{t('audit.title')}</span>
            </button>
          )}
          {manifest && (
            <button
              type="button"
              role="menuitem"
              onClick={run(() => {
                shell.getState().closeProject();
              })}
            >
              <Icon name="x" size={14} />
              <span className="pm-n">{t('titlebar.closeProject')}</span>
            </button>
          )}
        </div>
      )}
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
          <li className="tb-crumb-project" aria-current={showDate ? undefined : 'location'}>
            <ProjectSwitcher />
          </li>
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
