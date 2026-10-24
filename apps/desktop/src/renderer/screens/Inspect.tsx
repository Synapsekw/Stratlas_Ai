/**
 * Inspect: one screen for the project's photos, the findings drawn on them and the AI's
 * suggestions. The photo column on the left, the open photo in the centre with Ask AI above it,
 * and on the right the findings on this photo or, after a run, the review queue. Under 1000 px the
 * right panel is a drawer over the viewer's right edge.
 *
 * Keyboard first, as the Detections screen was: A accepts, D dismisses, L links, B draws, J and K
 * step (photos on the list, suggestions in the queue), F fixes in the queue and fits on the list,
 * Esc leaves the queue. Nothing the AI found becomes an issue until a person accepts it.
 */
import {
  annotateUi,
  AnnotateStyles,
  imageSizeOf,
  useAnnotateReadOnly,
  useTaxonomy,
  type PhotoViewerHandle,
} from '@aio/annotate';
import { currentOf, sourceKey, type Detection, type ReviewError } from '@aio/annotate/detections';
import type { DetectionGeom, Layer } from '@aio/schema';
import {
  actionsFor,
  formatCount,
  Icon,
  makeActionCtx,
  shortcutHint,
  useT,
  type MessageKey,
  type PhotoPick,
} from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { BatchError } from '../detections/BatchConfirm';
import { reviewCommand, typingIn, type ReviewCommand } from '../detections/keys';
import {
  dispatch,
  loadDetections,
  redoReview,
  undoReview,
  useDetections,
} from '../detections/store';
import '../detections/detections.css';
import { FocusZone } from '../FocusZone';
import { acceptSuggestion, dismissSuggestion } from '../inspect/actions';
import { AskAiBar } from '../inspect/askAi/AskAiBar';
import { RunStrip } from '../inspect/askAi/RunStrip';
import { ChangePicker } from '../inspect/ChangePicker';
import {
  findingsOnPhoto,
  followSelection,
  nextPhotoToReview,
  photoPosition,
  panelLayout,
  visibleDetections,
  chipCounts,
} from '../inspect/findings';
import { FindingsPanel } from '../inspect/FindingsPanel';
import { inspectAction, type InspectAction } from '../inspect/inspectKeys';
import { inspectUi, leaveQueue, openPhoto, openQueue, useInspectUi } from '../inspect/inspectUi';
import { InspectViewer, type Natural } from '../inspect/InspectViewer';
import { draftOnPhoto, photoToDraft } from '../inspect/viewerShapes';
import '../inspect/inspect.css';
import { trackDrawingChoice } from '../inspect/lastChoice';
import { PhotoColumn } from '../inspect/PhotoColumn';
import { queueCommand, ReviewQueue } from '../inspect/ReviewQueue';
import { IssueCard } from '../issueCard/IssueCard';
import { useMedia } from '../media';
import { processing } from '../processing/store';
import { bridge, useCall, useShell } from '../shell';
import { thermalPhotosOf, thermalPrimed } from '../shell/actions/thermalActions';
import { toastHost } from '../shell/actions/toastHost';
import { PageHeader } from '../shell/PageHeader';
import { InlineSpotStrip, SpotHistoryButton } from '../workspace/spot/SpotHistoryEntry';
import { useMediaPicks } from './mediaSelect';
import { findingsIndex } from './mediaFindings';
import { NoProject } from './NoProject';

type PhotosLayer = Extract<Layer, { kind: 'photos' }>;

const ERROR_KEY: Record<ReviewError, MessageKey> = {
  accepted: 'det.error.accepted',
  proposal: 'det.error.proposal',
  'undo-accepted': 'det.error.undoAccepted',
  missing: 'det.error.missing',
  duplicate: 'det.error.duplicate',
};

/** Open on the page while a key must not act: a confirm, a picker or a menu has it. */
const KEY_TAKERS =
  '[data-testid="cloud-confirm"], .det-batch-confirm, [data-testid="inspect-change-picker"], [role="menu"]';

const samePick = (a: PhotoPick | null, b: PhotoPick | null) =>
  a?.layerId === b?.layerId && a?.photoId === b?.photoId;

export function InspectScreen(): ReactElement {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  if (!project)
    return (
      <>
        <PageHeader heading="nav.inspect" />
        <NoProject view={t('nav.inspect')} />
      </>
    );
  return (
    <>
      <PageHeader heading="nav.inspect" />
      <InspectBody key={project.id} />
    </>
  );
}

