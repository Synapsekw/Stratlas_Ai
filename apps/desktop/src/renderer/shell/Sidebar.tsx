import {
  arrowFocus,
  ariaKeys,
  buildDatasetTree,
  DatasetTree,
  formatDate,
  Icon,
  t,
  treeLayerIds,
  useFocusTrap,
  useT,
  VisibilityEye,
  type IconName,
  type MessageKey,
  type TreeItem,
  shortcutHint,
} from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { openAuditTrail } from '../audit/auditView';
import { legacyLayers } from '../legacy';
import { useMedia } from '../media';
import { isActive } from '../jobs';
import { shell, useJobs, useShell } from '../shell';
import type { Screen } from '../store';
import { flightPathShown, toggleFlightPath } from '../workspace/flightPaths';
import { updateFlightPaths, useFlightPathModel } from '../workspace/pathModel';

interface NavDef {
  screen: Screen;
  label: MessageKey;
  icon: IconName;
}

const REVIEW: NavDef = { screen: 'review', label: 'nav.review', icon: 'history' };

const NAV: NavDef[] = [
  { screen: 'projects', label: 'nav.projects', icon: 'projects' },
  { screen: 'scene', label: 'nav.scene', icon: 'scene' },
  { screen: 'issues', label: 'nav.issues', icon: 'issues' },
  { screen: 'media', label: 'nav.media', icon: 'media' },
  { screen: 'detections', label: 'nav.detections', icon: 'target' },
  { screen: 'reports', label: 'nav.reports', icon: 'report' },
  { screen: 'jobs', label: 'nav.jobs', icon: 'clock' },
];

function NavItem({
  def,
  current,
  count,
}: {
  def: NavDef;
  current: boolean;
  count?: number | undefined;
}) {
  return (
    <button
      type="button"
      className="nav-item"
      aria-current={current ? 'page' : undefined}
      onClick={() => {
        shell.getState().go(def.screen);
      }}
    >
      <Icon name={def.icon} />
      <span className="lbl">{t(def.label)}</span>
      {count !== undefined && <span className="count">{count}</span>}
      <span className="tip">{t(def.label)}</span>
    </button>
  );
}

/** Select a clip: make it active and move the clock into it if the playhead is elsewhere. */
export function selectClip(layerId: string) {
  const ws = workspace.getState();
  const layer = ws.project?.manifest.layers.find((l) => l.id === layerId);
  ws.select({ kind: 'clip', id: layerId, layer: layerId });
  ws.setActiveClip(layerId);
  if (layer?.kind === 'video') {
    const start = layer.flight.startUtcMs + layer.offsetMs;
    if (ws.nowMs < start) ws.setTime(start);
  }
}

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

  const capture = manifest?.captures.at(-1);
  const meta = manifest
    ? [
        manifest.customer,
        manifest.site?.split(',').pop()?.trim(),
        capture && formatDate(capture.date),
      ]
        .filter(Boolean)
        .join(' · ')
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
          <b dir="auto">{manifest?.name ?? t('nav.noProject')}</b>
          <span>{meta}</span>
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
              <span className="pm-n">{e.name}</span>
              {e.customer && <span className="mono">{e.customer}</span>}
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

