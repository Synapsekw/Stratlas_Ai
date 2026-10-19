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
  itemMeasureIds,
  measureIdOf,
  measurementsGroup,
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
  type MeasureTreeProps,
  type MessageKey,
  type TreeGroup,
  type TreeItem,
  shortcutHint,
} from '@aio/ui';
import { dateTags, useWorkspace, workspace } from '@aio/workspace';
import { useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react';
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
import { filterTerms } from '../survey/measureFilter';
import { buildMeasureItems } from '../survey/measureRows';
import {
  deleteMeasurements,
  endNewFolder,
  measureStore,
  renameMeasurement,
  revealMeasurement,
  select,
  setFolder,
  setMeasurementsHidden,
  useMeasure,
} from '../survey/measureStore';
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
import { measureTarget, menuTitle, rowTarget } from './menuTargets';
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

/**
 * The groups open at first: the tree's own defaults (DatasetTree's DEFAULT_OPEN), and the
 * Measurements group, so a finished measurement is seen in the list without a click.
 */
const OPEN_GROUPS: readonly TreeGroupKind[] = [
  'models',
  'maps',
  'measurements',
  'drawings',
  'video',
  'walks',
  'panoramas',
  'annotations',
];

/** These marks without the measurements no longer in the file (the same marks when none went). */
function withoutGoneMeasures(m: Marks, present: readonly { id: string }[]): Marks {
  const ids = new Set(present.map((x) => x.id));
  const gone = (x: string) => {
    const id = measureIdOf(x);
    return id !== null && !ids.has(id);
  };
  if (![...m.marked].some(gone) && !(m.anchor !== null && gone(m.anchor))) return m;
  const marked = new Set([...m.marked].filter((x) => !gone(x)));
  if (marked.size === 0) return NO_MARKS;
  return { marked, anchor: m.anchor !== null && gone(m.anchor) ? null : m.anchor };
}

/** The measurement ids among marks (a measurement row marks `measure:<id>`). */
function measureIdsOf(marks: Iterable<string>): string[] {
  return [...marks].flatMap((m) => {
    const id = measureIdOf(m);
    return id === null ? [] : [id];
  });
}

/**
 * Select the marked measurements in view (`ids`); the focus moves off a marked one the filter
 * hides (`marked`: every marked measurement), so the panel never shows a row the tree hides.
 */
function selectMarked(marked: ReadonlySet<string>, ids: string[]): void {
  const f = measureStore.getState().focus;
  const focus = f === null || ids.includes(f) || !marked.has(f) ? f : (ids[0] ?? null);
  select(ids, focus);
}

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
  // the Measurements group: rows from the measurement store, their eyes remembered per project
  const measureFile = useMeasure((s) => s.file);
  const measureSettings = useMeasure((s) => s.settings);
  const measureTemplates = useMeasure((s) => s.templates);
  const hiddenMeasurements = useMeasure((s) => s.hiddenMeasurements);
  const measureFocus = useMeasure((s) => s.focus);
  const measureReadOnly = useMeasure((s) => s.readOnly);
  const newFolder = useMeasure((s) => s.newFolder);
  const reveal = useMeasure((s) => s.reveal);
  const measureRenaming = useRenameRequest((st) => st.measureId);
  const dates = useWorkspace((s) => s.dates);
  const manifest = project?.manifest ?? null;
  // the group's filter box: view state only, never saved; the rows are built from it
  const [measureQuery, setMeasureQuery] = useState('');
  const filteringMeasures = filterTerms(measureQuery).length > 0;
  const measureItems = useMemo(
    () =>
      buildMeasureItems(
        { file: measureFile, settings: measureSettings, templates: measureTemplates },
        manifest,
        { dates, hidden },
        measureQuery,
      ),
    [measureFile, measureSettings, measureTemplates, manifest, dates, hidden, measureQuery],
  );
  // under a filter the group still counts, and its eye covers, every measurement
  const measureIds = useMemo(
    () => (filteringMeasures ? measureFile.measurements.map((m) => m.id) : undefined),
    [filteringMeasures, measureFile],
  );
  // a reveal of a measurement the filter hides (one just drawn, one picked in 3D) clears the
  // filter, so the row can be shown; no measurements left, no filter (adjusted during render)
  const [filterSeenReveal, setFilterSeenReveal] = useState(reveal?.seq);
  if (filterSeenReveal !== reveal?.seq) {
    setFilterSeenReveal(reveal?.seq);
    const id = reveal?.id ?? null;
    if (filteringMeasures && id !== null && !measureItems.flatMap(itemMeasureIds).includes(id))
      setMeasureQuery('');
  }
  if (measureQuery !== '' && measureFile.measurements.length === 0) setMeasureQuery('');
  const measureHidden = useMemo(
    () => Object.fromEntries(hiddenMeasurements.map((id) => [id, true] as const)),
    [hiddenMeasurements],
  );
  // A reveal that opens the folded sidebar is asked again once the open tree is drawn: a tree
  // drawn after a reveal takes it as already seen (survey dates on, opening swaps the rail for the
  // date tree). Asked again without opening, so it is not asked a third time.
  const revealWaits = useRef<number | null>(null);
  useEffect(() => {
    if (collapsed) {
      if (reveal?.openSidebar === true) revealWaits.current = reveal.seq;
      return;
    }
    const waited = revealWaits.current;
    revealWaits.current = null;
    if (waited !== null && waited === reveal?.seq)
      revealMeasurement(reveal.id, { openSidebar: false });
  }, [reveal, collapsed]);
  const groups = useMemo(
    () =>
      project
        ? buildDatasetTree(project.manifest, issues, durations, {
            unplaced,
            measurements: measureItems,
            measurementIds: measureIds,
          })
        : [],
    [project, issues, durations, unplaced, measureItems, measureIds],
  );
  // survey dates on: the group shows once, below the date folders (no date folder holds it)
  const after = useMemo(() => {
    const g = measurementsGroup(measureItems, measureIds);
    return g ? [g] : [];
  }, [measureItems, measureIds]);
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
    setMeasureQuery('');
  }
  // a measurement that left the file (deleted from any menu, the 3D view, the map, the panel,
  // or taken back by Revert) is not marked any more (adjusted during render, not in an effect)
  const [marksFile, setMarksFile] = useState(measureFile);
  if (marksFile !== measureFile) {
    setMarksFile(measureFile);
    setMarks((m) => withoutGoneMeasures(m, measureFile.measurements));
  }
  // A measurement row the filter hides keeps its mark (clearing the filter brings the whole
  // multi-selection back), but the marks acted on (menu, header, Delete) are the rows in view,
  // and so is the selection they make (the Selected panel, the 3D and map menus)
  const shownMeasures = useMemo(
    () => (filteringMeasures ? new Set(measureItems.flatMap(itemMeasureIds)) : null),
    [filteringMeasures, measureItems],
  );
  const inView = useCallback(
    (marked: ReadonlySet<string>): ReadonlySet<string> => {
      if (!shownMeasures) return marked;
      const kept = [...marked].filter((x) => {
        const id = measureIdOf(x);
        return id === null || shownMeasures.has(id);
      });
      return kept.length === marked.size ? marked : new Set(kept);
    },
    [shownMeasures],
  );
  const shownMarks = useMemo(() => inView(marks.marked), [inView, marks.marked]);
  // the filter changed which marks are in view: the selection the marks made follows them (left
  // alone once something else selected, a plain click or a pick in the 3D view)
  const selectedMarks = useRef(shownMarks);
  useEffect(() => {
    const was = selectedMarks.current;
    selectedMarks.current = shownMarks;
    if (was === shownMarks) return;
    const all = new Set(measureIdsOf(marks.marked));
    if (all.size === 0) return;
    if (!measureStore.getState().selected.every((id) => all.has(id))) return;
    selectMarked(all, measureIdsOf(shownMarks));
  }, [shownMarks, marks.marked]);
  // a removal went through: what was marked is gone; Empty could not delete everything: say so
  // where the tree's notes go (adjusted during render, not in an effect)
  const [seenRemoval, setSeenRemoval] = useState({ removed, held });
  if (seenRemoval.removed !== removed || seenRemoval.held !== held) {
    setSeenRemoval({ removed, held });
    // the layers asked about are gone; marked measurements were not asked about, so stay marked
    if (seenRemoval.removed !== removed)
      setMarks((m) => {
        const marked = new Set([...m.marked].filter((x) => measureIdOf(x) !== null));
        return marked.size === 0 ? NO_MARKS : { marked, anchor: null };
      });
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
    const next = nextMarks(marks, order, id, mods);
    setMarks(next);
    // marked measurements in view are selected too, so the Selected panel totals them
    const all = measureIdsOf(next.marked);
    if (all.length > 0) selectMarked(new Set(all), measureIdsOf(inView(next.marked)));
    else letGoOfMeasures(marks.marked);
  };
  /** The marks held measurements and hold none now: only the focused one stays selected. */
  const letGoOfMeasures = (was: ReadonlySet<string>) => {
    if (measureIdsOf(was).length === 0) return;
    const f = measureStore.getState().focus;
    select(f ? [f] : [], f);
  };
  /** Rows marked in view: what the menu, the header and Delete act on. */
  const marked = shownMarks.size > 0;
  /**
   * Delete these rows. Layers go through the shared dialog, which may be cancelled, so with
   * layers among them only the layers are asked about and the measurements stay marked for a
   * second Delete; measurements alone go straight away, with an Undo notice
   * (`MeasureUndoNotice`) that brings them back.
   */
  const deleteRows = (ids: readonly string[]) => {
    const layers = deletable(ids.filter((id) => measureIdOf(id) === null));
    if (layers.length > 0) {
      askLayers(layers);
      return;
    }
    const ms = measureIdsOf(ids);
    if (ms.length === 0 || measureReadOnly) return;
    // the marks of the deleted rows go with them (withoutGoneMeasures)
    deleteMeasurements(ms);
  };

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
    const target = rowTarget(item, shownMarks);
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
  /** A measurement row's menu: the marked measurements when it is one of them, else the row. */
  const openMeasure = (id: string, at: MenuPoint) => {
    const target = measureTarget(id, shownMarks);
    const name = measureFile.measurements.find((m) => m.id === id)?.label ?? id;
    setMenu({
      target,
      ...at,
      title: menuTitle(target, ctx, name),
      label: t('actions.menu.label', { name }),
      testId: 'measure-menu',
      host: {},
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
    // a plain click selects one row and lets go of the marks, and of the measurements they held
    setMarks(NO_MARKS);
    letGoOfMeasures(marks.marked);
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

  // rename, folders and delete edit the measurements file: not when it is read-only
  const canMeasureEdit = canEdit && !measureReadOnly;
  const measures: MeasureTreeProps = {
    hidden: measureHidden,
    selectedId: measureFocus,
    onSetVisible: (ids, visible) => {
      setMeasurementsHidden(ids, !visible);
    },
    onSelect: (id) => {
      // a plain click selects one row and lets go of the marks
      setMarks(NO_MARKS);
      select([id], id);
    },
    onMenu: openMeasure,
    renaming: canMeasureEdit ? measureRenaming : null,
    onRenameStart: canMeasureEdit
      ? (id) => {
          renameRequest.getState().askMeasure(id);
        }
      : undefined,
    onRename: (id, label) => {
      renameMeasurement(id, label);
    },
    onRenameEnd: () => {
      renameRequest.getState().done();
    },
    newFolder: canMeasureEdit ? newFolder : null,
    onNewFolder: (name) => {
      if (name && newFolder) setFolder(newFolder.ids, name);
      endNewFolder();
    },
    reveal,
    query: measureQuery,
    onQuery: setMeasureQuery,
  };

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
          const measureRow = e.target.closest<HTMLElement>('[data-testid="measure-row"]');
          const measureId = measureRow?.dataset.id;
          if (measureRow && measureId !== undefined) {
            openMeasure(measureId, keyMenuPoint(measureRow));
            return;
          }
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
        // Escape lets go of every mark, those the filter hides too
        if (marks.marked.size > 0 && e.key === 'Escape') {
          e.stopPropagation();
          setMarks(NO_MARKS);
          letGoOfMeasures(marks.marked);
        } else if (e.key === 'Delete' && canEdit) {
          // the marked rows, else the focused row: layers through the shared dialog,
          // measurements at once with an Undo notice
          const row = marked ? null : e.target.closest<HTMLElement>('[data-mark]')?.dataset.mark;
          const ids = marked ? [...shownMarks] : row ? [row] : [];
          if (ids.length === 0) return;
          e.preventDefault();
          deleteRows(ids);
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
                deleteRows([...shownMarks]);
              }}
            >
              {t('tree.marked', { count: shownMarks.size })} · {t('tree.delete')}
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
          defaultOpen={OPEN_GROUPS}
          measures={measures}
          after={after}
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
          defaultOpen={OPEN_GROUPS}
          measures={measures}
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
  // a reveal of a measurement (the telecom panel's Measurements) opens a folded sidebar; finishing
  // a shape reveals it without opening
  const revealSeq = useMeasure((s) => s.reveal?.seq);
  const revealOpens = useMeasure((s) => s.reveal?.openSidebar === true);
  useEffect(() => {
    if (revealSeq === undefined || !revealOpens) return;
    const sh = shell.getState();
    if (isSidebarFolded(sh)) void sh.toggleSidebar();
  }, [revealSeq, revealOpens]);

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
