/**
 * Detection review (BLD-5) and AI-assisted detection (BLD-6): a contact sheet of every photo and
 * reviewed video frame, an editor for the boxes and outlines of one, and an inspector for the
 * current detection. Keyboard first: J and K step, A accepts, X rejects, L links to an issue.
 * Nothing becomes an issue until a person accepts it.
 */
import { useTaxonomy, type ImageTool } from '@aio/annotate';
import {
  clampGeom,
  currentOf,
  queueOf,
  REVIEW_PASS,
  sourceCounts,
  sourceKey,
  canRedo,
  canUndo,
  type Detection,
  type DetectionSource,
  type QueueFilter,
  type ReviewError,
} from '@aio/annotate/detections';
import type { Layer } from '@aio/schema';
import { formatCount, Icon, shortcutHint, useT, type MessageKey } from '@aio/ui';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { authorName } from '../author';
import { AiDetectDialog } from '../detections/AiDetectDialog';
import { ContactSheet, type SheetItem } from '../detections/ContactSheet';
import { itemKey, type DetectItem } from '../detections/convert';
import { ReviewEditor, type EditorShape } from '../detections/Editor';
import { Inspector } from '../detections/Inspector';
import { reviewCommand, typingIn } from '../detections/keys';
import { acceptCurrent, dispatch, loadDetections, useDetections } from '../detections/store';
import '../detections/detections.css';
import { FocusZone } from '../FocusZone';
import { useMedia } from '../media';
import { bridge, shell, useCall } from '../shell';
import { findingsIndex, photoKey, type PhotoFindings } from './mediaFindings';
import { NoProject } from './NoProject';

const FILTERS: QueueFilter[] = ['draft', 'all', 'accepted', 'rejected'];
const ERROR_KEY: Record<ReviewError, MessageKey> = {
  accepted: 'det.error.accepted',
  proposal: 'det.error.proposal',
  'undo-accepted': 'det.error.undoAccepted',
  missing: 'det.error.missing',
  duplicate: 'det.error.duplicate',
};
const UNKNOWN_COLOR = '#8a94a6';

type PhotosLayer = Extract<Layer, { kind: 'photos' }>;

/** A tile's issue marker: how many issues the photo already shows and the worst colour. */
function issueMark(f: PhotoFindings | undefined): Pick<SheetItem, 'issues'> {
  return f && f.issues > 0 ? { issues: { count: f.issues, color: f.color } } : {};
}

function sourceLabel(s: DetectionSource, layers: readonly Layer[]): string {
  if (s.kind === 'photo') return s.photo;
  const name = layers.find((l) => l.id === s.layer)?.name ?? s.layer;
  return `${name} ${s.t.toFixed(1)} s`;
}

