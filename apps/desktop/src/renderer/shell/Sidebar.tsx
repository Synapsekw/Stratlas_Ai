import { useAnnotateReadOnly } from '@aio/annotate';
import {
  arrowFocus,
  ariaKeys,
  buildDatasetTree,
  buildDateTree,
  captureLabelFor,
  datableLayerIds,
  DatasetTree,
  DateTree,
  EVERY_DATE,
  formatBytes,
  formatDate,
  groupDatableLayerIds,
  Icon,
  nextMarks,
  NO_MARKS,
  t,
  treeLayerIds,
  useFocusTrap,
  useT,
  VisibilityEye,
  type DateFolderMenuRequest,
  type DateItemMenuRequest,
  type IconName,
  type MarkMods,
  type Marks,
  type MessageKey,
  type TreeGroup,
  type TreeItem,
  shortcutHint,
} from '@aio/ui';
import { clipStartMs, dateTags, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { openAuditTrail } from '../audit/auditView';
import { builder } from '../builder/state';
import { DrawingControls } from '../drawings/DrawingControls';
import { drawings, unplacedOf, useDrawings } from '../drawings/store';
import { useMedia } from '../media';
import { shell, useShell } from '../shell';
import { walkBadge, walkGroupAction } from '../walks/walkBadge';
import { openWalk, placeWalk, removeWalkPlacement, useWalks } from '../walks/walks';
import { WalkRowProcess } from '../walks/WalkProcessLine';
import { walkFilesMissing, walkRecordKey } from '../walks/walkStore';
import { PANEL_ID, PanelHandle } from './PanelHandle';
import type { Screen } from '../store';
import { useCaptureIndex } from '../workspace/compare';
import { flightPathShown, toggleFlightPath } from '../workspace/flightPaths';
import { updateFlightPaths, useFlightPathModel } from '../workspace/pathModel';
import { timeline, useTimeline } from '../workspace/timeline';
import { moveLayersToDate, undoDateMove, updateCapture } from './dateFolders';
import { AddSurveyDateButton } from './AddSurveyDate';
import { DateFolderMenu, LayerDateMenu } from './DateMenus';
import { DateNotes, type DateNote } from './DateNotes';
import { askRemove, removal, useRemoval } from './removal';
import { EmptyTrashDialog } from './RemoveHost';
import './surveyDates.css';

interface NavDef {
  screen: Screen;
  label: MessageKey;
  icon: IconName;
}

const NAV: NavDef[] = [
  { screen: 'projects', label: 'nav.projects', icon: 'projects' },
  { screen: 'globe', label: 'globe.nav', icon: 'globe' },
  { screen: 'scene', label: 'nav.scene', icon: 'scene' },
  { screen: 'issues', label: 'nav.issues', icon: 'issues' },
  { screen: 'media', label: 'nav.media', icon: 'media' },
  { screen: 'detections', label: 'nav.detections', icon: 'target' },
  { screen: 'reports', label: 'nav.reports', icon: 'report' },
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
  // drawings that are not placed yet say so on their row
  const placed = useDrawings((s) => s.placed);
  const unplaced = useMemo(() => unplacedOf(placed), [placed]);
  const drawingOpen = useDrawings((s) => s.controls);
  // a walk row carries one badge: files missing, needs placing, path not computed, check placing
  const walkLayers = useWalks((s) => s.walks);
  const walkRecords = useWalks((s) => s.records);
  const walkChecked = useWalks((s) => s.checked);
  const walkBadges = useMemo(
    () =>
      new Map(
        walkLayers.map((w) => [
          w.id,
          walkBadge(w, walkFilesMissing({ records: walkRecords, checked: walkChecked }, w)),
        ]),
      ),
    [walkLayers, walkRecords, walkChecked],
  );
  const groups = useMemo(
    () => (project ? buildDatasetTree(project.manifest, issues, durations, { unplaced }) : []),
    [project, issues, durations, unplaced],
  );
  const t = useT();
  const index = useCaptureIndex();
  const focus = useTimeline((s) => s.focus);
  const datesOn = !collapsed && index !== null && index.captures.length > 0;
  const tags = useMemo(() => (index ? dateTags(index.captures) : {}), [index]);
  const folders = useMemo(
    () =>
      project && index && datesOn
        ? buildDateTree(
            project.manifest,
            issues,
            durations,
            index,
            {
              every: t('tree.dates.every'),
              dateLabel: (c) => formatDate(c.date),
            },
            { unplaced },
          )
        : [],
    [project, index, datesOn, issues, durations, t, unplaced],
  );
  // filing datasets under dates and naming the folders edits the manifest: not in a package,
  // and not for a reviewer who may only look
  const lookOnly = useAnnotateReadOnly();
  const canEdit = !readOnly && !lookOnly;
  const [folderMenu, setFolderMenu] = useState<DateFolderMenuRequest | null>(null);
  const [itemMenu, setItemMenu] = useState<DateItemMenuRequest | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [note, setNote] = useState<DateNote | null>(null);
  // rows marked with Ctrl or Shift for one Delete
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const removed = useRemoval((s) => s.removed);
  const trash = useRemoval((s) => s.trash);
  const held = useRemoval((s) => s.held);
  const [emptying, setEmptying] = useState(false);
  // menus, the name field, the note and the marks belong to the project they were opened in
  const projectId = project?.id;
  const [notedFor, setNotedFor] = useState(projectId);
  if (notedFor !== projectId) {
    setNotedFor(projectId);
    setFolderMenu(null);
    setItemMenu(null);
    setRenaming(null);
    setNote(null);
    setMarks(NO_MARKS);
    setEmptying(false);
  }
  // a removal went through: what was marked is gone; Empty could not delete everything: say so
  // where the tree's notes go (adjusted during render, not in an effect)
  const [seenRemoval, setSeenRemoval] = useState({ removed, held });
  if (seenRemoval.removed !== removed || seenRemoval.held !== held) {
    setSeenRemoval({ removed, held });
    if (seenRemoval.removed !== removed) setMarks(NO_MARKS);
    if (held > 0 && seenRemoval.held !== held)
      setNote({ text: t('trash.held', { count: held }), danger: false });
  }
  // the footer reads the trash when the project opens (the store reads it again after a removal)
  useEffect(() => {
    if (projectId) void removal.getState().loadTrash(projectId);
  }, [projectId]);
  const kinds = useMemo(
    () => new Map((project?.manifest.layers ?? []).map((l) => [l.id, l.kind])),
    [project],
  );
  if (!project) return null;

  /** The rows that can be deleted: layers, not retired viewers or basemaps. */
  const deletable = (ids: readonly string[]) =>
    ids.filter((id) => {
      const k = kinds.get(id);
      return k !== undefined && k !== 'legacy' && k !== 'basemap';
    });
  /** Open the shared removal dialog on these rows (nothing when none can be deleted). */
  const askLayers = (ids: readonly string[]) => {
    const ok = deletable(ids);
    if (ok.length > 0) askRemove(ok.map((layer) => ({ layer })));
  };
  const onMark = (id: string, mods: MarkMods, order: readonly string[]) => {
    setMarks((m) => nextMarks(m, order, id, mods));
  };
  const marked = marks.marked.size > 0;

  const failed = (error: string | null) => {
    setNote(error ? { text: error, danger: true } : null);
  };

  const onMove = (layerIds: string[], capture: string | null) => {
    void moveLayersToDate(layerIds, capture).then(({ error, stays, moved }) => {
      if (error) {
        failed(error);
        return;
      }
      const manifest = workspace.getState().project?.manifest;
      // one dataset is put back by dragging it back; a group or a flight needs Undo
      const undo = moved.length > 1 ? { undo: { moved, target: capture } } : {};
      const kept = Object.entries(stays);
      const [first] = kept;
      if (first) {
        const name = manifest?.layers.find((l) => l.id === first[0])?.name ?? first[0];
        const date = manifest?.captures.find((c) => c.id === first[1])?.date;
        setNote({
          text: t('tree.dates.move.stays', {
            count: kept.length,
            name,
            date: date ? formatDate(date) : first[1],
          }),
          danger: false,
          ...undo,
        });
        return;
      }
      if (moved.length > 1) {
        const date = capture ? manifest?.captures.find((c) => c.id === capture)?.date : undefined;
        setNote({
          text: date
            ? t('tree.dates.move.done', { count: moved.length, date: formatDate(date) })
            : t('tree.dates.move.doneNone', { count: moved.length }),
          danger: false,
          undo: { moved, target: capture },
        });
        return;
      }
      setNote(null);
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
    // a plain click selects one row and lets go of the marks
    setMarks(NO_MARKS);
    if (!it.layerId) {
      shell.getState().go('issues');
      return;
    }
    if (it.layerKind === 'video') selectClip(it.layerId);
    else workspace.getState().select({ kind: 'layer', id: it.layerId, layer: it.layerId });
    // a walk row opens the walk in the 360 video pane, as its Open action does
    if (it.layerKind === 'walk') openWalk(it.layerId);
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

  // a walk row says under itself where its processing stands (walk.process), once main has
  // listed its record
  const walkLine = (it: TreeItem) => {
    const layer = it.layerKind === 'walk' ? walkLayers.find((w) => w.id === it.layerId) : undefined;
    return layer && walkRecordKey(layer) in walkRecords ? <WalkRowProcess layer={layer} /> : null;
  };

  // a drawing row opens its controls under itself; the Drawings header adds a drawing
  const drawingProps = {
    onDrawingSettings: (it: TreeItem) => {
      drawings.getState().toggleControls(it.id);
    },
    rowExtra: (it: TreeItem) =>
      it.drawing && it.id === drawingOpen ? (
        <DrawingControls layerId={it.id} name={it.name} canEdit={canEdit} />
      ) : (
        walkLine(it)
      ),
    groupAction: (g: TreeGroup) =>
      g.kind === 'drawings' && !readOnly
        ? {
            label: t('tree.addDrawing'),
            onClick: () => void builder.getState().pickAndAddDrawing(),
          }
        : walkGroupAction(g.kind, readOnly, t('walk.add'), () => {
            void builder.getState().pickAndImport360();
          }),
  };

  // a walk row: its placing badge, and Open, Place walk (Edit placement once placed), Remove
  // placement and Remove walk (all but Open not in a package, nor for a reviewer who may only look)
  const walkProps = {
    rowBadge: (it: TreeItem) =>
      it.layerKind === 'walk' && it.layerId ? (walkBadges.get(it.layerId) ?? null) : null,
    walkActions: {
      onOpen: (it: TreeItem) => {
        if (it.layerId) openWalk(it.layerId);
      },
      onPlace: canEdit
        ? (it: TreeItem) => {
            if (it.layerId) placeWalk(it.layerId);
          }
        : undefined,
      // placed: two pins or more saved (Edit placement and Remove placement instead of Place walk)
      placed: (it: TreeItem) =>
        project.manifest.layers.some(
          (w) =>
            w.kind === 'walk' &&
            w.id === it.layerId &&
            w.place !== undefined &&
            w.place.pins.length >= 2 &&
            w.place.quality !== 'unplaced',
        ),
      // the row asks first; the walk stays, only its placement goes (a refusal shows as the note)
      onRemovePlacement: canEdit
        ? (it: TreeItem) => {
            if (it.layerId)
              // only a refusal touches the note (a removal leaves any other note alone)
              void removeWalkPlacement(it.layerId)
                .then((e) => {
                  if (e) failed(e);
                })
                .catch((e: unknown) => {
                  failed(String(e));
                });
          }
        : undefined,
      // the shared removal dialog asks first
      onRemove: canEdit
        ? (it: TreeItem) => {
            if (it.layerId) askLayers([it.layerId]);
          }
        : undefined,
    },
  };

  // Ctrl+click, Shift+click, Ctrl+Space and Shift+ArrowUp/Down mark rows (not in a package, nor
  // for a reviewer who may only look)
  const markProps = { marked: marks.marked, onMark: canEdit ? onMark : undefined };

  // while rows are marked the header offers their Delete in place of the count and the add tools
  // (the sidebar is too narrow for all of them); the eye stays (founder, 13 Oct 2026)
  const marking = canEdit && marked;

  return (
    <div
      className="sb-sec sb-tree"
      onKeyDown={(e) => {
        // keys typed in a menu or dialog the tree opened (portals) are theirs, not the tree's
        if (!(e.target instanceof Element) || !e.currentTarget.contains(e.target)) return;
        // and keys typed in a field (a date's name) are the field's
        if (e.target.closest('input, textarea, select, [contenteditable]')) return;
        if (marked && e.key === 'Escape') {
          e.stopPropagation();
          setMarks(NO_MARKS);
        } else if (e.key === 'Delete' && canEdit) {
          // the marked rows, else the focused row; always through the shared dialog
          const row = marked ? null : e.target.closest<HTMLElement>('[data-mark]')?.dataset.mark;
          const ids = marked ? [...marks.marked] : row ? [row] : [];
          if (ids.length === 0) return;
          e.preventDefault();
          askLayers(ids);
        }
      }}
    >
      <div className="tree-h sb-hide">
        <span className="caps">Datasets</span>
        <span className="tree-h-end">
          {/* a retired viewer of an older project has no row, so it is not counted */}
          {!marking && (
            <span className="mono faint">
              {project.manifest.layers.filter((l) => l.kind !== 'legacy').length}
            </span>
          )}
          {marking && (
            <button
              type="button"
              className="tree-marked"
              data-testid="tree-marked-delete"
              onClick={() => {
                askLayers([...marks.marked]);
              }}
            >
              {t('tree.marked', { count: marks.marked.size })} · {t('tree.delete')}
            </button>
          )}
          {!readOnly && !marking && (
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
          {!readOnly && !marking && (
            <button
              type="button"
              className="eye"
              data-testid="add-drawing"
              aria-label={t('tree.addDrawing')}
              title={t('tree.addDrawing.tip')}
              onClick={() => void builder.getState().pickAndAddDrawing()}
            >
              <Icon name="drawing" size={14} />
            </button>
          )}
          {canEdit && !marking && (
            <AddSurveyDateButton
              onNote={(text) => {
                setNote({ text, danger: false });
              }}
            />
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
      <DateNotes
        collapsed={collapsed}
        canEdit={canEdit}
        note={note}
        onPromptResult={(n) => {
          setNote({ text: n.text, danger: false, ...(n.undo ? { undo: n.undo } : {}) });
        }}
        onUndo={(pending) => {
          // the note goes first, so a second quick click has nothing to start again
          setNote(null);
          void undoDateMove(pending.moved, pending.target).then(failed);
        }}
        onDismiss={() => {
          setNote(null);
        }}
      />
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
          {...drawingProps}
          {...walkProps}
          {...markProps}
          onFolderMenu={setFolderMenu}
          onMove={canEdit ? onMove : undefined}
          onItemMenu={setItemMenu}
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
          {...drawingProps}
          {...walkProps}
          {...markProps}
          onSelect={onSelect}
          onRailGroup={() => {
            void shell.getState().toggleSidebar();
          }}
          // survey dates off: rows and group headers still have a menu (Compare, Delete)
          onItemMenu={(it, at) => {
            const layerIds = datableLayerIds(it);
            if (layerIds.length > 0)
              setItemMenu({ name: it.name, item: it, layerIds, from: EVERY_DATE, ...at });
          }}
          dragGroupIds={groupDatableLayerIds}
          onGroupMenu={(g, layerIds, at) => {
            setItemMenu({
              name: t('tree.dates.move.group', { group: g.label, count: layerIds.length }),
              layerIds,
              from: EVERY_DATE,
              ...at,
            });
          }}
        />
      )}
      {canEdit && !collapsed && trash !== null && trash.entries > 0 && (
        <div className="tree-foot sb-hide" data-testid="tree-trash">
          <Icon name="trash" size={12} />
          <span>{t('tree.trash', { size: formatBytes(trash.bytes) })}</span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className="tree-foot-btn"
            data-testid="tree-trash-empty"
            onClick={() => {
              // what an earlier Empty held is forgotten, so this one's held entries note again
              removal.setState({ held: 0 });
              setEmptying(true);
            }}
          >
            {t('tree.trash.empty')}
          </button>
        </div>
      )}
      {emptying && (
        <EmptyTrashDialog
          projectId={project.id}
          onClose={() => {
            setEmptying(false);
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
          onDelete={
            canEdit
              ? (capture) => {
                  askRemove([{ capture }]);
                }
              : undefined
          }
        />
      )}
      {itemMenu && (
        <LayerDateMenu
          menu={itemMenu}
          captures={project.manifest.captures}
          tags={tags}
          every={EVERY_DATE}
          canEdit={canEdit}
          dateMoves={datesOn}
          onClose={() => {
            setItemMenu(null);
          }}
          onMove={onMove}
          onDelete={canEdit && deletable(itemMenu.layerIds).length > 0 ? askLayers : undefined}
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

  return (
    <aside className="sidebar" id={PANEL_ID.left} aria-label={t('nav.primary')}>
      <div className="sb-scroll">
        <nav className="sb-sec sb-nav" aria-label={t('nav.sections')}>
          {NAV.map((n) => (
            <NavItem
              key={n.screen}
              def={n}
              current={screen === n.screen}
              count={
                n.screen === 'projects' ? libCount : n.screen === 'issues' ? issueCount : undefined
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
