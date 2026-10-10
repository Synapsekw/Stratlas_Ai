import type { FrameGeom, ImageGeom, Sighting } from '@aio/schema';
import { issuesOnScreen, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fitView, type Point, type Size, type ViewTransform } from '../image/geometry';
import {
  beginSighting,
  issueEditor,
  loadFlightPoses,
  rememberImageSize,
  annotateUi,
  useAnnotateReadOnly,
  useAnnotateUi,
  type ImageTool,
} from '../runtime';
import { severityColor } from '../tools/mesh';
import {
  interpolateTrack,
  markRange,
  removeKeyframe,
  setKeyframe,
  trackGeomAt,
  videoTimeS,
  type VideoSighting,
} from '../video/track';
import { formatClock, useTaxonomy } from './common';
import { DrawLayer, type ShapeItem } from './DrawLayer';
import { SightingPicker } from './SightingPicker';
import { AnnotateStyles } from './styles';

const VIDEO_TOOLS: { id: ImageTool; label: string; key: string }[] = [
  { id: 'select', label: 'Select', key: 'v' },
  { id: 'box', label: 'Box', key: 'b' },
  { id: 'polygon', label: 'Polygon', key: 'p' },
];

const isFrameGeom = (g: ImageGeom): g is FrameGeom => g.type === 'box' || g.type === 'polygon';

/**
 * Annotation overlay for a video window: draw a box or polygon on the current frame (time `t` in
 * video seconds at `workspace.nowMs`), add keyframes as the clip plays (move or reshape the box at
 * a new time, or press K), interpolate between them, and mark time-range events (I and O).
 * Mounted inside VideoWindow; it assumes the video is drawn with `object-fit: contain` in the same
 * box. `frameSize` overrides the size read from the sibling `<video>` element.
 */