export function DetectionsScreen() {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const review = useDetections((s) => s.review);
  const loading = useDetections((s) => s.loading);
  const loadError = useDetections((s) => s.loadError);
  const readOnly = useDetections((s) => s.readOnly);
  const save = useDetections((s) => s.save);
  const problem = useDetections((s) => s.problem);
  const issueError = useDetections((s) => s.issueError);
  const hidden = useDetections((s) => s.hidden);
  const problems = useDetections((s) => s.problems);
  const { classById, classes } = useTaxonomy();
  const { durations } = useMedia(project);
  const [tool, setTool] = useState<ImageTool>('select');
  /** Show every photo, or only those with detections (default: all until there are some). */
  const [allPhotos, setAllPhotos] = useState<boolean | null>(null);
  const [viewKey, setViewKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [noteFocus, setNoteFocus] = useState(0);
  const [fitSignal, setFitSignal] = useState(0);
  const [aiOpen, setAiOpen] = useState(false);
  const [maskError, setMaskError] = useState<string | null>(null);
  const mask = useCall('detections:maskAssistStatus', {}, project?.id ?? null);
  const maskAvailable = mask?.ok === true && mask.value.available;

  const projectId = project?.id ?? null;
  // Read the passes each time the review opens: a pipeline run or another tool may have
  // written passes or issues since (pending edits are saved first).
  useEffect(() => {
    if (projectId) void loadDetections(projectId, true);
  }, [projectId]);

  const layers = useMemo(() => project?.manifest.layers ?? [], [project]);
  const photoSets = useMemo(
    () => layers.filter((l): l is PhotosLayer => l.kind === 'photos'),
    [layers],
  );
  const current = currentOf(review);
  const queue = useMemo(() => queueOf(review), [review]);
  const counts = useMemo(() => {
    const c = { draft: 0, accepted: 0, rejected: 0 };
    for (const d of review.detections) c[d.status] += 1;
    return c;
  }, [review.detections]);

  // Issues already marked on each photo (the same index as the Media screen, issues only).
  const issueMarks = useMemo(
    () => (project ? findingsIndex(project.manifest, issues) : new Map<string, never>()),
    [project, issues],
  );

  // The sheet: every photo, then the video frames that have detections.
  const items = useMemo<SheetItem[]>(() => {
    const perSource = new Map(sourceCounts(review.detections).map((c) => [c.key, c]));
    const outlines = new Map<string, SheetItem['outlines']>();
    for (const d of review.detections) {
      if (d.status === 'rejected' && review.filter !== 'rejected') continue;
      const k = sourceKey(d.source);
      const list = outlines.get(k) ?? [];
      list.push({
        id: d.id,
        geom: d.geom,
        color: classById.get(d.classId)?.color ?? UNKNOWN_COLOR,
        size: d.size,
        status: d.status,
      });
      outlines.set(k, list);
    }
    const out: SheetItem[] = [];
    const showAll = allPhotos ?? review.detections.length === 0;
    for (const set of photoSets) {
      for (const p of set.items) {
        const source: DetectionSource = { kind: 'photo', layer: set.id, photo: p.id };
        const key = sourceKey(source);
        const c = perSource.get(key);
        if (!showAll && !c) continue;
        out.push({
          key,
          source,
          label: p.id,
          photo: p.src,
          draft: c?.draft ?? 0,
          accepted: c?.accepted ?? 0,
          rejected: c?.rejected ?? 0,
          outlines: outlines.get(key) ?? [],
          ...issueMark(issueMarks.get(photoKey(set.id, p.id))),
        });
      }
    }
    for (const c of perSource.values()) {
      if (c.source.kind !== 'frame') continue;
      const layer = layers.find((l) => l.id === c.source.layer);
      let video: string | undefined;
      try {
        video = layer?.kind === 'video' && projectId ? assetUrl(projectId, layer.src) : undefined;
      } catch {
        video = undefined;
      }
      out.push({
        key: c.key,
        source: c.source,
        label: sourceLabel(c.source, layers),
        ...(video ? { video } : {}),
        draft: c.draft,
        accepted: c.accepted,
        rejected: c.rejected,
        outlines: outlines.get(c.key) ?? [],
      });
    }
    return out;
  }, [
    review.detections,
    review.filter,
    photoSets,
    layers,
    allPhotos,
    classById,
    projectId,
    issueMarks,
  ]);

  // The editor follows the current detection; a tile without one opens on its own.
  const currentKey = current ? sourceKey(current.source) : null;
  const shownKey = currentKey ?? viewKey;
  const shownItem = items.find((i) => i.key === shownKey) ?? null;
  const shownSource: DetectionSource | null = shownItem?.source ?? current?.source ?? null;

  const shapes = useMemo<EditorShape[]>(() => {
    if (!shownSource) return [];
    const k = sourceKey(shownSource);
    return review.detections
      .filter((d) => sourceKey(d.source) === k)
      .filter(
        (d) => d.status !== 'rejected' || d.id === review.currentId || review.filter === 'rejected',
      )
      .map((d) => {
        const cls = classById.get(d.classId);
        const conf =
          d.confidence !== undefined ? ` ${String(Math.round(d.confidence * 100))}%` : '';
        return {
          detection: d,
          color: cls?.color ?? UNKNOWN_COLOR,
          label: `${cls?.label ?? d.label ?? '?'}${conf}`,
        };
      });
  }, [shownSource, review.detections, review.currentId, review.filter, classById]);

  if (!project) return <NoProject view={t('nav.detections')} />;

  const position = current
    ? { index: queue.findIndex((d) => d.id === current.id) + 1, total: queue.length }
    : { index: 0, total: queue.length };

  const toItem = (s: DetectionSource): DetectItem =>
    s.kind === 'photo'
      ? { kind: 'photo', layer: s.layer, photo: s.photo }
      : { kind: 'frame', layer: s.layer, t: s.t };

  const openKey = (key: string) => {
    setLinking(false);
    const first = queue.find((d) => sourceKey(d.source) === key);
    if (first) dispatch({ type: 'select', id: first.id });
    else {
      // review the photo's other detections, or draw on it
      const any = review.detections.find((d) => sourceKey(d.source) === key);
      dispatch({ type: 'select', id: any?.id ?? null });
    }
    setViewKey(key);
  };

  const selectTile = (key: string, mode: 'toggle' | 'range') => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (mode === 'toggle' || !anchor) {
        if (next.has(key)) next.delete(key);
        else next.add(key);
      } else {
        const a = items.findIndex((i) => i.key === anchor);
        const b = items.findIndex((i) => i.key === key);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) {
          const k = items[i]?.key;
          if (k) next.add(k);
        }
      }
      return next;
    });
    setAnchor(key);
  };

  const now = () => new Date().toISOString();
  const by = () => authorName() || 'user';

  const patch = (p: Partial<Pick<Detection, 'classId' | 'severity' | 'uncertain' | 'note'>>) => {
    if (!current) return;
    dispatch({ type: 'edit', id: current.id, patch: p, now: now() });
  };

  const step = (dir: 1 | -1) => {
    setLinking(false);
    dispatch({ type: dir === 1 ? 'next' : 'prev' });
    setViewKey(null);
  };

  const runMask = async () => {
    if (current?.source.kind !== 'photo' || current.geom.type !== 'box') return;
    const src = current.source;
    const layer = layers.find((l) => l.id === src.layer);
    const photo =
      layer?.kind === 'photos' ? layer.items.find((p) => p.id === src.photo) : undefined;
    if (!photo || !('path' in photo.src)) return;
    const g = current.geom;
    const r = await bridge.call('detections:maskAssist', {
      projectId: project.id,
      path: photo.src.path,
      box: [g.x, g.y, g.w, g.h],
    });
    const res = r.ok ? r.value : { ok: false as const, error: r.error };
    if (!res.ok) {
      setMaskError(res.error);
      return;
    }
    setMaskError(null);
    dispatch({
      type: 'edit',
      id: current.id,
      patch: { geom: { type: 'polygon', points: res.points } },
      now: now(),
    });
  };

  const accept = () => {
    const r = acceptCurrent({ kind: 'new' });
    if (r.ok) setLinking(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (aiOpen || typingIn(e.target)) return;
    const cmd = reviewCommand(e);
    if (!cmd) return;
    // Enter and Backspace close and edit a polygon while one is being drawn
    if (e.key === 'Enter' && tool !== 'select') return;
    const editable = current && !readOnly && current.status !== 'accepted';
    switch (cmd.kind) {
      case 'next':
        step(1);
        break;
      case 'prev':
        step(-1);
        break;
      case 'nextSource':
      case 'prevSource':
        setLinking(false);
        setViewKey(null);
        dispatch({ type: cmd.kind });
        break;
      case 'accept':
        if (editable) accept();
        break;
      case 'link':
        if (editable) setLinking(true);
        break;
      case 'reject':
        if (editable) dispatch({ type: 'reject', id: current.id, by: by(), now: now() });
        break;
      case 'reopen':
        if (current && !readOnly) dispatch({ type: 'reopen', id: current.id, now: now() });
        break;
      case 'delete':
        if (editable) dispatch({ type: 'remove', id: current.id });
        break;
      case 'uncertain':
        if (editable) patch({ uncertain: !current.uncertain });
        break;
      case 'severity': {
        if (!editable) break;
        const cls = classById.get(current.classId);
        const model = project.manifest.severityModels.find((m) => m.id === cls?.severityModel);
        if (!model || model.levels.some((l) => l.value === cmd.value))
          patch({ severity: cmd.value });
        break;
      }
      case 'class': {
        if (!editable || classes.length === 0) break;
        const at = classes.findIndex((c) => c.id === current.classId);
        const next = classes[(at + cmd.step + classes.length) % classes.length];
        if (next) patch({ classId: next.id });
        break;
      }
      case 'note':
        setNoteFocus((n) => n + 1);
        break;
      case 'tool':
        if (!readOnly) setTool(cmd.tool);
        break;
      case 'mask':
        if (editable && maskAvailable) void runMask();
        break;
      case 'fit':
        setFitSignal((n) => n + 1);
        break;
      case 'undo':
        dispatch({ type: 'undo' });
        break;
      case 'redo':
        dispatch({ type: 'redo' });
        break;
    }
    e.preventDefault();
  };

  const selectedItems: DetectItem[] = items
    .filter((i) => selected.has(i.key))
    .map((i) => toItem(i.source));
  const reviewedKeys = new Set(review.detections.map((d) => sourceKey(d.source)));
  const unreviewed: DetectItem[] = [];
  for (const set of photoSets) {
    for (const p of set.items) {
      const item: DetectItem = { kind: 'photo', layer: set.id, photo: p.id };
      if (!reviewedKeys.has(itemKey(item))) unreviewed.push(item);
    }
  }
  const lastSeverity = current?.severity ?? null;

  return (
    <FocusZone
      kind="photo"
      className="screen det-screen"
      aria-label={t('nav.detections')}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="det-h">
        <h1>{t('det.title')}</h1>
        <span className="mono faint" data-testid="det-counts">
          {t('det.counts', {
            draft: formatCount(counts.draft),
            accepted: formatCount(counts.accepted),
            rejected: formatCount(counts.rejected),
          })}
        </span>
        <div className="seg" role="group" aria-label={t('det.filter')}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={review.filter === f}
              onClick={() => {
                dispatch({ type: 'filter', filter: f });
              }}
            >
              {t(`det.filter.${f}`)}
            </button>
          ))}
        </div>
        <label className="det-conf">
          <span>{t('det.minConfidence', { pct: Math.round(review.minConfidence * 100) })}</span>
          <input
            type="range"
            min={0}
            max={0.95}
            step={0.05}
            value={review.minConfidence}
            aria-label={t('det.minConfidenceLabel')}
            onChange={(e) => {
              dispatch({ type: 'minConfidence', value: Number(e.target.value) });
            }}
          />
        </label>
        <span className="grow" />
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('det.undo', { keys: shortcutHint('review.undo') })}
          title={t('det.undo', { keys: shortcutHint('review.undo') })}
          disabled={!canUndo(review)}
          onClick={() => {
            dispatch({ type: 'undo' });
          }}
        >
          <Icon name="undo" size={14} />
        </button>
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('det.redo', { keys: shortcutHint('review.redo') })}
          title={t('det.redo', { keys: shortcutHint('review.redo') })}
          disabled={!canRedo(review)}
          onClick={() => {
            dispatch({ type: 'redo' });
          }}
        >
          <Icon name="undo" size={14} className="flip" />
        </button>
        <span
          className="ann-save"
          data-state={save.state}
          title={save.error ?? ''}
          data-testid="det-save"
        >
          <i />
          {readOnly ? t('det.save.readOnly') : t(`det.save.${save.state}`)}
        </span>
        <button
          type="button"
          className="btn primary sm"
          data-testid="det-ai-open"
          disabled={readOnly}
          onClick={() => {
            setAiOpen(true);
          }}
        >
          <Icon name="agent" size={14} />
          {selected.size > 0
            ? t('det.ai.openSelected', { count: selected.size })
            : t('det.ai.open')}
        </button>
      </header>

      <div className="det-sub">
        <div className="seg" role="group" aria-label={t('det.sheet.show')}>
          <button
            type="button"
            aria-pressed={!(allPhotos ?? review.detections.length === 0)}
            onClick={() => {
              setAllPhotos(false);
            }}
          >
            {t('det.sheet.withDetections')}
          </button>
          <button
            type="button"
            aria-pressed={allPhotos ?? review.detections.length === 0}
            onClick={() => {
              setAllPhotos(true);
            }}
          >
            {t('det.sheet.allPhotos')}
          </button>
        </div>
        <span className="mono faint">{t('det.sheet.count', { count: items.length })}</span>
        {selected.size > 0 && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setSelected(new Set());
            }}
          >
            {t('det.sheet.clearSelection', { count: selected.size })}
          </button>
        )}
        <span className="grow" />
        <div className="seg" role="group" aria-label={t('det.tools')}>
          {(
            [
              ['select', 'det.tool.select', 'V'],
              ['box', 'det.tool.box', 'B'],
              ['polygon', 'det.tool.polygon', 'P'],
            ] as const
          ).map(([id, label, k]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tool === id}
              disabled={readOnly}
              title={`${t(label)} (${k})`}
              onClick={() => {
                setTool(id);
              }}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <span className="det-keys faint">{t('det.keys')}</span>
      </div>

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
      {maskError && (
        <p className="det-banner" role="alert">
          {maskError}
        </p>
      )}

      <div className="det-body">
        <ContactSheet
          projectId={project.id}
          items={items}
          currentKey={shownKey}
          selected={selected}
          onOpen={openKey}
          onSelect={selectTile}
        />
        <div className="det-center">
          {shownSource ? (
            <ReviewEditor
              projectId={project.id}
              layers={layers}
              source={shownSource}
              shapes={shapes}
              currentId={review.currentId}
              tool={tool}
              readOnly={readOnly}
              fitSignal={fitSignal}
              onCreate={(drawn, size) => {
                const geom = drawn.type === 'mask' ? null : clampGeom(drawn, size);
                if (!geom) return;
                const d: Detection = {
                  id: globalThis.crypto.randomUUID(),
                  pass: REVIEW_PASS,
                  source: shownSource,
                  size: [size.width, size.height],
                  geom,
                  classId: current?.classId ?? '',
                  severity: lastSeverity,
                  uncertain: false,
                  note: '',
                  status: 'draft',
                  origin: { kind: 'human', author: by() },
                  createdAt: now(),
                  updatedAt: now(),
                };
                dispatch({ type: 'add', detections: [d], label: t('det.drawLabel') });
                setTool('select');
              }}
              onEdit={(id, geom) => {
                if (geom.type !== 'mask')
                  dispatch({ type: 'edit', id, patch: { geom }, now: now() });
              }}
              onSelect={(id) => {
                if (id) dispatch({ type: 'select', id });
              }}
            />
          ) : (
            <div className="side-empty">
              <Icon name="target" size={20} />
              <p>{loading ? t('det.loading') : t('det.pickTile')}</p>
            </div>
          )}
        </div>
        <Inspector
          detection={current}
          position={position}
          issues={issues}
          readOnly={readOnly}
          problem={problem}
          issueError={issueError}
          linking={linking}
          noteFocus={noteFocus}
          maskAssist={maskAvailable}
          onPatch={patch}
          onAccept={accept}
          onLinkStart={() => {
            setLinking(true);
          }}
          onLinkCancel={() => {
            setLinking(false);
          }}
          onLink={(issueId) => {
            const r = acceptCurrent({ kind: 'link', issueId });
            if (r.ok) setLinking(false);
          }}
          onReject={() => {
            if (current) dispatch({ type: 'reject', id: current.id, by: by(), now: now() });
          }}
          onReopen={(issueGone) => {
            if (current) dispatch({ type: 'reopen', id: current.id, now: now(), issueGone });
          }}
          onDelete={() => {
            if (current) dispatch({ type: 'remove', id: current.id });
          }}
          onOpenIssue={(id) => {
            workspace.getState().select({ kind: 'issue', id });
            shell.getState().go('issues');
          }}
          onMask={() => void runMask()}
          onStep={step}
        />
      </div>

      {aiOpen && (
        <AiDetectDialog
          projectId={project.id}
          layers={layers}
          selected={selectedItems}
          current={shownSource ? toItem(shownSource) : null}
          unreviewed={unreviewed}
          durations={durations}
          videoUrl={(layerId) => {
            const l = layers.find((x) => x.id === layerId);
            try {
              return l?.kind === 'video' ? assetUrl(project.id, l.src) : null;
            } catch {
              return null;
            }
          }}
          onClose={() => {
            setAiOpen(false);
            setSelected(new Set());
            if (!review.currentId) dispatch({ type: 'filter', filter: review.filter });
          }}
        />
      )}
    </FocusZone>
  );
}
