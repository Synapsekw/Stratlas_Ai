import { arrowFocus, Icon, IconButton, t, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { openAuditTrail } from '../audit/auditView';
import { shell, useShell } from '../shell';
import { isSidebarFolded } from '../store';
import { BrandSymbol, BrandWordmark } from './BrandMark';

function ProjectSwitcher({ collapsed }: { collapsed: boolean }) {
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

  // "client / project": the client above, the project's name under it
  const client = manifest
    ? (manifest.customer ?? manifest.site?.split(',').pop()?.trim() ?? t('titlebar.project'))
    : t('nav.chooseProject');

  return (
    <div className="proj-wrap" ref={ref}>
      <button
        ref={button}
        type="button"
        className="proj-switch"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          if (collapsed) {
            void shell.getState().toggleSidebar();
            setOpen(true);
          } else setOpen(!open);
        }}
      >
        <span className="pglyph">
          <Icon name={manifest ? 'layers' : 'projects'} />
        </span>
        <span className="pt">
          <span dir="auto">
            {client}
            {manifest && <span className="sr-only"> / </span>}
          </span>
          <b dir="auto">{manifest?.name ?? t('nav.noProject')}</b>
        </span>
        <Icon name="updown" size={14} className="faint" />
        <span className="tip">{manifest?.name ?? 'Projects'}</span>
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
              onClick={() => {
                setOpen(false);
                void shell.getState().openProject(e.path);
              }}
            >
              <Icon name={e.path === root ? 'check' : 'layers'} size={14} />
              <span className="pm-t">
                <span className="pm-n">{e.name}</span>
                {e.customer && <span className="pm-c mono">{e.customer}</span>}
              </span>
            </button>
          ))}
          {(library ?? []).length === 0 && <div className="pm-empty">The library is empty.</div>}
          <div className="pm-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              shell.getState().go('projects');
            }}
          >
            <Icon name="projects" size={14} />
            <span className="pm-n">All projects</span>
          </button>
          {manifest && (
            <button
              type="button"
              role="menuitem"
              data-testid="menu-audit-trail"
              onClick={() => {
                setOpen(false);
                openAuditTrail();
              }}
            >
              <Icon name="history" size={14} />
              <span className="pm-n">{t('audit.title')}</span>
            </button>
          )}
          {manifest && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                shell.getState().closeProject();
              }}
            >
              <Icon name="x" size={14} />
              <span className="pm-n">Close project</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The top of the left sidebar, where the title bar's start used to be: the logo row (a window drag
 * region, its buttons not; on macOS the traffic lights sit at its start, `--caption-start`) with
 * the search that opens the command palette, and under it the project switcher.
 */
export function SidebarTop() {
  useT();
  const collapsed = useShell(isSidebarFolded);
  return (
    <>
      <div className="sb-top">
        <span className="sb-logo">
          <BrandSymbol small />
          <BrandWordmark />
        </span>
        <span className="sb-top-fill" />
        <IconButton
          icon="search"
          label={t('titlebar.search')}
          shortcut="global.palette"
          className="sb-search sb-hide"
          onClick={() => {
            shell.getState().setPalette(true);
          }}
        />
      </div>
      <div className="sb-sec sb-proj">
        <ProjectSwitcher collapsed={collapsed} />
      </div>
    </>
  );
}
