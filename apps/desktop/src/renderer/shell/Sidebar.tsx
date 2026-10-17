import { useAnnotateReadOnly } from '@aio/annotate';
import {
  ariaKeys,
  Button,
  buildDatasetTree,
  buildDateTree,
  captureLabelFor,
  DatasetTree,
  DateTree,
  EVERY_DATE,
  formatBytes,
  formatDate,
  groupDatableLayerIds,
  Icon,
  isMenuKey,
  keyMenuPoint,
  makeActionCtx,
  menuPoint,
  nextMarks,
  NO_MARKS,
  t,
  treeLayerIds,
  useT,
  VisibilityEye,
  type DateFolderMenuRequest,
  type DateItemMenuRequest,
  type GroupFold,
  type MenuPoint,
  type TreeGroupKind,
  NO_HOST,
  type ActionHost,
  type IconName,
  type MarkMods,
  type Marks,
  type MessageKey,
  type TreeGroup,
  type TreeItem,
  shortcutHint,
} from '@aio/ui';
import { dateTags, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useState, type HTMLAttributes } from 'react';
import { builder } from '../builder/state';
import { DrawingControls } from '../drawings/DrawingControls';
import { drawings, unplacedOf, useDrawings } from '../drawings/store';
import { help } from '../help/store';
import { lineUpTip } from '../lineup/planLineUp';
import { useMedia } from '../media';
import { watchPanoStitches } from '../panos/panoJobs';
import { pickAndScanPanos } from '../panos/panos';
import { PanoSphereRows } from '../panos/PanoSphereRows';
import { shell, useShell } from '../shell';
import { walkBadge, walkGroupAction } from '../walks/walkBadge';
import { openWalk, placeWalk, removeWalkPlacement, useWalks } from '../walks/walks';
import { WalkRowProcess } from '../walks/WalkProcessLine';
import { walkFilesMissing, walkRecordKey } from '../walks/walkStore';
import { PANEL_ID, PanelHandle } from './PanelHandle';
import { isSidebarFolded, type Screen } from '../store';
import { useCaptureIndex } from '../workspace/compare';
import { flightPathShown, toggleFlightPath } from '../workspace/flightPaths';
import { updateFlightPaths, useFlightPathModel } from '../workspace/pathModel';
import { selectClip } from '../workspace/pickClip';
import { timeline, useTimeline } from '../workspace/timeline';
import { moveLayersToDate, undoDateMove, updateCapture } from './dateFolders';
import { AddSurveyDateButton } from './AddSurveyDate';
import { registerSidebarActions } from './actions';
import { commitLayerRename } from './actions/layerActions';
import { TreeMenu, type TreeMenuRequest } from './DateMenus';
import { DateNotes, type DateNote } from './DateNotes';
import { menuTitle, rowTarget } from './menuTargets';
import { renameRequest, useRenameRequest } from './renameRequest';
import { askRemove, removal, useRemoval } from './removal';
import { EmptyTrashDialog } from './RemoveHost';
import { SidebarStatus } from './SidebarStatus';
import { SidebarTop } from './SidebarTop';
import './surveyDates.css';

