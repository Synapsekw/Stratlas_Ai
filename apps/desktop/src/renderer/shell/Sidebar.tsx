import { useAnnotateReadOnly } from '@aio/annotate';
import {
  arrowFocus,
  ariaKeys,
  buildDatasetTree,
  buildDateTree,
  captureLabelFor,
  DatasetTree,
  DateTree,
  EVERY_DATE,
  formatDate,
  Icon,
  t,
  treeLayerIds,
  useFocusTrap,
  useT,
  VisibilityEye,
  type DateFolderMenuRequest,
  type DateItemMenuRequest,
  type IconName,
  type MessageKey,
  type TreeItem,
  shortcutHint,
} from '@aio/ui';
import { clipStartMs, dateTags, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { openAuditTrail } from '../audit/auditView';
import { builder } from '../builder/state';
import { legacyLayers } from '../legacy';
import { useMedia } from '../media';
import { isActive } from '../jobs';
import { shell, useJobs, useShell } from '../shell';
import { PANEL_ID, PanelHandle } from './PanelHandle';
import type { Screen } from '../store';
import { useCaptureIndex } from '../workspace/compare';
import { flightPathShown, toggleFlightPath } from '../workspace/flightPaths';
import { updateFlightPaths, useFlightPathModel } from '../workspace/pathModel';
import { timeline, useTimeline } from '../workspace/timeline';
import { moveLayersToDate, updateCapture } from './dateFolders';
import { DateFolderMenu, LayerDateMenu } from './DateMenus';

interface NavDef {
  screen: Screen;
  label: MessageKey;
  icon: IconName;
}

const REVIEW: NavDef = { screen: 'review', label: 'nav.review', icon: 'history' };

const NAV: NavDef[] = [
  { screen: 'projects', label: 'nav.projects', icon: 'projects' },
  { screen: 'globe', label: 'globe.nav', icon: 'globe' },
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
    const start = clipStartMs(layer);
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
  // a package is read-only: nothing is imported into it
  const readOnly = useShell((s) => s.pkg !== null);
  const groups = useMemo(
    () => (project ? buildDatasetTree(project.manifest, issues, durations) : []),
    [project, issues, durations],
  );
  const t = useT();
  const index = useCaptureIndex();
  const focus = useTimeline((s) => s.focus);
  const datesOn = !collapsed && index !== null && index.captures.length > 0;
  const tags = useMemo(() => (index ? dateTags(index.captures) : {}), [index]);
  const folders = useMemo(
    () =>
      project && index && datesOn
        ? buildDateTree(project.manifest, issues, durations, index, {
            every: t('tree.dates.every'),
            dateLabel: (c) => formatDate(c.date),
          })
        : [],
    [project, index, datesOn, issues, durations, t],
  );
  // filing datasets under dates and naming the folders edits the manifest: not in a package,
  // and not for a reviewer who may only look
  const lookOnly = useAnnotateReadOnly();
  const canEdit = !readOnly && !lookOnly;
  const [folderMenu, setFolderMenu] = useState<DateFolderMenuRequest | null>(null);
  const [itemMenu, setItemMenu] = useState<DateItemMenuRequest | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; danger: boolean } | null>(null);
  // menus, the name field and the note belong to the project they were opened in
  const projectId = project?.id;
  const [notedFor, setNotedFor] = useState(projectId);
  if (notedFor !== projectId) {
    setNotedFor(projectId);
    setFolderMenu(null);
    setItemMenu(null);
    setRenaming(null);
    setNote(null);
  }
  if (!project) return null;

  const failed = (error: string | null) => {
    setNote(error ? { text: error, danger: true } : null);
  };

  const onMove = (layerIds: string[], capture: string | null) => {
    void moveLayersToDate(layerIds, capture).then(({ error, stays }) => {
      if (error) {
        failed(error);
        return;
      }
      const kept = Object.entries(stays);
      const [first] = kept;
      if (!first) {
        setNote(null);
        return;
      }
      const manifest = workspace.getState().project?.manifest;
      const name = manifest?.layers.find((l) => l.id === first[0])?.name ?? first[0];
      const date = manifest?.captures.find((c) => c.id === first[1])?.date;
      setNote({
        text: t('tree.dates.move.stays', {
          count: kept.length,
          name,
          date: date ? formatDate(date) : first[1],
        }),
        danger: false,
      });
    });
  };

  const onRename = (captureId: string, name: string) => {
    const capture = project.manifest.captures.find((c) => c.id === captureId);
    if (!capture) return;
    void updateCapture(captureId, { label: captureLabelFor(capture, name) }).then(failed);
  };

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

  const onToggleVisible = (id: string, visible: boolean) => {
    workspace.getState().setLayerVisible(id, visible);
  };

  const flightPath = paths
    ? {
        shown: (id: string) => flightPathShown(paths.pref, id, paths.activeFlight),
        onToggle: (id: string) => {
          updateFlightPaths((p, m) => toggleFlightPath(p, id, m.flights, m.activeFlight));
        },
      }
    : undefined;

  const onLayerSettings = () => {
    shell.getState().openCloudPanel();
  };

  return (
    <div className="sb-sec sb-tree">
      <div className="tree-h sb-hide">
        <span className="caps">Datasets</span>
        <span className="tree-h-end">
          <span className="mono faint">{project.manifest.layers.length}</span>
          {!readOnly && (
            <button
              type="button"
              className="tree-add"
              data-testid="add-data"
              title={t('tree.addData.tip')}
              onClick={() => void builder.getState().pickAndImport()}
            >
              <Icon name="import" size={14} />
              {t('tree.addData')}
            </button>
          )}
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
      {datesOn && note && (
        <p
          className={`dtree-note${note.danger ? ' danger' : ''}`}
          role={note.danger ? 'alert' : 'status'}
          data-testid="date-note"
        >
          <span>{note.text}</span>
          <button
            type="button"
            aria-label={t('tree.dates.dismiss')}
            title={t('tree.dates.dismiss')}
            onClick={() => {
              setNote(null);
            }}
          >
            <Icon name="x" size={12} />
          </button>
        </p>
      )}
      {datesOn ? (
        <DateTree
          folders={folders}
          tags={tags}
          focus={focus}
          onFocus={(id) => {
            timeline.getState().focusSurvey(id);
          }}
          hidden={hidden}
          selectedId={selectedId}
          activeClip={activeClip}
          onToggleVisible={onToggleVisible}
          onSetVisible={setVisible}
          onSelect={onSelect}
          flightPath={flightPath}
          onLayerSettings={onLayerSettings}
          onFolderMenu={setFolderMenu}
          onMove={canEdit ? onMove : undefined}
          onItemMenu={canEdit ? setItemMenu : undefined}
          renaming={canEdit ? renaming : null}
          onRenameStart={canEdit ? setRenaming : undefined}
          onRename={onRename}
          onRenameEnd={() => {
            setRenaming(null);
          }}
        />
      ) : (
        <DatasetTree
          groups={groups}
          hidden={hidden}
          selectedId={selectedId}
          activeClip={activeClip}
          collapsed={collapsed}
          onToggleVisible={onToggleVisible}
          onSetVisible={setVisible}
          flightPath={flightPath}
          onLayerSettings={onLayerSettings}
          onSelect={onSelect}
          onRailGroup={() => {
            void shell.getState().toggleSidebar();
          }}
        />
      )}
      {datesOn && folderMenu && (
        <DateFolderMenu
          menu={folderMenu}
          folder={folders.find((f) => f.id === folderMenu.folder.id) ?? folderMenu.folder}
          tag={tags[folderMenu.folder.id]}
          focused={folderMenu.folder.id === focus}
          hidden={hidden}
          canEdit={canEdit}
          onClose={() => {
            setFolderMenu(null);
          }}
          onFocus={(id) => {
            timeline.getState().focusSurvey(id);
          }}
          onSetVisible={setVisible}
          onRename={setRenaming}
          onStyle={(id, patch) => {
            void updateCapture(id, patch).then(failed);
          }}
        />
      )}
      {datesOn && canEdit && itemMenu && (
        <LayerDateMenu
          menu={itemMenu}
          captures={project.manifest.captures}
          tags={tags}
          every={EVERY_DATE}
          onClose={() => {
            setItemMenu(null);
          }}
          onMove={onMove}
        />
      )}
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
    <aside className="sidebar" id={PANEL_ID.left} aria-label={t('nav.primary')}>
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
          aria-controls={PANEL_ID.left}
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
      <PanelHandle
        side="left"
        collapsed={collapsed}
        shortcut="global.sidebar"
        onToggle={() => {
          void shell.getState().toggleSidebar();
        }}
      />
    </aside>
  );
}