export function VideoAnnotator({ layerId, frameSize }: { layerId: string; frameSize?: Size }) {
  const project = useWorkspace((s) => s.project);
  const nowMs = useWorkspace((s) => s.nowMs);
  const allIssues = useWorkspace((s) => s.issues);
  const dates = useWorkspace((s) => s.dates);
  const hidden = useWorkspace((s) => s.hidden);
  // the clip is on screen here, so its survey date is; an issue of a date that is not is left out
  const issues = useMemo(
    () => issuesOnScreen(allIssues, dates, hidden, [layerId]),
    [allIssues, dates, hidden, layerId],
  );
  const selection = useWorkspace((s) => s.selection);
  const storedTool = useAnnotateUi((s) => s.imageTool);
  const { modelById } = useTaxonomy();
  const rootRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [videoSize, setVideoSize] = useState<Size | null>(null);
  const [picked, setActive] = useState(false);
  const readOnly = useAnnotateReadOnly();
  // A read-only package never annotates.
  const active = picked && !readOnly;

  const layer = project?.manifest.layers.find((l) => l.id === layerId);
  const clip = layer?.kind === 'video' ? layer : null;
  const t = clip ? Math.max(0, videoTimeS(clip, nowMs)) : 0;
  const tool: ImageTool = VIDEO_TOOLS.some((x) => x.id === storedTool) ? storedTool : 'select';
  const aspect = clip?.lens.aspect ?? 16 / 9;
  const frame: Size = useMemo(
    () => frameSize ?? videoSize ?? { width: 1280, height: Math.round(1280 / aspect) },
    [frameSize, videoSize, aspect],
  );
  const view: ViewTransform = useMemo(
    () => (box.width && box.height ? fitView(frame, box, 0) : { scale: 1, x: 0, y: 0 }),
    [frame, box],
  );
  const selectedIssueId = selection?.kind === 'issue' ? selection.id : null;

  useEffect(() => {
    if (project && clip) void loadFlightPoses(project.id, clip);
  }, [project, clip]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      setBox({ width: el.clientWidth, height: el.clientHeight });
      const v = el.parentElement?.querySelector('video');
      if (v?.videoWidth && v.videoHeight) {
        setVideoSize({ width: v.videoWidth, height: v.videoHeight });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const v = el.parentElement?.querySelector('video');
    v?.addEventListener('loadedmetadata', measure);
    return () => {
      ro.disconnect();
      v?.removeEventListener('loadedmetadata', measure);
    };
  }, []);

  useEffect(() => {
    rememberImageSize(layerId, null, [frame.width, frame.height]);
  }, [layerId, frame.width, frame.height]);

  /** The selected issue's track on this clip, if any. */
  const selectedTrack = useMemo(() => {
    const issue = issues.find((i) => i.id === selectedIssueId);
    if (!issue) return null;
    const index = issue.sightings.findIndex((s) => s.on === 'video' && s.layer === layerId);
    const s = issue.sightings[index];
    return s?.on === 'video' ? { issue, index, sighting: s } : null;
  }, [issues, selectedIssueId, layerId]);

  const shapes = useMemo<ShapeItem[]>(() => {
    const out: ShapeItem[] = [];
    for (const issue of issues) {
      const color = severityColor(modelById.get(issue.severityModelId), issue.severity);
      issue.sightings.forEach((s, i) => {
        if (s.on !== 'video' || s.layer !== layerId) return;
        const inRange = !s.range || (t >= s.range[0] && t <= s.range[1]);
        const at = interpolateTrack(s.track, t);
        if (!at || !inRange) return;
        const selected = issue.id === selectedIssueId;
        out.push({
          key: `${issue.id}:${i}`,
          geom: at.geom,
          color,
          label: `${issue.code}${at.key ? ' ◆' : ''}`,
          selected,
          editable: selected,
        });
      });
    }
    return out;
  }, [issues, modelById, layerId, t, selectedIssueId]);

  const writeTrack = (s: VideoSighting, issueId: string, index: number) => {
    issueEditor.replaceSighting(issueId, index, s);
  };

  const onEdit = (key: string, geom: ImageGeom) => {
    const [issueId, idx] = key.split(':');
    const issue = issues.find((i) => i.id === issueId);
    const s = issue?.sightings[Number(idx)];
    if (!issue || s?.on !== 'video' || !isFrameGeom(geom)) return;
    writeTrack({ ...s, track: setKeyframe(s.track, t, geom) }, issue.id, Number(idx));
  };

  const addKey = () => {
    if (!selectedTrack) return;
    const { sighting: s, issue, index } = selectedTrack;
    const geom = trackGeomAt(s.track, t);
    if (!geom) return;
    writeTrack({ ...s, track: setKeyframe(s.track, t, geom) }, issue.id, index);
  };
  const deleteKey = () => {
    if (!selectedTrack) return;
    const { sighting: s, issue, index } = selectedTrack;
    const track = removeKeyframe(s.track, t);
    if (track.length && track.length !== s.track.length) {
      writeTrack({ ...s, track }, issue.id, index);
    }
  };
  const mark = (end: 'in' | 'out') => {
    if (!selectedTrack) return;
    const { sighting: s, issue, index } = selectedTrack;
    writeTrack({ ...s, range: markRange(s.range, end, t) }, issue.id, index);
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || annotateUi.getState().pending) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      const tl = VIDEO_TOOLS.find((x) => x.key === k);
      if (tl) annotateUi.setState({ imageTool: tl.id });
      else if (k === 'k') addKey();
      else if (k === 'i') mark('in');
      else if (k === 'o') mark('out');
      else if (k === 'escape') setActive(false);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });

  const onCreate = (geom: ImageGeom, at: Point) => {
    if (!isFrameGeom(geom)) return;
    workspace.getState().pause();
    const s: Sighting = { on: 'video', layer: layerId, track: [{ t, geom }] };
    beginSighting(s, at);
  };

  return (
    <div
      ref={rootRef}
      className="ann-video ann-stage"
      style={{ background: 'transparent', pointerEvents: active ? 'auto' : 'none' }}
      data-stub="video-annotator"
      data-layer={layerId}
    >
      <AnnotateStyles />
      {box.width > 0 && (
        <DrawLayer
          view={view}
          size={frame}
          tool={active ? tool : 'select'}
          shapes={shapes}
          onCreate={onCreate}
          onEdit={onEdit}
          onSelect={(key) => {
            const id = key?.split(':')[0];
            if (id) workspace.getState().select({ kind: 'issue', id });
          }}
          onPan={() => undefined}
        />
      )}
      <div
        className="bar"
        style={{ pointerEvents: 'auto' }}
        role="toolbar"
        aria-label="Video annotation"
      >
        {!readOnly && (
          <button
            type="button"
            className="ann-btn ghost"
            aria-pressed={active}
            title="Annotate this clip (Esc to stop)"
            onClick={() => {
              setActive((a) => !a);
            }}
          >
            Annotate
          </button>
        )}
        {active &&
          VIDEO_TOOLS.map((x) => (
            <button
              key={x.id}
              type="button"
              className="ann-btn ghost"
              aria-pressed={tool === x.id}
              title={`${x.label} (${x.key.toUpperCase()})`}
              onClick={() => {
                annotateUi.setState({ imageTool: x.id });
              }}
            >
              {x.label}
            </button>
          ))}
        {active && selectedTrack && (
          <>
            <button
              type="button"
              className="ann-btn ghost"
              title="Keyframe at this time (K)"
              onClick={addKey}
            >
              Key
            </button>
            <button
              type="button"
              className="ann-btn ghost"
              title="Delete the keyframe at this time"
              onClick={deleteKey}
            >
              Del key
            </button>
            <button
              type="button"
              className="ann-btn ghost"
              title="Event starts here (I)"
              onClick={() => {
                mark('in');
              }}
            >
              In
            </button>
            <button
              type="button"
              className="ann-btn ghost"
              title="Event ends here (O)"
              onClick={() => {
                mark('out');
              }}
            >
              Out
            </button>
            <span className="ann-faint" style={{ padding: '0 6px' }}>
              {selectedTrack.issue.code} · {selectedTrack.sighting.track.length} keys
              {selectedTrack.sighting.range
                ? ` · ${formatClock(selectedTrack.sighting.range[0])} to ${formatClock(selectedTrack.sighting.range[1])}`
                : ''}
            </span>
          </>
        )}
        <span className="ann-faint" style={{ padding: '0 6px', fontFamily: 'var(--f-mono)' }}>
          {formatClock(t)}
        </span>
      </div>
      {!readOnly && <SightingPicker kinds={['video']} />}
    </div>
  );
}
