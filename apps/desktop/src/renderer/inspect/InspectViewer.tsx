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
import { PhotoViewer, useTaxonomy, type PhotoViewerHandle } from '@aio/annotate';
import {
  geomBounds,
  sourceKey,
  type Detection,
  type DetectionSource,
} from '@aio/annotate/detections';
import type { DetectionGeom, ImageGeom, Layer } from '@aio/schema';
import { Icon, Tip, useT, type PhotoPick } from '@aio/ui';
import { useCallback, useMemo, useRef, type ReactElement, type Ref } from 'react';
import { ReviewEditor, type EditorShape } from '../detections/Editor';
import { detectionLook } from '../detections/look';
import { noteImageSize } from '../detections/store';
import { AI_COLOR, draftIdOf, draftOnPhoto, photoToDraft, suggestionShapes } from './viewerShapes';

export interface Natural {
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
  /** The size the photo is drawn at, as it loads (`photo:<layer>:<photo>` key). */
  onSize?: (key: string, size: Natural) => void;
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
  // the size the photo is drawn at: the one PhotoViewer hands to `extraShapes` once the photo is
  // in (the image as the browser shows it, EXIF turn applied). The chips and a Fix edit use the
  // same size, never the library's (read from the file header, it may be the other way round).
  const drawn = useRef<{ key: string; size: Natural } | null>(null);
  const onSize = p.onSize;
  const natural = useCallback(
    (): Natural | null => (drawn.current?.key === photoKey ? drawn.current.size : null),
    [photoKey],
  );

  // one array per change, as PhotoViewer keeps its shapes by the callback's identity
  const extraShapes = useCallback(
    (size: Natural) => {
      if (photoKey) {
        drawn.current = { key: photoKey, size };
        noteImageSize(photoKey, [size.width, size.height]);
        onSize?.(photoKey, size);
      }
      return suggestionShapes(waiting, size, { currentId, fixing, classLabel });
    },
    [photoKey, waiting, currentId, fixing, classLabel, onSize],
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
              <Tip content={t('inspect.accept')} repeatsName>
                <button
                  type="button"
                  className="ok"
                  data-testid="inspect-inline-accept"
                  aria-label={t('inspect.accept')}
                  onClick={() => {
                    p.onAccept(d.id);
                  }}
                >
                  <Icon name="check" size={12} />
                </button>
              </Tip>
              <Tip content={t('inspect.dismiss')} repeatsName>
                <button
                  type="button"
                  data-testid="inspect-inline-dismiss"
                  aria-label={t('inspect.dismiss')}
                  onClick={() => {
                    p.onDismiss(d.id);
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </Tip>
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