watchPanoStitches();
registerSidebarActions();

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
              lineUp: (c) => lineUpTip(project.manifest, c.id, t) ?? undefined,
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
  const [menu, setMenu] = useState<TreeMenuRequest | null>(null);
  const layerRenaming = useRenameRequest((st) => st.layerId);
  const [unplace, setUnplace] = useState<{ id: string; seq: number } | null>(null);
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
    setMenu(null);
    setUnplace(null);
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

  const askEmpty = () => {
    // what an earlier Empty held is forgotten, so this one's held entries note again
    removal.setState({ held: 0 });
    setEmptying(true);
  };

  // what the registered actions read and call; rebuilt every render so an open menu stays live
  const host: Partial<ActionHost> = {
    note: (text, danger) => {
      setNote({ text, danger: danger === true });
    },
    renameDate: setRenaming,
    moveLayers: onMove,
    askUnplace: (id) => {
      setUnplace((u) => ({ id, seq: (u?.seq ?? 0) + 1 }));
    },
    emptyTrash: askEmpty,
  };
  const ctx = makeActionCtx({
    manifest: project.manifest,
    hidden,
    canEdit,
    pkg: readOnly,
    datesOn,
    focus,
    tags,
    folderLayers: Object.fromEntries(folders.map((f) => [f.id, f.layerIds])),
    trashEntries: trash?.entries ?? 0,
    drafts: issues.filter((i) => i.status === 'draft').length,
    host: { ...NO_HOST, ...host },
  });

  const openProject = (at: MenuPoint) => {
    const name = project.manifest.name;
    setMenu({
      target: { kind: 'project' },
      ...at,
      title: name,
      label: t('actions.menu.label', { name }),
      testId: 'ctx-menu',
      host: {},
    });
  };
  /** A row's menu: the marked rows when it is one of them, else the row. */
  const openRow = (item: TreeItem, at: MenuPoint, from: string) => {
    const target = rowTarget(item, marks.marked);
    if (!target) return;
    setMenu({
      target,
      ...at,
      title: menuTitle(target, ctx, item.name),
      label: t('actions.menu.label', { name: item.name }),
      testId: target.kind === 'layers' ? 'move-menu' : 'ctx-menu',
      host: { from },
    });
  };
  /** A group heading's menu; every heading has one, one without layers too. */
  const openGroup = (
    group: TreeGroupKind,
    title: string,
    layerIds: string[],
    at: MenuPoint,
    from: string,
    fold: GroupFold,
  ) => {
    const target = {
      kind: 'group' as const,
      group,
      layerIds,
      captureId: from === EVERY_DATE ? null : from,
    };
    setMenu({
      target,
      ...at,
      title,
      label: t('actions.menu.label', { name: title }),
      testId: 'move-menu',
      host: { toggle: fold.toggle, expanded: fold.expanded, from },
    });
  };
  const openFolder = (m: DateFolderMenuRequest) => {
    setMenu({
      target: { kind: 'date', captureId: m.folder.capture?.id ?? null },
      x: m.x,
      y: m.y,
      title: m.folder.sub ? `${m.folder.label} · ${m.folder.sub}` : m.folder.label,
      label: t('tree.dates.menu.label', { date: m.folder.label }),
      testId: 'date-menu',
      host: { toggle: m.toggle, expanded: m.expanded, from: m.folder.id },
    });
  };
  const onDatesMenu = (m: DateItemMenuRequest) => {
    if (m.item) openRow(m.item, m, m.from);
    else if (m.group && m.fold) openGroup(m.group, m.name, m.layerIds, m, m.from, m.fold);
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

  // a panoramas layer lists its spheres under itself (older layers of plain panos keep one row)
  const panoLines = (it: TreeItem) => {
    if (it.layerKind !== 'panoramas') return null;
    const layer = project.manifest.layers.find((l) => l.id === it.layerId);
    return layer?.kind === 'panoramas' && layer.items.some((p) => p.stitch !== undefined) ? (
      <PanoSphereRows layer={layer} canEdit={canEdit} />
    ) : null;
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
        (walkLine(it) ?? panoLines(it))
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
  const layerRenameProps = {
    renamingLayer: canEdit ? layerRenaming : null,
    onRenameLayerStart: canEdit
      ? (id: string) => {
          renameRequest.getState().ask(id);
        }
      : undefined,
    onRenameLayer: (id: string, name: string) => {
      void commitLayerRename(id, name).then(failed);
    },
    onRenameLayerEnd: () => {
      renameRequest.getState().done();
    },
    unplaceRequest: unplace,
  };
  const markProps = { marked: marks.marked, onMark: canEdit ? onMark : undefined };

  // while rows are marked the header offers their Delete in place of the count and the add tools
  // (the sidebar is too narrow for all of them); the eye stays (founder, 13 Oct 2026)
  const marking = canEdit && marked;

  return (
    <div
      className="sb-sec sb-tree"
      onContextMenu={(e) => {
        // rows, groups and folders handle their own; a field keeps the system menu; a dialog
        // the tree opened (a portal) is not empty space
        if (e.defaultPrevented) return;
        if (!(e.target instanceof Element) || !e.currentTarget.contains(e.target)) return;
        if (e.target instanceof Element && e.target.closest('input, textarea')) return;
        e.preventDefault();
        openProject(menuPoint(e));
      }}
      onKeyDown={(e) => {
        // keys typed in a menu or dialog the tree opened (portals) are theirs, not the tree's
        if (!(e.target instanceof Element) || !e.currentTarget.contains(e.target)) return;
        // and keys typed in a field (a date's name) are the field's
        if (e.target.closest('input, textarea, select, [contenteditable]')) return;
        if (isMenuKey(e)) {
          e.preventDefault();
          // a button inside a row (eye, gear) opens that row's menu
          const row = e.target.closest<HTMLElement>('[data-mark]');
          const id = row?.dataset.mark;
          const layer = id ? project.manifest.layers.find((l) => l.id === id) : undefined;
          if (row && layer) {
            const folder = row.closest<HTMLElement>('[data-testid^="date-folder-"]');
            const from = folder?.dataset.testid?.slice('date-folder-'.length) ?? EVERY_DATE;
            openRow(
              { id: layer.id, layerId: layer.id, layerKind: layer.kind, name: layer.name },
              keyMenuPoint(row),
              from,
            );
          } else openProject(keyMenuPoint(e.target as HTMLElement));
          return;
        }
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
        {/* the count sits with its label ("DATASETS 10"), the actions at the end */}
        <span className="tree-h-title">
          <span className="caps">Datasets</span>
          {/* a retired viewer of an older project has no row, so it is not counted */}
          {!marking && (
            <span className="mono faint">
              {project.manifest.layers.filter((l) => l.kind !== 'legacy').length}
            </span>
          )}
        </span>
        <span className="tree-h-end">
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
              <span className="lbl">{t('tree.addData')}</span>
            </button>
          )}
          {!readOnly && !marking && (
            <button
              type="button"
              className="eye"
              data-testid="add-panos"
              aria-label={t('pano.add')}
              title={t('pano.add.tip')}
              onClick={() => void pickAndScanPanos()}
            >
              <Icon name="pano" size={14} />
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
          onFolderMenu={openFolder}
          onMove={canEdit ? onMove : undefined}
          onItemMenu={onDatesMenu}
          renaming={canEdit ? renaming : null}
          onRenameStart={canEdit ? setRenaming : undefined}
          onRename={onRename}
          onRenameEnd={() => {
            setRenaming(null);
          }}
          {...layerRenameProps}
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
            openRow(it, at, EVERY_DATE);
          }}
          dragGroupIds={groupDatableLayerIds}
          {...layerRenameProps}
          onGroupMenu={(g, layerIds, at, fold) => {
            openGroup(
              g.kind,
              t('tree.dates.move.group', { group: g.label, count: layerIds.length }),
              layerIds,
              at,
              EVERY_DATE,
              fold,
            );
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
            onClick={askEmpty}
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
      {menu && (
        <TreeMenu
          request={menu}
          ctx={ctx}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

export interface SidebarProps {
  /** The `shell.sidebar` split's separator (App.tsx): the drag handle on the inner edge. */
  resize?: HTMLAttributes<HTMLDivElement>;
}

export function Sidebar({ resize }: SidebarProps = {}) {
  useT();
  const screen = useShell((s) => s.screen);
  const collapsed = useShell(isSidebarFolded);
  const libCount = useShell((s) => s.library?.length);
  const issueCount = useWorkspace((s) => (s.project ? s.issues.length : undefined));

  return (
    <aside className="sidebar" id={PANEL_ID.left} aria-label={t('nav.primary')}>
      {/* the panel's surface slides out as it folds, and the rail's fades in (styles.css) */}
      <div className="sb-surface" aria-hidden="true" />
      <div className="sb-rail" aria-hidden="true" />
      <SidebarTop />
      {/* the nav stays put above the tree, which scrolls on its own */}
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
      {/* the dataset tree is the Scene's; on the other screens the space stays empty */}
      <div className="sb-scroll">{screen === 'scene' && <Datasets collapsed={collapsed} />}</div>
      <div className="sb-foot">
        <SidebarStatus />
        <div className="sb-foot-row">
          <NavItem
            def={{ screen: 'settings', label: 'nav.settings', icon: 'settings' }}
            current={screen === 'settings'}
          />
          <Button
            variant="icon"
            className="help-btn sb-hide"
            aria-label={t('help.open')}
            aria-keyshortcuts="F1"
            tip={t('help.open')}
            data-testid="help-open"
            onClick={() => {
              help.getState().openHelp();
            }}
          >
            ?
          </Button>
        </div>
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
      {resize && (
        <div
          {...resize}
          className="split-handle sb-resize"
          aria-label={t('panel.resizeLeft')}
          aria-controls={PANEL_ID.left}
        >
          <span className="kbd split-readout" aria-hidden="true" />
        </div>
      )}
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