function Datasets({ collapsed }: { collapsed: boolean }) {
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const hidden = useWorkspace((s) => s.hidden);
  const selection = useWorkspace((s) => s.selection);
  const activeClip = useWorkspace((s) => s.activeClip);
  const { durations } = useMedia(project);
  const paths = useFlightPathModel();
  const groups = useMemo(
    () => (project ? buildDatasetTree(project.manifest, issues, durations) : []),
    [project, issues, durations],
  );
  if (!project) return null;

  const selectedId =
    selection && (selection.kind === 'layer' || selection.kind === 'clip')
      ? (selection.layer ?? selection.id)
      : null;

  const setVisible = (ids: string[], visible: boolean) => {
    workspace.getState().setLayersVisible(ids, visible);
  };

  const onSelect = (it: TreeItem) => {
    if (!it.layerId) {
      shell.getState().go('issues');
      return;
    }
    if (it.layerKind === 'video') selectClip(it.layerId);
    else workspace.getState().select({ kind: 'layer', id: it.layerId, layer: it.layerId });
  };

  return (
    <div className="sb-sec sb-tree">
      <div className="tree-h sb-hide">
        <span className="caps">Datasets</span>
        <span className="tree-h-end">
          <span className="mono faint">{project.manifest.layers.length}</span>
          <VisibilityEye
            layerIds={treeLayerIds(groups)}
            hidden={hidden}
            onSet={setVisible}
            labels={{
              all: t('tree.eye.hideAll'),
              none: t('tree.eye.showAll'),
              mixed: t('tree.eye.showAllMixed'),
            }}
          />
        </span>
      </div>
      <DatasetTree
        groups={groups}
        hidden={hidden}
        selectedId={selectedId}
        activeClip={activeClip}
        collapsed={collapsed}
        onToggleVisible={(id, visible) => {
          workspace.getState().setLayerVisible(id, visible);
        }}
        onSetVisible={setVisible}
        flightPath={
          paths
            ? {
                shown: (id) => flightPathShown(paths.pref, id, paths.activeFlight),
                onToggle: (id) => {
                  updateFlightPaths((p, m) => toggleFlightPath(p, id, m.flights, m.activeFlight));
                },
              }
            : undefined
        }
        onLayerSettings={() => {
          shell.getState().openCloudPanel();
        }}
        onSelect={onSelect}
        onRailGroup={() => {
          void shell.getState().toggleSidebar();
        }}
      />
    </div>
  );
}

export function Sidebar() {
  useT();
  const screen = useShell((s) => s.screen);
  const collapsed = useShell((s) => s.settings.sidebarCollapsed);
  const libCount = useShell((s) => s.library?.length);
  const issueCount = useWorkspace((s) => (s.project ? s.issues.length : undefined));
  const runningJobs = useJobs((s) => s.jobs.filter(isActive).length);
  const hasReview = useWorkspace((s) => legacyLayers(s.project?.manifest).length > 0);
  // The original review sits right after Scene when the open project has one.
  const pkg = useShell((s) => s.pkg);
  const withReview = hasReview ? [...NAV.slice(0, 2), REVIEW, ...NAV.slice(2)] : NAV;
  // Pipelines write into project folders: a package (player) has no Jobs.
  const nav = pkg ? withReview.filter((n) => n.screen !== 'jobs') : withReview;

  return (
    <aside className="sidebar" aria-label={t('nav.primary')}>
      <div className="sb-scroll">
        <nav className="sb-sec sb-nav" aria-label={t('nav.sections')}>
          {nav.map((n) => (
            <NavItem
              key={n.screen}
              def={n}
              current={screen === n.screen}
              count={
                n.screen === 'projects'
                  ? libCount
                  : n.screen === 'issues'
                    ? issueCount
                    : n.screen === 'jobs' && runningJobs > 0
                      ? runningJobs
                      : undefined
              }
            />
          ))}
        </nav>
        <div className="sb-sec">
          <ProjectSwitcher collapsed={collapsed} />
        </div>
        <Datasets collapsed={collapsed} />
      </div>
      <div className="sb-foot">
        <NavItem
          def={{ screen: 'settings', label: 'nav.settings', icon: 'settings' }}
          current={screen === 'settings'}
        />
        <button
          type="button"
          className="nav-item"
          onClick={() => {
            void shell.getState().toggleSidebar();
          }}
          aria-keyshortcuts={ariaKeys('global.sidebar')}
          aria-expanded={!collapsed}
          data-testid="sidebar-toggle"
        >
          <Icon name="sidebar" />
          <span className="lbl">{t('nav.collapse')}</span>
          <span className="count">{shortcutHint('global.sidebar')}</span>
          <span className="tip">
            {t(collapsed ? 'nav.expandSidebar' : 'nav.collapseSidebar')}{' '}
            <span className="kbd">{shortcutHint('global.sidebar')}</span>
          </span>
        </button>
      </div>
    </aside>
  );
}