function InspectBody(): ReactElement | null {
  const t = useT();
  const panelId = useId();
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const selection = useWorkspace((s) => s.selection);
  const pkg = useShell((s) => s.pkg);
  const review = useDetections((s) => s.review);
  const storeReadOnly = useDetections((s) => s.readOnly);
  const loadError = useDetections((s) => s.loadError);
  const hidden = useDetections((s) => s.hidden);
  const problems = useDetections((s) => s.problems);
  const issueError = useDetections((s) => s.issueError);
  const lookOnly = useAnnotateReadOnly();
  const { classes, classById } = useTaxonomy();
  const photo = useInspectUi((s) => s.photo);
  const panel = useInspectUi((s) => s.panel);
  const drawerOpen = useInspectUi((s) => s.drawerOpen);
  const picks = useMediaPicks((s) => s);
  const { durations } = useMedia(project);
  const projectId = project?.id ?? '';
  const manifest = project?.manifest;
  const readOnly = storeReadOnly || lookOnly;
  const mask = useCall('detections:maskAssistStatus', {}, projectId || null);
  const maskAvailable = mask?.ok === true && mask.value.available;

  const [order, setOrder] = useState<readonly PhotoPick[]>([]);
  const [layout, setLayout] = useState<'columns' | 'drawer'>('columns');
  const [picker, setPicker] = useState<{ id: string; on: 'pick' | 'link' } | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [, setThermalSeen] = useState(0);
  const viewer = useRef<PhotoViewerHandle>(null);
  /** The size the open photo is drawn at (InspectViewer reports it as the photo loads). */
  const drawnSize = useRef<{ key: string; size: Natural } | null>(null);
  const section = useRef<HTMLElement>(null);
  const accepting = useRef(false);

  // the passes as they are on disk now (a run or another tool may have written since)
  useEffect(() => {
    if (projectId) void loadDetections(projectId, true);
  }, [projectId]);
  // the drawing picker opens on this project's last class and severity, and keeps the next one
  useEffect(() => (projectId ? trackDrawingChoice(projectId) : undefined), [projectId]);
  // Analyse thermal shows once the photo sets were probed
  useEffect(() => {
    let live = true;
    void thermalPrimed().then(() => {
      if (live) setThermalSeen((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  // three columns, or the findings as a drawer when the screen is narrow (the agent column open)
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    // a screen not laid out yet (no width) keeps its columns
    const measure = () => {
      setLayout(el.clientWidth > 0 ? panelLayout(el.clientWidth) : 'columns');
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => {
      ro.disconnect();
    };
  }, []);

  const layers = useMemo(() => manifest?.layers ?? [], [manifest]);
  const photoSets = useMemo(
    () => layers.filter((l): l is PhotosLayer => l.kind === 'photos'),
    [layers],
  );
  const visible = useMemo(() => visibleDetections(review), [review]);
  const index = useMemo(
    () => (manifest ? findingsIndex(manifest, issues, visible) : new Map<string, never>()),
    [manifest, issues, visible],
  );
  const counts = useMemo(() => chipCounts(photoSets, index), [photoSets, index]);
  const waiting = useMemo(() => visible.filter((d) => d.status === 'draft').length, [visible]);
  const current = useMemo(() => currentOf(review), [review]);
  const currentId = review.currentId;

  // the open photo follows the selection: a photo picked here, in 3D or on the map, an issue
  useEffect(() => {
    const now = inspectUi.getState().photo;
    const next = followSelection(now, selection, workspace.getState().issues, photoSets);
    if (!samePick(now, next)) openPhoto(next);
  }, [selection, photoSets]);

  // in the queue, the viewer shows the current suggestion's photo
  const queueSource = panel === 'queue' ? (current?.source ?? null) : null;
  const queuePhoto =
    queueSource?.kind === 'photo'
      ? { layerId: queueSource.layer, photoId: queueSource.photo }
      : null;
  const queueLayer = queuePhoto?.layerId;
  const queuePhotoId = queuePhoto?.photoId;
  useEffect(() => {
    if (!queueLayer || !queuePhotoId) return;
    const next = { layerId: queueLayer, photoId: queuePhotoId };
    if (!samePick(inspectUi.getState().photo, next)) openPhoto(next);
  }, [queueLayer, queuePhotoId]);
  const frame = queueSource?.kind === 'frame' ? queueSource : null;

  // the waiting suggestions (and the current one) of what the viewer shows
  const frameLayer = frame?.layer;
  const frameT = frame?.t;
  const photoLayer = photo?.layerId;
  const photoId = photo?.photoId;
  const shownKey = useMemo(
    () =>
      frameLayer !== undefined && frameT !== undefined
        ? sourceKey({ kind: 'frame', layer: frameLayer, t: frameT })
        : photoLayer && photoId
          ? sourceKey({ kind: 'photo', layer: photoLayer, photo: photoId })
          : null,
    [frameLayer, frameT, photoLayer, photoId],
  );
  const drafts = useMemo<Detection[]>(() => {
    if (!shownKey) return [];
    const ids = new Set(visible.map((d) => d.id));
    return review.detections.filter(
      (d) => sourceKey(d.source) === shownKey && (ids.has(d.id) || d.id === currentId),
    );
  }, [review.detections, visible, shownKey, currentId]);

  const onShown = current !== null && shownKey !== null && sourceKey(current.source) === shownKey;
  const draftSelected =
    current !== null && current.status === 'draft' && (panel === 'queue' || onShown);
  const pickerDraft = picker
    ? review.detections.find((d) => d.id === picker.id && d.status !== 'accepted')
    : undefined;
  const fixingNow = fixing !== null && fixing === currentId && pickerDraft !== undefined;

  const selectedIssueId = selection?.kind === 'issue' ? selection.id : null;
  const rows = useMemo(
    () =>
      photo
        ? findingsOnPhoto({
            pick: photo,
            issues,
            detections: visible,
            selectedIssueId,
            currentDetectionId: currentId,
          })
        : [],
    [photo, issues, visible, selectedIssueId, currentId],
  );
  // an issue marked only in 3D, or on frames: its card stands in for the photo's findings
  const cardIssue =
    selectedIssueId !== null &&
    !issues.find((i) => i.id === selectedIssueId)?.sightings.some((s) => s.on === 'image')
      ? selectedIssueId
      : null;

  const allPhotos = useMemo<PhotoPick[]>(
    () => photoSets.flatMap((s) => s.items.map((p) => ({ layerId: s.id, photoId: p.id }))),
    [photoSets],
  );
  const photoLayerIds = useMemo(() => new Set(photoSets.map((s) => s.id)), [photoSets]);
  const selectedPhotos = useMemo(
    () =>
      picks.projectId === projectId ? picks.picks.filter((p) => photoLayerIds.has(p.layerId)) : [],
    [picks, projectId, photoLayerIds],
  );

  const spotOpen = useMemo(
    () =>
      photo
        ? { item: { kind: 'photo' as const, layer: photo.layerId, photo: photo.photoId } }
        : null,
    [photo],
  );
  const thermal =
    photo && projectId && thermalPhotosOf(projectId, photo.layerId).includes(photo.photoId)
      ? manifest
        ? actionsFor(
            { kind: 'photos', picks: [photo] },
            makeActionCtx({
              manifest,
              pkg: !!pkg,
              canEdit: !pkg && !lookOnly,
              host: toastHost(photo.photoId),
            }),
          ).find((i) => i.id === 'thermal.analyse')
        : undefined
      : undefined;

  const selectDraft = useCallback((id: string) => {
    dispatch({ type: 'select', id });
  }, []);
  const editDraft = useCallback((id: string, geom: DetectionGeom) => {
    dispatch({ type: 'edit', id, patch: { geom }, now: new Date().toISOString() });
  }, []);
  const acceptDraft = useCallback(
    (id: string) => {
      if (accepting.current || !projectId) return;
      accepting.current = true;
      setNote(null);
      void acceptSuggestion(projectId, id)
        .then((r) => {
          if (r.ok) return;
          if ('needs' in r) setPicker({ id, on: 'pick' });
          else setNote(r.error);
        })
        .catch((e: unknown) => {
          setNote(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          accepting.current = false;
        });
    },
    [projectId],
  );
  const noteDrawnSize = useCallback((key: string, size: Natural) => {
    drawnSize.current = { key, size };
  }, []);
  /** The photo's size as drawn; the library's (its file header) when it is not open. */
  const sizeOf = (key: string, layerId: string, photoId: string): Natural | null => {
    if (drawnSize.current?.key === key) return drawnSize.current.size;
    const s = imageSizeOf(layerId, photoId);
    return s ? { width: s[0], height: s[1] } : null;
  };
  const dismissDraft = useCallback((id: string) => {
    setNote(null);
    dismissSuggestion(id);
  }, []);

  if (!project || !manifest) return null;

  const position = photoPosition(order, photo);
  const empty = !layers.some((l) =>
    l.kind === 'photos' || l.kind === 'panoramas'
      ? l.items.length > 0
      : l.kind === 'video' || l.kind === 'walk',
  );

  const stepPhoto = (dir: 1 | -1) => {
    if (order.length === 0) return;
    const at = order.findIndex((p) => samePick(p, photo));
    const to = at < 0 ? order[0] : order[Math.min(order.length - 1, Math.max(0, at + dir))];
    if (!to || samePick(to, photo)) return;
    workspace.getState().select({ kind: 'photo', id: to.photoId, layer: to.layerId });
  };

  // M: the mask model outlines the current box suggestion. It works in the photo's pixels, the
  // suggestion keeps its own grid: the box is scaled to the photo as it is drawn, and the outline
  // back to the suggestion's grid.
  const runMask = async () => {
    if (current?.source.kind !== 'photo' || current.geom.type !== 'box') return;
    const d = current;
    const src = current.source;
    const layer = layers.find((l) => l.id === src.layer);
    const item = layer?.kind === 'photos' ? layer.items.find((p) => p.id === src.photo) : undefined;
    if (!item || !('path' in item.src)) return;
    const size = sizeOf(sourceKey(src), src.layer, src.photo);
    const g = size ? draftOnPhoto(d, size) : null;
    if (!size || g?.type !== 'box') {
      setNote(t('card.photoFailed'));
      return;
    }
    const r = await bridge.call('detections:maskAssist', {
      projectId: project.id,
      path: item.src.path,
      box: [g.x, g.y, g.w, g.h],
    });
    const res = r.ok ? r.value : { ok: false as const, error: r.error };
    if (!res.ok) {
      setNote(res.error);
      return;
    }
    const geom = photoToDraft({ type: 'polygon', points: res.points }, d, size);
    if (!geom) return;
    setNote(null);
    dispatch({ type: 'edit', id: d.id, patch: { geom }, now: new Date().toISOString() });
  };

  // severity digit, C / Shift+C, U and Delete on the current draft
  const edit = (cmd: ReviewCommand) => {
    if (!current || readOnly || current.status === 'accepted') return;
    const now = new Date().toISOString();
    const patch = (p: Partial<Pick<Detection, 'classId' | 'severity' | 'uncertain'>>) => {
      dispatch({ type: 'edit', id: current.id, patch: p, now });
    };
    switch (cmd.kind) {
      case 'delete':
        dispatch({ type: 'remove', id: current.id });
        break;
      case 'uncertain':
        patch({ uncertain: !current.uncertain });
        break;
      case 'severity': {
        const cls = classById.get(current.classId);
        const model = manifest.severityModels.find((m) => m.id === cls?.severityModel);
        if (!model || model.levels.some((l) => l.value === cmd.value))
          patch({ severity: cmd.value });
        break;
      }
      case 'class': {
        if (classes.length === 0) break;
        const at = classes.findIndex((c) => c.id === current.classId);
        const next = classes[(at + cmd.step + classes.length) % classes.length];
        if (next) patch({ classId: next.id });
        break;
      }
      default:
        break;
    }
  };

  const fit = () => {
    if (frame) setFitSignal((n) => n + 1);
    else viewer.current?.fit();
  };

  const act = (a: InspectAction, e: KeyboardEvent<HTMLElement>) => {
    const queue = panel === 'queue';
    if (typeof a === 'object') {
      edit(a.edit);
      return;
    }
    switch (a) {
      case 'accept':
      case 'dismiss':
      case 'fix':
      case 'next':
      case 'prev':
        if (queue) {
          // F is Fix here: the viewer must not take it as Fit
          if (a === 'fix') e.stopPropagation();
          queueCommand(a);
          return;
        }
        if (a === 'accept' && current) acceptDraft(current.id);
        else if (a === 'dismiss' && current && !readOnly) dismissDraft(current.id);
        else if (a === 'next') stepPhoto(1);
        else if (a === 'prev') stepPhoto(-1);
        return;
      case 'nextSource':
      case 'prevSource':
        dispatch({ type: a });
        return;
      case 'draw':
        if (!readOnly && !frame) annotateUi.setState({ imageTool: 'box' });
        return;
      case 'link':
        if (current && !readOnly) setPicker({ id: current.id, on: 'link' });
        return;
      case 'leave':
        setFixing(null);
        leaveQueue();
        return;
      case 'undo':
        undoReview();
        return;
      case 'redo':
        redoReview();
        return;
      case 'fit':
        fit();
        return;
      case 'mask':
        // M is mask assist on a box suggestion; the viewer's own M (its overlay) is not wanted
        e.stopPropagation();
        if (!readOnly && maskAvailable) void runMask();
        return;
    }
  };

  const onKeyDownCapture = (e: KeyboardEvent<HTMLElement>) => {
    if (typingIn(e.target) || annotateUi.getState().pending) return;
    if (e.currentTarget.querySelector(KEY_TAKERS)) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    // Enter presses a focused button, and closes a polygon being drawn
    if (
      e.key === 'Enter' &&
      (annotateUi.getState().imageTool !== 'select' || target?.closest('button, a, summary'))
    )
      return;
    // the arrows move a focused slider
    if (target instanceof HTMLInputElement && target.type === 'range' && e.key.startsWith('Arrow'))
      return;
    const cmd = reviewCommand(e);
    if (!cmd) return;
    const a = inspectAction(cmd, panel, draftSelected);
    if (!a) return;
    act(a, e);
    e.preventDefault();
  };

  const nextToReview = () => {
    const to = nextPhotoToReview(order, index, photo);
    if (to) workspace.getState().select({ kind: 'photo', id: to.photoId, layer: to.layerId });
  };

  const drawer = layout === 'drawer';
  // a picker asked for by a key opens the drawer it lives in
  const showPanel = !drawer || drawerOpen || picker !== null;
  const picking = pickerDraft && !readOnly && (
    <ChangePicker
      key={`${pickerDraft.id}:${picker?.on ?? ''}`}
      projectId={project.id}
      detection={pickerDraft}
      issues={issues}
      startOn={picker?.on ?? 'pick'}
      onDone={() => {
        setPicker(null);
        setFixing(null);
      }}
      onCancel={() => {
        setPicker(null);
        setFixing(null);
      }}
    />
  );

  const right =
    panel === 'queue' ? (
      <ReviewQueue
        projectId={project.id}
        manifest={manifest}
        readOnly={readOnly}
        onFix={() => {
          if (!current) return;
          setFixing(current.id);
          setPicker({ id: current.id, on: 'pick' });
        }}
        onNeedsPicker={(id) => {
          setPicker({ id, on: 'pick' });
        }}
      />
    ) : cardIssue ? (
      <IssueCard issueId={cardIssue} place="media" className="fill-col" />
    ) : (
      <FindingsPanel
        projectId={project.id}
        rows={rows}
        issues={issues}
        leftToReview={counts.review}
        readOnly={readOnly}
        onSelectRow={(row) => {
          if (row.kind === 'you') workspace.getState().select({ kind: 'issue', id: row.issueId });
          else dispatch({ type: 'select', id: row.detectionId });
        }}
        onNextToReview={nextToReview}
      />
    );

  const panelEl = showPanel && (
    <aside
      id={panelId}
      className={`insp-right${drawer ? ' drawer' : ''}`}
      data-testid="inspect-findings"
      aria-label={t('inspect.panel.title')}
    >
      {picking}
      {right}
    </aside>
  );

  return (
    <section
      ref={section}
      className={`screen inspect${drawer ? ' narrow' : ''}`}
      aria-label={t('nav.inspect')}
      // a click anywhere on the screen keeps the keys here (a button that went away, a label)
      tabIndex={-1}
      onKeyDownCapture={onKeyDownCapture}
    >
      <AnnotateStyles />
      <FocusZone kind="photo" className="insp-zone">
        <RunStrip />
        {loadError && (
          <p className="det-banner error" role="alert">
            {loadError}
          </p>
        )}
        {hidden > 0 && <p className="det-banner">{t('det.sheet.hidden', { count: hidden })}</p>}
        {problems.map((pr) => (
          <p key={pr.name} className="det-banner">
            {t('det.sheet.problem', { name: pr.name, error: pr.error })}
          </p>
        ))}
        {review.lastError && (
          <p className="det-banner" role="status">
            {t(ERROR_KEY[review.lastError])}
          </p>
        )}
        {issueError && <BatchError message={issueError} />}
        {note && (
          <p className="det-banner" role="alert" data-testid="inspect-note">
            {note}
          </p>
        )}
        <div className="insp-body">
          <aside className="insp-left" data-testid="inspect-photos">
            <PhotoColumn
              projectId={project.id}
              manifest={manifest}
              index={index}
              open={photo}
              onOrder={setOrder}
            />
          </aside>
          <div className="insp-center">
            <header className="insp-center-h">
              <div className="insp-center-row">
                <h2>
                  <Icon name={frame ? 'video' : 'photo'} size={14} />
                  <span className="insp-name">{frame ? shownKey : (photo?.photoId ?? '')}</span>
                </h2>
                {position && !frame && (
                  <span className="mono faint" data-testid="inspect-position">
                    {t('inspect.position', {
                      index: formatCount(position.index + 1),
                      total: formatCount(position.total),
                    })}
                  </span>
                )}
                <span className="grow" />
                {spotOpen && !frame && <SpotHistoryButton open={spotOpen} />}
                {thermal && (
                  <button
                    type="button"
                    className="btn sm ghost"
                    data-testid="inspect-thermal"
                    disabled={thermal.disabled !== false}
                    onClick={() => {
                      thermal.run();
                    }}
                  >
                    <Icon name="flare" size={14} />
                    {thermal.label}
                  </button>
                )}
                {panel === 'photo' && waiting > 0 && (
                  <button
                    type="button"
                    className="btn sm insp-review"
                    data-testid="inspect-review"
                    onClick={() => {
                      openQueue();
                    }}
                  >
                    <Icon name="check" size={14} />
                    {t('askAi.run.review', { count: waiting })}
                  </button>
                )}
                {drawer && (
                  <button
                    type="button"
                    className={`btn sm${drawerOpen ? ' on' : ''}`}
                    data-testid="inspect-panel-toggle"
                    aria-expanded={drawerOpen}
                    aria-controls={panelId}
                    onClick={() => {
                      inspectUi.setState({ drawerOpen: !drawerOpen });
                    }}
                  >
                    {t('inspect.panel.toggle', { count: rows.length })}
                  </button>
                )}
              </div>
              <div className="insp-center-row">
                <AskAiBar
                  key={project.id}
                  projectId={project.id}
                  projectRoot={project.root}
                  manifest={manifest}
                  current={photo}
                  selected={selectedPhotos}
                  all={allPhotos}
                  durations={durations}
                />
                {manifest.type === 'inspection' && (
                  <button
                    type="button"
                    className="btn sm"
                    data-testid="det-to-issues"
                    disabled={readOnly}
                    onClick={() => {
                      processing.getState().openDialog({
                        pipeline: 'inspection.run',
                        project: project.root,
                        values: {},
                      });
                    }}
                  >
                    <Icon name="issues" size={14} />
                    {t('det.toIssues')}
                  </button>
                )}
              </div>
            </header>
            {/* under the header: in a narrow screen the findings drawer opens over its right edge */}
            <div className="insp-main">
              <div className="insp-view">
                {photo || frame ? (
                  <InspectViewer
                    projectId={project.id}
                    layers={layers}
                    photo={photo}
                    frame={frame}
                    drafts={drafts}
                    currentId={currentId}
                    fixing={fixingNow}
                    readOnly={readOnly}
                    handle={viewer}
                    fitSignal={fitSignal}
                    onSelect={selectDraft}
                    onEdit={editDraft}
                    onAccept={acceptDraft}
                    onDismiss={dismissDraft}
                    onSize={noteDrawnSize}
                  />
                ) : (
                  <div className="side-empty">
                    <Icon name="photo" size={20} />
                    <p>{empty ? t('inspect.empty') : t('inspect.pick')}</p>
                  </div>
                )}
              </div>
              {spotOpen && !frame && <InlineSpotStrip open={spotOpen} />}
              <p className="insp-hint faint">
                {t('inspect.hint', {
                  keys: `${shortcutHint('review.next')} / ${shortcutHint('review.prev')}`,
                })}
              </p>
              {drawer && panelEl}
            </div>
          </div>
          {!drawer && panelEl}
        </div>
      </FocusZone>
    </section>
  );
}
