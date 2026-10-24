/**
 * Inspect's centre: the open photo in the real `PhotoViewer` (its draw tools, the confirmed
 * findings solid in their severity colours) with the AI's waiting suggestions drawn dashed over it,
 * each with a small chip: its class, its confidence, Accept and Dismiss. In the queue, a
 * suggestion on a video or walk frame is shown in the review's frame editor instead; nothing is
 * drawn there by hand (a person's drawing is always an issue, made on a photo).
 *
 * Suggestions keep their own pixel grid: they are scaled to the loaded photo to be drawn, and a
 * Fix edit is scaled back before it is saved. The loaded photo's size is noted for the review
 * store too, so an accept scales a normalized suggestion with it.
 */
import { imageSizeOf, PhotoViewer, useTaxonomy, type PhotoViewerHandle } from '@aio/annotate';
import {
  geomBounds,
  sourceKey,
  type Detection,
  type DetectionSource,
} from '@aio/annotate/detections';
import type { DetectionGeom, ImageGeom, Layer } from '@aio/schema';
import { Icon, useT, type PhotoPick } from '@aio/ui';
import { useCallback, useMemo, type ReactElement, type Ref } from 'react';
import { ReviewEditor, type EditorShape } from '../detections/Editor';
import { detectionLook } from '../detections/look';
import { noteImageSize } from '../detections/store';
import { AI_COLOR, draftIdOf, draftOnPhoto, photoToDraft, suggestionShapes } from './viewerShapes';

interface Natural {
  width: number;
  height: number;
}

export interface InspectViewerProps {
  projectId: string;
  layers: readonly Layer[];
  /** The open photo; ignored while `frame` is set. */
  photo: PhotoPick | null;
  /** A frame of a clip or walk the queue is on. */
  frame: Extract<DetectionSource, { kind: 'frame' }> | null;
  /** The detections of the photo or frame the review shows (waiting ones are the suggestions). */
  drafts: readonly Detection[];
  currentId: string | null;
  /** Fix: the current suggestion's shape can be redrawn. */
  fixing: boolean;
  readOnly: boolean;
  handle: Ref<PhotoViewerHandle>;
  /** Bumped to fit a frame again (the photo fits through `handle`). */
  fitSignal: number;
  onSelect: (id: string) => void;
  /** A Fix edit, in the suggestion's own grid. */
  onEdit: (id: string, geom: DetectionGeom) => void;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
}

export function InspectViewer(p: InspectViewerProps): ReactElement | null {
  const t = useT();
  const { classById } = useTaxonomy();
  const { drafts, currentId, fixing, onEdit, onSelect } = p;
  const waiting = useMemo(() => drafts.filter((d) => d.status === 'draft'), [drafts]);
  const classLabel = useCallback((id: string) => classById.get(id)?.label ?? '', [classById]);
  const layerId = p.photo?.layerId ?? null;
  const photoId = p.photo?.photoId ?? null;
  const photoKey =
    layerId && photoId ? sourceKey({ kind: 'photo', layer: layerId, photo: photoId }) : null;
  // the loaded photo's size: the viewer remembers it as the photo comes in, before it draws
  const natural = useCallback((): Natural | null => {
    const s = layerId && photoId ? imageSizeOf(layerId, photoId) : null;
    return s ? { width: s[0], height: s[1] } : null;
  }, [layerId, photoId]);

  // one array per change, as PhotoViewer keeps its shapes by the callback's identity
  const extraShapes = useCallback(
    (size: Natural) => {
      if (photoKey) noteImageSize(photoKey, [size.width, size.height]);
      return suggestionShapes(waiting, size, { currentId, fixing, classLabel });
    },
    [photoKey, waiting, currentId, fixing, classLabel],
  );

  const onExtraSelect = useCallback(
    (key: string) => {
      const id = draftIdOf(key);
      if (id) onSelect(id);
    },
    [onSelect],
  );
  const onExtraEdit = useCallback(
    (key: string, geom: ImageGeom) => {
      const id = draftIdOf(key);
      const d = id ? waiting.find((x) => x.id === id) : undefined;
      const size = natural();
      const back = d && size ? photoToDraft(geom, d, size) : null;
      if (d && back) onEdit(d.id, back);
    },
    [waiting, natural, onEdit],
  );

  const chips = (toStage: (pt: { x: number; y: number }) => { x: number; y: number }) => {
    const size = natural();
    if (!size) return null;
    return waiting.map((d) => {
      const b = geomBounds(draftOnPhoto(d, size));
      if (!b) return null;
      const at = toStage({ x: b.x, y: b.y + b.h });
      const name = classById.get(d.classId)?.label ?? d.label ?? t('det.class.pick');
      const scored = d.confidence !== undefined && d.unscored !== true;
      return (
        <div
          key={d.id}
          className={`insp-inline${d.id === currentId ? ' on' : ''}`}
          data-testid="inspect-inline"
          data-key={`det:${d.id}`}
          style={{ left: at.x, top: at.y + 4 }}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
        >
          <button
            type="button"
            className="insp-inline-name"
            onClick={() => {
              onSelect(d.id);
            }}
          >
            {name}
            {scored && <b className="mono">{Math.round((d.confidence ?? 0) * 100)}%</b>}
          </button>
          {!p.readOnly && (
            <>
              <button
                type="button"
                className="ok"
                data-testid="inspect-inline-accept"
                aria-label={t('inspect.accept')}
                title={t('inspect.accept')}
                onClick={() => {
                  p.onAccept(d.id);
                }}
              >
                <Icon name="check" size={12} />
              </button>
              <button
                type="button"
                data-testid="inspect-inline-dismiss"
                aria-label={t('inspect.dismiss')}
                title={t('inspect.dismiss')}
                onClick={() => {
                  p.onDismiss(d.id);
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </>
          )}
        </div>
      );
    });
  };

  // a frame: the review's editor, suggestions in the AI colour, nothing drawn by hand
  const frameShapes = useMemo<EditorShape[]>(
    () =>
      p.frame
        ? drafts
            .filter((d) => d.status !== 'rejected' || d.id === currentId)
            .map((d) => {
              const look = detectionLook(d, classById.get(d.classId));
              return {
                detection: d,
                ...look,
                ...(d.status === 'draft' ? { color: AI_COLOR } : {}),
              };
            })
        : [],
    [p.frame, drafts, currentId, classById],
  );
  if (p.frame) {
    return (
      <ReviewEditor
        projectId={p.projectId}
        layers={p.layers}
        source={p.frame}
        shapes={frameShapes}
        currentId={currentId}
        tool="select"
        readOnly={p.readOnly}
        fitSignal={p.fitSignal}
        onCreate={() => undefined}
        onEdit={(id, geom) => {
          if (geom.type !== 'mask') onEdit(id, geom);
        }}
        onSelect={(id) => {
          if (id) onSelect(id);
        }}
      />
    );
  }
  if (!p.photo) return null;
  return (
    <PhotoViewer
      layerId={p.photo.layerId}
      photoId={p.photo.photoId}
      className="fill-col"
      handle={p.handle}
      look="detections"
      extraShapes={extraShapes}
      onExtraSelect={onExtraSelect}
      onExtraEdit={onExtraEdit}
      overlay={chips}
    />
  );
}
